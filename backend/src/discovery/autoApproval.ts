/*
 * Automatic approval (rules approval@a1): when a researched candidate may
 * become a Prospect without a person clicking Approve.
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
 */
import { scoreCandidate, researchGateErrors, type CandidateFacts } from "./approval.js";
import { CATEGORY_SOURCE_LABELS, isOutsideTarget, type CategorySource, type CategoryVerdict } from "./categoryCheck.js";
import { CANDIDATE_STATUS_LABELS, type CandidateStatus } from "./candidateStatus.js";
import { QUALIFICATION_LABELS } from "../scoring.js";

/** Rule set and version, written into every automatic approval. */
export const AUTO_APPROVAL_RULES = "approval@a1";
/** Every automatic approval's recorded reason starts with this. */
export const AUTO_APPROVED_PREFIX = "Automatically approved";

export type AutoApprovalDecision = "approve" | "review" | "blocked" | "approved";

export const AUTO_APPROVAL_LABELS: Record<AutoApprovalDecision, string> = {
  approve: "Meets every automatic-approval condition",
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
];

/** Business types on the website that contradict an independent shop. */
const CONTRADICTING_TYPES = new Set(["dealership", "chain or franchise", "possibly a chain"]);

export interface LatestResearch {
  status: string;
  outcome: string | null;
  version: string;
  warnings: unknown;
  /** The run's business_type fact, if it recorded one. */
  businessType: { value: string | null; note: string | null } | null;
}

export interface AutoApprovalInput extends CandidateFacts {
  status: CandidateStatus;
  categoryVerdict: CategoryVerdict | null;
  categorySource: CategorySource | null;
  categoryReason: string | null;
  websiteVerifiedAt: Date | null;
  evidence: readonly { signalKey: string }[];
  /** The candidate's most recent research run (any status). */
  latestRun: LatestResearch | null;
}

export interface AutoApprovalAssessment {
  decision: AutoApprovalDecision;
  /** Why: the conditions met (approve) or the ones that aren't (review, blocked). */
  reasons: string[];
  /** Non-blocking warnings, repeated in the approval note. */
  noted: string[];
  /** For "approve": the reason recorded on the candidate and the prospect. */
  approvalNote: string | null;
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
  if (state("independent_shop") !== "yes") held.push(`Independent shop is ${state("independent_shop")}, not yes.`);
  if (state("general_repair_services") !== "yes") held.push(`Offers general repair is ${state("general_repair_services")}, not yes.`);

  const type = run?.status === "completed" ? run.businessType : null;
  if (type && ((type.value && CONTRADICTING_TYPES.has(type.value)) || /also shows dealership activity/.test(type.note ?? ""))) {
    held.push(`The website contradicts an independent shop (business type: ${type.value ?? type.note}).`);
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
    "independent shop confirmed",
    "general repair confirmed",
    "qualification meets criteria",
    "no blocking warnings",
  ];
  const note = `${AUTO_APPROVED_PREFIX} (${AUTO_APPROVAL_RULES}): ${conditions.join(", ")}.${noted.length ? ` Noted: ${noted.join("; ")}.` : ""}`;
  return out("approve", conditions, noted, note);
}

/** Whether a candidate was approved by the rules rather than a person. */
export const isAutoApproved = (c: { status: string; decisionReason: string | null }) =>
  c.status === "approved" && Boolean(c.decisionReason?.startsWith(AUTO_APPROVED_PREFIX));

