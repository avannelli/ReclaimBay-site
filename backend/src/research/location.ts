import { addressMatchKey } from "../discovery/normalize.js";

/*
 * Location-aware identity (research r16). Evidence is attributed to the candidate's own
 * physical location, never to "any page on the same domain".
 *
 *   own_location   (A) shows the business name and THIS candidate's street address: identity and service evidence
 *   own_site       (B) a single-location site's page without an address: service evidence; identity when the
 *                  provider's phone is listed on the site
 *   brand          (C) a multi-location site's shared page: service evidence only once A established identity
 *   other_location (D) shows one other street address and not this one: never evidence for this candidate
 *   other_business (E) the business name is nowhere on the site: never evidence
 *
 * A site that lists other addresses must show this candidate's address before its identity is accepted,
 * and identity never rests on a phone the site does not list (a conflicting phone).
 */

export type PageLocation = "own_location" | "own_site" | "brand" | "other_location" | "other_business";
export type LocationIdentity = "verified_location" | "single_location_site" | "unverified" | "other_location" | "mismatch";

export const STRONG_IDENTITY: readonly LocationIdentity[] = ["verified_location", "single_location_site"];
export const isStrongIdentity = (identity: string | null | undefined) => STRONG_IDENTITY.includes(identity as LocationIdentity);

/** Pages whose quotes may count as service evidence under each identity. */
export function evidencePageAllowed(page: PageLocation | null | undefined, identity: LocationIdentity | string | null | undefined): boolean {
  if (identity === "verified_location") return page === "own_location" || page === "own_site" || page === "brand";
  if (identity === "single_location_site") return page === "own_location" || page === "own_site";
  return false;
}

const SUFFIX = "(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|ter|terrace|trl|trail|sq|square)";
const ADDRESS_IN_TEXT = new RegExp(String.raw`\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][\w'.]*(?:\s+[A-Za-z][\w'.]*){0,3}?\s+${SUFFIX}\b`, "gi");

/** A year in a copyright or founding notice ("© 2025 Saviers Road Auto Repair", "Since 1988"): never a house number. */
const NOTICE_YEAR = /(?:©|\(c\)|\bcopyright\b(?:\s*©)?|\bsince\b|\best\.?|\bestablished\b|\bfounded\b)\s*(?:(?:19|20)\d{2}\s*[-–—]\s*)?(?:19|20)\d{2}\b/gi;

/** Street addresses written in page text or structured data, as comparable keys. */
export function addressKeysIn(text: string, structured: readonly (string | null | undefined)[] = []): string[] {
  const keys = new Set<string>();
  for (const s of structured) {
    const k = addressMatchKey(s);
    if (k) keys.add(k);
  }
  // The notice becomes a separator, so the ZIP code before it can't join the name after it.
  const plain = text.replace(NOTICE_YEAR, " ; ");
  for (const m of plain.matchAll(ADDRESS_IN_TEXT)) {
    // A ZIP code after a state ("CA 93033 Saviers Road Auto Repair") is not a house number.
    if (/^\d{5}\s/.test(m[0]) && /\b[A-Z]{2},?\s+$/.test(plain.slice(Math.max(0, m.index - 4), m.index))) continue;
    const k = addressMatchKey(m[0]);
    if (k) keys.add(k);
  }
  return [...keys];
}

export interface LocationPageInput {
  url: string;
  /** The stored website's own page (what the candidate's website points to). */
  isStored: boolean;
  nameOnPage: boolean;
  /** This candidate's street address appears on the page. */
  ownAddress: boolean;
  /** Every street address the page lists (this candidate's included). */
  addressKeys: readonly string[];
}

export interface LocationResult {
  identity: LocationIdentity;
  /** Distinct street addresses on the pages read (this candidate's counted once). */
  siteLocations: number;
  pages: { url: string; location: PageLocation }[];
  reason: string;
}

export function classifyLocation(input: { subjectStreet: string | null; providerPhoneOnSite: boolean; pages: readonly LocationPageInput[] }): LocationResult {
  const ownKey = addressMatchKey(input.subjectStreet);
  const ownNumber = ownKey?.split(" ")[0];
  // Another spelling of this candidate's own address (same house number) is not another location.
  const others = (keys: readonly string[]) => keys.filter((k) => k !== ownKey && (!ownNumber || k.split(" ")[0] !== ownNumber));
  const otherKeys = new Set(input.pages.flatMap((p) => others(p.addressKeys)));
  const isOwn = (p: LocationPageInput) => p.ownAddress || (ownKey !== null && p.addressKeys.includes(ownKey));
  const ownFound = input.pages.some(isOwn);
  const siteLocations = otherKeys.size + (ownFound ? 1 : 0);
  const nameOnSite = input.pages.some((p) => p.nameOnPage);
  const pages = input.pages.map((p) => {
    const elsewhere = others(p.addressKeys);
    const location: PageLocation = !nameOnSite
      ? "other_business"
      : isOwn(p)
        ? "own_location"
        : elsewhere.length === 1
          ? "other_location"
          : elsewhere.length >= 2 || siteLocations >= 2
            ? "brand"
            : "own_site";
    return { url: p.url, location };
  });
  const stored = pages.find((p, i) => input.pages[i]!.isStored);
  let identity: LocationIdentity;
  let reason: string;
  if (!nameOnSite) {
    identity = "mismatch";
    reason = "The business name is not on the pages read.";
  } else if (ownFound) {
    identity = "verified_location";
    reason = "The site shows the business name and this location's street address.";
  } else if (stored?.location === "other_location") {
    identity = "other_location";
    reason = "The stored website is the page of another physical location of this brand.";
  } else if (otherKeys.size === 0 && input.providerPhoneOnSite) {
    identity = "single_location_site";
    reason = "A single-location site showing the business name and the provider's phone.";
  } else {
    identity = "unverified";
    reason =
      otherKeys.size > 0
        ? `The site lists ${otherKeys.size} other street address${otherKeys.size === 1 ? "" : "es"} but not this location's.`
        : "The site shows the business name but neither this address nor the provider's phone.";
  }
  return { identity, siteLocations, pages, reason };
}
