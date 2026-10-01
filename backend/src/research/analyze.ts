/*
 * Verification rules: from the pages of a business's website to verified
 * facts, signal values with evidence, and verified contact. Pure functions;
 * no network or database.
 *
 * The first question is always whether the website is the business's own:
 * the name must appear AND either its phone or its street address. Nothing
 * from a site that fails that test becomes verified contact or a signal; it
 * is reported as uncertain instead. Each signal follows its published rule
 * in src/scoring.ts, and every value carries a public URL and a short quote.
 */
import { addressMatchKey, namesMatchStrongly, namesSimilar, normalizeName, phoneKey, streetWordPattern } from "../discovery/normalize.js";
import type { SignalKey, StoredSignalValue } from "../scoring.js";
import type { ParsedPage } from "./html.js";

export type FactState = "verified" | "unverified" | "uncertain" | "not_found";

export interface Fact {
  field: string;
  value: string | null;
  state: FactState;
  confidence?: number | null;
  sourceUrl?: string | null;
  excerpt?: string | null;
  note?: string | null;
}

export interface SignalProposal {
  key: SignalKey;
  value: StoredSignalValue;
  sourceUrl: string;
  excerpt: string;
}

export interface ContactProposal {
  phone?: string;
  phoneSourceUrl?: string;
  email?: string;
  emailSourceUrl?: string;
}

/** What research knows about the candidate before it starts (provider data included). */
export interface Subject {
  businessName: string;
  website: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  providerPhone: string | null;
  providerBrand: string | null;
  providerStatus: string | null;
  provider: string;
}

export type PageRole = "home" | "contact" | "about" | "services" | "team" | "other";

export interface Page {
  url: string;
  role: PageRole;
  parsed: ParsedPage;
  /** The raw HTML, for widget detection only (scripts are stripped from `parsed`). */
  html: string;
}

export type Ownership = "verified" | "uncertain" | "mismatch";

export interface Analysis {
  ownership: Ownership;
  facts: Fact[];
  signals: SignalProposal[];
  contact: ContactProposal;
  warnings: string[];
}

const EXCERPT_MAX = 280;

/** A short quote around `at` in `text`, at most 280 characters. */
export function quote(text: string, at: number, length = 0): string {
  const pad = Math.max(40, Math.floor((240 - length) / 2));
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + length + pad);
  const s = `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
  return s.slice(0, EXCERPT_MAX);
}

const clip = (s: string, n = EXCERPT_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const formatPhone = (key: string) => `(${key.slice(0, 3)}) ${key.slice(3, 6)}-${key.slice(6)}`;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

const PHONE_IN_TEXT = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g;

/** Every phone on the site, with the page where it first appears. */
export function sitePhones(pages: Page[]): Map<string, string> {
  const found = new Map<string, string>();
  const add = (raw: string | null | undefined, url: string) => {
    const k = phoneKey(raw);
    if (k && !found.has(k)) found.set(k, url);
  };
  for (const p of pages) {
    p.parsed.tels.forEach((t) => add(t, p.url));
    p.parsed.structured.forEach((s) => add(s.telephone, p.url));
  }
  for (const p of pages) for (const m of p.parsed.text.matchAll(PHONE_IN_TEXT)) add(`${m[1]}${m[2]}${m[3]}`, p.url);
  return found;
}

const EMAIL_IN_TEXT = /\b[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,24}\b/gi;
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|sbcglobal|att|verizon|cox|charter|proton|protonmail)\.[a-z.]+$/i;
const NOT_CONTACT = /^(no-?reply|donotreply|privacy|abuse|postmaster|webmaster)@|@(sentry|wixpress|example|domain|email)\./i;

/** Emails on the site split into the business's own domain and others. */
export function siteEmails(pages: Page[], siteHost: string) {
  const own = new Map<string, string>();
  let freeMail = 0;
  let otherDomain = 0;
  const seen = new Set<string>();
  for (const p of pages) {
    const all = [...p.parsed.emails, ...p.parsed.structured.map((s) => s.email ?? ""), ...(p.parsed.text.match(EMAIL_IN_TEXT) ?? [])];
    for (const raw of all) {
      const e = raw.trim().toLowerCase();
      if (!e.includes("@") || seen.has(e) || NOT_CONTACT.test(e)) continue;
      seen.add(e);
      const domain = e.split("@")[1]!;
      if (domain === siteHost || siteHost.endsWith(`.${domain}`) || domain.endsWith(`.${siteHost}`)) {
        if (!own.has(e)) own.set(e, p.url);
      } else if (FREE_MAIL.test(domain)) freeMail++;
      else otherDomain++;
    }
  }
  return { own, freeMail, otherDomain };
}

/** The candidate's name without a branch label: "Jiffy Lube (E Thompson Blvd)" -> "Jiffy Lube". */
const coreName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;

/** Where on the site the business name appears, if it does. */
export function findName(subject: Subject, pages: Page[]): { url: string; excerpt: string; value: string } | null {
  const name = coreName(subject.businessName);
  for (const p of pages) {
    const labels = [p.parsed.siteName, p.parsed.title, ...p.parsed.structured.map((s) => s.name), ...p.parsed.headings].filter(
      (x): x is string => Boolean(x),
    );
    for (const label of labels) {
      const parts = label.split(/\s+[|–—-]\s+|\s*[|–—]\s*/).filter(Boolean);
      if (parts.some((part) => namesMatchStrongly(name, part) || namesSimilar(name, part))) {
        return { url: p.url, excerpt: clip(label), value: label.slice(0, 200) };
      }
    }
  }
  const key = normalizeName(name);
  if (key.split(" ").length >= 2) {
    for (const p of pages) {
      const i = normalizeName(p.parsed.text).indexOf(key);
      if (i >= 0) {
        const at = p.parsed.text.toLowerCase().indexOf(name.toLowerCase().split(" ")[0]!);
        return { url: p.url, excerpt: quote(p.parsed.text, Math.max(0, at), name.length), value: name };
      }
    }
  }
  return null;
}

/** Where the street address appears: house number and street name close together. */
export function findAddress(subject: Subject, pages: Page[]): { url: string; excerpt: string; index: number } | null {
  const key = addressMatchKey(subject.streetAddress);
  if (!key) return null;
  const [number, ...rest] = key.split(" ");
  const word = rest.find((w) => w.length > 2 && !["n", "s", "e", "w"].includes(w)) ?? rest[0];
  if (!number || !word) return null;
  for (const p of pages) {
    for (const s of p.parsed.structured) if (addressMatchKey(s.streetAddress) === key) return { url: p.url, excerpt: clip(`${s.streetAddress}${s.locality ? `, ${s.locality}` : ""}`), index: -1 };
    const lower = p.parsed.text.toLowerCase();
    const re = new RegExp(`\\b${number}\\b[^\\d]{1,40}?\\b${streetWordPattern(word)}`, "i");
    const m = re.exec(lower);
    if (m) return { url: p.url, excerpt: quote(p.parsed.text, m.index, m[0].length), index: m.index };
  }
  return null;
}

/**
 * The business address the site's structured data gives for this business
 * (matched by name or provider phone), when it is a single address and not
 * the provider's. Several addresses (a multi-location site) are not compared.
 */
export function differentSiteAddress(subject: Subject, pages: Page[]): { address: string; url: string } | null {
  const providerKey = addressMatchKey(subject.streetAddress);
  if (!providerKey) return null;
  const tel = phoneKey(subject.providerPhone);
  const found = new Map<string, { address: string; url: string }>();
  for (const p of pages) {
    for (const s of p.parsed.structured) {
      const key = addressMatchKey(s.streetAddress);
      if (!key) continue;
      const ours = namesSimilar(s.name, subject.businessName) || (tel !== null && phoneKey(s.telephone) === tel);
      if (!ours || found.has(key)) continue;
      found.set(key, { address: [s.streetAddress, [s.locality, s.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", "), url: p.url });
    }
  }
  const only = found.size === 1 ? [...found][0] : undefined;
  if (!only) return null;
  return only[0] === providerKey ? null : only[1];
}

// ---------- which phone belongs to this location ----------

/** Toll-free area codes: a central number, not a location's. */
const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);
const isTollFree = (key: string) => TOLL_FREE.has(key.slice(0, 3));

/** How far from the matched street address a phone still counts as "next to" it. */
const NEAR_ADDRESS = 250;

export type PhoneChoice = { key: string; url: string; how: string } | { ambiguous: string[] } | null;

/**
 * The phone of THIS location on a site that may list many. In order:
 * the provider's number when the site lists it; the phone in structured
 * data whose address is this location's; the one phone next to the matched
 * street address (or, among several there, the one in the provider
 * phone's area code); the only number in the provider phone's area code; the
 * site's only number; the only non-toll-free number. Anything else is
 * ambiguous: no number is guessed.
 */
export function choosePhone(
  subject: Subject,
  pages: Page[],
  phones: Map<string, string>,
  address: { url: string; index: number } | null,
): PhoneChoice {
  if (!phones.size) return null;
  const providerKey = phoneKey(subject.providerPhone);
  if (providerKey && phones.has(providerKey)) {
    return { key: providerKey, url: phones.get(providerKey)!, how: "the provider-reported number, listed on the business's own website" };
  }
  const street = addressMatchKey(subject.streetAddress);
  for (const p of pages) {
    for (const s of p.parsed.structured) {
      const k = phoneKey(s.telephone);
      if (k && street && addressMatchKey(s.streetAddress) === street) return { key: k, url: p.url, how: "listed with this location's address in the site's business data" };
    }
  }
  if (address && address.index >= 0) {
    const page = pages.find((p) => p.url === address.url);
    if (page) {
      const window = page.parsed.text.slice(Math.max(0, address.index - NEAR_ADDRESS), address.index + NEAR_ADDRESS);
      const near = [...new Set([...window.matchAll(PHONE_IN_TEXT)].map((m) => `${m[1]}${m[2]}${m[3]}`))];
      const local = near.filter((k) => !isTollFree(k));
      if (near.length === 1) return { key: near[0]!, url: page.url, how: "listed next to this location's street address" };
      if (local.length === 1) return { key: local[0]!, url: page.url, how: "the local number next to this location's street address" };
      // Location cards side by side: the neighbour's number can be as close
      // as this one's. The one in this location's area code decides.
      const nearArea = providerKey ? local.filter((k) => k.slice(0, 3) === providerKey.slice(0, 3)) : [];
      if (nearArea.length === 1) return { key: nearArea[0]!, url: page.url, how: "the number in this location's area code next to its street address" };
    }
  }
  const keys = [...phones.keys()];
  const local = keys.filter((k) => !isTollFree(k));
  if (providerKey) {
    const sameArea = local.filter((k) => k.slice(0, 3) === providerKey.slice(0, 3));
    if (sameArea.length === 1) return { key: sameArea[0]!, url: phones.get(sameArea[0]!)!, how: "the only number on the site in this location's area code" };
  }
  if (keys.length === 1) return { key: keys[0]!, url: phones.get(keys[0]!)!, how: "the only phone number on the business's own website" };
  if (local.length === 1) return { key: local[0]!, url: phones.get(local[0]!)!, how: "the only local number on the site (the others are toll-free)" };
  return { ambiguous: keys };
}

// ---------- signal vocabularies (from the rules in src/scoring.ts) ----------

const GENERAL_SERVICES: [string, RegExp][] = [
  ["brakes", /\bbrakes?\b/i],
  ["suspension/steering", /\b(suspension|steering|shocks?\b|struts?\b|alignment)/i],
  ["engine diagnostics", /\b(diagnostics?|diagnosis|check engine|engine repair)\b/i],
  ["maintenance/oil service", /\b(oil changes?|scheduled maintenance|factory maintenance|preventive maintenance|tune[- ]?ups?|maintenance services?)\b/i],
  ["A/C", /\b(a\/c|air[- ]condition(ing)?|ac (repair|service))\b/i],
  ["electrical", /\b(electrical|alternators?|starters?|batter(y|ies))\b/i],
  ["transmission", /\btransmissions?\b/i],
  ["cooling system", /\b(cooling systems?|radiators?|coolant|water pumps?)\b/i],
  ["exhaust", /\b(exhaust|mufflers?|catalytic converters?)\b/i],
];

const SPECIALTY_SERVICES: [string, RegExp][] = [
  ["collision/body", /\b(collision|auto ?body|body shop|dent repair|paint(less)? (and|&) body)\b/i],
  ["glass", /\b(auto glass|windshields?)\b/i],
  ["tint", /\b(window tint(ing)?)\b/i],
  ["detailing", /\b(detailing|car wash)\b/i],
  ["audio", /\b(car audio|car stereo)\b/i],
  ["towing", /\btowing\b/i],
];

/** Franchise and chain brands named in the "Independent shop" rule, and similar national chains. */
const CHAIN_BRANDS = [
  "midas", "meineke", "firestone", "jiffy lube", "pep boys", "christian brothers", "aamco", "brake masters", "valvoline",
  "take 5", "big o tires", "les schwab", "discount tire", "america's tire", "ntb", "mavis", "monro", "goodyear auto service",
  "precision tune", "grease monkey", "car-x", "caliber", "gerber collision", "maaco", "quick lane", "speedee", "oil can henry",
  "express oil", "tires plus", "sun devil", "cottman", "mr. transmission", "kwik kar", "lube stop", "american tire depot",
  "big brand tire", "just tires", "intoxalock", "lifesafer", "tesla",
];

const MAKES = [
  "acura", "audi", "bmw", "buick", "cadillac", "chevrolet", "chrysler", "dodge", "ford", "gmc", "honda", "hyundai", "infiniti",
  "jeep", "kia", "lexus", "lincoln", "mazda", "mercedes-benz", "mini", "mitsubishi", "nissan", "porsche", "ram", "subaru", "tesla",
  "toyota", "volkswagen", "volvo",
];
const MAKE_WORDS = MAKES.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
/** Words that make a "dealer" a vehicle dealer ("car dealer"), not a parts dealer. */
const VEHICLE_WORDS = "(?:new |used )?(?:car|vehicle|auto|automobile|truck|motor vehicle)s?";

/**
 * Evidence that the business sells vehicles (a dealership), from what it does
 * or says it is. The bare word "dealership", or a make in the title, is not
 * enough: independent specialists name makes and compare themselves to
 * dealers ("dealer-quality service without the dealership price").
 */
const DEALER_ACTIVITY = new RegExp(
  [
    "new (?:vehicle|car|truck|suv)s? (?:inventory|for sale|sales|specials)",
    "(?:shop|browse|search|view) (?:our )?(?:new|used|pre-owned) (?:inventory|vehicles|cars|trucks)",
    "new inventory",
    "certified pre-owned(?: (?:inventory|vehicles|cars|program))?",
    "(?:schedule|book) (?:a |your )?test drive",
    "value your trade",
    "trade[- ]in (?:value|appraisal)",
    // "Authorized dealer" only with a vehicle make or vehicle word: parts brands
    // ("Skyjacker Authorized Dealer") say it too.
    `(?:authorized|franchised|official) (?:(?:${MAKE_WORDS}) |${VEHICLE_WORDS} )dealer(?:ship)?`,
    `(?:${MAKE_WORDS}) (?:authorized|franchised|official) dealer(?:ship)?`,
    `(?:we are|is) (?:a|an|the|your) (?:[a-z-]+ ){0,3}?(?:dealership|(?:${MAKE_WORDS}|${VEHICLE_WORDS}) dealer)`,
    "(?:[a-z-]+ )?dealership (?:in|serving|located in)",
    "new (?:and|&) used (?:cars|vehicles|trucks)",
  ].join("|"),
  "gi",
);

/** Words that turn a dealer mention into a comparison ("better than the dealership"). */
const CONTRAST = /\b(than|unlike|instead of|without|vs\.?|versus|not|alternative to|compared (to|with)|like|of)\s+(a |an |the |your |any )?$/i;

const INDEPENDENT_WORDS =
  /\b(family[- ]owned|locally[- ]owned|independently[- ]owned|owner[- ]operated|privately[- ]owned|independent(?:\s+[a-z0-9&'.-]+){0,3}?\s+(?:repair|service|shop|garage|mechanic|specialist|centre|center)s?)\b/i;

const DVI_WORDS =
  /\b((digital|photo|video)(\s+(vehicle|courtesy|multi[- ]point|technician|video|photo))*\s+inspections?|dvi\b|(photo|video)s? (of|with) (your |each )?(inspection|vehicle)|inspection reports? (sent )?(by|via|through) (text|email)|(texted|emailed) inspection|autovitals|bolt on technology)\b/i;

/** A service-booking action: short link text like "Book an appointment", or a booking URL path. */
const BOOKING_TEXT = /^(?:(?:book|schedule|request|make)\b.{0,30}\b(?:appointment|service|visit|repair|maintenance|online|now)|(?:book|schedule) (?:now|online)|online (?:booking|scheduling)|appointments?)\W*$/i;
const BOOKING_PATH = /\/(?:[^?#]*[-_/])?(?:appointments?|schedule[-_]?service|service[-_]?(?:scheduler|appt|appointment)|serviceappmt|book[-_]?(?:online|now|appointment|service))\b/i;
const NOT_BOOKING = /test[- ]?drive|career|job|employment|fleet|faq/i;
const isBookingLink = (l: { href: string; text: string }) =>
  !NOT_BOOKING.test(l.text) && !NOT_BOOKING.test(l.href) && ((l.text.length <= 50 && BOOKING_TEXT.test(l.text.trim())) || BOOKING_PATH.test(l.href));
const BOOKING_WIDGETS = /(calendly\.com|setmore\.com|booksy\.com|squareup\.com\/appointments|autoops|shopmonkey\.io|tekmetric\.com|mechanicadvisor|myshopmanager|openbay\.com|xtime\.com|autoshopmanager|shop-ware\.com|steercrm)/i;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
// A count is 1-99 without a leading zero: "03" is a list number, not three.
const COUNT = "([1-9]\\d?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const BAYS = new RegExp(`\\b${COUNT}\\s+(?:service\\s+|repair\\s+|work\\s+)?bays?\\b`, "gi");
const TECHS = new RegExp(`\\b${COUNT}\\s+(?:ase[- ]certified\\s+|certified\\s+|experienced\\s+|master\\s+|full[- ]time\\s+)?(?:technicians|mechanics|techs)\\b`, "gi");

/** A standalone number used as a heading marker: "2 Premium Parts", "05 'Best of Ojai'". */
const LIST_MARKER = /(?<![\w.,:/$#+-])(\d{1,2})(?=\s+[A-Z'"\u2018\u201c(])/g;
/** How far apart consecutive items of a numbered list may be. */
const LIST_GAP = 120;

/**
 * Whether the number n at `index` is one item of a numbered feature list
 * ("1 Locally Owned 2 Premium Parts 3 ASE Certified Technicians 4 ..."):
 * part of a run of 3+ consecutive numbers, in order, each close to the next.
 */
function isListNumber(text: string, index: number, n: number): boolean {
  const from = Math.max(0, index - LIST_GAP * 3);
  const markers = [...text.slice(from, index + LIST_GAP * 3).matchAll(LIST_MARKER)].map((m) => ({ at: from + m.index, value: Number(m[1]) }));
  let run = 1;
  for (const dir of [-1, 1]) {
    let at = index;
    for (let v = n + dir; ; v += dir) {
      const next = markers.find((m) => m.value === v && (dir < 0 ? m.at < at && at - m.at <= LIST_GAP : m.at > at && m.at - at <= LIST_GAP));
      if (!next) break;
      run++;
      at = next.at;
    }
  }
  return run >= 3;
}

/** The first bay or technician count on the pages that is a statement, not a list number. */
function countStatement(pages: Page[], re: RegExp) {
  for (const p of pages) {
    for (const m of p.parsed.text.matchAll(re)) {
      const raw = m[1]!.toLowerCase();
      const n = NUMBER_WORDS[raw] ?? Number(raw);
      if (/^\d/.test(raw) && isListNumber(p.parsed.text, m.index, n)) continue;
      return { page: p, index: m.index, match: m, n };
    }
  }
  return null;
}

const CLOSED_WORDS = /\b(permanently closed|closed permanently|we (are|have) (now )?closed (our doors|for good)|out of business|has closed its doors)\b/i;

const MONTHS = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_PATTERNS = [
  /(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi,
  new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2},?\\s+((?:19|20)\\d{2})\\b`, "gi"),
  /\b(?:updated|posted|published)[^.\d]{0,20}((?:19|20)\d{2})\b/gi,
];

/** The first dealer-activity phrase that isn't a comparison. */
function dealerActivity(pages: Page[]) {
  for (const p of pages) {
    for (const source of [[p.parsed.title, p.parsed.siteName, ...p.parsed.headings].filter(Boolean).join(" | "), p.parsed.text]) {
      DEALER_ACTIVITY.lastIndex = 0;
      for (const m of source.matchAll(DEALER_ACTIVITY)) {
        const before = source.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
        if (CONTRAST.test(before)) continue;
        return { page: p, text: source, index: m.index ?? 0, match: m };
      }
    }
  }
  return null;
}

/** An independence statement in the site's own labels or text. */
function independenceStatement(pages: Page[]) {
  for (const p of pages) {
    const labels = [p.parsed.title, p.parsed.siteName, ...p.parsed.structured.map((s) => s.name), ...p.parsed.headings].filter(Boolean).join(" | ");
    const inLabels = INDEPENDENT_WORDS.exec(labels);
    if (inLabels) return { page: p, text: labels, index: inLabels.index, match: inLabels };
  }
  const m = firstMatch(pages, INDEPENDENT_WORDS);
  return m ? { page: m.page, text: m.page.parsed.text, index: m.index, match: m.match } : null;
}

const firstMatch = (pages: Page[], re: RegExp) => {
  for (const p of pages) {
    const m = re.exec(p.parsed.text);
    if (m) return { page: p, index: m.index, match: m };
  }
  return null;
};

function serviceHits(pages: Page[], vocab: [string, RegExp][]) {
  const hits: { label: string; page: Page; index: number; length: number }[] = [];
  for (const [label, re] of vocab) {
    for (const p of pages) {
      const m = re.exec(p.parsed.text);
      if (m) {
        hits.push({ label, page: p, index: m.index, length: m[0].length });
        break;
      }
    }
  }
  return hits;
}

const reviewedNote = (pages: Page[]) =>
  `Reviewed ${pages.length} page${pages.length === 1 ? "" : "s"} of the website (${pages.map((p) => new URL(p.url).pathname || "/").join(", ")})`;

/**
 * Analyses the fetched pages of the stored website. `secureHttps` is the
 * result of the HTTPS check (null when unknown). `today` sets "recent".
 */
export function analyze(subject: Subject, pages: Page[], secureHttps: boolean | null, today: Date): Analysis {
  const facts: Fact[] = [];
  const signals: SignalProposal[] = [];
  const contact: ContactProposal = {};
  const warnings: string[] = [];
  const home = pages.find((p) => p.role === "home") ?? pages[0]!;
  const siteHost = hostOf(home.url);

  // ----- is this the business's own website? -----
  const name = findName(subject, pages);
  const address = findAddress(subject, pages);
  const phones = sitePhones(pages);
  const providerKey = phoneKey(subject.providerPhone);
  const providerOnSite = providerKey ? phones.get(providerKey) : undefined;
  const ownership: Ownership =
    name && (providerOnSite || address) ? "verified" : name || providerOnSite || address ? "uncertain" : "mismatch";
  const evidenceFor = [name && "the business name", providerOnSite && "the provider's phone", address && "the street address"].filter(Boolean);

  facts.push({
    field: "website",
    value: home.url,
    state: ownership === "verified" ? "verified" : "uncertain",
    sourceUrl: home.url,
    confidence: ownership === "verified" ? (name && providerOnSite && address ? 0.95 : 0.85) : ownership === "uncertain" ? 0.4 : 0.1,
    note:
      ownership === "verified"
        ? `The business's own website: it shows ${evidenceFor.join(" and ")}.`
        : ownership === "uncertain"
          ? `Not confirmed: the site shows only ${evidenceFor.join(" and ")}. It needs the name and the phone or address.`
          : "The site shows neither the business name nor its phone or address: it may belong to another business.",
  });
  if (ownership === "mismatch") warnings.push("The stored website doesn't appear to belong to this business. Review it and remove it if it is wrong.");
  if (ownership === "uncertain") warnings.push("The stored website could not be confirmed as the business's own. Nothing from it was used as verified.");

  facts.push(
    name
      ? { field: "business_name", value: name.value, state: "verified", sourceUrl: name.url, excerpt: name.excerpt }
      : { field: "business_name", value: subject.businessName, state: "not_found", note: "The name was not found on the pages read." },
  );
  facts.push(
    address
      ? { field: "address", value: subject.streetAddress, state: ownership === "verified" ? "verified" : "uncertain", sourceUrl: address.url, excerpt: address.excerpt }
      : {
          field: "address",
          value: subject.streetAddress,
          state: subject.streetAddress ? "unverified" : "not_found",
          note: subject.streetAddress ? `Reported by ${subject.provider}; not found on the pages read.` : "No street address known.",
        },
  );

  // A confirmed site that gives another address: maybe a move, or an outdated
  // provider address. Reported only; neither address is changed.
  if (ownership === "verified" && !address) {
    const other = differentSiteAddress(subject, pages);
    if (other) {
      const provider = [subject.streetAddress, subject.city, [subject.state, subject.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      warnings.push(
        `The website gives a different business address (${other.address}) than ${subject.provider} (${provider}). The business may have moved, or the provider's address may be out of date. Verify the current location by hand.`,
      );
    }
  }

  // ----- phone -----
  if (subject.providerPhone) {
    facts.push(
      providerOnSite
        ? {
            field: "provider_phone",
            value: subject.providerPhone,
            state: ownership === "verified" ? "verified" : "uncertain",
            sourceUrl: providerOnSite,
            note: `Reported by ${subject.provider} and listed on the website.`,
          }
        : {
            field: "provider_phone",
            value: subject.providerPhone,
            state: phones.size ? "uncertain" : "unverified",
            note: phones.size
              ? `Reported by ${subject.provider}, but the website lists a different number. Sources disagree.`
              : `Reported by ${subject.provider}; the website lists no phone to compare.`,
          },
    );
    if (!providerOnSite && phones.size) warnings.push(`The provider's phone is not on the website, which lists ${[...phones.keys()].map(formatPhone).join(", ")}.`);
  }
  const choice = choosePhone(subject, pages, phones, address);
  if (choice && "key" in choice) {
    facts.push({
      field: "phone",
      value: formatPhone(choice.key),
      state: ownership === "verified" ? "verified" : "uncertain",
      sourceUrl: choice.url,
      note: ownership === "verified" ? `Verified: ${choice.how}.` : "Listed on a website not confirmed as the business's own.",
    });
    if (ownership === "verified") {
      contact.phone = formatPhone(choice.key);
      contact.phoneSourceUrl = choice.url;
    }
  } else if (choice) {
    const listed = choice.ambiguous.slice(0, 6).map(formatPhone).join(", ");
    facts.push({
      field: "phone",
      value: listed,
      state: "uncertain",
      sourceUrl: phones.get(choice.ambiguous[0]!) ?? null,
      note: `The website lists ${choice.ambiguous.length} numbers and none is clearly this location's. Check by hand.`,
    });
    if (ownership === "verified") warnings.push("The website lists several phone numbers and none could be tied to this location. Verify the phone by hand.");
  } else {
    facts.push({ field: "phone", value: null, state: "not_found", note: "No phone number on the pages read." });
  }

  // ----- email (business domain only; personal-looking addresses are never kept) -----
  const emails = siteEmails(pages, siteHost);
  const [ownEmail] = [...emails.own.entries()];
  if (ownEmail) {
    facts.push({
      field: "email",
      value: ownEmail[0],
      state: ownership === "verified" ? "verified" : "uncertain",
      sourceUrl: ownEmail[1],
      note: "An address on the business's own domain.",
    });
    if (ownership === "verified") {
      contact.email = ownEmail[0];
      contact.emailSourceUrl = ownEmail[1];
    }
  } else {
    const other = emails.freeMail + emails.otherDomain;
    facts.push({
      field: "email",
      value: null,
      state: other ? "uncertain" : "not_found",
      note: other
        ? "An address on a free or third-party email service was found and deliberately not recorded: it may be personal. Confirm it by hand."
        : "No email address on the pages read.",
    });
  }

  // ----- operating status -----
  const closed = firstMatch(pages, CLOSED_WORDS);
  if (closed) {
    facts.push({ field: "operating_status", value: "closed", state: "uncertain", sourceUrl: closed.page.url, excerpt: quote(closed.page.parsed.text, closed.index, closed.match[0].length) });
    warnings.push("The website says the business has closed.");
  } else {
    facts.push({
      field: "operating_status",
      value: subject.providerStatus,
      state: subject.providerStatus ? "unverified" : "not_found",
      note: "The website doesn't state it, and a site being online doesn't prove the shop is open." + (subject.providerStatus ? ` ${subject.provider} reports "${subject.providerStatus.replace(/_/g, " ")}".` : ""),
    });
  }

  // ----- services and business type -----
  const general = serviceHits(pages, GENERAL_SERVICES);
  const specialty = serviceHits(pages, SPECIALTY_SERVICES);
  if (general.length) {
    const g = general[0]!;
    facts.push({
      field: "services",
      value: general.map((h) => h.label).join(", "),
      state: ownership === "verified" ? "verified" : "uncertain",
      sourceUrl: g.page.url,
      excerpt: quote(g.page.parsed.text, g.index, g.length),
    });
  } else {
    facts.push({ field: "services", value: specialty.map((h) => h.label).join(", ") || null, state: specialty.length ? "uncertain" : "not_found", note: "No general repair services named on the pages read." });
  }

  const nameAndBrand = `${subject.businessName} ${subject.providerBrand ?? ""} ${siteHost}`.toLowerCase();
  const labels = pages.flatMap((p) => [p.parsed.title ?? "", p.parsed.siteName ?? "", ...p.parsed.headings.slice(0, 3)]).join(" | ");
  const chain = CHAIN_BRANDS.find((b) => labels.toLowerCase().includes(b) || nameAndBrand.includes(b));
  const chainOnSite = chain ? pages.find((p) => [p.parsed.title, p.parsed.siteName, ...p.parsed.headings.slice(0, 3)].some((l) => l?.toLowerCase().includes(chain))) : undefined;
  // A make in the title only labels a dealer's evidence; it is never evidence itself.
  const make = MAKES.find((m) => new RegExp(`\\b${m}\\b`, "i").test(labels) || siteHost.includes(m.replace("-", "")));
  const dealerText = dealerActivity(pages);
  const independent = independenceStatement(pages);

  // ----- signals (only from the business's own, verified website) -----
  if (ownership === "verified") {
    // Independent shop (required criterion).
    if (chainOnSite) {
      const label = [chainOnSite.parsed.title, chainOnSite.parsed.siteName, ...chainOnSite.parsed.headings].find((l) => l?.toLowerCase().includes(chain!))!;
      signals.push({ key: "independent_shop", value: "no", sourceUrl: chainOnSite.url, excerpt: clip(`Franchise or chain brand "${chain}": ${label}`) });
      facts.push({ field: "business_type", value: "chain or franchise", state: "verified", sourceUrl: chainOnSite.url, excerpt: clip(label) });
    } else if (dealerText && independent) {
      facts.push({
        field: "business_type",
        value: null,
        state: "uncertain",
        sourceUrl: dealerText.page.url,
        excerpt: quote(dealerText.text, dealerText.index, dealerText.match[0].length),
        note: "The site states it is independent but also shows dealership activity. Check by hand.",
      });
    } else if (dealerText) {
      const ex = quote(dealerText.text, dealerText.index, dealerText.match[0].length);
      signals.push({ key: "independent_shop", value: "no", sourceUrl: dealerText.page.url, excerpt: clip(`Dealership${make ? ` (${make})` : ""}: ${ex}`) });
      facts.push({ field: "business_type", value: "dealership", state: "verified", sourceUrl: dealerText.page.url, excerpt: ex });
    } else if (independent && !chain) {
      const ex = quote(independent.text, independent.index, independent.match[0].length);
      signals.push({ key: "independent_shop", value: "yes", sourceUrl: independent.page.url, excerpt: ex });
      facts.push({ field: "business_type", value: "independent", state: "verified", sourceUrl: independent.page.url, excerpt: ex });
    } else {
      facts.push({
        field: "business_type",
        value: chain ? "possibly a chain" : null,
        state: "uncertain",
        note: chain
          ? `"${chain}" appears in the provider data but not on the website. Check ownership by hand.`
          : "No franchise brand or dealership activity found, but the site doesn't state it is independent. Check ownership by hand.",
      });
    }

    // Offers general repair (required criterion).
    if (general.length >= 2) {
      const g = general[0]!;
      signals.push({
        key: "general_repair_services",
        value: "yes",
        sourceUrl: g.page.url,
        excerpt: clip(`Names ${general.map((h) => h.label).join(", ")}: ${quote(g.page.parsed.text, g.index, g.length)}`),
      });
      facts.push({ field: "performs_repair", value: "yes", state: "verified", sourceUrl: g.page.url, note: `Advertises ${general.length} kinds of general repair.` });
    } else if (general.length === 0 && specialty.length >= 2) {
      const s = specialty[0]!;
      signals.push({
        key: "general_repair_services",
        value: "no",
        sourceUrl: s.page.url,
        excerpt: clip(`Only specialty services found (${specialty.map((h) => h.label).join(", ")}): ${quote(s.page.parsed.text, s.index, s.length)}`),
      });
      facts.push({ field: "performs_repair", value: "no", state: "verified", sourceUrl: s.page.url, note: "Only non-mechanical specialty services are advertised." });
    } else {
      facts.push({ field: "performs_repair", value: null, state: "uncertain", note: "Too few services named on the pages read to decide." });
    }

    // Mentions digital inspections.
    const dvi = firstMatch(pages, DVI_WORDS);
    const reviewedServices = pages.some((p) => p.role === "services");
    if (dvi) {
      signals.push({ key: "digital_inspections", value: "yes", sourceUrl: dvi.page.url, excerpt: quote(dvi.page.parsed.text, dvi.index, dvi.match[0].length) });
    } else if (reviewedServices) {
      signals.push({ key: "digital_inspections", value: "no", sourceUrl: home.url, excerpt: clip(`${reviewedNote(pages)}: no mention of digital or photo/video inspections.`) });
    }

    // No online booking.
    const bookingLink = pages.flatMap((p) => p.parsed.links.map((l) => ({ p, l }))).find(({ l }) => isBookingLink(l));
    const widget = pages.find((p) => BOOKING_WIDGETS.test(p.html));
    if (bookingLink) {
      signals.push({ key: "no_online_booking", value: "no", sourceUrl: bookingLink.p.url, excerpt: clip(`Booking link: "${bookingLink.l.text || bookingLink.l.href}"`) });
    } else if (widget) {
      signals.push({ key: "no_online_booking", value: "no", sourceUrl: widget.url, excerpt: clip(`Online scheduling widget on the page (${BOOKING_WIDGETS.exec(widget.html)![0]}).`) });
    } else if (pages.length >= 2) {
      signals.push({ key: "no_online_booking", value: "yes", sourceUrl: home.url, excerpt: clip(`${reviewedNote(pages)}: no online booking link, form, or widget.`) });
    }

    // Website not on HTTPS.
    if (secureHttps === true) {
      signals.push({ key: "website_not_https", value: "no", sourceUrl: `https://${new URL(home.url).host}/`, excerpt: "The site loads over https:// with a valid certificate." });
    } else if (secureHttps === false) {
      signals.push({ key: "website_not_https", value: "yes", sourceUrl: `https://${new URL(home.url).host}/`, excerpt: "Opening the site over https:// fails, redirects to http://, or has an invalid certificate." });
    }

    // No recent date on website.
    let newest: { year: number; page: Page; index: number; length: number } | null = null;
    for (const p of pages) {
      for (const re of DATE_PATTERNS) {
        for (const m of p.parsed.text.matchAll(re)) {
          const year = Number(m[1]);
          if (year > today.getFullYear()) continue;
          if (!newest || year > newest.year) newest = { year, page: p, index: m.index ?? 0, length: m[0].length };
        }
      }
    }
    if (newest) {
      const ex = quote(newest.page.parsed.text, newest.index, newest.length);
      const recent = newest.year >= today.getFullYear() - 1;
      signals.push({ key: "website_no_recent_date", value: recent ? "no" : "yes", sourceUrl: newest.page.url, excerpt: clip(`Newest date on the site: ${newest.year}. ${ex}`) });
    }

    // 3+ bays or technicians.
    const count = countStatement(pages, BAYS) ?? countStatement(pages, TECHS);
    if (count) {
      const n = count.n;
      if (n >= 1) {
        signals.push({ key: "multiple_bays_or_staff", value: n >= 3 ? "yes" : "no", sourceUrl: count.page.url, excerpt: quote(count.page.parsed.text, count.index, count.match[0].length) });
      }
    }
  } else {
    facts.push({ field: "business_type", value: null, state: "uncertain", note: "Not assessed: the website isn't confirmed as the business's own." });
  }

  return { ownership, facts, signals, contact, warnings };
}
