/*
 * Sourcing: from one county's provider records, the businesses in one area worth prescreening.
 * The filters are Targeted Outreach 03's: core repair category, the area's cities or ZIP codes, a
 * website, not closed, provider confidence of at least 0.5, no chain or franchise dealer, and nothing
 * already known: not a candidate or prospect (by provider ID, or as the same business by the existing
 * identity matcher), not on a known domain, and never a record screened before (ScreeningEntry is unique).
 */
import { MatchIndex } from "../discovery/dedupe.js";
import { cleanDiscovered, normalizeDomain } from "../discovery/normalize.js";
import { identityKeys, type Identity } from "../discovery/protection.js";
import type { StagedPlace } from "../discovery/types.js";
import { inArea, UNSUITABLE_SOURCE, type Area } from "./policy.js";

export type SourceSkip =
  | "not_core"
  | "outside_area"
  | "no_website"
  | "closed"
  | "low_confidence"
  | "unsuitable_segment"
  | "already_screened"
  | "invalid"
  | "known_business";

export interface SourceContext {
  provider: string;
  index: MatchIndex;
  domains: Set<string>;
  /** Provider IDs already screened (any batch) or already candidates. */
  knownIds: Set<string>;
}

/** The existing candidates and prospects as the identity matcher and domain set the filters use. */
export function sourceContext(provider: string, known: { candidates: Identity[]; prospects: Identity[]; screenedIds: Iterable<string> }): SourceContext {
  const index = new MatchIndex([
    ...known.candidates.map((c) => ({ ...identityKeys(c), id: c.id, kind: "candidate" as const })),
    ...known.prospects.map((p) => ({ ...identityKeys(p), id: p.id, kind: "prospect" as const })),
  ]);
  const domains = new Set([...known.candidates, ...known.prospects].map((c) => normalizeDomain(c.website)).filter((d): d is string => !!d));
  const knownIds = new Set(known.screenedIds);
  for (const c of known.candidates) if (c.externalId && (c.provider ?? provider) === provider) knownIds.add(c.externalId);
  return { provider, index, domains, knownIds };
}

/** Why a record is not prescreened, or null when it should be. */
export function sourceSkip(p: StagedPlace, area: Area, ctx: SourceContext): SourceSkip | null {
  if (p.categoryTier !== "core") return "not_core";
  if (!inArea(p, area)) return "outside_area";
  if (!p.website) return "no_website";
  if (p.operatingStatus === "permanently_closed" || p.operatingStatus === "temporarily_closed") return "closed";
  if (p.confidence !== null && p.confidence !== undefined && p.confidence < 0.5) return "low_confidence";
  if (UNSUITABLE_SOURCE.test(`${p.businessName} ${p.brand ?? ""}`)) return "unsuitable_segment";
  if (ctx.knownIds.has(p.externalId)) return "already_screened";
  const clean = cleanDiscovered(p);
  if (!clean.ok || !clean.value.website) return "invalid";
  if (knownBusiness(p, ctx)) return "known_business";
  return null;
}

const keysOf = (p: StagedPlace, provider: string) =>
  identityKeys({ ...p, id: p.externalId, provider, phone: p.phone ?? null, website: p.website ?? null, city: p.city ?? null, state: p.state ?? null });

/** Whether the existing identity matcher (any verdict but a clean no-match) or a known domain says this business is already known. */
export function knownBusiness(p: StagedPlace, ctx: SourceContext): boolean {
  const verdict = ctx.index.classify(keysOf(p, ctx.provider));
  const domain = normalizeDomain(p.website);
  return verdict.outcome !== "NO_MATCH" || Boolean(verdict.relatedCandidate || verdict.relatedProspect) || Boolean(domain && ctx.domains.has(domain));
}

/** Records a selected business so a second record for it (or its domain) is never selected too. */
export function remember(p: StagedPlace, ctx: SourceContext) {
  ctx.index.add({ ...keysOf(p, ctx.provider), id: `screening:${p.externalId}`, kind: "candidate" });
  ctx.knownIds.add(p.externalId);
  const domain = normalizeDomain(p.website);
  if (domain) ctx.domains.add(domain);
}

export interface SourceResult {
  selected: StagedPlace[];
  read: number;
  skipped: Partial<Record<SourceSkip, number>>;
  /** True when the whole county was read: the area has nothing more to give in this release. */
  exhausted: boolean;
}

/**
 * Reads batches until `businesses` are selected or `sourceRows` read. Each selected record is added to
 * the matcher, so two provider rows for one business (or one domain) are never both selected.
 */
export async function selectFromSource(
  batches: AsyncIterable<StagedPlace[]>,
  area: Area,
  ctx: SourceContext,
  limits: { businesses: number; sourceRows: number },
): Promise<SourceResult> {
  const result: SourceResult = { selected: [], read: 0, skipped: {}, exhausted: true };
  outer: for await (const batch of batches) {
    for (const p of batch) {
      if (result.selected.length >= limits.businesses || result.read >= limits.sourceRows) {
        result.exhausted = false;
        break outer;
      }
      result.read++;
      const skip = sourceSkip(p, area, ctx);
      if (skip) {
        result.skipped[skip] = (result.skipped[skip] ?? 0) + 1;
        continue;
      }
      result.selected.push(p);
      remember(p, ctx);
    }
  }
  return result;
}
