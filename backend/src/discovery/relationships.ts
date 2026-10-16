import { normalizeDomain, phoneKey, streetKey, suiteKey } from "./normalize.js";

/*
 * Duplicate relationships that keep a candidate out of Ready (automation discovery@d2).
 * Detection (dedupe.ts) flags only the newer record of a pair, so the record a flag points
 * at must check incoming flags itself. Nothing here resolves, merges or changes anything:
 * a person answers each question on the candidate page.
 *
 *   blocking  an unresolved duplicate flag pointing here, directly or through a chain of flags
 *             (including through a record already closed as a duplicate of this one); an exact
 *             phone shared with an active candidate; the same website with the same street
 *             address or phone; the same street address and the same suite
 *   peers     the same website at a different address and phone: a multi-location brand, not a
 *             duplicate, so this location must prove its own address (research/location.ts)
 *   warnings  the same street address without a suite match (a multi-tenant building)
 *
 * A pair a person resolved as "not a duplicate" never blocks.
 */

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["discovered", "researching", "researched", "needs_review"]);

export interface RelationshipRow {
  id: string;
  businessName: string;
  status: string;
  website: string | null;
  phone: string | null;
  providerPhone?: string | null;
  streetAddress?: string | null;
  possibleDuplicateCandidateId?: string | null;
  duplicateDecision?: string | null;
}

export interface Relationships {
  blocking: string[];
  multiLocationPeers: string[];
  warnings: string[];
}

const label = (r: RelationshipRow) => `${r.businessName} (${r.id.slice(0, 8)})`;
const phones = (r: RelationshipRow) => new Set([phoneKey(r.phone), phoneKey(r.providerPhone)].filter((k): k is string => Boolean(k)));
const pendingFlag = (r: RelationshipRow) => Boolean(r.possibleDuplicateCandidateId) && r.duplicateDecision !== "not_duplicate";

/** A person resolved this pair as different businesses. */
const resolvedApart = (a: RelationshipRow, b: RelationshipRow) =>
  (a.possibleDuplicateCandidateId === b.id && a.duplicateDecision === "not_duplicate") || (b.possibleDuplicateCandidateId === a.id && b.duplicateDecision === "not_duplicate");

export function duplicateRelationships(
  subject: { id: string; businessName?: string | null; website?: string | null; phone?: string | null; providerPhone?: string | null; streetAddress?: string | null; possibleDuplicateCandidateId?: string | null },
  rows: readonly RelationshipRow[],
): Relationships {
  // The index row carries the status and duplicate decision; a subject outside it is treated as active.
  const self: RelationshipRow = rows.find((r) => r.id === subject.id) ?? {
    ...subject,
    businessName: subject.businessName ?? "",
    status: "discovered",
    website: subject.website ?? null,
    phone: subject.phone ?? null,
  };
  const out: Relationships = { blocking: [], multiLocationPeers: [], warnings: [] };

  // Incoming flags, followed through every record that points (directly or via a chain) at this one.
  const pointingAt = new Map<string, RelationshipRow[]>();
  for (const r of rows) {
    if (!r.possibleDuplicateCandidateId || r.id === self.id) continue;
    pointingAt.set(r.possibleDuplicateCandidateId, [...(pointingAt.get(r.possibleDuplicateCandidateId) ?? []), r]);
  }
  const seen = new Set([self.id]);
  const queue = [self.id];
  while (queue.length) {
    for (const r of pointingAt.get(queue.shift()!) ?? []) {
      if (seen.has(r.id) || r.duplicateDecision === "not_duplicate") continue;
      seen.add(r.id);
      if (ACTIVE_STATUSES.has(r.status) && pendingFlag(r)) out.blocking.push(`Unresolved possible-duplicate flag from ${label(r)}.`);
      queue.push(r.id);
    }
  }

  const domain = normalizeDomain(self.website);
  const street = streetKey(self.streetAddress);
  const suite = suiteKey(self.streetAddress);
  const ownPhones = phones(self);
  for (const r of rows) {
    if (r.id === self.id || !ACTIVE_STATUSES.has(r.status) || resolvedApart(self, r)) continue;
    const samePhone = [...phones(r)].some((k) => ownPhones.has(k));
    const sameStreet = Boolean(street) && streetKey(r.streetAddress) === street;
    const otherSuite = suiteKey(r.streetAddress);
    const sameDomain = Boolean(domain) && normalizeDomain(r.website) === domain;
    if (samePhone) out.blocking.push(`Same phone number as ${label(r)}.`);
    if (sameDomain && (sameStreet || samePhone)) out.blocking.push(`Same website and ${sameStreet ? "street address" : "phone"} as ${label(r)}.`);
    else if (sameDomain) out.multiLocationPeers.push(label(r));
    if (sameStreet && !sameDomain && !samePhone) {
      if (suite && otherSuite && suite === otherSuite) out.blocking.push(`Same street address and suite as ${label(r)}.`);
      else out.warnings.push(`Same street address as ${label(r)}${suite && otherSuite ? " (a different suite)" : ""}: likely a multi-tenant building.`);
    }
  }
  out.blocking = [...new Set(out.blocking)];
  return out;
}
