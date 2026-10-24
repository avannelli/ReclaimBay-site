/*
 * Supply replenishment policy: when to look for new businesses, where, and how much it may cost.
 *
 * Replenishment only finds and prescreens businesses and adds the qualifying ones to Discovery.
 * Research, qualification, eligibility, protection and every outreach rule stay exactly as they are:
 * a business added here is researched and judged like any other candidate. The prescreen below is an
 * extra filter in front of Discovery (it can only keep businesses out), never a substitute for Research.
 *
 * The defaults reproduce Targeted Outreach 03 (100 screened, 19 ingested, 6 eligible). Every limit has
 * a hard ceiling that a stored configuration cannot exceed.
 */
import { isCountyName, STATE_FIPS } from "../discovery/boundaries.js";
import { isOvertureRelease } from "../discovery/overture.js";

export const LIMIT_BOUNDS = {
  /** Businesses prescreened per batch. */
  businesses: { default: 60, min: 1, max: 100 },
  /** Physical HTTP requests (redirects, robots.txt and retries each count) per batch. */
  fetches: { default: 600, min: 10, max: 1_000 },
  /** Response bytes per batch. */
  bytes: { default: 60_000_000, min: 1_000_000, max: 150_000_000 },
  /** Physical HTTP requests one business may use; reserved in full before it is screened. */
  perBusinessFetches: { default: 25, min: 5, max: 40 },
  /** Response bytes one business may use; reserved in full before it is screened. */
  perBusinessBytes: { default: 8_000_000, min: 1_500_000, max: 10_000_000 },
  /** Pages of a business's site read at prescreen (the research crawler's own maximum is 5). */
  pagesPerBusiness: { default: 5, min: 1, max: 5 },
  /** Provider rows read while sourcing one batch. */
  sourceRows: { default: 25_000, min: 100, max: 50_000 },
  /** Batches started in any rolling 24 hours. */
  batchesPerDay: { default: 4, min: 1, max: 12 },
  /** Physical HTTP requests across all batches in any rolling 24 hours. */
  fetchesPerDay: { default: 1_500, min: 10, max: 3_000 },
  /** Minimum minutes between the start of two batches. */
  cooldownMinutes: { default: 60, min: 15, max: 1_440 },
  /** Businesses screened at once (each site still gets the crawler's per-host pacing). */
  concurrency: { default: 3, min: 1, max: 4 },
} as const;

export type Limits = { [K in keyof typeof LIMIT_BOUNDS]: number };

/** Replenish when eligible plus still-in-research supply is below this. */
export const SUPPLY_BOUNDS = { default: 10, min: 1, max: 50 } as const;

export interface Area {
  /** Stable key, recorded on every batch (lowercase, digits and dashes). */
  key: string;
  label: string;
  state: string;
  county: string;
  /** Lowercase city names as providers write them. */
  cities: string[];
  /** Five-digit ZIP codes. A record is in the area when its city OR its ZIP matches. */
  zips: string[];
}

export interface ReplenishmentConfig {
  provider: "overture";
  /** "latest" (the newest published release) or an exact Overture release. */
  release: string;
  lowSupply: number;
  /**
   * Prescreen keeps only businesses whose official site publishes an email. Stricter than Targeted
   * Outreach 03 (which also kept businesses without one): a business with no email can never become
   * eligible for outreach, so researching it spends budget for nothing.
   */
  requirePublishedEmail: boolean;
  /** Rotation order: the area least recently sourced goes next. */
  areas: Area[];
  limits: Limits;
}

/*
 * Default rotation: the West San Fernando Valley area proven by Targeted Outreach 03, then the
 * neighbouring areas of Ventura County (the project's validated region) and northern Los Angeles County.
 * A stored configuration may reorder, narrow or replace it.
 */
export const DEFAULT_AREAS: Area[] = [
  {
    key: "la-west-sfv", label: "West San Fernando Valley, Agoura Hills and Calabasas", state: "CA", county: "Los Angeles County",
    cities: ["agoura hills", "calabasas", "hidden hills", "canoga park", "west hills", "chatsworth", "reseda", "tarzana", "encino", "woodland hills", "winnetka", "northridge", "porter ranch"],
    zips: ["91301", "91302", "91372", "91303", "91304", "91305", "91309", "91307", "91308", "91311", "91313", "91335", "91337", "91356", "91357", "91316", "91416", "91426", "91436", "91364", "91365", "91367", "91371", "91306", "91396", "91324", "91325", "91326", "91327", "91328", "91330"],
  },
  {
    key: "ventura-conejo", label: "Thousand Oaks, Newbury Park, Westlake Village and Oak Park", state: "CA", county: "Ventura County",
    cities: ["thousand oaks", "newbury park", "westlake village", "oak park"],
    zips: ["91320", "91358", "91359", "91360", "91361", "91362", "91377"],
  },
  {
    key: "ventura-simi-moorpark", label: "Simi Valley and Moorpark", state: "CA", county: "Ventura County",
    cities: ["simi valley", "moorpark"],
    zips: ["93062", "93063", "93064", "93065", "93094", "93099", "93020", "93021"],
  },
  {
    key: "ventura-camarillo-oxnard", label: "Camarillo, Oxnard and Port Hueneme", state: "CA", county: "Ventura County",
    cities: ["camarillo", "somis", "oxnard", "port hueneme"],
    zips: ["93010", "93011", "93012", "93066", "93030", "93031", "93032", "93033", "93034", "93035", "93036", "93041", "93044"],
  },
  {
    key: "ventura-west", label: "Ventura, Ojai, Santa Paula and Fillmore", state: "CA", county: "Ventura County",
    cities: ["ventura", "san buenaventura", "ojai", "oak view", "santa paula", "fillmore", "piru"],
    zips: ["93001", "93002", "93003", "93004", "93005", "93006", "93007", "93009", "93022", "93023", "93024", "93060", "93061", "93015", "93016", "93040"],
  },
  {
    key: "la-santa-clarita", label: "Santa Clarita Valley", state: "CA", county: "Los Angeles County",
    cities: ["santa clarita", "valencia", "newhall", "saugus", "canyon country", "stevenson ranch", "castaic"],
    zips: ["91321", "91322", "91350", "91351", "91354", "91355", "91380", "91381", "91382", "91383", "91384", "91385", "91386", "91387", "91390"],
  },
  {
    key: "la-east-sfv", label: "East San Fernando Valley", state: "CA", county: "Los Angeles County",
    cities: ["van nuys", "sherman oaks", "studio city", "north hollywood", "valley village", "panorama city", "sun valley", "arleta", "pacoima", "sylmar", "mission hills", "granada hills", "north hills", "lake balboa"],
    zips: ["91401", "91402", "91403", "91404", "91405", "91406", "91407", "91408", "91409", "91411", "91423", "91601", "91602", "91604", "91605", "91606", "91607", "91352", "91331", "91342", "91343", "91344", "91345", "91340"],
  },
];

export function defaultConfig(): ReplenishmentConfig {
  return {
    provider: "overture",
    release: "latest",
    lowSupply: SUPPLY_BOUNDS.default,
    requirePublishedEmail: true,
    areas: DEFAULT_AREAS.map((a) => ({ ...a, cities: [...a.cities], zips: [...a.zips] })),
    limits: Object.fromEntries(Object.entries(LIMIT_BOUNDS).map(([k, b]) => [k, b.default])) as Limits,
  };
}

const AREA_KEY = /^[a-z0-9][a-z0-9-]{1,59}$/;
const CITY = /^[a-z][a-z .'-]{1,80}$/;

function bounded(name: string, value: unknown, b: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < b.min || value > b.max) {
    throw new Error(`Invalid replenishment setting ${name}: a whole number from ${b.min} to ${b.max} is required.`);
  }
  return value;
}

function validArea(raw: unknown): Area {
  const a = raw as Partial<Area> | null;
  if (!a || typeof a.key !== "string" || !AREA_KEY.test(a.key)) throw new Error("Each area needs a key: lowercase letters, digits and dashes.");
  if (typeof a.label !== "string" || !a.label.trim() || a.label.length > 120) throw new Error(`Area ${a.key}: a label of at most 120 characters is required.`);
  if (typeof a.state !== "string" || !STATE_FIPS[a.state]) throw new Error(`Area ${a.key}: a two-letter US state is required.`);
  if (typeof a.county !== "string" || !isCountyName(a.county) || !/ County$/.test(a.county.trim())) throw new Error(`Area ${a.key}: a county such as "Ventura County" is required.`);
  const cities = Array.isArray(a.cities) ? [...new Set(a.cities.map((c) => String(c).trim().toLowerCase()))] : [];
  const zips = Array.isArray(a.zips) ? [...new Set(a.zips.map((z) => String(z).trim()))] : [];
  if (cities.some((c) => !CITY.test(c)) || cities.length > 40) throw new Error(`Area ${a.key}: at most 40 city names, letters only.`);
  if (zips.some((z) => !/^\d{5}$/.test(z)) || zips.length > 60) throw new Error(`Area ${a.key}: at most 60 five-digit ZIP codes.`);
  if (!cities.length && !zips.length) throw new Error(`Area ${a.key}: at least one city or ZIP code is required.`);
  return { key: a.key, label: a.label.trim(), state: a.state, county: a.county.trim(), cities, zips };
}

/** A stored override merged over the defaults and checked against every hard bound. Throws on anything invalid. */
export function resolveConfig(stored: unknown): ReplenishmentConfig {
  const base = defaultConfig();
  if (stored === null || stored === undefined) return base;
  if (typeof stored !== "object" || Array.isArray(stored)) throw new Error("The stored replenishment configuration must be an object.");
  const s = stored as Partial<ReplenishmentConfig> & { limits?: Partial<Limits> };
  const known = new Set(["provider", "release", "lowSupply", "requirePublishedEmail", "areas", "limits"]);
  const unknown = Object.keys(s).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`Unknown replenishment setting(s): ${unknown.join(", ")}.`);
  if (s.provider !== undefined && s.provider !== "overture") throw new Error("Only the Overture provider is supported.");
  const release = s.release ?? base.release;
  if (release !== "latest" && !isOvertureRelease(release)) throw new Error('release must be "latest" or an exact Overture release such as 2026-10-21.0.');
  const limits = { ...base.limits };
  for (const [k, v] of Object.entries(s.limits ?? {})) {
    if (!(k in LIMIT_BOUNDS)) throw new Error(`Unknown replenishment limit ${k}.`);
    limits[k as keyof Limits] = bounded(k, v, LIMIT_BOUNDS[k as keyof Limits]);
  }
  if (limits.perBusinessFetches > limits.fetches || limits.perBusinessBytes > limits.bytes || limits.fetches > limits.fetchesPerDay) {
    throw new Error("A per-business limit cannot exceed its batch limit, and a batch's requests cannot exceed the daily limit.");
  }
  const areas = s.areas === undefined ? base.areas : Array.isArray(s.areas) ? s.areas.map(validArea) : [];
  if (!areas.length || areas.length > 20) throw new Error("Between 1 and 20 areas are required.");
  if (new Set(areas.map((a) => a.key)).size !== areas.length) throw new Error("Area keys must be distinct.");
  if (s.requirePublishedEmail !== undefined && typeof s.requirePublishedEmail !== "boolean") throw new Error("requirePublishedEmail must be true or false.");
  return {
    provider: "overture",
    release,
    lowSupply: s.lowSupply === undefined ? base.lowSupply : bounded("lowSupply", s.lowSupply, SUPPLY_BOUNDS),
    requirePublishedEmail: s.requirePublishedEmail ?? base.requirePublishedEmail,
    areas,
    limits,
  };
}

export const needsSupply = (supply: number, config: Pick<ReplenishmentConfig, "lowSupply">) => supply < config.lowSupply;

/** Whether a provider record lies in an area: its city or its ZIP code. */
export function inArea(place: { city?: string | null; postalCode?: string | null; state?: string | null; county?: string | null }, area: Area): boolean {
  if (place.state && place.state !== area.state) return false;
  if (place.county && place.county !== area.county) return false;
  const city = place.city?.trim().toLowerCase() ?? "";
  const zip = String(place.postalCode ?? "").trim().slice(0, 5);
  return (city !== "" && area.cities.includes(city)) || (zip !== "" && area.zips.includes(zip));
}

/*
 * Source exclusions only (Targeted Outreach 03's list): national chains, franchises and franchise
 * dealers are never sourced. This keeps them out of Discovery; it is not a change to acquisition policy,
 * which still holds any chain Research finds for a person.
 */
export const UNSUITABLE_SOURCE =
  /\b(?:classic collision|caliber|gerber|maaco|midas|meineke|firestone|jiffy|valvoline|pep boys|aamco|service king|crash champions|tesla|rivian|dealership|fleet|truck center|big o|goodyear|discount tire|ntb|christian brothers|precision tune|brakes plus|just brakes|take 5|grease monkey|fix auto|carstar|abra|earl scheib|monro|les schwab|america'?s tire|costco|walmart|sears)\b|\b(?:toyota|honda|ford|chevrolet|nissan|bmw|mercedes-benz|lexus|audi|porsche|volkswagen|subaru|hyundai|kia|mazda|infiniti|acura|cadillac|jeep|chrysler|lincoln|volvo|jaguar|land rover|mini|genesis)\s+of\b/i;

/** Thrown when a budget, limit or control stops replenishment on purpose: not a failure. */
export class ReplenishmentStop extends Error {}

/** A message safe to store and print: no URLs or connection strings. */
export const safeReason = (e: unknown) =>
  (e instanceof Error ? e.message : "Unexpected replenishment error").replace(/(?:https?|postgres(?:ql)?|s3):\/\/\S+/g, "[url]").slice(0, 500);
