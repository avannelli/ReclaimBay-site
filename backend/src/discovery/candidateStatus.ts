/*
 * Candidate lifecycle. Pure rules, enforced by the service for every change.
 *
 *   discovered -> researching -> researched -> (human approval) -> approved
 *
 * with needs_review as a holding state for anything that wants a second
 * look (every possible duplicate enters it), and rejected / duplicate as
 * reversible exits. `approved` is terminal and is entered only through
 * approveCandidate(), which creates the Prospect; it is not a status anyone
 * can set directly. Approval is a human "yes, put this in the pipeline",
 * never a claim that the business is qualified.
 */

export const CANDIDATE_STATUSES = [
  "discovered",
  "researching",
  "researched",
  "needs_review",
  "approved",
  "rejected",
  "duplicate",
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const isCandidateStatus = (v: string): v is CandidateStatus =>
  (CANDIDATE_STATUSES as readonly string[]).includes(v);

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  discovered: "Discovered",
  researching: "Researching",
  researched: "Researched",
  needs_review: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
  duplicate: "Duplicate",
};

export const CANDIDATE_STATUS_MEANINGS: Record<CandidateStatus, string> = {
  discovered: "Found by a provider or added by hand. Nothing researched yet.",
  researching: "Being researched.",
  researched: "Research recorded, and every recorded fact has a public source.",
  needs_review: "Waiting for a human look, for example a possible duplicate.",
  approved: "A human approved it. It is now a Prospect (status New).",
  rejected: "A human decided it should not enter the pipeline.",
  duplicate: "The same business as another candidate or prospect.",
};

/** Manual moves. `approved` is deliberately absent from every list. */
export const CANDIDATE_TRANSITIONS: Record<CandidateStatus, readonly CandidateStatus[]> = {
  discovered: ["researching", "needs_review", "rejected", "duplicate"],
  researching: ["researched", "discovered", "needs_review", "rejected", "duplicate"],
  researched: ["researching", "needs_review", "rejected", "duplicate"],
  needs_review: ["researching", "researched", "rejected", "duplicate"],
  rejected: ["discovered"],
  duplicate: ["discovered"],
  approved: [],
};

/** Statuses from which a human may approve. */
export const APPROVABLE_FROM: readonly CandidateStatus[] = ["researched", "needs_review"];

/** Statuses that need a recorded reason. */
export const CANDIDATE_REASON_REQUIRED: readonly CandidateStatus[] = ["rejected", "duplicate"];

/** Statuses whose facts are frozen. */
export const isFrozen = (s: CandidateStatus) => s === "approved";

export interface CandidateTransitionContext {
  /** Recorded yes/no signals that have no evidence yet. */
  unevidencedSignals: readonly string[];
  evidenceCount: number;
}

/** Empty when the change is allowed, otherwise every reason it isn't. */
export function candidateTransitionErrors(
  from: CandidateStatus,
  to: CandidateStatus,
  ctx: CandidateTransitionContext,
  reason: string | null,
): string[] {
  if (from === "approved") return ["An approved candidate is already a prospect and can't be changed."];
  if (to === "approved") return ["Use Approve to create the prospect; approval is not a status you set."];
  if (from === to) return [`Already ${CANDIDATE_STATUS_LABELS[to]}.`];
  if (!CANDIDATE_TRANSITIONS[from].includes(to)) {
    return [`Can't move from ${CANDIDATE_STATUS_LABELS[from]} to ${CANDIDATE_STATUS_LABELS[to]}.`];
  }
  const errors: string[] = [];
  if (to === "researched") errors.push(...researchedErrors(ctx));
  if (CANDIDATE_REASON_REQUIRED.includes(to) && !reason?.trim()) {
    errors.push(`Moving to ${CANDIDATE_STATUS_LABELS[to]} requires a reason.`);
  }
  return errors;
}

/**
 * "Researched" means evidence-backed: something was actually found at a
 * public source, and every yes/no signal recorded has its own source. A
 * signal with no evidence should be left Unknown instead.
 */
export function researchedErrors(ctx: CandidateTransitionContext): string[] {
  const errors: string[] = [];
  if (ctx.evidenceCount === 0) errors.push("Researched requires at least one evidence item with a public source URL.");
  if (ctx.unevidencedSignals.length) {
    errors.push(
      `Every recorded signal needs evidence. Add evidence, or set to Unknown: ${ctx.unevidencedSignals.join(", ")}.`,
    );
  }
  return errors;
}
