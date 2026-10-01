/*
 * Overture Maps Places as a discovery provider.
 *
 *   Overture release (GeoParquet on Overture's public S3 bucket)
 *     -> read only the county's bounding box (overtureSource.ts, DuckDB)
 *     -> keep places inside the county boundary (boundaries.ts)
 *     -> keep repair-related categories (categories.ts overtureTier)
 *     -> minimized StagedPlace rows -> staging (staging.ts runImport)
 *
 * Runs only as a background job (npm run discovery:import), never in a
 * request. Overture identity: the place `id` is its GERS ID, stored as the
 * candidate's externalId. It identifies the place; it says nothing about
 * ownership or fit.
 *
 * Data license: Places is CDLA-Permissive-2.0, with some records Apache-2.0
 * (Foursquare) or CC0 (AllThePlaces), per record in `sources`; it contains
 * no OpenStreetMap data. Attribution: "Overture Maps Foundation,
 * overturemaps.org". Each record's upstream datasets and licenses are kept
 * (StagedPlace.sources) so attribution stays possible per record.
 */
import { countySlug, fetchCountyBoundary, inBoundary, type BBox, type Boundary } from "./boundaries.js";
import { overtureTier } from "./categories.js";
import { isOwnWebsiteHost } from "./normalize.js";
import type { ImportScope, ImportStats, ProviderImporter, ProviderOperatingStatus, StagedPlace } from "./types.js";

export const OVERTURE = "overture";
export const OVERTURE_STAC = "https://stac.overturemaps.org/catalog.json";
export const OVERTURE_PLACES_PATH = (release: string) => `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/`;

/** Overture release names, e.g. "2026-09-23.1". */
export const isOvertureRelease = (r: string) => /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(r);

/** The columns read from Overture Places (see overtureSource.ts for the query). */
export interface OvertureRow {
  id: string | null;
  name: string | null;
  taxonomy: { primary?: string | null; hierarchy?: string[] | null; alternates?: string[] | null } | null;
  confidence: number | null;
  operating_status: string | null;
  websites: string[] | null;
  phones: string[] | null;
  brand: string | null;
  addresses: { freeform?: string | null; locality?: string | null; postcode?: string | null; region?: string | null; country?: string | null }[] | null;
  sources: { dataset?: string | null; license?: string | null }[] | null;
  lon: number | null;
  lat: number | null;
}

/** Reads the places inside a bounding box, in batches. */
export interface OvertureSource {
  query(release: string, bbox: BBox): AsyncIterable<OvertureRow[]>;
}

type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Overture release catalog returned HTTP ${res.status}`);
  return res.json();
};

/**
 * Turns "latest" or an explicit release into a release that Overture
 * currently publishes, using Overture's STAC release catalog. Overture
 * keeps only recent releases (about two months), so an old release is
 * refused with the list of available ones.
 */
export async function resolveOvertureRelease(requested: string, fetchJson: FetchJson = defaultFetchJson): Promise<string> {
  const want = requested.trim();
  if (want !== "latest" && !isOvertureRelease(want)) {
    throw new Error(`"${want}" is not an Overture release name (expected e.g. 2026-09-23.1, or "latest").`);
  }
  const catalog = (await fetchJson(OVERTURE_STAC)) as { latest?: string; links?: { rel?: string; href?: string }[] };
  const available = (catalog.links ?? [])
    .filter((l) => l.rel === "child")
    .map((l) => /\/(\d{4}-\d{2}-\d{2}\.\d{1,3})\//.exec(l.href ?? "")?.[1])
    .filter((r): r is string => Boolean(r))
    .sort();
  if (want === "latest") {
    const latest = catalog.latest ?? available.at(-1);
    if (!latest || !isOvertureRelease(latest)) throw new Error("Overture's release catalog did not name a latest release.");
    return latest;
  }
  if (!available.includes(want)) {
    throw new Error(`Overture release ${want} is not available. Available: ${available.join(", ") || "none"}.`);
  }
  return want;
}

const clip = (v: unknown, max: number): string | null => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
};

const STATUSES: readonly ProviderOperatingStatus[] = ["open", "temporarily_closed", "permanently_closed"];

/** "CA" and "US-CA" both mean California (Overture documents ISO 3166-2; the data uses both). */
export function stateOf(region: string | null | undefined): string | null {
  const m = /^(?:US-)?([A-Z]{2})$/i.exec(region?.trim() ?? "");
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * The upstream datasets and licenses a record was assembled from, e.g.
 * "meta (CDLA-Permissive-2.0); Foursquare (Apache-2.0)". Overture's own
 * derived entries (confidence, operating-status signals) are left out.
 */
export function sourcesOf(sources: OvertureRow["sources"]): string | null {
  const seen = new Set<string>();
  for (const s of sources ?? []) {
    const dataset = clip(s?.dataset, 40);
    if (!dataset || /^overture/i.test(dataset)) continue;
    const license = clip(s?.license, 40);
    seen.add(license ? `${dataset} (${license})` : dataset);
  }
  return seen.size ? [...seen].join("; ").slice(0, 200) : null;
}

/** Drops the query string and fragment: tracking parameters (utm_*, yext) are not part of a site. */
function withoutQuery(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** The first website that is the business's own (not a social, listing, or locator page), without tracking parameters. */
export function websiteOf(websites: OvertureRow["websites"]): string | null {
  for (const w of websites ?? []) {
    const url = clip(w, 500);
    if (url && isOwnWebsiteHost(url)) return withoutQuery(url).slice(0, 200);
  }
  return null;
}

/** A name that is only a street, e.g. "E Los Angeles Ave" or "West 5th Street". */
const STREET_LABEL =
  /^(?:(?:n|s|e|w|north|south|east|west)\.?\s+)?[a-z0-9 .'-]*?\b(?:ave|avenue|blvd|boulevard|st|street|rd|road|dr|drive|way|ln|lane|pkwy|parkway|hwy|highway|cir|circle|ct|court|pl|place)\.?$/i;

/**
 * Some upstream sources name a chain's branch by its street ("E Thompson
 * Blvd") and put the business in `brand`. Those become "Jiffy Lube (E
 * Thompson Blvd)". A name is only rewritten when a brand is present and the
 * name is nothing but a street, so an independent shop is never renamed.
 */
export function displayName(name: string, brand: string | null): string {
  if (!brand || !STREET_LABEL.test(name) || name.toLowerCase().includes(brand.toLowerCase())) return name;
  return `${brand} (${name})`.slice(0, 120);
}

export type SkipReason =
  | "malformed"
  | "outside_area"
  | "no_category"
  | "not_automotive"
  | "excluded_automotive"
  | "alternate_only";

export interface MapContext {
  boundary: Pick<Boundary, "name" | "state" | "bbox" | "polygons">;
}

/**
 * Maps one Overture row to a staged place, or says why it was left out.
 * Only business and location fields are kept; emails, socials, and the raw
 * record are dropped. The phone is kept as the provider's (unverified) phone.
 */
export function mapOvertureRow(row: OvertureRow, ctx: MapContext): { place: StagedPlace } | { skip: SkipReason; category?: string | null } {
  const externalId = clip(row.id, 200);
  const businessName = clip(row.name, 120);
  const { lon, lat } = row;
  const coordsOk =
    typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  if (!externalId || !businessName || !coordsOk) return { skip: "malformed" };
  if (!inBoundary(ctx.boundary, lon, lat)) return { skip: "outside_area" };

  const cls = overtureTier(row.taxonomy);
  if (!cls.tier) return { skip: cls.reason, category: cls.category };

  const brand = clip(row.brand, 120);
  const address = (row.addresses ?? []).find((a) => a && (!a.country || a.country.toUpperCase() === "US")) ?? null;
  const status = clip(row.operating_status, 30)?.toLowerCase() as ProviderOperatingStatus | undefined;
  const confidence = typeof row.confidence === "number" && row.confidence >= 0 && row.confidence <= 1 ? row.confidence : null;
  return {
    place: {
      externalId,
      businessName: displayName(businessName, brand),
      website: websiteOf(row.websites),
      phone: clip(row.phones?.[0], 30),
      streetAddress: clip(address?.freeform, 200),
      city: clip(address?.locality, 100),
      county: ctx.boundary.name,
      // The boundary is authoritative for where the place is, so the state
      // comes from it rather than from the address's own region.
      state: ctx.boundary.state,
      postalCode: clip(address?.postcode, 20),
      country: "US",
      latitude: lat,
      longitude: lon,
      category: cls.category,
      categoryTier: cls.tier,
      brand,
      confidence,
      operatingStatus: status && STATUSES.includes(status) ? status : null,
      // Overture has no public page per place; the GERS ID and release are the reference.
      sourceUrl: null,
      sources: sourcesOf(row.sources),
    },
  };
}

export interface OvertureImporterDeps {
  /** Where rows come from. Defaults to Overture's S3 bucket via DuckDB. */
  source?: OvertureSource;
  /** County boundary lookup. Defaults to the Census TIGERweb service. */
  boundary?: (state: string, county: string) => Promise<Boundary>;
  fetchJson?: FetchJson;
}

/**
 * The Overture importer. Deliberately one county at a time: a statewide or
 * national import is refused until it has been sized and scheduled.
 */
export function createOvertureImporter(deps: OvertureImporterDeps = {}): ProviderImporter {
  const boundaryOf = deps.boundary ?? ((state: string, county: string) => fetchCountyBoundary(state, county));
  return {
    provider: OVERTURE,
    label: "Overture Maps Places",
    resolveRelease: (requested) => resolveOvertureRelease(requested, deps.fetchJson),
    checkScope(scope: ImportScope) {
      if (!scope.county) return "Overture imports are limited to one county at a time (pass --county).";
      return null;
    },
    async *fetch(release: string, scope: ImportScope, stats: ImportStats = {}) {
      if (!isOvertureRelease(release)) throw new Error(`Not an Overture release: ${release}`);
      const state = scope.region.split("-")[1] ?? "";
      const boundary = await boundaryOf(state, scope.county ?? "");
      const source = deps.source ?? (await import("./overtureSource.js")).duckdbOvertureSource();
      Object.assign(stats, {
        source: OVERTURE_PLACES_PATH(release),
        boundary: `US Census TIGERweb county ${boundary.geoid} (${boundary.name}, ${boundary.state})`,
        areaSlug: countySlug(boundary.name),
        read: 0,
        staged: 0,
        repeatedId: 0,
        malformed: 0,
        outside_area: 0,
        no_category: 0,
        not_automotive: 0,
        excluded_automotive: 0,
        alternate_only: 0,
      });
      const bump = (key: string) => (stats[key] = Number(stats[key] ?? 0) + 1);
      const seen = new Set<string>();
      for await (const rows of source.query(release, boundary.bbox)) {
        const out: StagedPlace[] = [];
        for (const row of rows) {
          bump("read");
          const r = mapOvertureRow(row, { boundary });
          if ("skip" in r) {
            bump(r.skip);
            if (r.skip === "excluded_automotive" && r.category) bump(`excluded:${r.category}`);
            continue;
          }
          if (seen.has(r.place.externalId)) {
            bump("repeatedId");
            continue;
          }
          seen.add(r.place.externalId);
          bump("staged");
          bump(`tier:${r.place.categoryTier}`);
          out.push(r.place);
        }
        if (out.length) yield out;
      }
    },
  };
}
