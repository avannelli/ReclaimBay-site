/*
 * Automatic decisions on researched candidates: approval (rules approval@a1),
 * when a candidate may become a Prospect without a person clicking Approve,
 * and rejection (rules rejection@r1), when research has shown with sources
 * that it can never qualify.
 *
 * A deterministic, inspectable rule over evidence ReclaimBay already has. It
 * adds no qualification criteria, signals, or weights: it reuses the
 * existing qualification (scoring.ts), category check, research outcome,
 * and approval gates, and only decides between three outcomes:
 *
 *   approve   every condition below holds: a clean, high-confidence lead
 *   review    anything less: it stays in the existing candidate workflow
 *             for a person (manual approval works as before)
 *   blocked   outside the target category, or a person rejected it or
 *             marked it a duplicate
 *
 * Automatic approval only ever starts from "researched". "Needs review" is a
 * person's (or the duplicate check's) request for a human look, so it is
 * never approved automatically, and nothing a person decided is overwritten.
 *
 * Automatic rejection (rejection@r1) is the same in reverse: from
 * "researched" only, and only on evidence research recorded with a source:
 *
 *   reject    the category check says outside the target (from the website,
 *             or from the name or provider when research found nothing to
 *             the contrary), or a required criterion is No with a research
 *             quote and URL (a chain or franchise brand, a dealership)
 *
 * Never on a person's input (a criterion or category a person recorded, a
 * hold, a candidate a person reopened after a rejection), never on missing
 * evidence, and never where research disagrees with itself or with a
 * person: those stay for review.
 */
import { scoreCandidate, researchGateErrors, type CandidateFacts } from "./approval.js";
import { CATEGORY_SOURCE_LABELS, isOutsideTarget, type CategorySource, type CategoryVerdict } from "./categoryCheck.js";
import { CANDIDATE_STATUS_LABELS, type CandidateStatus } from "./candidateStatus.js";
import { FIT_CRITERION, QUALIFICATION_LABELS, REQUIRED_CRITERIA, SIGNALS, type SignalDefinition } from "../scoring.js";
import { fitBasis, fitConflict } from "../research/repairFit.js";

/** Rule set and version, written into every automatic approval. */
export const AUTO_APPROVAL_RULES = "approval@a3";
/** Every automatic approval's recorded reason starts with this. */
export const AUTO_APPROVED_PREFIX = "Automatically approved";
/** Rule set and version, written into every automatic rejection. */
export const AUTO_REJECTION_RULES = "rejection@r3";
/** Every automatic rejection's recorded reason starts with this. */
export const AUTO_REJECTED_PREFIX = "Automatically rejected";
/** The note a person's reopening of a rejected candidate leaves: from then on, only a person rejects it. */
export const REOPENED_PREFIX = "Reopened by a person";

export type AutoApprovalDecision = "approve" | "reject" | "review" | "blocked" | "approved";

export const AUTO_APPROVAL_LABELS: Record<AutoApprovalDecision, string> = {
  approve: "Meets every automatic-approval condition",
  reject: "Rejected on research evidence",
  review: "Held for human review",
  blocked: "Blocked",
  approved: "Already approved",
};

interface Labelled {
  label: string;
  pattern: RegExp;
}

/**
 * Research warnings that need a person before approval (matched against the
 * warnings research records; see src/research). Anything research may say in
 * future that is in neither list also holds the candidate for review.
 */
export const CRITICAL_WARNINGS: readonly Labelled[] = [
  { label: "the website gives a different business address", pattern: /gives a different business address/ },
  { label: "the website says the business has closed", pattern: /says the business has closed/ },
  { label: "research disagrees with something a person recorded", pattern: /but a person (?:recorded|set the category)/ },
  { label: "the website's phone differs from the stored phone", pattern: /the stored phone .+ was kept/ },
  { label: "no phone on the website could be tied to this location", pattern: /none could be tied to this location/ },
];

/**
 * Warnings that don't need a person: ownership was confirmed by the name and
 * the address, and the provider's phone is never used as contact. They are
 * repeated in the approval note.
 */
export const NOTED_WARNINGS: readonly Labelled[] = [
  { label: "the provider's phone is not on the website", pattern: /^The provider's phone is not on the website/ },
  // Only the collision/body segment is unverified; product fit is held separately on its own evidence.
  { label: "collision/body specialty services are unverified", pattern: /^Dealership or specialty collision\/body services require human verification before recording/ },
];

/** Business types on the website that need a person to verify the repair operation. */
const POSSIBLE_TYPES = new Set(["dealership"]);

export interface LatestResearch {
  status: string;
  outcome: string | null;
  version: string;
  warnings: unknown;
  /** The run's business_type fact, if it recorded one. */
  businessType: { value: string | null; note: string | null } | null;
}

export interface AutoApprovalInput extends CandidateFacts {
  /** Who recorded each signal ("research" or "manual"); rejection uses only research's. */
  signals: readonly { key: string; value: CandidateFacts["signals"][number]["value"]; origin?: string }[];
  status: CandidateStatus;
  categoryVerdict: CategoryVerdict | null;
  categorySource: CategorySource | null;
  categoryReason: string | null;
  categorySourceUrl?: string | null;
  websiteVerifiedAt: Date | null;
  evidence: readonly { signalKey: string; origin?: string; sourceUrl?: string; excerpt?: string }[];
  /** The candidate's most recent research run (any status). */
  latestRun: LatestResearch | null;
  /** A person reopened it after a rejection (a REOPENED_PREFIX note): only a person rejects it again. */
  reopenedByPerson?: boolean;
}

export interface AutoApprovalAssessment {
  decision: AutoApprovalDecision;
  /** Why: the conditions met (approve), the evidence (reject), or what isn't met (review, blocked). */
  reasons: string[];
  /** Non-blocking warnings, repeated in the approval note. */
  noted: string[];
  /** For "approve": the reason recorded on the candidate and the prospect. For "reject": the rejection reason. */
  approvalNote: string | null;
}

const signalLabel = (key: string) => (SIGNALS as readonly SignalDefinition[]).find((s) => s.key === key)?.label ?? key;

/**
 * rejection@r1: the source-backed grounds for rejecting a researched
 * candidate, and anything that stops an automatic rejection (a person's
 * input, missing evidence, conflicting evidence). A candidate is rejected
 * automatically only with grounds and nothing stopping it.
 */
export function rejectionGrounds(c: AutoApprovalInput): { grounds: string[]; stops: string[] } {
  const grounds: string[] = [];
  const stops: string[] = [];
  const run = c.latestRun;
  if (c.status !== "researched") stops.push("Only a researched candidate is rejected automatically.");
  if (!run || run.status !== "completed") stops.push("No completed research run to rely on.");
  if (c.reopenedByPerson) stops.push("A person reopened it after a rejection; only a person rejects it again.");
  if (run?.status === "completed" && warningList(run.warnings).some((w) => /but a person (?:recorded|set the category)|Collision\/body evidence is contradictory|Automotive repair evidence is contradictory/.test(w))) {
    stops.push("Research disagrees with something a person recorded.");
  }

  // A required criterion is No: only research's own value, with its own quoted, sourced evidence.
  for (const key of REQUIRED_CRITERIA) {
    const signal = c.signals.find((s) => s.key === key);
    if (signal?.value !== "no") continue;
    if (signal.origin !== "research") {
      stops.push(`A person recorded ${signalLabel(key)} as No; a person decides.`);
      continue;
    }
    const ev = c.evidence.find((e) => e.signalKey === key && e.origin === "research" && e.sourceUrl && e.excerpt);
    if (!ev) {
      stops.push(`${signalLabel(key)} is No without research evidence.`);
      continue;
    }
    grounds.push(`${signalLabel(key)} is No: "${ev.excerpt}" (${ev.sourceUrl}).`);
  }

  // Outside the target category, by the category check (never a person's verdict).
  if (c.categoryVerdict === "wrong_category" && c.categoryReason) {
    if (c.categorySource === "manual") stops.push("A person set the category; a person decides.");
    else if (fitBasis(c.signals)) {
      // The name says another trade, but repair evidence says Yes: conflicting evidence.
      stops.push(`The ${c.categorySource ?? "name"} says it is outside the target category, but automotive repair evidence says Yes; resolve the conflict.`);
    } else {
      const from = c.categorySource === "website" && c.categorySourceUrl ? ` (${c.categorySourceUrl})` : ` (from the ${c.categorySource ?? "name"})`;
      grounds.push(`Outside the target category: ${c.categoryReason.replace(/\.$/, "")}${from}.`);
    }
  }
  return { grounds, stops: [...new Set(stops)] };
}

const warningList = (w: unknown): string[] => (Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : []);

export function assessAutoApproval(c: AutoApprovalInput): AutoApprovalAssessment {
  const out = (decision: AutoApprovalDecision, reasons: string[], noted: string[] = [], approvalNote: string | null = null): AutoApprovalAssessment => ({
    decision,
    reasons,
    noted,
    approvalNote,
  });
  if (c.status === "approved") return out("approved", ["This candidate is already a prospect."]);
  const conflict = c.latestRun?.status === "completed" ? fitConflict(c.latestRun.warnings, fitBasis(c.signals)) : null;
  if (conflict) return out("review", [`${conflict === "collision/body" ? "Collision/body" : "Automotive repair"} evidence is contradictory; human review is required.`]);

  // rejection@r1: source-backed grounds, and nothing a person did or research disputes.
  if (c.status === "researched") {
    const { grounds, stops } = rejectionGrounds(c);
    if (grounds.length && !stops.length) {
      return out("reject", grounds, [], `${AUTO_REJECTED_PREFIX} (${AUTO_REJECTION_RULES}): ${grounds.join(" ")}`.slice(0, 2000));
    }
  }

  // Blocked: outside the target category, or a person closed it.
  const blocked: string[] = [];
  if (isOutsideTarget(c)) blocked.push(`The category check says it is outside the target category${c.categoryReason ? ` (${c.categoryReason.replace(/\.$/, "")})` : ""}.`);
  if (c.status === "rejected" || c.status === "duplicate") blocked.push(`A person marked it ${CANDIDATE_STATUS_LABELS[c.status]}.`);
  if (blocked.length) return out("blocked", blocked);

  const held: string[] = [];
  if (c.status === "needs_review") held.push("It is waiting for a person (Needs review).");
  else if (c.status !== "researched") held.push(`Research isn't complete: the status is ${CANDIDATE_STATUS_LABELS[c.status]}.`);

  if (c.categoryVerdict === "unclear") held.push(`The category is unclear${c.categoryReason ? ` (${c.categoryReason.replace(/\.$/, "")})` : ""}.`);
  else if (c.categoryVerdict !== "in_target") held.push("The category hasn't been checked yet.");

  const run = c.latestRun;
  if (!c.websiteVerifiedAt) held.push("Website ownership isn't confirmed.");
  if (!run) held.push("The candidate has never been researched.");
  else if (run.status !== "completed") held.push(`The latest research run ${run.status === "failed" ? "failed" : "hasn't finished"}; run it again.`);
  else if (run.outcome !== "website_verified") held.push(`The latest research didn't confirm the website (${(run.outcome ?? "no outcome").replace(/_/g, " ")}).`);

  const result = scoreCandidate(c);
  const state = (key: string) => result.breakdown.find((s) => s.key === key)?.state ?? "unknown";
  if (result.qualification !== "meets_criteria") held.push(`Qualification is ${QUALIFICATION_LABELS[result.qualification]}, not Meets criteria.`);
  if (state(FIT_CRITERION) !== "yes") held.push(`Verified automotive repair is ${state(FIT_CRITERION)}, not yes.`);
  // The basis of fit (automotive repair, or collision/body for a body shop) needs its own quoted source.
  const basis = fitBasis(c.signals);
  if (!c.evidence.some(e => e.signalKey === (basis === "collision" ? "collision_repair_services" : FIT_CRITERION) && e.sourceUrl?.trim() && e.excerpt?.trim())) held.push("Automotive repair fit requires its own source URL and supporting excerpt.");

  const type = run?.status === "completed" ? run.businessType : null;
  if (type && ((type.value && POSSIBLE_TYPES.has(type.value)) || /also shows dealership activity/.test(type.note ?? ""))) {
    held.push("A dealership service department requires human verification and approval.");
  }

  const noted: string[] = [];
  for (const w of run?.status === "completed" ? warningList(run.warnings) : []) {
    const critical = CRITICAL_WARNINGS.find((x) => x.pattern.test(w));
    const benign = NOTED_WARNINGS.find((x) => x.pattern.test(w));
    if (critical) held.push(`A research warning needs a person: ${critical.label}.`);
    else if (benign) noted.push(benign.label);
    else held.push(`A research warning needs a person: "${w.slice(0, 120)}".`);
  }

  // The existing approval gate: every recorded signal has its own evidence.
  held.push(...researchGateErrors(c.signals, c.evidence));

  if (held.length) return out("review", [...new Set(held)], noted);

  const conditions = [
    `target category confirmed (in target, ${c.categorySource === "manual" ? "set by a person" : `from the ${CATEGORY_SOURCE_LABELS[c.categorySource ?? "name"]}`})`,
    `website ownership verified (research ${run!.version})`,
    "automotive repair services confirmed with a source and excerpt",
    "qualification meets criteria",
    "no blocking warnings",
  ];
  const note = `${AUTO_APPROVED_PREFIX} (${AUTO_APPROVAL_RULES}): ${conditions.join(", ")}.${noted.length ? ` Noted: ${noted.join("; ")}.` : ""}`;
  return out("approve", conditions, noted, note);
}

/** Whether a candidate was approved by the rules rather than a person. */
export const isAutoApproved = (c: { status: string; decisionReason: string | null }) =>
  c.status === "approved" && Boolean(c.decisionReason?.startsWith(AUTO_APPROVED_PREFIX));

