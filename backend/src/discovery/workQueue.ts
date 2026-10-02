/*
 * The Discovery work queue: what a person should do next with each candidate.
 * Pure rules over what the candidate record, research, and scoring already
 * say; nothing here changes a business rule. The order of the checks matches
 * the candidate page's decision panel, so the queue and the page never
 * disagree about the next step.
 *
 *   decision  a person must decide something (duplicate, category, a
 *             criterion observed as No, a provider closure, a person's hold)
 *   ready     everything approval needs is in place
 *   verify    research is done but a required criterion is still unknown
 *   research  research hasn't run, is running, failed, or found too little
 *   handled   approved, disregarded, or a confirmed duplicate
 */
import { OUTCOME_LABELS, type ResearchOutcome } from "../research/researcher.js";
import { SIGNALS, type Qualification, type SignalDefinition } from "../scoring.js";
import type { CandidateStatus } from "./candidateStatus.js";
import type { DuplicateState } from "./duplicateReview.js";

export const LANES = ["decision", "ready", "verify", "research", "handled"] as const;
export type Lane = (typeof LANES)[number];
/** Lanes that still need something from a person or from research. */
export const ACTIVE_LANES: readonly Lane[] = ["decision", "ready", "verify", "research"];

export const LANE_LABELS: Record<Lane, string> = {
  decision: "Needs decision",
  ready: "Ready to approve",
  verify: "Needs verification",
  research: "Needs research",
  handled: "Handled",
};

export const LANE_HINTS: Record<Lane, string> = {
  decision: "A person has to decide before anything else can happen.",
  ready: "Research is complete and both required criteria are confirmed.",
  verify: "Research ran, but a required criterion is still unknown.",
  research: "Research hasn't run, is running, or found too little to go on.",
  handled: "Approved, disregarded, or closed as a duplicate.",
};

export type StepKind =
  | "duplicate"
  | "outside_target"
  | "disqualified"
  | "category_unclear"
  | "provider_closed"
  | "on_hold"
  | "ready"
  | "unverified"
  | "research_running"
  | "not_researched"
  | "research_failed"
  | "research_incomplete"
  | "approved"
  | "disregarded"
  | "duplicate_closed";

export type ActionKind = "review_duplicate" | "disregard" | "review" | "approve" | "verify" | "run_research" | "wait" | "open";

export interface NextStep {
  lane: Lane;
  kind: StepKind;
  action: ActionKind;
  /** The required criterion to verify, for `verify`. */
  criterion?: string;
}

export interface QueueInput {
  status: CandidateStatus;
  duplicate: DuplicateState;
  outsideTarget: boolean;
  categoryVerdict: string | null;
  providerStatus: string | null;
  qualification: Qualification;
  unverifiedCriteria: readonly string[];
  disqualifiedBy: readonly string[];
  /** Why approval isn't possible now (the same list the candidate page shows). */
  approvalBlockers: readonly string[];
  research: { pending: boolean; latest: { status: string; outcome: string | null } | null };
}

/** The one next step for a candidate. */
export function nextStep(i: QueueInput): NextStep {
  if (i.status === "approved") return { lane: "handled", kind: "approved", action: "open" };
  if (i.status === "duplicate") return { lane: "handled", kind: "duplicate_closed", action: "open" };
  if (i.status === "rejected") return { lane: "handled", kind: "disregarded", action: "open" };

  if (i.duplicate === "possible" || i.duplicate === "unresolved") return { lane: "decision", kind: "duplicate", action: "review_duplicate" };
  if (i.outsideTarget) return { lane: "decision", kind: "outside_target", action: "disregard" };
  if (i.qualification === "disqualified") return { lane: "decision", kind: "disqualified", action: "disregard" };
  if (i.categoryVerdict === "unclear") return { lane: "decision", kind: "category_unclear", action: "review" };
  if (i.providerStatus === "permanently_closed") return { lane: "decision", kind: "provider_closed", action: "review" };
  if (i.status === "needs_review") return { lane: "decision", kind: "on_hold", action: "review" };

  // Running research matters only while the candidate is waiting on it.
  if (i.research.pending && (i.approvalBlockers.length || i.qualification === "unverified")) {
    return { lane: "research", kind: "research_running", action: "wait" };
  }
  if (i.approvalBlockers.length) {
    if (!i.research.latest) return { lane: "research", kind: "not_researched", action: "run_research" };
    if (i.research.latest.status === "failed") return { lane: "research", kind: "research_failed", action: "run_research" };
    return { lane: "research", kind: "research_incomplete", action: "review" };
  }
  if (i.qualification === "unverified") return { lane: "verify", kind: "unverified", action: "verify", criterion: i.unverifiedCriteria[0] };
  return { lane: "ready", kind: "ready", action: "approve" };
}

const SIGNAL_DEFS = SIGNALS as readonly SignalDefinition[];
const label = (key: string) => SIGNAL_DEFS.find((s) => s.key === key)?.label ?? key;
const names = (keys: readonly string[]) => keys.map(label).join(" and ");

/** The state in a few words, as a person would say it. */
export const STEP_LABELS: Record<StepKind, string> = {
  duplicate: "Possible duplicate",
  outside_target: "Outside target category",
  disqualified: "Does not qualify",
  category_unclear: "Category unclear",
  provider_closed: "Provider says closed",
  on_hold: "On hold for review",
  ready: "Ready to approve",
  unverified: "Needs verification",
  research_running: "Research running",
  not_researched: "Not researched",
  research_failed: "Research failed",
  research_incomplete: "Research incomplete",
  approved: "Approved",
  disregarded: "Disregarded",
  duplicate_closed: "Duplicate",
};

/** What the primary button says. */
export const ACTION_LABELS: Record<ActionKind, string> = {
  review_duplicate: "Review duplicate",
  disregard: "Disregard…",
  review: "Review",
  approve: "Approve as prospect",
  verify: "Verify qualification",
  run_research: "Run research",
  wait: "Research running…",
  open: "Open",
};

/** Why the candidate is in its lane, in one plain sentence. */
export function stepReason(
  s: NextStep,
  c: {
    duplicateReasonText?: string | null;
    categoryReason?: string | null;
    unverifiedCriteria: readonly string[];
    disqualifiedBy: readonly string[];
    latestOutcome?: string | null;
    decisionReason?: string | null;
    automatic?: boolean;
  },
): string {
  const outcome = c.latestOutcome && c.latestOutcome in OUTCOME_LABELS ? OUTCOME_LABELS[c.latestOutcome as ResearchOutcome] : null;
  switch (s.kind) {
    case "duplicate":
      return c.duplicateReasonText ? `It may be the same business as another record: ${c.duplicateReasonText.toLowerCase()}.` : "It may be the same business as another record.";
    case "outside_target":
      return c.categoryReason ? `${c.categoryReason.replace(/\.$/, "")}.` : "The category check says this isn't a business ReclaimBay serves.";
    case "disqualified":
      return `${names(c.disqualifiedBy)} ${c.disqualifiedBy.length === 1 ? "is" : "are"} No.`;
    case "category_unclear":
      return c.categoryReason ? `${c.categoryReason.replace(/\.$/, "")}.` : "The category check couldn't tell whether this is a target business.";
    case "provider_closed":
      return "The discovery provider reports this business as permanently closed.";
    case "on_hold":
      return "A person put this on hold to look at again.";
    case "ready":
      return "Both required criteria are confirmed with evidence.";
    case "unverified":
      return `${names(c.unverifiedCriteria)} ${c.unverifiedCriteria.length === 1 ? "hasn't" : "haven't"} been verified yet.`;
    case "research_running":
      return "Automated research is reading the business's website now.";
    case "not_researched":
      return "Nothing has been checked yet.";
    case "research_failed":
      return "The last research run failed; run it again.";
    case "research_incomplete":
      return outcome && outcome !== OUTCOME_LABELS.website_verified ? `${outcome}, so research found too little to go on.` : "Research found no evidence with a public source yet.";
    case "approved":
      return c.automatic ? "Approved automatically as a clean lead." : "Approved by a person.";
    case "disregarded":
      return c.decisionReason ?? "A person decided it shouldn't become a prospect.";
    case "duplicate_closed":
      return c.decisionReason ?? "The same business as another record.";
  }
}

/** The colour family of a step: green go, amber look, red stop, blue information. */
export const STEP_TONE: Record<StepKind, "pos" | "warn" | "neg" | "info" | "quiet"> = {
  duplicate: "warn",
  outside_target: "neg",
  disqualified: "neg",
  category_unclear: "warn",
  provider_closed: "warn",
  on_hold: "warn",
  ready: "pos",
  unverified: "warn",
  research_running: "info",
  not_researched: "info",
  research_failed: "warn",
  research_incomplete: "info",
  approved: "pos",
  disregarded: "quiet",
  duplicate_closed: "quiet",
};

export const STEP_GLYPHS: Record<StepKind, string> = {
  duplicate: "⚠",
  outside_target: "✕",
  disqualified: "✕",
  category_unclear: "?",
  provider_closed: "⚠",
  on_hold: "⏸",
  ready: "✓",
  unverified: "⚠",
  research_running: "◔",
  not_researched: "○",
  research_failed: "⚠",
  research_incomplete: "◑",
  approved: "✓",
  disregarded: "✕",
  duplicate_closed: "↔",
};
