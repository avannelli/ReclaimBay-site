/*
 * The provider smoke test (`npm run ai:smoke -- --candidate <id>`): one real
 * call for one candidate, to prove the provider integration works (the key,
 * the model, structured output, parsing, validation). It records NOTHING:
 * no AiDecision, so a smoke answer can never become a gold-set evaluation
 * answer, and no other write of any kind. Its database handle can read one
 * candidate and sum recent AI spend, and nothing else.
 *
 * It builds exactly the shadow judge's input (judgeInput, readPages), calls
 * the same provider adapter once with no retry, and applies the same
 * validator. It runs only when explicitly armed (AI_SMOKE_ENABLED=1) and
 * configured, never on a schedule, and refuses any call whose worst-case
 * cost could exceed a fixed ceiling or the configured daily budget.
 */
import type { Db } from "../db.js";
import type { PoliteFetcher } from "@avannelli/aos/fetch";
import { COLLISION_FIT_SCHEMA, COLLISION_FIT_SYSTEM, collisionFitUserMessage, validateCollisionFit } from "./collisionFitJudge.js";
import { AiProviderError, costMicroUsd, type AiProvider } from "./provider.js";
import { CANDIDATE_SELECT, SHADOW_MAX_TOKENS, estimateTokens, judgeInput, readPages } from "./shadow.js";

/** The hard ceiling for the one smoke call's worst-case cost: $0.25. Not configurable. */
export const SMOKE_MAX_CALL_MICRO_USD = 250_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything the smoke test may do to the database: read one candidate, and sum recent AI spend. */
export interface SmokeDb {
  discoveryCandidate: Pick<Db["discoveryCandidate"], "findUnique">;
  aiDecision: Pick<Db["aiDecision"], "aggregate">;
}

/** The command line: exactly one `--candidate <uuid>`, nothing else. */
export function parseSmokeArgs(argv: readonly string[]): { candidateId: string } | { error: string } {
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--candidate" && i + 1 < argv.length) ids.push(argv[++i]!);
    else if (a.startsWith("--candidate=")) ids.push(a.slice("--candidate=".length));
    else return { error: `Unexpected argument "${a.slice(0, 40)}". Usage: npm run ai:smoke -- --candidate <id>` };
  }
  if (ids.length !== 1) return { error: "Give exactly one --candidate <id>." };
  if (!UUID_RE.test(ids[0]!)) return { error: "The candidate id must be a UUID." };
  return { candidateId: ids[0]! };
}

/** The worst-case cost of the call, and whether the fixed ceiling refuses it. */
export function smokeCeiling(model: string, promptChars: number): { worstMicroUsd: number | null; allowed: boolean } {
  const worst = costMicroUsd(model, estimateTokens(promptChars), SHADOW_MAX_TOKENS);
  return { worstMicroUsd: worst, allowed: worst !== null && worst <= SMOKE_MAX_CALL_MICRO_USD };
}

export interface SmokeReport {
  outcome:
    | "disabled" | "not_configured" | "no_price" | "no_budget" | "invalid_candidate" | "not_found" | "not_judgeable" | "unreadable"
    | "over_ceiling" | "budget" | "provider_error" | "invalid" | "valid";
  candidateId: string;
  provider: string | null;
  model: string | null;
  /** The provider call: none, ok, or the failure kind. */
  call: "none" | "ok" | string;
  decision: string | null;
  confidence: number | null;
  validationErrors: string[];
  evidenceItems: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Estimated: from usage when returned, else the worst case. */
  costMicroUsd: number | null;
  worstMicroUsd: number | null;
  latencyMs: number | null;
  /** Always false: the smoke test never writes. */
  databaseWrite: false;
  message: string;
}

export interface SmokeOptions {
  enabled: boolean;
  provider: AiProvider | null;
  dailyBudgetUsd: number;
  candidateId: string;
  makeFetcher: () => PoliteFetcher;
  clock?: () => number;
  now?: () => Date;
}

export async function runAiSmoke(db: SmokeDb, o: SmokeOptions): Promise<SmokeReport> {
  const clock = o.clock ?? Date.now;
  const now = o.now ?? (() => new Date());
  const r: SmokeReport = {
    outcome: "valid", candidateId: o.candidateId, provider: o.provider?.name ?? null, model: o.provider?.model ?? null, call: "none",
    decision: null, confidence: null, validationErrors: [], evidenceItems: 0, inputTokens: null, outputTokens: null, costMicroUsd: null, worstMicroUsd: null, latencyMs: null,
    databaseWrite: false, message: "",
  };
  const stop = (outcome: SmokeReport["outcome"], message: string): SmokeReport => ({ ...r, outcome, message });
  if (!o.enabled) return stop("disabled", "AI_SMOKE_ENABLED is not 1; nothing done.");
  const provider = o.provider;
  if (!provider) return stop("not_configured", "No AI provider configured (AI_PROVIDER, AI_API_KEY); nothing done.");
  if (costMicroUsd(provider.model, 0, 0) === null) return stop("no_price", "The configured model has no known price, so the cost can't be bounded; nothing done.");
  const budgetMicro = Math.floor(o.dailyBudgetUsd * 1_000_000);
  if (budgetMicro <= 0) return stop("no_budget", "No daily budget (AI_SHADOW_DAILY_BUDGET); nothing done.");
  if (!UUID_RE.test(o.candidateId)) return stop("invalid_candidate", "The candidate id must be a UUID; nothing done.");

  const c = await db.discoveryCandidate.findUnique({ where: { id: o.candidateId }, select: CANDIDATE_SELECT });
  if (!c) return stop("not_found", "No such candidate; nothing done.");
  const run = c.research[0];
  if (!run || run.status !== "completed" || run.outcome !== "website_verified" || !c.website) {
    return stop("not_judgeable", "The candidate needs a website its latest completed research verified; nothing done.");
  }
  const pages = await readPages(o.makeFetcher(), c.website);
  if (!pages.length) return stop("unreadable", "The website could not be read; no AI call was made.");
  const input = judgeInput(c, run, c.website, pages);
  const user = collisionFitUserMessage(input);
  const ceiling = smokeCeiling(provider.model, COLLISION_FIT_SYSTEM.length + user.length);
  r.worstMicroUsd = ceiling.worstMicroUsd;
  if (!ceiling.allowed) return stop("over_ceiling", "The call's worst-case cost exceeds the $0.25 smoke ceiling; no AI call was made.");
  const spent = (await db.aiDecision.aggregate({ where: { createdAt: { gte: new Date(now().getTime() - DAY_MS) } }, _sum: { costMicroUsd: true } }))._sum.costMicroUsd ?? 0;
  if (spent + ceiling.worstMicroUsd! > budgetMicro) return stop("budget", "The call's worst case would exceed the daily AI budget; no AI call was made.");

  // Exactly one call. No retry, whatever happens.
  const t0 = clock();
  try {
    const answer = await provider.complete({ system: COLLISION_FIT_SYSTEM, user, schema: COLLISION_FIT_SCHEMA, maxTokens: SHADOW_MAX_TOKENS });
    r.latencyMs = clock() - t0;
    r.call = "ok";
    r.model = answer.model;
    r.inputTokens = answer.inputTokens;
    r.outputTokens = answer.outputTokens;
    r.costMicroUsd = answer.inputTokens !== null && answer.outputTokens !== null ? costMicroUsd(provider.model, answer.inputTokens, answer.outputTokens) : ceiling.worstMicroUsd;
    const v = validateCollisionFit(answer.text, input);
    const a = v.ok ? v.answer : v.partial;
    r.decision = a.decision ?? null;
    r.confidence = a.confidence ?? null;
    r.evidenceItems = a.evidence?.length ?? 0;
    if (!v.ok) {
      r.validationErrors = v.errors;
      return stop("invalid", "The provider answered, but the answer failed deterministic validation: unusable.");
    }
    return stop("valid", "The provider answered and the answer passed deterministic validation.");
  } catch (err) {
    r.latencyMs = clock() - t0;
    r.costMicroUsd = ceiling.worstMicroUsd;
    r.call = err instanceof AiProviderError ? err.failure : "unexpected";
    return stop("provider_error", err instanceof AiProviderError ? err.message : "The provider call failed unexpectedly.");
  }
}

/** The printed summary: no secrets, no website text. The last line states the write guarantee. */
export function smokeSummary(r: SmokeReport): string {
  const usd = (m: number | null) => (m === null ? "unknown" : `$${(m / 1_000_000).toFixed(4)}`);
  return [
    `AI smoke test: ${r.outcome} (${r.message})`,
    `  candidate: ${r.candidateId}`,
    `  provider: ${r.provider ?? "none"}; model: ${r.model ?? "none"}`,
    `  provider call: ${r.call}`,
    `  decision: ${r.decision ?? "none"}; confidence: ${r.confidence ?? "none"}; evidence items: ${r.evidenceItems}`,
    `  validation: ${r.outcome === "valid" ? "PASS" : r.validationErrors.length ? "FAIL" : "not reached"}${r.validationErrors.length ? `\n${r.validationErrors.map((e) => `    - ${e}`).join("\n")}` : ""}`,
    `  tokens: input ${r.inputTokens ?? "unknown"}, output ${r.outputTokens ?? "unknown"}`,
    `  estimated cost: ${usd(r.costMicroUsd)} (worst case ${usd(r.worstMicroUsd)}, ceiling ${usd(SMOKE_MAX_CALL_MICRO_USD)})`,
    `  latency: ${r.latencyMs === null ? "none" : `${r.latencyMs} ms`}`,
    `  database write: no`,
    "SMOKE TEST: NO DATABASE WRITE",
  ].join("\n");
}
