/*
 * Research runs: queueing, processing, and folding the results into the
 * candidate's EXISTING signals, evidence, and contact, so the existing
 * qualification and opportunity score (src/scoring.ts) consume them
 * unchanged.
 *
 * Rules:
 *   - Research only ever replaces its own signals and evidence (origin
 *     "research"). A person's signals and evidence are never changed; when
 *     research disagrees with a person, it says so in a warning.
 *   - Contact (phone, email) is set only from the business's own, verified
 *     website, and only when none is stored yet. It is never removed.
 *   - A run never approves anything or creates a prospect itself. After a
 *     completed run, the automatic-approval rule (discovery/autoApproval.ts)
 *     decides separately whether the candidate is a clean enough lead to
 *     become a Prospect without a click; anything less waits for a person.
 *   - Re-running is safe: each run replaces the previous run's research
 *     signals and evidence instead of adding to them. Runs are kept as
 *     history (the newest RESEARCH_HISTORY per candidate).
 *   - One queued or running run per candidate at a time.
 *   - Failures are recorded on the run; nothing retries in a loop.
 */
import type { Db } from "../db.js";
import { researchGateErrors } from "../discovery/approval.js";
import { autoApproveCandidate } from "../discovery/service.js";
import { CATEGORY_VERDICT_LABELS, automatedMayReplace, categoryFields, isOutsideTarget } from "../discovery/categoryCheck.js";
import { phoneKey } from "../discovery/normalize.js";
import type { Prisma } from "../generated/prisma/client.js";
import { isPhoneNumber, parseProspectInput } from "../prospects.js";
import { PoliteFetcher } from "./fetcher.js";
import { RESEARCH_VERSION, researchCandidate, type ResearchResult } from "./researcher.js";

/** Runs kept per candidate. */
export const RESEARCH_HISTORY = 5;
/** A run still "running" after this long lost its worker. */
export const STALE_RESEARCH_MS = 10 * 60 * 1000;
/** Candidates one admin batch may queue. */
export const MAX_BATCH = 10;
/** Pause between two candidates in a batch (different sites; politeness only). */
export const BETWEEN_CANDIDATES_MS = 1_000;

export type ResearchTrigger = "admin" | "batch" | "cli";

const NOT_RESEARCHABLE = new Set(["approved", "rejected", "duplicate"]);

export interface EnqueueResult {
  queued: { candidateId: string; researchId: string }[];
  skipped: { candidateId: string; reason: string }[];
}

/** Queues research for each candidate that can be researched and has nothing queued. */
export async function enqueueResearch(db: Db, candidateIds: readonly string[], trigger: ResearchTrigger, max = MAX_BATCH): Promise<EnqueueResult> {
  const out: EnqueueResult = { queued: [], skipped: [] };
  for (const candidateId of [...new Set(candidateIds)].slice(0, max)) {
    await db.$transaction(async (tx) => {
      const c = await tx.discoveryCandidate.findUnique({ where: { id: candidateId }, select: { status: true } });
      if (!c) return void out.skipped.push({ candidateId, reason: "not found" });
      if (NOT_RESEARCHABLE.has(c.status)) return void out.skipped.push({ candidateId, reason: `candidate is ${c.status}` });
      const pending = await tx.candidateResearch.findFirst({ where: { candidateId, status: { in: ["queued", "running"] } }, select: { id: true } });
      if (pending) return void out.skipped.push({ candidateId, reason: "research already queued or running" });
      const run = await tx.candidateResearch.create({ data: { candidateId, version: RESEARCH_VERSION, trigger } });
      out.queued.push({ candidateId, researchId: run.id });
    });
  }
  return out;
}

export interface ProcessDeps {
  /** A fresh fetcher per run (tests inject one that never touches the network). */
  makeFetcher?: () => PoliteFetcher;
  /** Apply the automatic-approval rule after a completed run (default true). */
  autoApprove?: boolean;
  today?: Date;
  sleep?: (ms: number) => Promise<void>;
}

const redact = (m: string) => m.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);

/**
 * Runs one queued research run. Returns null when it wasn't queued (already
 * claimed by another worker, or finished).
 */
export async function processResearch(db: Db, researchId: string, deps: ProcessDeps = {}) {
  const now = new Date();
  const claimed = await db.candidateResearch.updateMany({
    where: { id: researchId, status: "queued" },
    data: { status: "running", startedAt: now, heartbeatAt: now },
  });
  if (claimed.count !== 1) return null;
  const run = await db.candidateResearch.findUniqueOrThrow({ where: { id: researchId } });
  const c = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: run.candidateId } });

  if (NOT_RESEARCHABLE.has(c.status)) {
    return db.candidateResearch.update({
      where: { id: researchId },
      data: { status: "failed", error: `The candidate became ${c.status} before research ran.`, finishedAt: new Date() },
    });
  }
  // Show that research is under way.
  const movedToResearching = c.status === "discovered";
  if (movedToResearching) {
    await db.discoveryCandidate.update({ where: { id: c.id }, data: { status: "researching", statusChangedAt: now } });
  }

  let stored;
  try {
    const fetcher = deps.makeFetcher?.() ?? new PoliteFetcher();
    const result = await researchCandidate(
      {
        businessName: c.businessName,
        website: c.website,
        streetAddress: c.streetAddress,
        city: c.city,
        state: c.state,
        postalCode: c.postalCode,
        providerPhone: c.providerPhone,
        providerBrand: c.providerBrand,
        providerStatus: c.providerStatus,
        provider: c.provider,
      },
      fetcher,
      deps.today ?? new Date(),
    );
    stored = await store(db, researchId, c.id, result, movedToResearching);
  } catch (err) {
    if (movedToResearching) await db.discoveryCandidate.update({ where: { id: c.id }, data: { status: "discovered", statusChangedAt: new Date() } });
    return db.candidateResearch.update({
      where: { id: researchId },
      data: { status: "failed", error: redact(`Research error: ${err instanceof Error ? err.message : "unknown"}`), finishedAt: new Date() },
    });
  }
  // Separate from the run: the run is stored whatever the approval decides.
  if (deps.autoApprove !== false && stored.status === "completed") await autoApproveCandidate(db, c.id);
  return stored;
}

type Tx = Prisma.TransactionClient;

async function store(db: Db, researchId: string, candidateId: string, r: ResearchResult, movedToResearching: boolean) {
  return db.$transaction(async (tx) => {
    // Sources first, so facts can point at them.
    const sourceIds = new Map<string, string>();
    for (const s of r.sources) {
      const row = await tx.researchSource.create({ data: { researchId, ...s } });
      if (s.kind === "website" && s.ok) {
        sourceIds.set(s.url, row.id);
        if (s.finalUrl) sourceIds.set(s.finalUrl, row.id);
      }
    }
    for (const f of r.facts) {
      await tx.researchFact.create({
        data: {
          researchId,
          field: f.field.slice(0, 40),
          value: f.value?.slice(0, 500) ?? null,
          state: f.state,
          confidence: f.confidence ?? null,
          sourceId: f.sourceUrl ? (sourceIds.get(f.sourceUrl) ?? null) : null,
          excerpt: f.excerpt?.slice(0, 280) ?? null,
          note: f.note?.slice(0, 300) ?? null,
        },
      });
    }

    const warnings = [...r.warnings];
    let applied = 0;
    const c = await tx.discoveryCandidate.findUniqueOrThrow({ where: { id: candidateId }, include: { signals: true } });

    let categoryNote = "";
    if (r.status === "completed") {
      applied = await reconcileSignals(tx, researchId, c, r, warnings);
      await applyContact(tx, c, r, warnings);
      categoryNote = await applyCategory(tx, c, r, warnings);
    }

    // The candidate's place in the lifecycle follows the evidence-backed rule.
    const after = await tx.discoveryCandidate.findUniqueOrThrow({ where: { id: candidateId }, include: { signals: true, evidence: true } });
    const gateOk = researchGateErrors(after.signals, after.evidence).length === 0;
    let status = after.status;
    if (after.status === "researching") status = r.status === "completed" && gateOk ? "researched" : movedToResearching ? "discovered" : "researching";
    else if (after.status === "researched" && !gateOk) status = "researching";
    const now = new Date();
    await tx.discoveryCandidate.update({
      where: { id: candidateId },
      data: {
        ...(status !== after.status ? { status, statusChangedAt: now } : {}),
        ...(status === "researched" && after.status !== "researched" ? { researchedAt: now } : {}),
        ...(r.status === "completed" ? { websiteVerifiedAt: r.websiteVerified ? now : null } : {}),
      },
    });
    await tx.candidateNote.create({
      data: {
        candidateId,
        body: `Automated research (${RESEARCH_VERSION}): ${r.outcome.replace(/_/g, " ")}. ${applied} signal(s) recorded with evidence${r.contact.phone && !c.phone ? `; phone verified at ${r.contact.phoneSourceUrl}` : ""}${r.contact.email && !c.email ? `; email verified at ${r.contact.emailSourceUrl}` : ""}.${categoryNote}`.slice(0, 2000),
      },
    });

    const run = await tx.candidateResearch.update({
      where: { id: researchId },
      data: {
        status: r.status,
        outcome: r.outcome,
        error: r.error ? redact(r.error) : null,
        warnings,
        pagesFetched: r.pagesFetched,
        heartbeatAt: now,
        finishedAt: now,
      },
    });
    await pruneHistory(tx, candidateId);
    return run;
  });
}

/**
 * Replaces the previous research signals and evidence with this run's. A
 * signal a person recorded is never changed. Returns how many were applied.
 */
async function reconcileSignals(
  tx: Tx,
  researchId: string,
  c: { id: string; signals: { id: string; key: string; value: string; origin: string }[] },
  r: ResearchResult,
  warnings: string[],
) {
  await tx.candidateEvidence.deleteMany({ where: { candidateId: c.id, origin: "research" } });
  const proposed = new Map(r.signals.map((s) => [s.key, s]));
  const stale = c.signals.filter((s) => s.origin === "research" && !proposed.has(s.key as never)).map((s) => s.id);
  if (stale.length) await tx.candidateSignal.deleteMany({ where: { id: { in: stale } } });

  const now = new Date();
  let applied = 0;
  for (const s of r.signals) {
    const existing = c.signals.find((x) => x.key === s.key);
    if (existing && existing.origin === "manual") {
      if (existing.value !== s.value) warnings.push(`Research found "${s.key}" = ${s.value}, but a person recorded ${existing.value}; the person's value was kept.`);
      continue;
    }
    await tx.candidateSignal.upsert({
      where: { candidateId_key: { candidateId: c.id, key: s.key } },
      create: { candidateId: c.id, key: s.key, value: s.value, observedAt: now, origin: "research" },
      update: { value: s.value, observedAt: now, origin: "research" },
    });
    await tx.candidateEvidence.create({
      data: { candidateId: c.id, signalKey: s.key, sourceUrl: s.sourceUrl.slice(0, 500), excerpt: s.excerpt.slice(0, 280), origin: "research", researchId },
    });
    applied++;
  }
  return applied;
}

/**
 * The website's category result, where an automated result may replace the
 * stored one: never a person's decision (that disagreement becomes a
 * warning), never positive name evidence of wrong category with "unclear".
 * Returns a sentence for the run's note.
 */
async function applyCategory(
  tx: Tx,
  c: { id: string; categoryVerdict: string | null; categorySource: string | null },
  r: ResearchResult,
  warnings: string[],
): Promise<string> {
  const next = r.category;
  if (!next) return "";
  const current = { verdict: c.categoryVerdict as never, source: c.categorySource as never };
  if (!automatedMayReplace(current, next)) {
    if (c.categorySource === "manual" && c.categoryVerdict !== next.verdict) {
      warnings.push(`The website suggests "${CATEGORY_VERDICT_LABELS[next.verdict]}" (${next.reason}), but a person set the category; the person's decision was kept.`);
    }
    return "";
  }
  await tx.discoveryCandidate.update({ where: { id: c.id }, data: categoryFields(next, new Date()) });
  return ` Category check: ${CATEGORY_VERDICT_LABELS[next.verdict]} (from the website).`;
}

/** Verified contact from the business's own website, only where none is stored. */
async function applyContact(
  tx: Tx,
  c: { id: string; phone: string | null; email: string | null; providerPhone: string | null; businessName: string },
  r: ResearchResult,
  warnings: string[],
) {
  const data: Prisma.DiscoveryCandidateUpdateInput = {};
  const { phone, phoneSourceUrl, email, emailSourceUrl } = r.contact;
  if (phone && phoneSourceUrl && !c.phone && isPhoneNumber(phone)) {
    data.phone = phone;
    data.phoneSourceUrl = phoneSourceUrl;
    data.phoneKey = phoneKey(phone) ?? phoneKey(c.providerPhone);
  } else if (phone && c.phone && phoneKey(phone) !== phoneKey(c.phone)) {
    warnings.push(`The website lists ${phone}; the stored phone ${c.phone} was kept.`);
  }
  if (email && emailSourceUrl && !c.email) {
    const { errors } = parseProspectInput({ businessName: c.businessName, email, emailSourceUrl });
    if (!errors.length) {
      data.email = email;
      data.emailSourceUrl = emailSourceUrl;
    }
  }
  if (Object.keys(data).length) await tx.discoveryCandidate.update({ where: { id: c.id }, data });
}

async function pruneHistory(tx: Tx, candidateId: string) {
  const old = await tx.candidateResearch.findMany({
    where: { candidateId, status: { in: ["completed", "failed"] } },
    orderBy: { queuedAt: "desc" },
    skip: RESEARCH_HISTORY,
    select: { id: true },
  });
  if (old.length) await tx.candidateResearch.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
}

/** Marks runs whose worker stopped responding as failed. They are not retried automatically. */
export async function failStaleResearch(db: Db, staleAfterMs = STALE_RESEARCH_MS) {
  const { count } = await db.candidateResearch.updateMany({
    where: { status: "running", heartbeatAt: { lt: new Date(Date.now() - staleAfterMs) } },
    data: { status: "failed", error: "Interrupted: the research stopped before it finished. Run it again.", finishedAt: new Date() },
  });
  return count;
}

let working: Promise<unknown> | null = null;

/** Resolves once the in-process research worker has nothing left to do (tests, graceful shutdown). */
export async function researchIdle() {
  await new Promise((r) => setImmediate(r));
  while (working) await working.catch(() => undefined);
}

/**
 * Processes queued runs one at a time, oldest first, up to `limit`. Only one
 * loop runs per process; a second call while one is running returns at once
 * (the running loop picks up newly queued runs).
 */
export async function processQueuedResearch(db: Db, opts: ProcessDeps & { limit?: number } = {}) {
  if (working) return { reclaimed: 0, processed: [] as Awaited<ReturnType<typeof processResearch>>[] };
  const task = runQueue(db, opts);
  working = task;
  try {
    return await task;
  } finally {
    working = null;
  }
}

async function runQueue(db: Db, opts: ProcessDeps & { limit?: number }) {
  const reclaimed = await failStaleResearch(db);
  const processed = [];
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (opts.limit ?? 25); i++) {
    const next = await db.candidateResearch.findFirst({ where: { status: "queued" }, orderBy: { queuedAt: "asc" }, select: { id: true } });
    if (!next) break;
    if (i > 0) await sleep(BETWEEN_CANDIDATES_MS);
    const run = await processResearch(db, next.id, opts);
    if (run) processed.push(run);
  }
  return { reclaimed, processed };
}

/** Research for the candidate page: the newest runs, with the latest run's sources and facts. */
export async function candidateResearch(db: Db, candidateId: string) {
  const runs = await db.candidateResearch.findMany({
    where: { candidateId },
    orderBy: { queuedAt: "desc" },
    take: RESEARCH_HISTORY,
    include: { sources: { orderBy: { fetchedAt: "asc" } }, facts: { include: { source: { select: { url: true, finalUrl: true } } } } },
  });
  const latest = runs.find((r) => r.status === "completed" || r.status === "failed") ?? null;
  const pending = runs.find((r) => r.status === "queued" || r.status === "running") ?? null;
  return { runs, latest, pending };
}

/** Queue and recent outcome counts for the Discovery overview. */
export async function researchQueue(db: Db) {
  const [queued, running, failed, completed] = await Promise.all([
    db.candidateResearch.count({ where: { status: "queued" } }),
    db.candidateResearch.count({ where: { status: "running" } }),
    db.candidateResearch.count({ where: { status: "failed" } }),
    db.candidateResearch.count({ where: { status: "completed" } }),
  ]);
  return { queued, running, failed, completed };
}

/** Candidates in a list that research could run on (for the batch action). */
/**
 * Candidates an AUTOMATIC selection (the admin's "research up to 10", the
 * CLI's --limit) may research: never researched, still researchable, and not
 * outside the target category. Explicit requests for one candidate don't use
 * this, so a person can still research anything.
 */
export const autoResearchIds = (
  rows: { candidate: { id: string; status: string; categoryVerdict: string | null; research: readonly unknown[] } }[],
  max = MAX_BATCH,
) =>
  rows
    .filter((r) => !r.candidate.research.length && !NOT_RESEARCHABLE.has(r.candidate.status) && !isOutsideTarget(r.candidate))
    .slice(0, max)
    .map((r) => r.candidate.id);

