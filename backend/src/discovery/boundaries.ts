/*
 * County boundaries for geographically scoped imports.
 *
 * The boundary comes from the US Census Bureau's TIGERweb service (public
 * domain). Overture's own divisions theme is not used here: it includes
 * OpenStreetMap data under the ODbL, and joining it to places would bring
 * share-alike obligations to the result.
 */

/** [minLon, minLat, maxLon, maxLat] */
export type BBox = [number, number, number, number];

/** A polygon as rings of [lon, lat]; the first ring is the outline, the rest are holes. */
export type Polygon = [number, number][][];

export interface Boundary {
  /** The official name, e.g. "Ventura County". */
  name: string;
  /** Two-letter state, e.g. "CA". */
  state: string;
  /** Census GEOID (state + county FIPS), e.g. "06111". */
  geoid: string;
  bbox: BBox;
  polygons: Polygon[];
}

/** State and territory FIPS codes, by postal abbreviation. */
export const STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", DC: "11", FL: "12",
  GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23",
  MD: "24", MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33",
  NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
  SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
  WY: "56", PR: "72",
};

const COUNTY_SUFFIX = /\s+(county|parish|borough|census area|municipality|city and borough)$/i;

/** "Ventura County", "ventura" -> "ventura". Used in import scope keys. */
export function countySlug(county: string): string {
  return county
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(COUNTY_SUFFIX, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** County names are plain words: letters, spaces, periods, apostrophes, hyphens. */
export const isCountyName = (s: string) => /^[A-Za-z][A-Za-z .'-]{1,60}$/.test(s.trim());

/** Even-odd ray casting over every ring, so holes are excluded. */
function inPolygon(p: Polygon, lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of p) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function inBoundary(b: Pick<Boundary, "bbox" | "polygons">, lon: number, lat: number): boolean {
  const [x0, y0, x1, y1] = b.bbox;
  if (lon < x0 || lon > x1 || lat < y0 || lat > y1) return false;
  return b.polygons.some((p) => inPolygon(p, lon, lat));
}

export function bboxOf(polygons: Polygon[]): BBox {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polygons) {
    for (const [x, y] of p[0] ?? []) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
  }
  return box;
}

/** Reads a GeoJSON Polygon or MultiPolygon geometry. */
export function polygonsOf(geometry: unknown): Polygon[] {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (g?.type === "Polygon") return [g.coordinates as Polygon];
  if (g?.type === "MultiPolygon") return g.coordinates as Polygon[];
  throw new Error(`Unsupported boundary geometry: ${g?.type ?? "none"}`);
}

const TIGERWEB_COUNTIES =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query";

type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`boundary service returned HTTP ${res.status}`);
  return res.json();
};

/** Fetches one county's boundary from the Census TIGERweb service. */
export async function fetchCountyBoundary(state: string, county: string, fetchJson: FetchJson = defaultFetchJson): Promise<Boundary> {
  const fips = STATE_FIPS[state.toUpperCase()];
  if (!fips) throw new Error(`Unknown state "${state}".`);
  if (!isCountyName(county)) throw new Error(`"${county}" doesn't look like a county name.`);
  const base = county.trim().replace(COUNTY_SUFFIX, "").replace(/'/g, "''");
  const where = `STATE='${fips}' AND (BASENAME='${base}' OR NAME='${county.trim().replace(/'/g, "''")}')`;
  const url = `${TIGERWEB_COUNTIES}?${new URLSearchParams({
    where,
    outFields: "GEOID,NAME,BASENAME,STATE",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  })}`;
  const body = (await fetchJson(url)) as { features?: { properties?: Record<string, string>; geometry?: unknown }[] };
  const features = body.features ?? [];
  if (features.length !== 1) {
    throw new Error(`Expected one county named "${county}" in ${state}, found ${features.length}.`);
  }
  const f = features[0]!;
  const polygons = polygonsOf(f.geometry);
  return {
    name: f.properties?.NAME ?? county.trim(),
    state: state.toUpperCase(),
    geoid: f.properties?.GEOID ?? "",
    bbox: bboxOf(polygons),
    polygons,
  };
}
