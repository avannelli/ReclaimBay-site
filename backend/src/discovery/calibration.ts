import type { Db } from "../db.js";
import { RESEARCH_VERSION } from "../research/researcher.js";
import { CONCRETE_SERVICES, assessServiceEvidence, businessKinds } from "../research/serviceEvidence.js";
import { assessCommercialFit, type CommercialQuote } from "../policies/reclaimbay/commercial.js";
import { AUTOMATION_RULES, assessDiscovery, automationInclude, type AutomationAssessment, type AutomationCandidate, type Protection } from "./automationPolicy.js";
import { candidateProtection, protectionIndex } from "./protection.js";
import { duplicateRelationships, type RelationshipRow } from "./relationships.js";
import { accountSafety } from "./account.js";
import { isOnBusinessSite } from "./normalize.js";

/*
 * Readiness calibration (R16.2): what the current rules (research r16, discovery@d2,
 * reclaimbay.commercial@v1) decide for existing candidates, from what is already stored.
 * Read-only by construction: it never fetches, queues, approves, rejects or writes.
 * The database entry point runs inside a READ ONLY transaction and checks that it is.
 *
 *   current     the real assessDiscovery decision on the stored record (what deploying does)
 *   projection  what the retained historical quotes SUGGEST an r16 re-read will find. Never
 *               sufficient on its own: an older run cannot make a candidate Ready under r16.
 *               Missing evidence (r15 never recorded it) is kept apart from negative evidence
 *               (a stored "no", a quoted exclusion).
 *   simulation  the decision after a hypothetical r16 re-read (verified, failed, blocked):
 *               a research action there would be a research loop.
 */

export const CALIBRATION_RULES = "reclaimbay.calibration@v1";

export type ImmediateOutcome = "still_ready" | "fresh_research" | "commercial_review" | "evidence_hold" | "identity_ownership_account_hold" | "duplicate_hold" | "protected" | "other_hold";
export type ProjectedOutcome = "current_rules_result" | "likely_ready_after_reread" | "likely_restored_by_reread" | "likely_service_evidence_hold" | "likely_commercial_review" | "likely_identity_hold" | "likely_ownership_hold" | "likely_account_or_duplicate_hold" | "confirmed_negative" | "no_verified_run";

const REPAIR_KEYS = ["automotive_repair_services", "collision_repair_services", "general_repair_services"];
/** What r16 records that older runs did not: without these an older run is missing evidence, not negative evidence. */
const R16_FACTS = ["location_identity", "page_location", "site_locations", "service_evidence", "ownership_class", "commercial_quote"];
const IMMEDIATE: Record<string, ImmediateOutcome> = {
  commercial_review: "commercial_review",
  service_evidence: "evidence_hold", outside_icp: "evidence_hold", adjacent_trade: "evidence_hold", insufficient_evidence: "evidence_hold", manual_verification: "evidence_hold", conflicting_evidence: "evidence_hold",
  location_identity: "identity_ownership_account_hold", ownership: "identity_ownership_account_hold", account_review: "identity_ownership_account_hold", identity: "identity_ownership_account_hold", missing_website: "identity_ownership_account_hold",
  duplicate_relationship: "duplicate_hold", duplicate: "duplicate_hold", canonical_prospect: "duplicate_hold",
};

export interface CalibrationRow {
  id: string;
  name: string;
  website: string | null;
  run: { id: string; version: string; outcome: string | null; status: string; finishedAt: string | null } | null;
  current: { action: string; code: string; reason: string; researchKind?: string; warnings?: string[] };
  immediate: ImmediateOutcome;
  projection: {
    outcome: ProjectedOutcome;
    /** Only a current-rules (r16) run can establish Ready; historical quotes never do. */
    sufficient: boolean;
    basis: string;
    /** labelOnly: strict-phrase services a historical label names without their own quote; looseLabels: single-word-scan labels (never evidence). */
    service: { strength: string; counted: string[]; reason: string; labelOnly: string[]; looseLabels: string[] };
    commercial: { disposition: string; confidence: string; codes: string[] };
    identity: "address_verified" | "phone_verified" | "unverified" | "current_rules";
    ownership: "independent" | "unknown" | "possible_chain" | "dealership" | "current_rules";
    missingEvidence: string[];
    negativeEvidence: { kind: string; excerpt: string; sourceUrl: string | null }[];
  };
  relationships: { blocking: string[]; multiLocationPeers: string[]; warnings: string[]; account: string; unverified: string[] };
  simulation: { afterVerifiedReread: string; afterFailedReread: string; afterBlockedReread: string; researchLoop: boolean; automaticRetriesAfterFailure: number };
  restore: string[];
  reviewFlags: string[];
}

export interface CalibrationResult {
  rules: typeof CALIBRATION_RULES;
  automationRules: string;
  researchVersion: string;
  source: string;
  asOf: string;
  readOnly: string;
  completeness: string[];
  assumptions: string[];
  rows: CalibrationRow[];
  summary: ReturnType<typeof summarize>;
}

const RUN_ORDER = (a: Run, b: Run) =>
  (b.queuedAt?.getTime() ?? 0) - (a.queuedAt?.getTime() ?? 0) || (b.finishedAt?.getTime() ?? -1) - (a.finishedAt?.getTime() ?? -1) ||
  (b.startedAt?.getTime() ?? -1) - (a.startedAt?.getTime() ?? -1) || b.id.localeCompare(a.id);
type Run = AutomationCandidate["research"][number];

/** r11 and general-repair labels came from the loose single-word scan, which r16 never counts; r13+ fit labels are strict phrase matches. */
const LOOSE_LABELS = /\b(?:engine diagnostics|maintenance\/oil service)\b|\btransmission\b(?!\/)/;
const labelsOf = (excerpt: string) => (/^Names ([^:]+):/.exec(excerpt)?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => CONCRETE_SERVICES.includes(s));
const immediateOf = (a: AutomationAssessment): ImmediateOutcome =>
  a.action === "ready" ? "still_ready" : a.action === "research" ? "fresh_research" : a.action === "protected" ? "protected" : a.action === "link_duplicate" ? "duplicate_hold" : IMMEDIATE[a.code] ?? "other_hold";

/** A run the decision would see after a hypothetical re-read, prepended in memory only. */
function withRun(c: AutomationCandidate, now: Date, run: Partial<Run>): AutomationCandidate {
  const synthetic = { id: `calibration-simulated-${run.status}-${run.outcome}`, candidateId: c.id, version: RESEARCH_VERSION, trigger: "scheduled", pagesFetched: 0, warnings: [], error: null,
    queuedAt: now, startedAt: now, heartbeatAt: now, finishedAt: now, candidateRevision: c.researchRevision, subjectWebsite: c.website, facts: [], sources: [], ...run } as unknown as Run;
  return { ...c, research: [synthetic, ...c.research] };
}

/** One candidate, from stored data only. `relationshipsComplete` is false when the caller could not supply every candidate/prospect. */
export function calibrateCandidate(c: AutomationCandidate, protection: Protection, now: Date, extra: { unverifiedRelationships?: string[] } = {}): CalibrationRow {
  const research = [...c.research].sort(RUN_ORDER);
  const candidate = { ...c, research };
  const current = assessDiscovery(candidate, protection, now);
  const verified = research.find((r) => r.status === "completed" && r.outcome === "website_verified" && (r.subjectWebsite === null || r.subjectWebsite === c.website));
  const latest = research[0] ?? null;
  const fact = (field: string) => verified?.facts.find((f) => f.field === field);

  // Historical quotes from the latest verified run (that run's own evidence, on the business's site).
  const quotes = verified ? c.evidence.filter((e) => e.researchId === verified.id && isOnBusinessSite(e.sourceUrl, c.website)) : [];
  const repair = quotes.filter((e) => REPAIR_KEYS.includes(e.signalKey));
  const service = assessServiceEvidence({ businessName: c.businessName, quotes: repair.map((e) => ({ url: e.sourceUrl, excerpt: e.excerpt })) });
  const strictLabelled = repair.filter((e) => ["automotive_repair_services", "collision_repair_services"].includes(e.signalKey) && !LOOSE_LABELS.test(/^Names ([^:]+):/.exec(e.excerpt)?.[1] ?? ""));
  const uncounted = (labels: string[]) => [...new Set(labels)].filter((l) => !service.counted.some((x) => x.label === l)).sort();
  const labelOnly = uncounted(strictLabelled.flatMap((e) => labelsOf(e.excerpt)));
  const looseLabels = uncounted(repair.filter((e) => !strictLabelled.includes(e)).flatMap((e) => labelsOf(e.excerpt))).filter((l) => !labelOnly.includes(l));
  // A service hold the strict historical label contradicts: old runs kept one quote per signal, r16 keeps one per service.
  const restorable = service.strength !== "strong" && !service.trades.length && service.counted.length + labelOnly.length >= 2;
  const commercialQuotes: CommercialQuote[] = [
    ...quotes.filter((e) => [...REPAIR_KEYS, "independent_shop"].includes(e.signalKey)).map((e) => ({ sourceUrl: e.sourceUrl, excerpt: e.excerpt, evidenceId: e.id })),
    ...(verified?.facts ?? []).filter((f) => ["business_type", "commercial_quote"].includes(f.field) && f.excerpt && f.state === "verified").map((f) => ({ sourceUrl: c.website ?? "", excerpt: f.excerpt!, factId: f.id })),
  ];
  const commercial = assessCommercialFit({ quotes: commercialQuotes, ownership: fact("ownership_class")?.value ?? null });

  const negativeEvidence = [
    ...c.signals.filter((s) => ["automotive_repair_services", "collision_repair_services"].includes(s.key) && s.value === "no").map((s) => {
      const e = c.evidence.find((x) => x.signalKey === s.key);
      return { kind: `${s.key}=no (${s.origin})`, excerpt: e?.excerpt ?? "", sourceUrl: e?.sourceUrl ?? null };
    }),
    ...(verified?.facts ?? []).filter((f) => f.field === "performs_repair" && f.value === "no").map((f) => ({ kind: "performs_repair=no", excerpt: f.excerpt ?? f.note ?? "", sourceUrl: null })),
    ...(commercial.disposition === "exclude" ? commercial.findings.map((f) => ({ kind: f.code, excerpt: f.evidence.map((e) => e.excerpt).join(" | ").slice(0, 280), sourceUrl: f.evidence[0]?.sourceUrl ?? null })) : []),
  ];

  const isCurrent = verified?.version === RESEARCH_VERSION;
  const missingEvidence = !verified ? ["a verified website read"] : isCurrent ? [] : R16_FACTS.filter((f) => !verified.facts.some((x) => x.field === f));
  if (!isCurrent && verified && labelOnly.length) missingEvidence.push(`one quote per service (only the machine label names: ${labelOnly.join(", ")})`);

  const identity: CalibrationRow["projection"]["identity"] = isCurrent ? "current_rules" : fact("address")?.state === "verified" ? "address_verified" : fact("phone")?.state === "verified" ? "phone_verified" : "unverified";
  const independentNo = c.signals.some((s) => s.key === "independent_shop" && s.value === "no");
  const ownership: CalibrationRow["projection"]["ownership"] = isCurrent ? "current_rules" : fact("business_type")?.value === "dealership" ? "dealership" : independentNo ? "possible_chain"
    : fact("business_type")?.value === "independent" || c.signals.some((s) => s.key === "independent_shop" && s.value === "yes") ? "independent" : "unknown";
  const rel = protection.relationships;
  const accountHeld = !protection.account.clear;
  const peersNeedAddress = identity !== "address_verified" && rel.multiLocationPeers.length > 0;

  let outcome: ProjectedOutcome;
  if (!verified) outcome = "no_verified_run";
  else if (isCurrent) outcome = "current_rules_result";
  else if (negativeEvidence.length) outcome = "confirmed_negative";
  else if (identity === "unverified" || peersNeedAddress) outcome = "likely_identity_hold";
  else if (ownership === "dealership" || ownership === "possible_chain") outcome = "likely_ownership_hold";
  else if (rel.blocking.length || accountHeld || protection.protected) outcome = "likely_account_or_duplicate_hold";
  // A restorable service hold also clears a commercial review that rests only on missing service quotes.
  else if (service.strength !== "strong") outcome = restorable ? "likely_restored_by_reread" : "likely_service_evidence_hold";
  else if (commercial.disposition !== "fit") outcome = "likely_commercial_review";
  else outcome = "likely_ready_after_reread";

  // What happens after a re-read. Any "research" answer here would be a loop.
  const failedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000);
  const afterVerified = assessDiscovery(withRun(candidate, now, { status: "completed", outcome: "website_verified" }), protection, now);
  const afterFailed = assessDiscovery(withRun(candidate, failedAt, { status: "failed", outcome: "website_unreachable", finishedAt: failedAt }), protection, now);
  const afterBlocked = assessDiscovery(withRun(candidate, now, { status: "completed", outcome: "access_blocked" }), protection, now);
  const researchLoop = afterVerified.action === "research" || afterBlocked.action === "research";

  const restore: string[] = [];
  if (current.action === "research") restore.push(`One ${RESEARCH_VERSION} re-read of the stored website (${current.researchKind ?? current.code}) in a human-authorized Admin batch.`);
  if (outcome === "likely_identity_hold") restore.push(peersNeedAddress ? "This location's street address must appear on its own pages (another candidate uses the same website elsewhere), or correct its website." : "Confirm this location's address or the provider phone on its own website, or correct the website.");
  if (outcome === "likely_ownership_hold") restore.push("A person checks ownership (dealer/chain/franchise) and records the decision.");
  if (outcome === "likely_account_or_duplicate_hold" || rel.blocking.length) restore.push("A person answers the duplicate/account question on the candidate page.");
  if (accountHeld && outcome !== "likely_account_or_duplicate_hold") restore.push(`Account: ${protection.account.reason}`);
  if (outcome === "likely_restored_by_reread") restore.push(`The re-read must quote each service on this location's pages; the historical label already names ${labelOnly.join(", ")}.`);
  if (outcome === "likely_service_evidence_hold") restore.push("Quoted concrete repair services on this location's pages: two, or one that is the stated specialty.");
  if (outcome === "likely_commercial_review") restore.push("A person reviews the commercial findings; an exclusion can be approved with a recorded reason.");
  if (outcome === "confirmed_negative") restore.push("A person reviews the negative evidence; nothing is rejected automatically by these rules.");

  const reviewFlags: string[] = [];
  if (!isCurrent && restorable) reviewFlags.push(`Service hold is likely a storage artefact: the historical strict-phrase label names ${labelOnly.join(", ")} but the old run kept one quote per signal. A re-read storing one quote per service should restore it.`);
  if (!isCurrent && service.strength !== "strong" && !restorable && looseLabels.length && !service.trades.length) reviewFlags.push(`Only the old single-word scan names ${looseLabels.join(", ")}; that is not evidence under ${RESEARCH_VERSION}. The re-read decides.`);
  if (businessKinds(c.businessName).includes("tire")) reviewFlags.push(`Tire business: ${RESEARCH_VERSION} needs two concrete services and holds a tire retailer with several locations for an ownership check.`);
  if (!isCurrent && commercial.disposition === "review" && commercial.findings.some((f) => f.code === "commercial.insufficient_service_evidence") && restorable) reviewFlags.push("Commercial review rests only on missing service quotes, not on any exclusion claim.");
  if (commercial.disposition === "exclude") reviewFlags.push(`Commercial exclusion from historical text (${commercial.findings.map((f) => f.code).join(", ")}): a person should confirm it.`);
  if (identity === "unverified" && fact("phone")?.state === "verified" && !rel.multiLocationPeers.length) reviewFlags.push("Address not matched, but the provider phone was verified on the site: r16 may accept it as a single-location identity.");
  for (const u of extra.unverifiedRelationships ?? []) reviewFlags.push(`Relationship not verifiable from this data: ${u}`);

  return {
    id: c.id, name: c.businessName, website: c.website,
    run: verified ? { id: verified.id, version: verified.version, outcome: verified.outcome, status: verified.status, finishedAt: verified.finishedAt?.toISOString() ?? null }
      : latest ? { id: latest.id, version: latest.version, outcome: latest.outcome, status: latest.status, finishedAt: latest.finishedAt?.toISOString() ?? null } : null,
    current: { action: current.action, code: current.code, reason: current.reason, ...(current.researchKind ? { researchKind: current.researchKind } : {}), ...(current.warnings?.length ? { warnings: current.warnings } : {}) },
    immediate: immediateOf(current),
    projection: {
      outcome, sufficient: isCurrent && current.action === "ready",
      basis: !verified ? "none" : isCurrent ? `current ${RESEARCH_VERSION} run` : `historical ${verified.version} quotes (projection only; insufficient under ${RESEARCH_VERSION})`,
      service: { strength: service.strength, counted: service.counted.map((x) => x.label), reason: service.reason, labelOnly, looseLabels },
      commercial: { disposition: commercial.disposition, confidence: commercial.confidence, codes: commercial.findings.map((f) => f.code) },
      identity, ownership, missingEvidence, negativeEvidence,
    },
    relationships: { blocking: [...rel.blocking].sort(), multiLocationPeers: [...rel.multiLocationPeers].sort(), warnings: [...rel.warnings].sort(), account: protection.account.code, unverified: [...(extra.unverifiedRelationships ?? [])].sort() },
    simulation: { afterVerifiedReread: `${afterVerified.action}/${afterVerified.code}`, afterFailedReread: `${afterFailed.action}/${afterFailed.code}`, afterBlockedReread: `${afterBlocked.action}/${afterBlocked.code}`,
      researchLoop, automaticRetriesAfterFailure: afterFailed.action === "research" ? 1 : 0 },
    restore, reviewFlags,
  };
}

export function summarize(rows: readonly CalibrationRow[]) {
  const count = <K extends string>(key: (r: CalibrationRow) => K) => rows.reduce<Record<string, number>>((out, r) => { out[key(r)] = (out[key(r)] ?? 0) + 1; return out; }, {});
  const research = rows.filter((r) => r.current.action === "research").length;
  return {
    candidates: rows.length,
    immediate: count((r) => r.immediate),
    leaveReady: rows.filter((r) => r.immediate !== "still_ready").length,
    projected: count((r) => r.projection.outcome),
    reviewFlags: rows.filter((r) => r.reviewFlags.length).length,
    // Held now, or likely to be held after the re-read.
    humanReview: rows.filter((r) => ["human", "protected", "link_duplicate"].includes(r.current.action) ||
      (r.current.action === "research" && !["likely_ready_after_reread", "likely_restored_by_reread", "current_rules_result"].includes(r.projection.outcome))).map((r) => r.id).sort(),
    workload: {
      immediateResearch: research,
      adminBatchesOf25: Math.ceil(research / 25),
      researchLoops: rows.filter((r) => r.simulation.researchLoop).length,
      noAutomaticRetryAfterOneFailure: rows.filter((r) => r.current.action === "research" && r.simulation.automaticRetriesAfterFailure === 0).length,
    },
    negativeVersusMissing: {
      confirmedNegative: rows.filter((r) => r.projection.negativeEvidence.length).length,
      missingEvidenceOnly: rows.filter((r) => !r.projection.negativeEvidence.length && r.projection.missingEvidence.length).length,
    },
  };
}

const sortRows = (rows: CalibrationRow[]) => rows.sort((a, b) => a.id.localeCompare(b.id));

/** Database calibration in a READ ONLY transaction. `ids` limits it to those candidates (default: every non-terminal candidate). */
export async function calibrateReadiness(db: Db, options: { ids?: readonly string[]; now?: Date } = {}): Promise<CalibrationResult> {
  const now = options.now ?? new Date();
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const readOnly = (await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>("SHOW transaction_read_only"))[0]?.transaction_read_only ?? "unknown";
    if (readOnly !== "on") throw new Error("Calibration requires a read-only transaction.");
    const index = await protectionIndex(tx);
    const candidates = await tx.discoveryCandidate.findMany({
      where: options.ids ? { id: { in: [...options.ids] } } : { status: { notIn: ["approved", "rejected", "duplicate"] } },
      include: automationInclude, orderBy: { id: "asc" },
    });
    const rows = sortRows(candidates.map((c) => calibrateCandidate(c, candidateProtection(c, index), now)));
    return { rules: CALIBRATION_RULES, automationRules: AUTOMATION_RULES, researchVersion: RESEARCH_VERSION, source: "database (read-only transaction)", asOf: now.toISOString(), readOnly,
      completeness: ["Every candidate, prospect, outreach, suppression and opt-out row was available to protection, relationship and account checks."], assumptions: [], rows, summary: summarize(rows) };
  }, { timeout: 120_000 });
}

/* ---------- Offline: the read-only production snapshot format of review/ready-25-audit (remote.mjs) ---------- */

type SnapshotIdentity = Omit<SnapshotCandidate, "assessment" | "protection" | "signals" | "evidence" | "notes" | "research">;
interface SnapshotCandidate {
  id: string; name: string; city: string | null; state: string | null; website: string | null; streetAddress: string | null; phone: string | null; providerPhone: string | null;
  status: string; prospectId: string | null; possibleDuplicateCandidateId: string | null; possibleDuplicateProspectId: string | null; duplicateReason: string | null;
  relatedCandidateId: string | null; relatedProspectId: string | null; categoryVerdict: string | null; categoryReason: string | null; websiteVerifiedAt: string | null;
  assessment?: { action: string; code: string } | null;
  protection: Omit<Protection, "relationships" | "account">;
  signals: unknown[]; evidence: unknown[]; notes: unknown[]; research: unknown[];
}
export interface ReadySnapshot { checkedAt: string; readOnly?: string; deployedCommit?: string; candidates: SnapshotCandidate[]; neighboring?: SnapshotIdentity[] }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** JSON dates back to Date objects, as Prisma returns them. */
function revive<T>(value: T): T {
  if (Array.isArray(value)) return value.map(revive) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "string" && k.endsWith("At") && ISO.test(v) ? new Date(v) : revive(v)])) as T;
  return value;
}

export const SNAPSHOT_ASSUMPTIONS = [
  "Fields absent from the snapshot are filled conservatively: categorySource/categoryRules = null, providerStatus = null, duplicateHold = false, researchRevision = 0, email/emailSourceUrl = null.",
  "duplicateDecision is absent: a candidate that was Ready under discovery@d1 with its own duplicate link must have had it resolved, so it is read as not_duplicate. Inbound flags from other records cannot be resolved from the snapshot and are reported as unverifiable, not as holds.",
  "Protection (prospect/outreach/suppression/opt-out) is the value the production code computed at snapshot time; it is not recomputed.",
  "Assessments use the snapshot time as 'now', so results are reproducible.",
];

export function calibrateSnapshot(snapshot: ReadySnapshot): CalibrationResult {
  const now = new Date(snapshot.checkedAt);
  const neighbours = snapshot.neighboring ?? [];
  const known = new Map<string, SnapshotIdentity>();
  for (const n of [...neighbours, ...snapshot.candidates]) known.set(n.id, n);
  const asRow = (r: SnapshotIdentity, resolved: boolean): RelationshipRow => ({
    id: r.id, businessName: r.name, status: r.status, website: r.website, phone: r.phone, providerPhone: r.providerPhone, streetAddress: r.streetAddress,
    // An unresolvable flag from another record is reported, never treated as a hold here.
    possibleDuplicateCandidateId: resolved ? r.possibleDuplicateCandidateId : null, duplicateDecision: resolved && r.possibleDuplicateCandidateId ? "not_duplicate" : null,
  });
  const rows = sortRows(snapshot.candidates.map((raw) => {
    const s = revive(raw);
    const c = {
      id: s.id, businessName: s.name, website: s.website, streetAddress: s.streetAddress, city: s.city, state: s.state, phone: s.phone, providerPhone: s.providerPhone,
      status: s.status, prospectId: s.prospectId, possibleDuplicateCandidateId: s.possibleDuplicateCandidateId, possibleDuplicateProspectId: s.possibleDuplicateProspectId,
      duplicateReason: s.duplicateReason, relatedCandidateId: s.relatedCandidateId, relatedProspectId: s.relatedProspectId, categoryVerdict: s.categoryVerdict, categoryReason: s.categoryReason,
      websiteVerifiedAt: s.websiteVerifiedAt, categorySource: null, categoryRules: null, categoryCheckedAt: null, categorySourceUrl: null, providerStatus: null, providerCategory: null, categoryTier: null,
      duplicateHold: false, duplicateDecision: s.possibleDuplicateCandidateId || s.possibleDuplicateProspectId ? "not_duplicate" : null, researchRevision: 0, email: null, emailSourceUrl: null, decisionReason: null,
      signals: s.signals, evidence: s.evidence, notes: s.notes, research: s.research,
    } as unknown as AutomationCandidate;
    const others = [...known.values()].filter((k) => k.id !== s.id);
    const relRows = [asRow(s, true), ...others.map((o) => asRow(o, false))];
    const unverified = others.filter((o) => o.possibleDuplicateCandidateId === s.id).map((o) => `inbound possible-duplicate flag from ${o.name} (${o.id.slice(0, 8)}, ${o.status}); its decision is not in the snapshot`);
    const protection = { ...s.protection, relationships: duplicateRelationships(c, relRows),
      account: accountSafety(c, others.map((o) => ({ id: o.id, businessName: o.name, website: o.website, city: o.city, state: o.state, phone: o.phone, prospectId: o.prospectId })), []) } as Protection;
    return calibrateCandidate(c, protection, now, { unverifiedRelationships: unverified });
  }));
  return {
    rules: CALIBRATION_RULES, automationRules: AUTOMATION_RULES, researchVersion: RESEARCH_VERSION,
    source: `read-only production snapshot ${snapshot.checkedAt}${snapshot.deployedCommit ? ` (deployed ${snapshot.deployedCommit.slice(0, 7)})` : ""}`,
    asOf: now.toISOString(), readOnly: snapshot.readOnly ?? "unknown",
    completeness: [
      `Full stored records for ${snapshot.candidates.length} candidates; identities only for ${neighbours.length} neighbouring candidates.`,
      "Not in the snapshot: the other candidates and all prospects, so shared-phone, shared-domain and existing-account checks see only these records.",
      "No data after the snapshot time: later edits, research or decisions are not reflected.",
    ],
    assumptions: SNAPSHOT_ASSUMPTIONS, rows, summary: summarize(rows),
  };
}
