/*
 * Normalization for discovered businesses: cleaning provider output, and the
 * deterministic keys that deduplication compares. Reuses the prospect
 * validators, so the rules that protect a manually entered prospect also
 * protect a discovered one.
 */
import { isPhoneNumber, normalizeUrl, parseProspectInput } from "../prospects.js";
import type { CategoryTier, DiscoveredBusiness, ProviderOperatingStatus } from "./types.js";

/**
 * Hosts that serve many businesses' pages. A link to one of them is not a
 * business's own website, so it never counts as "has a website" and never
 * identifies a business by domain.
 */
const LISTING_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "yelp.com",
  "yellowpages.com",
  "mapquest.com",
  "google.com",
  "goo.gl",
  "bbb.org",
  "nextdoor.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "linktr.ee",
  "angi.com",
  "manta.com",
  // Directories and messaging links seen in provider data.
  "hub.biz",
  "wa.me",
  "whatsapp.com",
  // Seen in Overture data for Ventura County: a directory, a placeholder, and
  // webmail hosts given as a "website". None identifies a business.
  "superpages.com",
  "listyourwebsite.com",
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
];

/**
 * Shared infrastructure: parts/manufacturer programs and store locators that
 * list many independent shops under one domain. Seen in the Ventura County
 * bake-off (e.g. locations.autovalue.com, acdelco.com). Like listing hosts,
 * they are never a business's own website and never identify a business.
 */
const SHARED_DOMAINS = ["acdelco.com", "autovalue.com", "napaautocare.com", "napaonline.com", "carquest.com"];
const LOCATOR_PREFIXES = ["locations.", "location.", "stores.", "store.", "local.", "find.", "dealers.", "dealer."];

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

const isUnder = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export const isListingHost = (host: string) => LISTING_HOSTS.some((h) => isUnder(host, h));

/** A locator subdomain or a shared parts/manufacturer domain. */
export const isSharedDomain = (host: string) =>
  SHARED_DOMAINS.some((d) => isUnder(host, d)) || LOCATOR_PREFIXES.some((p) => host.startsWith(p));

/** Whether a URL can be a business's own website (not a listing, locator, or shared domain). */
export function isOwnWebsiteHost(url: string | null | undefined): boolean {
  if (!url) return false;
  const host = hostOf(normalizeUrl(url) ?? "");
  return Boolean(host) && !isListingHost(host!) && !isSharedDomain(host!);
}

/** The identity of a business's own website (host without www), or null. */
export function normalizeDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  const normalized = normalizeUrl(url);
  const host = normalized ? hostOf(normalized) : null;
  if (!host || isListingHost(host) || isSharedDomain(host)) return null;
  return host;
}

/** Whether `url` is a page on the business's own website `website`. */
export function isOnBusinessSite(url: string | null | undefined, website: string | null | undefined): boolean {
  const site = normalizeDomain(website);
  const host = url ? hostOf(normalizeUrl(url) ?? "") : null;
  return Boolean(site && host && isUnder(host, site));
}

const LEGAL_SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "corp", "corporation", "co"]);

/**
 * Lowercased, accent-free, punctuation-free name without legal suffixes.
 * Deliberately NOT stripping words like "auto" or "repair": "Smith Auto" and
 * "Smith Auto Body" must stay different.
 */
export function normalizeName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  if (words.length > 1 && words[0] === "the") words.shift();
  return words.join(" ");
}

/** Words too generic to tell two repair businesses apart. */
const GENERIC_WORDS = new Set([
  "auto", "autos", "automotive", "repair", "repairs", "service", "services", "center", "centre", "car", "cars",
  "care", "shop", "garage", "and", "of", "complete", "tire", "tires", "inc", "llc", "co",
]);

const distinctive = (name: string) => normalizeName(name).split(" ").filter((t) => t && !GENERIC_WORDS.has(t));

const editDistance = (a: string, b: string) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
};

/**
 * Whether two business names plausibly name the same business: identical
 * after normalization, or sharing at least half of their distinctive words
 * (one typo allowed in longer words). "Bender's Automotive" ~ "Benders Auto",
 * but "Smith Auto" is not ~ "Jones Auto".
 */
export function namesSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const A = distinctive(a), B = distinctive(b);
  if (!A.length || !B.length) return false;
  const hits = A.filter((x) => B.some((y) => x === y || (x.length > 4 && y.length > 4 && editDistance(x, y) <= 1))).length;
  return hits / Math.min(A.length, B.length) >= 0.5;
}

/**
 * The stricter test used when a name and a location are the ONLY evidence
 * (no shared website or phone): identical after normalization, or shared
 * distinctive words covering at least half of EACH name. Words that name
 * the place itself (e.g. the city) don't count. So "Skyline Auto Repair
 * LLC" matches "Skyline Auto Repair", but "Santa Paula Auto Center" does not
 * match "Santa Paula Automotive Machine Shop", nor "Chevo's Diesel
 * Performance" match "Performance Transmissions".
 */
export function namesMatchStrongly(
  a: string | null | undefined,
  b: string | null | undefined,
  placeWords: Iterable<string> = [],
): boolean {
  if (!a || !b) return false;
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const place = new Set(placeWords);
  const A = distinctive(a).filter((t) => !place.has(t));
  const B = distinctive(b).filter((t) => !place.has(t));
  if (!A.length || !B.length) return false;
  const hits = A.filter((x) => B.some((y) => x === y || (x.length > 4 && y.length > 4 && editDistance(x, y) <= 1))).length;
  return hits / Math.max(A.length, B.length) >= 0.5;
}

/** Null without a city: a name alone is too weak to match on. */
export function locationKey(city: string | null | undefined, state: string | null | undefined): string | null {
  const c = city ? normalizeName(city) : "";
  if (!c) return null;
  return `${c}|${(state ?? "").trim().toUpperCase()}`;
}

const STREET_WORDS: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", boulevard: "blvd", drive: "dr", road: "rd", lane: "ln", court: "ct",
  place: "pl", parkway: "pkwy", highway: "hwy", circle: "cir", way: "way", north: "n", south: "s", east: "e", west: "w",
};

/** House number + street, comparable across providers; suite/unit ignored. Null if unusable. */
export function streetKey(street: string | null | undefined): string | null {
  if (!street) return null;
  const base = street.toLowerCase().split(/\s*(?:#|\bsuite\b|\bste\b|\bunit\b|\bapt\b|,)\s*/)[0] ?? "";
  const words = base.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).map((w) => STREET_WORDS[w] ?? w);
  if (words.length < 2 || !/\d/.test(words[0]!)) return null;
  return words.join(" ");
}

/** Ten digits, or null when the number isn't a complete US-style number. */
export function phoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

export interface CleanedBusiness {
  businessName: string;
  website: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  /** Unverified provider-reported phone. Never the business's public phone. */
  providerPhone: string | null;
  sourceUrl: string | null;
  externalId: string | null;
  category: string | null;
  categoryTier: CategoryTier | null;
  brand: string | null;
  confidence: number | null;
  operatingStatus: ProviderOperatingStatus | null;
  retrievedAt: Date | null;
  release: string | null;
  /** Upstream datasets and licenses (provenance / attribution only). */
  sources: string | null;
}

const trimmed = (v: string | null | undefined, max: number): string | null => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
};

/** Valid WGS84 coordinates, or nulls. (0, 0) is treated as missing. */
export function cleanCoordinates(lat: unknown, lon: unknown): { latitude: number | null; longitude: number | null } {
  const a = typeof lat === "number" ? lat : NaN, o = typeof lon === "number" ? lon : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(o) || Math.abs(a) > 90 || Math.abs(o) > 180 || (a === 0 && o === 0)) {
    return { latitude: null, longitude: null };
  }
  return { latitude: Math.round(a * 1e6) / 1e6, longitude: Math.round(o * 1e6) / 1e6 };
}

/** Provider wording -> one of our three statuses, or null when unknown. */
export function cleanOperatingStatus(v: unknown): ProviderOperatingStatus | null {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (s === "open" || s === "operating") return "open";
  if (s === "temporarily_closed") return "temporarily_closed";
  if (s === "permanently_closed" || s === "closed") return "permanently_closed";
  return null;
}

const cleanConfidence = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);
const cleanTier = (v: unknown): CategoryTier | null => (v === "core" || v === "adjacent" ? v : null);
const cleanDate = (v: unknown) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v : null);

/**
 * Cleans one provider record with the same validators as the prospect form.
 * A value that fails validation is dropped rather than stored; a record with
 * no usable name is rejected. A website that is really a listing, social,
 * locator, or shared program page is dropped, since it isn't the business's
 * own site. The provider's phone is kept only as unverified provider contact.
 */
export function cleanDiscovered(
  raw: DiscoveredBusiness,
): { ok: true; value: CleanedBusiness } | { ok: false; reason: string } {
  const businessName = trimmed(raw.businessName, 120);
  if (!businessName || !normalizeName(businessName)) return { ok: false, reason: "no business name" };

  const sourceUrlRaw = trimmed(raw.sourceUrl, 500);
  const sourceUrl = sourceUrlRaw ? normalizeUrl(sourceUrlRaw) : null;

  let website = trimmed(raw.website, 200);
  if (website && !isOwnWebsiteHost(website)) website = null;
  const phone = trimmed(raw.phone, 30);

  const base = {
    businessName,
    city: trimmed(raw.city, 100) ?? "",
    state: trimmed(raw.state, 50) ?? "",
    postalCode: trimmed(raw.postalCode, 20) ?? "",
    country: trimmed(raw.country, 2) ?? "US",
  };
  // Most complete first; fall back by dropping whatever fails validation.
  const attempts: Record<string, string>[] = [{ website: website ?? "" }, {}];
  for (const extra of attempts) {
    const { input, errors } = parseProspectInput({ ...base, ...extra });
    if (errors.length) continue;
    const f = input.fields;
    return {
      ok: true,
      value: {
        businessName: f.businessName ?? businessName,
        website: f.website,
        streetAddress: trimmed(raw.streetAddress, 200),
        city: f.city,
        state: f.state,
        postalCode: f.postalCode,
        country: f.country,
        ...cleanCoordinates(raw.latitude, raw.longitude),
        providerPhone: phone && isPhoneNumber(phone) ? phone : null,
        sourceUrl,
        externalId: trimmed(raw.externalId, 200),
        category: trimmed(raw.category, 100),
        categoryTier: cleanTier(raw.categoryTier),
        brand: trimmed(raw.brand, 120),
        confidence: cleanConfidence(raw.confidence),
        operatingStatus: cleanOperatingStatus(raw.operatingStatus),
        retrievedAt: cleanDate(raw.retrievedAt),
        release: trimmed(raw.release, 64),
        sources: trimmed(raw.sources, 200),
      },
    };
  }
  return { ok: false, reason: "invalid fields" };
}
