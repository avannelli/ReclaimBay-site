/*
 * A person's review of a possible duplicate. Pure rules; the service applies them.
 *
 * Duplicate detection (dedupe.ts) is unchanged: a weak or ambiguous match is
 * stored as a flag (possibleDuplicateCandidateId / possibleDuplicateProspectId
 * and duplicateReason) and the candidate waits in Needs review. This module
 * only names where that question stands and what a person may answer:
 *
 *   possible        flagged, nobody has answered
 *   unresolved      a person looked and left it open (the hold stays)
 *   not_duplicate   a person said it is a different business (the hold is lifted)
 *   duplicate       a person confirmed it (candidate status `duplicate`)
 *   none            nothing was flagged
 *
 * The flag itself is never cleared: it stays as the record of what the check
 * found, next to the decision.
 */
import type { CandidateStatus } from "./candidateStatus.js";

export type DuplicateState = "none" | "possible" | "unresolved" | "not_duplicate" | "duplicate";

export const DUPLICATE_DECISIONS = ["not_duplicate", "duplicate", "unresolved"] as const;
export type DuplicateAnswer = (typeof DUPLICATE_DECISIONS)[number];
export const isDuplicateAnswer = (v: string): v is DuplicateAnswer => (DUPLICATE_DECISIONS as readonly string[]).includes(v);

export interface DuplicateFlag {
  status: CandidateStatus;
  possibleDuplicateCandidateId: string | null;
  possibleDuplicateProspectId: string | null;
  duplicateDecision: "not_duplicate" | "unresolved" | null;
}

export const isFlagged = (c: DuplicateFlag) => Boolean(c.possibleDuplicateCandidateId || c.possibleDuplicateProspectId);

export function duplicateState(c: DuplicateFlag): DuplicateState {
  if (c.status === "duplicate") return "duplicate";
  if (!isFlagged(c)) return "none";
  return c.duplicateDecision ?? "possible";
}

/** Still waiting on a person: approval should not be the next step. */
export const duplicatePending = (c: DuplicateFlag) => ["possible", "unresolved"].includes(duplicateState(c));

export const DUPLICATE_STATE_LABELS: Record<DuplicateState, string> = {
  none: "No duplicate concern",
  possible: "Possible duplicate",
  unresolved: "Duplicate question unresolved",
  not_duplicate: "Not a duplicate",
  duplicate: "Duplicate",
};

/**
 * The detection rule's reason, as a person would say it. Reasons come from
 * dedupe.ts (relate); anything unrecognised is shown as written.
 */
const REASON_TEXT: Record<string, string> = {
  "same website and location, different name": "Same website and address, different name",
  "same website, location unconfirmed": "Same website; location not confirmed",
  "same phone number": "Same phone number",
  "same name and city": "Same name in the same city",
  "similar name at the same location": "Similar name at the same address",
  "similar name nearby": "Similar name within 150 m",
};

export interface MatchReason {
  kind: "candidate" | "prospect";
  text: string;
}

/** Parses the stored "candidate: …; prospect: …" reason into plain sentences. */
export function matchReasons(duplicateReason: string | null): MatchReason[] {
  if (!duplicateReason) return [];
  return duplicateReason
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(candidate|prospect):\s*(.+)$/.exec(part);
      const kind = (m?.[1] ?? "candidate") as MatchReason["kind"];
      const raw = (m?.[2] ?? part).trim();
      const text = REASON_TEXT[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
      return { kind, text };
    });
}
