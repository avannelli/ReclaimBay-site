/*
 * Normalization for discovered businesses: cleaning provider output, and the
 * deterministic keys that deduplication compares. Reuses the prospect
 * validators, so the rules that protect a manually entered prospect also
 * protect a discovered one.
 */
import { normalizeUrl, parseProspectInput } from "../prospects.js";
import type { DiscoveredBusiness } from "./types.js";

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
];

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

export const isListingHost = (host: string) => LISTING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/** The identity of a business's own website (host without www), or null. */
export function normalizeDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  const normalized = normalizeUrl(url);
  const host = normalized ? hostOf(normalized) : null;
  if (!host || isListingHost(host)) return null;
  return host;
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

/** Null without a city: a name alone is too weak to match on. */
export function locationKey(city: string | null | undefined, state: string | null | undefined): string | null {
  const c = city ? normalizeName(city) : "";
  if (!c) return null;
  return `${c}|${(state ?? "").trim().toUpperCase()}`;
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
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  phoneSourceUrl: string | null;
  sourceUrl: string | null;
  externalId: string | null;
}

const trimmed = (v: string | null | undefined, max: number): string | null => {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Cleans one provider record with the same validators as the prospect form.
 * A value that fails validation is dropped rather than stored; a record with
 * no usable name is rejected. A website that is really a listing/social page
 * is dropped, since it would wrongly satisfy "has a website".
 */
export function cleanDiscovered(
  raw: DiscoveredBusiness,
): { ok: true; value: CleanedBusiness } | { ok: false; reason: string } {
  const businessName = trimmed(raw.businessName, 120);
  if (!businessName || !normalizeName(businessName)) return { ok: false, reason: "no business name" };

  const sourceUrlRaw = trimmed(raw.sourceUrl, 500);
  const sourceUrl = sourceUrlRaw ? normalizeUrl(sourceUrlRaw) : null;

  let website = trimmed(raw.website, 200);
  if (website) {
    const host = hostOf(normalizeUrl(website) ?? "");
    if (!host || isListingHost(host)) website = null;
  }
  const phone = trimmed(raw.phone, 30);
  const phoneSource = phone && sourceUrl ? sourceUrl : "";

  const base = {
    businessName,
    city: trimmed(raw.city, 100) ?? "",
    state: trimmed(raw.state, 50) ?? "",
    postalCode: trimmed(raw.postalCode, 20) ?? "",
    country: trimmed(raw.country, 2) ?? "US",
  };
  // Most complete first; fall back by dropping whatever fails validation.
  const attempts: Record<string, string>[] = [
    { website: website ?? "", phone: phone ?? "", phoneSourceUrl: phoneSource },
    { website: website ?? "" },
    { phone: phone ?? "", phoneSourceUrl: phoneSource },
    {},
  ];
  for (const extra of attempts) {
    const { input, errors } = parseProspectInput({ ...base, ...extra });
    if (errors.length) continue;
    const f = input.fields;
    return {
      ok: true,
      value: {
        businessName: f.businessName ?? businessName,
        website: f.website,
        city: f.city,
        state: f.state,
        postalCode: f.postalCode,
        country: f.country,
        phone: f.phone,
        phoneSourceUrl: f.phoneSourceUrl,
        sourceUrl,
        externalId: trimmed(raw.externalId, 200),
      },
    };
  }
  return { ok: false, reason: "invalid fields" };
}
