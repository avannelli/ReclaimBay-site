/*
 * Deterministic duplicate detection. No fuzzy or AI matching.
 *
 * CONFIDENT duplicates (the incoming record is skipped, not stored):
 *   1. the same provider and external ID, or
 *   2. the same website domain (business-owned domains only; listing and
 *      social hosts never identify a business).
 *
 * POSSIBLE duplicates (the record IS stored, flagged for a human):
 *   3. the same normalized name in the same city and state, or
 *   4. the same ten-digit phone number.
 *
 * A shared name or phone can be two real businesses (a second location, a
 * relocated shop, a shared switchboard), so those are never dropped silently.
 */

export interface MatchKeys {
  id: string;
  kind: "candidate" | "prospect";
  provider?: string | null;
  externalId?: string | null;
  domainKey: string | null;
  nameKey: string;
  locationKey: string | null;
  phoneKey: string | null;
}

export interface IncomingKeys {
  provider: string;
  externalId: string | null;
  domainKey: string | null;
  nameKey: string;
  locationKey: string | null;
  phoneKey: string | null;
}

export interface Match {
  kind: "candidate" | "prospect";
  id: string;
  reason: string;
}

export type Outcome = "CONFIDENT_DUPLICATE" | "REVIEW_REQUIRED" | "NO_MATCH";

export interface Verdict {
  /**
   * CONFIDENT_DUPLICATE: strong evidence; the incoming record is skipped.
   * REVIEW_REQUIRED: weak evidence; the record is kept and flagged for a human.
   * NO_MATCH: nothing overlaps.
   */
  outcome: Outcome;
  /** Confident: skip the incoming record. */
  duplicateOf: Match | null;
  /** Possible: keep the record, flag it. At most one per kind. */
  possibleCandidate: Match | null;
  possibleProspect: Match | null;
}

/**
 * `existing` should list candidates before prospects, so a confident match
 * against another candidate is reported in preference to a prospect.
 */
export function classifyMatch(incoming: IncomingKeys, existing: readonly MatchKeys[]): Verdict {
  let duplicateOf: Match | null = null;
  let possibleCandidate: Match | null = null;
  let possibleProspect: Match | null = null;

  for (const e of existing) {
    if (!duplicateOf) {
      if (
        e.kind === "candidate" &&
        incoming.externalId &&
        e.externalId === incoming.externalId &&
        e.provider === incoming.provider
      ) {
        duplicateOf = { kind: e.kind, id: e.id, reason: "same provider record" };
      } else if (incoming.domainKey && e.domainKey === incoming.domainKey) {
        duplicateOf = { kind: e.kind, id: e.id, reason: "same website domain" };
      }
    }
    const possible =
      incoming.locationKey && e.nameKey === incoming.nameKey && e.locationKey === incoming.locationKey
        ? "same name and city"
        : incoming.phoneKey && e.phoneKey === incoming.phoneKey
          ? "same phone number"
          : null;
    if (possible) {
      if (e.kind === "candidate" && !possibleCandidate) possibleCandidate = { kind: e.kind, id: e.id, reason: possible };
      if (e.kind === "prospect" && !possibleProspect) possibleProspect = { kind: e.kind, id: e.id, reason: possible };
    }
  }
  const outcome: Outcome = duplicateOf
    ? "CONFIDENT_DUPLICATE"
    : possibleCandidate || possibleProspect
      ? "REVIEW_REQUIRED"
      : "NO_MATCH";
  return { outcome, duplicateOf, possibleCandidate, possibleProspect };
}

/** Human-readable reason for the single flag stored on a candidate. */
export function flagReason(v: Verdict): string | null {
  const parts = [
    v.possibleCandidate && `candidate: ${v.possibleCandidate.reason}`,
    v.possibleProspect && `prospect: ${v.possibleProspect.reason}`,
  ].filter(Boolean);
  return parts.length ? parts.join("; ").slice(0, 120) : null;
}
