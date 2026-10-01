/*
 * Deterministic duplicate detection. No fuzzy or AI matching beyond a
 * documented name-similarity rule, always combined with other evidence.
 *
 * CONFIDENT_DUPLICATE (the incoming record is skipped, not stored):
 *   A. the same provider and external ID;
 *   B. the same website domain at the same physical location with a
 *      similar name (or, when neither record has an address or position,
 *      the same website, a similar name, and the same city);
 *   F'. the same phone with a similar name at the same location;
 *   the same (similar) name at the same physical location.
 *
 * REVIEW_REQUIRED (the record IS stored and flagged for a human):
 *   - the same website at the same location under a different name;
 *   - the same website where the location can't be confirmed;
 *   - the same phone number;
 *   - the same name in the same city (location not proven different);
 *   - a similar name within 150 m.
 *
 * RELATED (not a duplicate; both are kept, and the link is a research hint):
 *   C. the same website at a materially different location: a second
 *      location of a multi-location business or a chain;
 *   - the same name in the same city at a proven different location.
 *
 * Directory, locator, and shared parts/manufacturer domains never identify
 * a business (normalizeDomain returns null for them), so a shared domain of
 * that kind can't merge two shops (rule D).
 *
 * When evidence is ambiguous the rules prefer flagging for review over
 * discarding: a distinct business must never disappear silently.
 */
import { namesMatchStrongly, namesSimilar } from "./normalize.js";

export interface LocationKeys {
  locationKey: string | null;
  streetKey?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface MatchKeys extends LocationKeys {
  id: string;
  kind: "candidate" | "prospect";
  provider?: string | null;
  externalId?: string | null;
  domainKey: string | null;
  nameKey: string;
  phoneKey: string | null;
}

export interface IncomingKeys extends LocationKeys {
  provider: string;
  externalId: string | null;
  domainKey: string | null;
  nameKey: string;
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
   * REVIEW_REQUIRED: weak or ambiguous evidence; the record is kept and flagged.
   * NO_MATCH: no duplicate evidence (a RELATED link may still be set).
   */
  outcome: Outcome;
  /** Confident: skip the incoming record. */
  duplicateOf: Match | null;
  /** Possible: keep the record, flag it. At most one per kind. */
  possibleCandidate: Match | null;
  possibleProspect: Match | null;
  /** Not a duplicate: another location sharing the website (or name). */
  relatedCandidate: Match | null;
  relatedProspect: Match | null;
}

/** Same spot: within this distance two records describe one premises. */
export const SAME_SPOT_METERS = 75;
/** Nearby: a similar name this close is worth a human look. */
export const NEARBY_METERS = 150;
/** Different: at least this far apart is a different location. */
export const DIFFERENT_PLACE_METERS = 250;

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const r = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * r, dLon = (b.longitude - a.longitude) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const hasPoint = (k: LocationKeys): k is LocationKeys & { latitude: number; longitude: number } =>
  typeof k.latitude === "number" && typeof k.longitude === "number";

export type PlaceComparison = { place: "same" | "different" | "unknown"; meters: number | null; evidence: boolean };

/**
 * Whether two records are at the same physical location. `evidence` is true
 * when the answer rests on a position or a street address (not just a city).
 */
export function comparePlace(a: LocationKeys, b: LocationKeys): PlaceComparison {
  if (hasPoint(a) && hasPoint(b)) {
    const m = distanceMeters(a, b);
    let place: PlaceComparison["place"] = m <= SAME_SPOT_METERS ? "same" : m >= DIFFERENT_PLACE_METERS ? "different" : "unknown";
    // Close together but at different street addresses: neighbours on a
    // strip or units in a complex, not proof of one place.
    if (place === "same" && a.streetKey && b.streetKey && a.streetKey !== b.streetKey) place = "unknown";
    return { place, meters: m, evidence: true };
  }
  if (a.streetKey && b.streetKey) {
    const sameStreet = a.streetKey === b.streetKey;
    const cityConflict = a.locationKey && b.locationKey && a.locationKey !== b.locationKey;
    return { place: sameStreet && !cityConflict ? "same" : "different", meters: null, evidence: true };
  }
  if (a.locationKey && b.locationKey && a.locationKey !== b.locationKey) {
    return { place: "different", meters: null, evidence: false };
  }
  return { place: "unknown", meters: null, evidence: false };
}

type Strength = "confident" | "review" | "related";

/** The strongest relationship between an incoming record and one existing record. */
export function relate(incoming: IncomingKeys, e: MatchKeys): { strength: Strength; reason: string } | null {
  // A. Same provider record.
  if (e.kind === "candidate" && incoming.externalId && e.externalId === incoming.externalId && e.provider === incoming.provider) {
    return { strength: "confident", reason: "same provider record" };
  }
  const where = comparePlace(incoming, e);
  const similar = namesSimilar(incoming.nameKey, e.nameKey);
  const sameCity = Boolean(incoming.locationKey && incoming.locationKey === e.locationKey);
  const results: { strength: Strength; reason: string }[] = [];

  // B, C, D. Website domain (shared infrastructure never gets a domainKey).
  if (incoming.domainKey && incoming.domainKey === e.domainKey) {
    if (where.place === "same") {
      results.push(
        similar
          ? { strength: "confident", reason: "same website and location" }
          : { strength: "review", reason: "same website and location, different name" },
      );
    } else if (where.place === "different") {
      results.push({ strength: "related", reason: "same website, different location" });
    } else if (!where.evidence && sameCity && similar) {
      results.push({ strength: "confident", reason: "same website, name and city" });
    } else {
      results.push({ strength: "review", reason: "same website, location unconfirmed" });
    }
  }

  // F. Phone.
  if (incoming.phoneKey && incoming.phoneKey === e.phoneKey) {
    results.push(
      where.place === "same" && where.evidence && similar
        ? { strength: "confident", reason: "same phone, name and location" }
        : { strength: "review", reason: "same phone number" },
    );
  }

  // E, G. Name with location. With no website or phone to corroborate, only
  // a strong name match at a confirmed place is confident; a weaker one is
  // flagged for review, never skipped.
  if (similar) {
    const placeWords = [incoming.locationKey, e.locationKey].flatMap((k) => (k ? k.split("|")[0]!.split(" ") : []));
    if (where.place === "same" && where.evidence && namesMatchStrongly(incoming.nameKey, e.nameKey, placeWords)) {
      results.push({ strength: "confident", reason: "same name at the same location" });
    } else if (where.place === "same" && where.evidence) {
      results.push({ strength: "review", reason: "similar name at the same location" });
    } else if (where.meters !== null && where.meters <= NEARBY_METERS) {
      results.push({ strength: "review", reason: "similar name nearby" });
    } else if (sameCity && incoming.nameKey === e.nameKey) {
      results.push(
        where.place === "different" && where.evidence
          ? { strength: "related", reason: "same name, different location" }
          : { strength: "review", reason: "same name and city" },
      );
    }
  }

  const rank: Record<Strength, number> = { confident: 3, review: 2, related: 1 };
  return results.sort((a, b) => rank[b.strength] - rank[a.strength])[0] ?? null;
}

/**
 * `existing` should list candidates before prospects, so a match against
 * another candidate is reported in preference to a prospect.
 */
export function classifyMatch(incoming: IncomingKeys, existing: readonly MatchKeys[]): Verdict {
  const v: Verdict = {
    outcome: "NO_MATCH",
    duplicateOf: null,
    possibleCandidate: null,
    possibleProspect: null,
    relatedCandidate: null,
    relatedProspect: null,
  };
  for (const e of existing) {
    const r = relate(incoming, e);
    if (!r) continue;
    const m: Match = { kind: e.kind, id: e.id, reason: r.reason };
    if (r.strength === "confident") v.duplicateOf ??= m;
    else if (r.strength === "review") {
      if (e.kind === "candidate") v.possibleCandidate ??= m;
      else v.possibleProspect ??= m;
    } else if (e.kind === "candidate") v.relatedCandidate ??= m;
    else v.relatedProspect ??= m;
  }
  v.outcome = v.duplicateOf ? "CONFIDENT_DUPLICATE" : v.possibleCandidate || v.possibleProspect ? "REVIEW_REQUIRED" : "NO_MATCH";
  return v;
}

/** Human-readable reason for the single flag stored on a candidate. */
export function flagReason(v: Verdict): string | null {
  const parts = [
    v.possibleCandidate && `candidate: ${v.possibleCandidate.reason}`,
    v.possibleProspect && `prospect: ${v.possibleProspect.reason}`,
  ].filter(Boolean);
  return parts.length ? parts.join("; ").slice(0, 120) : null;
}

/** Human-readable reason for a related (non-duplicate) link. */
export function relationReason(v: Verdict): string | null {
  const parts = [
    v.relatedCandidate && `candidate: ${v.relatedCandidate.reason}`,
    v.relatedProspect && `prospect: ${v.relatedProspect.reason}`,
  ].filter(Boolean);
  return parts.length ? parts.join("; ").slice(0, 120) : null;
}

/** Grid cell size in degrees (~220 m of latitude); neighbours cover NEARBY_METERS. */
const CELL = 0.002;
const cellOf = (lat: number, lon: number) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

/**
 * An index over existing records so each incoming record is compared only
 * with records that could possibly relate to it (same provider ID, domain,
 * phone, name, street, or a nearby grid cell). Returns exactly the records
 * classifyMatch could match, in the same order, so results are identical to
 * a full scan, which a state-sized import couldn't afford.
 */
export class MatchIndex {
  private readonly entries: MatchKeys[] = [];
  private readonly maps = new Map<string, number[]>();

  constructor(existing: Iterable<MatchKeys> = []) {
    for (const e of existing) this.add(e);
  }

  get size() {
    return this.entries.length;
  }

  private put(key: string, i: number) {
    const list = this.maps.get(key);
    if (list) list.push(i);
    else this.maps.set(key, [i]);
  }

  add(e: MatchKeys) {
    const i = this.entries.push(e) - 1;
    if (e.provider && e.externalId) this.put(`x|${e.provider}|${e.externalId}`, i);
    if (e.domainKey) this.put(`d|${e.domainKey}`, i);
    if (e.phoneKey) this.put(`p|${e.phoneKey}`, i);
    if (e.nameKey) this.put(`n|${e.nameKey}`, i);
    if (e.streetKey) this.put(`s|${e.streetKey}`, i);
    if (hasPoint(e)) this.put(`c|${cellOf(e.latitude, e.longitude)}`, i);
  }

  /** The existing records that could relate to `k`, candidates before prospects. */
  candidatesFor(k: IncomingKeys): MatchKeys[] {
    const hits = new Set<number>();
    const take = (key: string) => this.maps.get(key)?.forEach((i) => hits.add(i));
    if (k.externalId) take(`x|${k.provider}|${k.externalId}`);
    if (k.domainKey) take(`d|${k.domainKey}`);
    if (k.phoneKey) take(`p|${k.phoneKey}`);
    if (k.nameKey) take(`n|${k.nameKey}`);
    if (k.streetKey) take(`s|${k.streetKey}`);
    if (hasPoint(k)) {
      const [y, x] = [Math.floor(k.latitude / CELL), Math.floor(k.longitude / CELL)];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) take(`c|${y + dy}:${x + dx}`);
    }
    return [...hits]
      .sort((a, b) => a - b)
      .map((i) => this.entries[i]!)
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "candidate" ? -1 : 1));
  }

  classify(k: IncomingKeys): Verdict {
    return classifyMatch(k, this.candidatesFor(k));
  }
}
