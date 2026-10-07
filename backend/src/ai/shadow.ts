/*
 * The AI shadow runner for collision/body fit (`npm run ai:shadow`). It
 * observes and records; it never acts.
 *
 *   - Off unless armed (AI_SHADOW_ENABLED=1), configured (a provider and a
 *     model with a known price), and given a daily budget.
 *   - One run at a time (a session advisory lock).
 *   - Selects candidates the existing rules leave for a person to verify
 *     (researched or held, website verified, no collision/body signal
 *     recorded), or, with `labeled`, candidates a person already decided
 *     (for measuring agreement; the AI never sees that decision), or, with
 *     `cohort`, exactly the candidates of one gold-set cohort, in labeling
 *     order (src/ai/goldSet.ts), whatever the rules decided.
 *   - Re-reads each website politely with the research fetcher, builds the
 *     input, asks the model once, validates the answer, and appends one
 *     AiDecision row. Unchanged input reuses the earlier decision without a
 *     provider call; a changed prompt or model makes a new decision.
 *   - Stops at the batch limit (provider calls), the daily budget (estimated
 *     worst case before each call), a 10-minute time budget, or a signal.
 *
 * Its database handle can read candidates and read and create AiDecision
 * rows, and nothing else: it is typed that way, so the runner can't change a
 * candidate, prospect, signal, evidence, status, or anything in outreach.
 */
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PoliteFetcher, RESEARCH_LIMITS } from "../research/fetcher.js";
import { parseHtml } from "../research/html.js";
import { pickPages } from "../research/researcher.js";
import {
  COLLISION_FIT_KIND,
  COLLISION_FIT_PROMPT_VERSION,
  COLLISION_FIT_SCHEMA,
  COLLISION_FIT_SYSTEM,
  agreementWithRule,
  buildCollisionFitInput,
  collisionFitUserMessage,
  inputHash,
  ruleVerdict,
  validateCollisionFit,
  type CollisionDecision,
  type FetchedPage,
  type HumanFit,
  type StoredExcerpt,
} from "./collisionFitJudge.js";
import { AiProviderError, costMicroUsd, type AiProvider } from "./provider.js";

/** Everything the runner may do to the database. */
export interface ShadowDb {
  discoveryCandidate: Pick<Db["discoveryCandidate"], "findMany">;
  aiEvalCase: Pick<Db["aiEvalCase"], "findMany">;
  aiDecision: Pick<Db["aiDecision"], "findFirst" | "create" | "aggregate">;
}

export type ShadowMode = "verify" | "labeled" | "cohort";

export const SHADOW_MAX_TOKENS = 8_000;
export const SHADOW_TIME_BUDGET_MS = 10 * 60 * 1000;
/** A failed attempt (unreadable site, provider error) isn't tried again for this long. */
export const ERROR_RETRY_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A conservative input-token estimate: about 2 characters per token. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 2);

const COLLISION = "collision_repair_services";

export const CANDIDATE_SELECT = {
  id: true,
  businessName: true,
  website: true,
  city: true,
  state: true,
  signals: { where: { key: COLLISION }, select: { value: true, origin: true } },
  evidence: { where: { signalKey: COLLISION, origin: "research" }, orderBy: { createdAt: "asc" }, select: { sourceUrl: true, excerpt: true } },
  research: {
    orderBy: { queuedAt: "desc" },
    take: 1,
    select: {
      id: true,
      status: true,
      outcome: true,
      version: true,
      warnings: true,
      facts: { where: { field: { in: [COLLISION, "business_type"] } }, orderBy: { id: "asc" }, select: { field: true, value: true, excerpt: true, source: { select: { url: true } } } },
    },
  },
} satisfies Prisma.DiscoveryCandidateSelect;

export type Selected = Prisma.DiscoveryCandidateGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/**
 * The judge's input for a candidate, from its research's own stored evidence
 * and facts and the pages just read. The one place it is assembled: the
 * shadow runner and the smoke test (smoke.ts) both use it.
 */
export function judgeInput(c: Selected, run: Selected["research"][number], website: string, pages: readonly FetchedPage[]) {
  const stored: StoredExcerpt[] = [
    ...c.evidence.map((e) => ({ kind: "research_evidence" as const, sourceUrl: e.sourceUrl, excerpt: e.excerpt })),
    ...run.facts.filter((f) => f.excerpt && f.source?.url).map((f) => ({ kind: "research_fact" as const, sourceUrl: f.source!.url, excerpt: f.excerpt! })),
  ];
  const businessType = run.facts.find((f) => f.field === "business_type")?.value ?? null;
  return buildCollisionFitInput({
    business: { name: c.businessName, website, city: c.city, state: c.state },
    research: { version: run.version, outcome: run.outcome, businessType, warnings: run.warnings },
    pages,
    stored,
  });
}

/** Candidates the shadow layer may judge, by mode. All need a verified own website. */
export function shadowWhere(mode: ShadowMode, cohortCandidateIds: readonly string[] = []): Prisma.DiscoveryCandidateWhereInput {
  const site = { website: { not: null }, websiteVerifiedAt: { not: null } } satisfies Prisma.DiscoveryCandidateWhereInput;
  if (mode === "cohort") return { ...site, id: { in: [...cohortCandidateIds] } };
  if (mode === "labeled") {
    return { ...site, status: { not: "duplicate" }, signals: { some: { key: COLLISION, origin: "manual", value: { in: ["yes", "no"] } } } };
  }
  return {
    ...site,
    status: { in: ["researched", "needs_review"] },
    prospectId: null,
    OR: [{ categoryVerdict: null }, { categoryVerdict: { not: "wrong_category" } }],
    signals: { none: { key: COLLISION } },
  };
}

const humanOf = (c: Selected): HumanFit | null => {
  const s = c.signals.find((x) => x.origin === "manual");
  return s?.value === "yes" ? "collision_yes" : s?.value === "no" ? "collision_no" : null;
};

/** The pages the research fetcher reads: the website, then up to four same-site pages it links to. Never stored. */
export async function readPages(fetcher: PoliteFetcher, website: string): Promise<FetchedPage[]> {
  const pages: FetchedPage[] = [];
  const read = async (url: string, role: FetchedPage["role"]) => {
    const r = await fetcher.page(url);
    if (r.html !== null && r.result) pages.push({ url: r.result.finalUrl ?? url, role, parsed: parseHtml(r.html) });
  };
  await read(website, "home");
  const home = pages[0];
  if (!home) return [];
  const parsedHome = home.parsed as ReturnType<typeof parseHtml>;
  for (const next of pickPages({ url: home.url, role: "home", parsed: parsedHome, html: "" }, RESEARCH_LIMITS.maxPages - 1)) await read(next.url, next.role);
  return pages;
}

export interface ShadowReport {
  outcome: "disabled" | "not_configured" | "no_price" | "no_budget" | "locked" | "done" | "limit" | "budget" | "time" | "signal";
  examined: number;
  calls: number;
  valid: number;
  invalid: number;
  errors: number;
  reused: number;
  costMicroUsd: number;
  elapsedMs: number;
}

export interface ShadowOptions {
  enabled: boolean;
  provider: AiProvider | null;
  dailyBudgetUsd: number;
  /** Provider calls per run. */
  limit: number;
  mode?: ShadowMode;
  /** For mode "cohort": the gold-set cohort to judge. */
  cohortId?: string;
  acquireLock: () => Promise<{ release: () => Promise<void> } | null>;
  makeFetcher: () => PoliteFetcher;
  now?: () => Date;
  clock?: () => number;
  shouldStop?: () => boolean;
  timeBudgetMs?: number;
}

export async function runAiShadow(db: ShadowDb, o: ShadowOptions): Promise<ShadowReport> {
  const clock = o.clock ?? Date.now;
  const now = o.now ?? (() => new Date());
  const start = clock();
  const report: ShadowReport = { outcome: "done", examined: 0, calls: 0, valid: 0, invalid: 0, errors: 0, reused: 0, costMicroUsd: 0, elapsedMs: 0 };
  const finish = (outcome: ShadowReport["outcome"]) => ({ ...report, outcome, elapsedMs: clock() - start });
  if (!o.enabled) return finish("disabled");
  const provider = o.provider;
  if (!provider) return finish("not_configured");
  if (costMicroUsd(provider.model, 0, 0) === null) return finish("no_price");
  const budgetMicro = Math.floor(o.dailyBudgetUsd * 1_000_000);
  if (budgetMicro <= 0) return finish("no_budget");

  const lock = await o.acquireLock();
  if (!lock) return finish("locked");
  try {
    const mode = o.mode ?? "verify";
    const limit = Math.max(1, o.limit);
    const cohortIds = mode === "cohort" ? (await db.aiEvalCase.findMany({ where: { cohortId: o.cohortId ?? "" }, orderBy: { position: "asc" }, select: { candidateId: true } })).map((c) => c.candidateId) : [];
    const found = await db.discoveryCandidate.findMany({
      where: shadowWhere(mode, cohortIds),
      orderBy: [{ discoveredAt: "asc" }, { id: "asc" }],
      ...(mode === "cohort" ? {} : { take: Math.min(250, limit * 10) }),
      select: CANDIDATE_SELECT,
    });
    // A cohort is judged in its labeling order.
    const order = new Map(cohortIds.map((id, i) => [id, i]));
    const candidates = mode === "cohort" ? found.sort((a, b) => order.get(a.id)! - order.get(b.id)!) : found;
    const base = { kind: COLLISION_FIT_KIND, subjectType: "candidate", mode: "shadow", model: provider.model, promptVersion: COLLISION_FIT_PROMPT_VERSION } as const;
    const spent = async () => (await db.aiDecision.aggregate({ where: { createdAt: { gte: new Date(now().getTime() - DAY_MS) } }, _sum: { costMicroUsd: true } }))._sum.costMicroUsd ?? 0;

    for (const c of candidates) {
      if (report.calls >= limit) return finish("limit");
      if (o.shouldStop?.()) return finish("signal");
      if (clock() - start >= (o.timeBudgetMs ?? SHADOW_TIME_BUDGET_MS)) return finish("time");
      const run = c.research[0];
      if (!run || run.status !== "completed" || run.outcome !== "website_verified" || !c.website) continue;

      // Already judged for this research run, prompt, and model (or failed recently): skip without fetching.
      const done = await db.aiDecision.findFirst({
        where: { ...base, subjectId: c.id, researchId: run.id, OR: [{ status: { in: ["valid", "invalid"] } }, { status: "error", createdAt: { gte: new Date(now().getTime() - ERROR_RETRY_MS) } }] },
        select: { id: true },
      });
      if (done) continue;
      if ((await spent()) >= budgetMicro) return finish("budget");

      report.examined++;
      const record = { ...base, subjectId: c.id, researchId: run.id, humanDecision: humanOf(c) };
      const pages = await readPages(o.makeFetcher(), c.website);
      if (!pages.length) {
        await db.aiDecision.create({ data: { ...record, inputHash: inputHash(COLLISION_FIT_KIND, COLLISION_FIT_PROMPT_VERSION, provider.model, { unreadable: c.website }), status: "error", error: "The website could not be read; no AI call was made." } });
        report.errors++;
        continue;
      }
      const input = judgeInput(c, run, c.website, pages);
      const hash = inputHash(COLLISION_FIT_KIND, COLLISION_FIT_PROMPT_VERSION, provider.model, input);
      const rule = ruleVerdict(c.businessName, pages);

      // Unchanged input: the earlier decision stands, recorded again for this research run without a provider call.
      const prior = await db.aiDecision.findFirst({ where: { ...base, subjectId: c.id, inputHash: hash, status: { in: ["valid", "invalid"] } }, orderBy: { createdAt: "desc" } });
      if (prior) {
        await db.aiDecision.create({
          data: {
            ...record, inputHash: hash, status: prior.status, decision: prior.decision, confidence: prior.confidence,
            evidence: prior.evidence ?? undefined, reasons: prior.reasons ?? undefined, concerns: prior.concerns ?? undefined, nextAction: prior.nextAction,
            validationErrors: prior.validationErrors ?? undefined, ruleDecision: rule, agreement: prior.status === "valid" ? agreementWithRule(prior.decision as CollisionDecision | null, rule) : "not_comparable",
            inputTokens: 0, outputTokens: 0, costMicroUsd: 0, latencyMs: 0,
          },
        });
        report.reused++;
        continue;
      }

      const user = collisionFitUserMessage(input);
      const worst = costMicroUsd(provider.model, estimateTokens(COLLISION_FIT_SYSTEM.length + user.length), SHADOW_MAX_TOKENS)!;
      if ((await spent()) + worst > budgetMicro) return finish("budget");

      report.calls++;
      const t0 = clock();
      try {
        const answer = await provider.complete({ system: COLLISION_FIT_SYSTEM, user, schema: COLLISION_FIT_SCHEMA, maxTokens: SHADOW_MAX_TOKENS });
        const latencyMs = clock() - t0;
        // Without usage figures, the worst case is charged so the budget can't be bypassed.
        const cost = answer.inputTokens !== null && answer.outputTokens !== null ? costMicroUsd(provider.model, answer.inputTokens, answer.outputTokens)! : worst;
        report.costMicroUsd += cost;
        const v = validateCollisionFit(answer.text, input);
        const a = v.ok ? v.answer : v.partial;
        await db.aiDecision.create({
          data: {
            ...record, inputHash: hash, status: v.ok ? "valid" : "invalid",
            decision: a.decision ?? null, confidence: a.confidence ?? null, evidence: a.evidence ?? [], reasons: a.reasons ?? [], concerns: a.concerns ?? [],
            nextAction: a.recommendedNextAction ?? null, validationErrors: v.ok ? undefined : v.errors,
            ruleDecision: rule, agreement: v.ok ? agreementWithRule(v.answer.decision, rule) : "not_comparable",
            inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, costMicroUsd: cost, latencyMs,
          },
        });
        if (v.ok) report.valid++;
        else report.invalid++;
      } catch (err) {
        const latencyMs = clock() - t0;
        const message = err instanceof AiProviderError ? `${err.failure}: ${err.message}` : "The provider call failed unexpectedly.";
        // A failed call may still have been billed: charge the worst case.
        report.costMicroUsd += worst;
        await db.aiDecision.create({ data: { ...record, inputHash: hash, status: "error", ruleDecision: rule, agreement: "not_comparable", costMicroUsd: worst, latencyMs, error: message.slice(0, 300) } });
        report.errors++;
      }
    }
    return finish("done");
  } finally {
    await lock.release();
  }
}

export function shadowSummary(r: ShadowReport): string {
  const why: Record<ShadowReport["outcome"], string> = {
    disabled: "off (AI_SHADOW_ENABLED is not 1); nothing done.",
    not_configured: "no AI provider configured (AI_PROVIDER, AI_API_KEY); nothing done.",
    no_price: "the configured model has no known price, so the budget can't be enforced; nothing done.",
    no_budget: "no daily budget (AI_SHADOW_DAILY_BUDGET); nothing done.",
    locked: "another shadow run holds the lock; nothing done.",
    done: "nothing left",
    limit: "batch limit reached",
    budget: "daily budget reached",
    time: "time budget reached",
    signal: "stopped by signal",
  };
  if (["disabled", "not_configured", "no_price", "no_budget", "locked"].includes(r.outcome)) return `AI shadow: ${why[r.outcome]}`;
  return (
    `AI shadow (shadow mode, nothing acted on): examined ${r.examined}; ${r.calls} provider call(s): ${r.valid} valid, ${r.invalid} invalid, ${r.errors} error(s); ` +
    `${r.reused} unchanged input(s) reused; est. cost $${(r.costMicroUsd / 1_000_000).toFixed(4)}; ${why[r.outcome]}; ${Math.round(r.elapsedMs / 1000)}s.`
  );
}
