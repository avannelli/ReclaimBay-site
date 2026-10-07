/*
 * Blind gold sets for evaluating an AI decision kind (collision/body fit).
 *
 *   cohort    a frozen, reproducible sample of candidates (AiEvalCohort,
 *             AiEvalCase), chosen from candidate and research state only,
 *             never from AI output
 *   label     a person's answer (AiLabel), given blind: revision 1 is
 *             accepted only before any label exists for the case; a later
 *             revision is an adjudication after review, with a reason
 *
 * The labeling side never sees AI output: its database handle (GoldDb) has no
 * access to the AI's recorded decisions at all, and the labeling view shows only the evidence
 * a person verifying collision/body fit legitimately uses: the business, its
 * website, the pages research read, and research's quoted excerpts, never a
 * verdict (no signal values, qualification, status, decision reasons, notes,
 * a person's evidence, or the case's stratum).
 *
 * Nothing here changes a candidate, prospect, or anything in outreach.
 */
import { createHash } from "node:crypto";
import type { Db } from "../db.js";

export const GOLD_KIND = "collision_fit";
/** Bumped whenever the strata or their rules change: a cohort records the version that chose it. */
export const SAMPLING_VERSION = "stratified@s1";

/** The human label taxonomy: the same five answers the AI gives, worded for a person. */
export const HUMAN_LABELS = {
  collision_primary: "Performs collision or auto body repair",
  specialty_body: "A body specialty only (dent, paint or refinishing, frame or structural)",
  dealership_body_dept: "A dealership with its own body shop or collision department",
  not_collision: "Does not perform collision or body repair",
  insufficient_evidence: "Can't tell from the evidence",
} as const;
export type HumanLabel = keyof typeof HUMAN_LABELS;
export const isHumanLabel = (v: unknown): v is HumanLabel => typeof v === "string" && v in HUMAN_LABELS;

export class AiEvalError extends Error {
  constructor(readonly messages: string[], readonly kind: "invalid" | "conflict" | "not_found" = "invalid") {
    super(messages.join(" "));
    this.name = "AiEvalError";
  }
}

/** Everything the gold-set code may touch. Nothing of the AI's: the labeling side can't read AI output. */
export interface GoldDb {
  discoveryCandidate: Pick<Db["discoveryCandidate"], "findMany" | "findUnique">;
  aiEvalCohort: Pick<Db["aiEvalCohort"], "create" | "findUnique" | "findMany">;
  aiEvalCase: Pick<Db["aiEvalCase"], "findUnique" | "findFirst" | "findMany">;
  aiLabel: Pick<Db["aiLabel"], "create" | "findFirst" | "findMany">;
}

// ---------- sampling ----------

export const STRATA = ["verify", "specialty_or_uncertain", "auto_approved", "auto_rejected", "person_decided"] as const;
export type Stratum = (typeof STRATA)[number] | "manual";
export const STRATUM_LABELS: Record<Stratum, string> = {
  verify: "Left for a person to verify",
  specialty_or_uncertain: "Dealership, specialty, or contradictory",
  auto_approved: "Approved automatically",
  auto_rejected: "Rejected automatically",
  person_decided: "A person recorded collision/body fit",
  manual: "Chosen explicitly",
};
/** The default quotas: 150 cases, most where the rules defer to a person, some from each automatic outcome. */
export const DEFAULT_QUOTAS: Record<(typeof STRATA)[number], number> = { verify: 60, specialty_or_uncertain: 25, auto_approved: 30, auto_rejected: 20, person_decided: 15 };

/** discovery/autoApproval.ts writes these prefixes into decisionReason (a unit test keeps them in step). */
export const AUTO_APPROVED_REASON = "Automatically approved";
export const AUTO_REJECTED_REASON = "Automatically rejected";
const UNCERTAIN_WARNING = /dealership\/specialty|Dealership or specialty|Collision\/body evidence is contradictory/i;

export interface SampleFacts {
  status: string;
  decisionReason: string | null;
  manualCollision: boolean;
  anyCollisionSignal: boolean;
  warnings: unknown;
}

/** Each candidate's stratum, in precedence order: from its record and research, never from AI output. */
export function stratumOf(f: SampleFacts): (typeof STRATA)[number] | null {
  if (f.manualCollision) return "person_decided";
  const warnings = Array.isArray(f.warnings) ? f.warnings.filter((w): w is string => typeof w === "string") : [];
  if (f.status !== "duplicate" && warnings.some((w) => UNCERTAIN_WARNING.test(w))) return "specialty_or_uncertain";
  if (f.status === "approved" && f.decisionReason?.startsWith(AUTO_APPROVED_REASON)) return "auto_approved";
  if (f.status === "rejected" && f.decisionReason?.startsWith(AUTO_REJECTED_REASON)) return "auto_rejected";
  if ((f.status === "researched" || f.status === "needs_review") && !f.anyCollisionSignal) return "verify";
  return null;
}

/** A seeded order: the same seed and candidates always give the same order. */
const seeded = (seed: string, salt: string, id: string) => createHash("sha256").update(`${seed}\n${salt}\n${id}`).digest("hex");

export interface CohortPlan {
  strata: Record<string, { quota: number; available: number; chosen: number }>;
  picks: { candidateId: string; stratum: Stratum }[];
}

/**
 * Which candidates a cohort would hold, without writing anything. Eligible:
 * a website research confirmed as the business's own, and a completed
 * research run that read it (so the AI can be asked about it too). Within
 * each stratum, the seeded order decides; a stratum short of its quota is
 * reported, never filled from another.
 */
export async function planCohort(db: GoldDb, opts: { seed: string; quotas?: Partial<Record<(typeof STRATA)[number], number>>; candidateIds?: readonly string[] }): Promise<CohortPlan> {
  const seed = opts.seed.trim();
  if (!seed || seed.length > 80) throw new AiEvalError(["A seed of 1 to 80 characters is required."]);
  if (opts.candidateIds) {
    const ids = [...new Set(opts.candidateIds)];
    if (!ids.length || ids.length > 500) throw new AiEvalError(["Give 1 to 500 candidate ids."]);
    const found = await db.discoveryCandidate.findMany({ where: { id: { in: ids } }, select: { id: true } });
    if (found.length !== ids.length) throw new AiEvalError([`${ids.length - found.length} of the given candidate ids don't exist.`]);
    return { strata: { manual: { quota: ids.length, available: ids.length, chosen: ids.length } }, picks: ids.map((candidateId) => ({ candidateId, stratum: "manual" as const })) };
  }
  const quotas = { ...DEFAULT_QUOTAS, ...opts.quotas };
  const rows = await db.discoveryCandidate.findMany({
    where: { website: { not: null }, websiteVerifiedAt: { not: null }, status: { not: "duplicate" } },
    select: {
      id: true,
      status: true,
      decisionReason: true,
      signals: { where: { key: "collision_repair_services" }, select: { origin: true, value: true } },
      research: { orderBy: { queuedAt: "desc" }, take: 1, select: { status: true, outcome: true, warnings: true } },
    },
  });
  const by = new Map<string, string[]>(STRATA.map((s) => [s, []]));
  for (const r of rows) {
    const run = r.research[0];
    if (!run || run.status !== "completed" || run.outcome !== "website_verified") continue;
    const s = stratumOf({
      status: r.status,
      decisionReason: r.decisionReason,
      manualCollision: r.signals.some((x) => x.origin === "manual" && (x.value === "yes" || x.value === "no")),
      anyCollisionSignal: r.signals.length > 0,
      warnings: run.warnings,
    });
    if (s) by.get(s)!.push(r.id);
  }
  const plan: CohortPlan = { strata: {}, picks: [] };
  for (const s of STRATA) {
    const quota = Math.max(0, Math.floor(quotas[s] ?? 0));
    const pool = by.get(s)!.sort((a, b) => seeded(seed, s, a).localeCompare(seeded(seed, s, b)));
    const chosen = pool.slice(0, quota);
    plan.strata[s] = { quota, available: pool.length, chosen: chosen.length };
    plan.picks.push(...chosen.map((candidateId) => ({ candidateId, stratum: s })));
  }
  return plan;
}

/** Creates a frozen cohort from a plan. Its cases are never added, removed, or reordered afterwards. */
export async function createCohort(db: GoldDb, opts: { name: string; seed: string; quotas?: Partial<Record<(typeof STRATA)[number], number>>; candidateIds?: readonly string[] }) {
  const name = opts.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new AiEvalError(["A cohort name of 1 to 80 characters is required."]);
  if (await db.aiEvalCohort.findUnique({ where: { name }, select: { id: true } })) throw new AiEvalError([`A cohort named "${name}" already exists. Cohorts are never changed; choose a new name.`], "conflict");
  const plan = await planCohort(db, opts);
  if (!plan.picks.length) throw new AiEvalError(["No eligible candidates: nothing to label."]);
  // Strata are interleaved for labeling: a seeded shuffle across the whole cohort.
  const ordered = [...plan.picks].sort((a, b) => seeded(opts.seed.trim(), "order", a.candidateId).localeCompare(seeded(opts.seed.trim(), "order", b.candidateId)));
  try {
    return await db.aiEvalCohort.create({
      data: {
        name,
        kind: GOLD_KIND,
        samplingVersion: opts.candidateIds ? "manual" : SAMPLING_VERSION,
        seed: opts.seed.trim(),
        strata: plan.strata,
        cases: { create: ordered.map((p, i) => ({ candidateId: p.candidateId, stratum: p.stratum, position: i + 1 })) },
      },
      include: { _count: { select: { cases: true } } },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new AiEvalError([`A cohort named "${name}" already exists.`], "conflict");
    throw err;
  }
}

// ---------- labels ----------

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "") || null;

/** The blind label: revision 1, accepted only while the case has no label at all. */
export async function blindLabel(db: GoldDb, caseId: string, raw: { label?: unknown; note?: unknown; labeledBy?: unknown }) {
  if (!isHumanLabel(raw.label)) throw new AiEvalError(["Choose one of the answers."]);
  const c = await db.aiEvalCase.findUnique({ where: { id: caseId }, select: { id: true, candidateId: true } });
  if (!c) throw new AiEvalError(["Case not found."], "not_found");
  if (await db.aiLabel.findFirst({ where: { caseId }, select: { id: true } })) {
    throw new AiEvalError(["This case already has its blind label. A change after review is an adjudication, with a reason."], "conflict");
  }
  try {
    return await db.aiLabel.create({ data: { caseId, candidateId: c.candidateId, revision: 1, source: "blind", label: raw.label, note: clean(raw.note, 500), labeledBy: clean(raw.labeledBy, 80) } });
  } catch (err) {
    // Two submissions at once: the unique (case, revision) lets one through.
    if ((err as { code?: string }).code === "P2002") throw new AiEvalError(["This case was labeled meanwhile."], "conflict");
    throw err;
  }
}

/** An adjudication after review: a new revision with its reason. The blind label stays, and stays the gold label. */
export async function adjudicateLabel(db: GoldDb, caseId: string, raw: { label?: unknown; note?: unknown; labeledBy?: unknown }) {
  if (!isHumanLabel(raw.label)) throw new AiEvalError(["Choose one of the answers."]);
  const note = clean(raw.note, 500);
  if (!note) throw new AiEvalError(["An adjudication needs a reason."]);
  const c = await db.aiEvalCase.findUnique({ where: { id: caseId }, select: { candidateId: true } });
  if (!c) throw new AiEvalError(["Case not found."], "not_found");
  const latest = await db.aiLabel.findFirst({ where: { caseId }, orderBy: { revision: "desc" }, select: { revision: true } });
  if (!latest) throw new AiEvalError(["A case is labeled blind first; adjudication comes after."], "conflict");
  try {
    return await db.aiLabel.create({ data: { caseId, candidateId: c.candidateId, revision: latest.revision + 1, source: "adjudicated", label: raw.label, note, labeledBy: clean(raw.labeledBy, 80) } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new AiEvalError(["This case changed meanwhile. Reload and try again."], "conflict");
    throw err;
  }
}

// ---------- what the labeler sees ----------

/** Research warnings that reveal a decision (a person's recorded value, an automatic decision) are not evidence. */
const DECISION_WARNING = /\bbut a person (?:recorded|set)\b|\bAutomatically (?:approved|rejected)\b/i;

export interface LabelingView {
  caseId: string;
  cohort: { id: string; name: string };
  position: number;
  total: number;
  labeled: { revision: number; label: HumanLabel; source: string; note: string | null; createdAt: Date }[];
  business: { name: string; website: string | null; street: string | null; place: string };
  websiteConfirmed: boolean;
  pagesRead: { url: string; ok: boolean; status: number | null }[];
  excerpts: { sourceUrl: string; excerpt: string }[];
  warnings: string[];
}

/** The blind labeling view of one case: evidence only. It reads no AI output, by construction. */
export async function labelingView(db: GoldDb, caseId: string): Promise<LabelingView | null> {
  const c = await db.aiEvalCase.findUnique({ where: { id: caseId }, select: { id: true, candidateId: true, position: true, cohort: { select: { id: true, name: true, _count: { select: { cases: true } } } }, labels: { orderBy: { revision: "asc" } } } });
  if (!c) return null;
  const cand = await db.discoveryCandidate.findUnique({
    where: { id: c.candidateId },
    select: {
      businessName: true,
      website: true,
      streetAddress: true,
      city: true,
      state: true,
      postalCode: true,
      websiteVerifiedAt: true,
      evidence: { where: { origin: "research" }, orderBy: { createdAt: "asc" }, select: { sourceUrl: true, excerpt: true } },
      research: {
        where: { status: "completed" },
        orderBy: { queuedAt: "desc" },
        take: 1,
        select: {
          warnings: true,
          sources: { where: { kind: "website" }, orderBy: { fetchedAt: "asc" }, select: { url: true, finalUrl: true, ok: true, httpStatus: true } },
          facts: { where: { excerpt: { not: null } }, orderBy: { id: "asc" }, select: { excerpt: true, source: { select: { url: true } } } },
        },
      },
    },
  });
  if (!cand) return null;
  const run = cand.research[0];
  const seen = new Set<string>();
  const excerpts: LabelingView["excerpts"] = [];
  for (const e of [...cand.evidence.map((x) => ({ sourceUrl: x.sourceUrl, excerpt: x.excerpt })), ...(run?.facts ?? []).filter((f) => f.source?.url).map((f) => ({ sourceUrl: f.source!.url, excerpt: f.excerpt! }))]) {
    const key = `${e.sourceUrl}\n${e.excerpt}`;
    if (!seen.has(key)) excerpts.push(e), seen.add(key);
  }
  return {
    caseId: c.id,
    cohort: { id: c.cohort.id, name: c.cohort.name },
    position: c.position,
    total: c.cohort._count.cases,
    labeled: c.labels.map((l) => ({ revision: l.revision, label: l.label as HumanLabel, source: l.source, note: l.note, createdAt: l.createdAt })),
    business: { name: cand.businessName, website: cand.website, street: cand.streetAddress, place: [cand.city, cand.state, cand.postalCode].filter(Boolean).join(", ") },
    websiteConfirmed: Boolean(cand.websiteVerifiedAt),
    pagesRead: (run?.sources ?? []).map((s) => ({ url: s.finalUrl ?? s.url, ok: s.ok, status: s.httpStatus })),
    excerpts,
    warnings: (Array.isArray(run?.warnings) ? run.warnings : []).filter((w): w is string => typeof w === "string" && !DECISION_WARNING.test(w)),
  };
}

/** The next case in a cohort without a label, in labeling order. */
export const nextUnlabeledCase = (db: GoldDb, cohortId: string) =>
  db.aiEvalCase.findFirst({ where: { cohortId, labels: { none: {} } }, orderBy: { position: "asc" }, select: { id: true } });

/** Candidates in a cohort case still waiting for its blind label: their AI output must stay hidden everywhere. */
export async function blindedCandidateIds(db: Pick<GoldDb, "aiEvalCase">, candidateIds?: readonly string[]): Promise<Set<string>> {
  const rows = await db.aiEvalCase.findMany({ where: { labels: { none: {} }, ...(candidateIds ? { candidateId: { in: [...candidateIds] } } : {}) }, select: { candidateId: true } });
  return new Set(rows.map((r) => r.candidateId));
}

/** A case's labels and identity, for the review page shown after its blind label. Reads no AI output itself. */
export async function caseLabels(db: GoldDb, caseId: string) {
  const c = await db.aiEvalCase.findUnique({ where: { id: caseId }, select: { id: true, candidateId: true, cohort: { select: { id: true, name: true } }, labels: { orderBy: { revision: "asc" }, select: { revision: true, source: true, label: true, note: true } } } });
  if (!c) return null;
  const cand = await db.discoveryCandidate.findUnique({ where: { id: c.candidateId }, select: { businessName: true } });
  return { caseId: c.id, candidateId: c.candidateId, cohort: c.cohort, businessName: cand?.businessName ?? "Unknown candidate", labels: c.labels, blindDone: c.labels.some((l) => l.revision === 1) };
}

/** Every cohort with its labeling progress. */
export async function cohortProgress(db: Pick<GoldDb, "aiEvalCohort">) {
  const rows = await db.aiEvalCohort.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, kind: true, samplingVersion: true, seed: true, strata: true, createdAt: true, cases: { select: { _count: { select: { labels: true } } } } } });
  return rows.map(({ cases, ...c }) => ({ ...c, total: cases.length, labeled: cases.filter((x) => x._count.labels > 0).length }));
}
