import { REPAIR_SERVICES, repairFit } from "./repairFit.js";

/*
 * Service evidence (research r16): "this business demonstrably performs automotive repair",
 * not "this website contains automotive-related language". Pure: research applies it to the
 * pages it read, and the Ready assessment applies the same function to the quotes research stored.
 *
 *   - Only concrete repair services count, each from its own quote, in repairFit's strict
 *     phrase vocabulary. "general repair" ("auto repair", "car repairs", "complete car care",
 *     "we are an auto repair shop") is generic language and never counts; maintenance and
 *     cosmetic work support but never establish fit. The loose single-word service scan
 *     (analyze.ts GENERAL_SERVICES) never reaches this function.
 *   - Two or more concrete services are strong evidence.
 *   - Exactly one is strong only when it is the business's stated specialty (its name, or its
 *     own "transmission specialists" / "muffler shop" wording). Make specialties (German,
 *     Japanese, European) are not service specialties. Performance/motorsports, tire, mobile
 *     and adjacent-trade businesses get no specialist exception.
 *   - In an adjacent-trade context (trailer, hitch, welding, fabrication, RV, marine,
 *     motorcycle, machining) a service counts only when its quote names a passenger vehicle
 *     and affirms no adjacent trade ("no RVs or motorcycles" rules them out). The business name and the site's own title set the context for
 *     every quote; a page's title or URL path sets it for that page's quotes only, so a repair
 *     shop's "/trailer-hitches" page doesn't discount its brake and engine pages.
 */

/** A negation earlier in the same clause ("no RVs or motorcycles", "except boats", "not trailers"). */
const NEGATED_BEFORE = /\b(?:no|not|never|nor|except|excluding|without|other\s+than)\b(?:(?!\b(?:but|we|our|also)\b)[^.;:!?]){0,40}$/i;

/** Whether the text names the term anywhere it does not negate: "no RVs" rules RVs out, it is not RV work. */
export function affirms(rule: RegExp, text: string): boolean {
  for (const m of text.matchAll(new RegExp(rule.source, "gi"))) {
    if (!NEGATED_BEFORE.test(text.slice(Math.max(0, m.index - 60), m.index))) return true;
  }
  return false;
}

const MACHINE_PREFIX = /^Names [^:]+:\s*/;
/** A stored quote without research's machine-written "Names …:" label, so a label can never confirm itself. */
export const quotedText = (excerpt: string) => excerpt.replace(MACHINE_PREFIX, "");

/** Concrete repair services, in vocabulary order. */
export const CONCRETE_SERVICES: readonly string[] = [
  ...new Set(REPAIR_SERVICES.filter(([label, kind]) => kind === "repair" && label !== "general repair").map(([label]) => label)),
];
export const isConcreteService = (label: string) => CONCRETE_SERVICES.includes(label);

/** The words that state each specialty, in a business name or self-description. */
const SPECIALTY_WORDS: Readonly<Record<string, RegExp>> = {
  "transmission/drivetrain": /\b(?:transmissions?|drive\s?(?:shafts?|lines?|trains?)|driveshaft\w*|differentials?|axles?|4x4|clutch(?:es)?)/i,
  brakes: /\bbrakes?\b/i,
  exhaust: /\b(?:mufflers?|exhaust)\b/i,
  "cooling system": /\bradiators?\b/i,
  electrical: /\b(?:auto(?:motive)?\s+electric(?:al)?|electrical)\b/i,
  diesel: /\bdiesel\b/i,
  "suspension/steering": /\b(?:alignment|suspension|steering)\b/i,
  "collision/body": /\b(?:collision|auto\s?body|body\s+shop|body\s+(?:&|and)\s+paint)\b/i,
  "smog repair": /\bsmog\b/i,
  "A/C": /\b(?:a\/c|air[- ]condition\w*)\b/i,
  engine: /\b(?:engines?|carburetors?|fuel\s+injection)\b/i,
  "hybrid/EV": /\b(?:hybrids?|electric\s+vehicles?|evs?)\b/i,
};
const SELF_SPECIALTY = (words: RegExp) => new RegExp(String.raw`(?:${words.source})\s+(?:repair\s+)?(?:shop|specialists?|experts?|center|centre)\b`, "i");

/** The adjacent trades a person reviews, with their wording. */
export const ADJACENT_TRADES: readonly (readonly [string, RegExp])[] = [
  ["trailer", /\btrailers?\b/i],
  ["hitch", /\bhitch(?:es)?\b/i],
  ["welding", /\bweld(?:ing|ers?)?\b/i],
  ["fabrication", /\bfabricat\w*/i],
  ["RV", /\b(?:rvs?|motor\s?homes?|campers?)\b/i],
  ["marine", /\b(?:marine|boats?|outboards?)\b/i],
  ["motorcycle", /\b(?:motorcycles?|powersports|atvs?)\b/i],
  ["machining", /\bmachin(?:ing|e\s+(?:shop|company|works))\b/i],
];
const PASSENGER_VEHICLE = /\b(?:cars?|trucks?|suvs?|vans?|vehicles?|auto(?:s|motive|mobiles?)?|sedans?|pickups?)\b/i;
const PERFORMANCE = /\b(?:performance|motorsports?|racing|speed\s+shop|hot\s?rods?|custom\s+(?:auto|cars?|shop))\b/i;
const TIRE = /\btires?\b/i;
const MOBILE = /\bmobile\b/i;

export type BusinessKind = "performance" | "tire" | "mobile";

/** The adjacent trades named by the business name, a page title, or a URL path. */
export function tradeContext(input: { businessName: string; titles?: readonly (string | null | undefined)[]; urls?: readonly string[] }): string[] {
  const paths = (input.urls ?? []).map((u) => {
    try {
      return decodeURIComponent(new URL(u).pathname).replace(/[-_/.]+/g, " ");
    } catch {
      return "";
    }
  });
  const texts = [input.businessName, ...(input.titles ?? []).filter((t): t is string => Boolean(t)), ...paths];
  return ADJACENT_TRADES.filter(([, re]) => texts.some((t) => re.test(t))).map(([trade]) => trade);
}

/** Business kinds that change the service rule: no specialist exception. */
export function businessKinds(businessName: string, titles: readonly (string | null | undefined)[] = []): BusinessKind[] {
  const kinds: BusinessKind[] = [];
  if (PERFORMANCE.test(businessName) || titles.some((t) => t && PERFORMANCE.test(t))) kinds.push("performance");
  if (TIRE.test(businessName)) kinds.push("tire");
  if (MOBILE.test(businessName)) kinds.push("mobile");
  return kinds;
}

export interface ServiceQuote {
  url: string;
  excerpt: string;
  /** The title of the page the quote is from, when known. */
  title?: string | null;
}

export interface ServiceAssessment {
  /** strong: Ready may rely on it. weak: one non-specialist service. none: no concrete service. */
  strength: "strong" | "weak" | "none";
  counted: { label: string; url: string; excerpt: string }[];
  specialist: string | null;
  trades: string[];
  kinds: BusinessKind[];
  /** Hitch installation with no concrete vehicle repair: outside the initial ICP, held for a person. */
  outsideIcp: boolean;
  reason: string;
}

/** The concrete repair services one quote itself states (its machine label ignored). */
export function concreteServicesIn(businessName: string, excerpt: string, url = "https://quote.invalid/"): string[] {
  const fit = repairFit(businessName, [{ url, role: "services", parsed: { text: quotedText(excerpt) } }], { vehicleSite: true });
  return fit.quotes.filter((q) => q.kind === "repair" && isConcreteService(q.label)).map((q) => q.label);
}

/** The single rule both research and the Ready assessment use. */
export function assessServiceEvidence(input: {
  businessName: string;
  quotes: readonly ServiceQuote[];
  /** The site's own name and home title (business-level context). */
  siteTitles?: readonly (string | null | undefined)[];
  /** Business-level trades research already recorded (trade_context). */
  trades?: readonly string[];
}): ServiceAssessment {
  const businessTrades = [...new Set([...(input.trades ?? []), ...tradeContext({ businessName: input.businessName, titles: input.siteTitles })])];
  const kinds = businessKinds(input.businessName, input.siteTitles);
  const adjacent = businessTrades.length > 0;
  const trades = new Set(businessTrades);
  const tradeWords = ADJACENT_TRADES.map(([, re]) => re);
  const counted: ServiceAssessment["counted"] = [];
  const usable: { q: ServiceQuote; labels: string[]; own: string | null }[] = [];
  for (const q of input.quotes) {
    const text = quotedText(q.excerpt);
    const pageTrades = tradeContext({ businessName: "", titles: [q.title], urls: [q.url] });
    pageTrades.forEach((t) => trades.add(t));
    // A trade the quote rules out ("cars and trucks, no RVs or motorcycles") does not make it trade work.
    if ((adjacent || pageTrades.length) && !(PASSENGER_VEHICLE.test(text) && !tradeWords.some((re) => affirms(re, text)))) continue;
    const own = /^Names ([^:,]+):/.exec(q.excerpt)?.[1]?.trim() ?? null;
    usable.push({ q, labels: concreteServicesIn(input.businessName, q.excerpt, q.url), own });
  }
  // Each service is counted with its own quote: the one research centred on it when there is one.
  const add = (label: string, q: ServiceQuote) => {
    if (!counted.some((c) => c.label === label)) counted.push({ label, url: q.url, excerpt: `Names ${label}: ${quotedText(q.excerpt)}`.slice(0, 280) });
  };
  for (const u of usable) if (u.own && u.labels.includes(u.own)) add(u.own, u.q);
  for (const u of usable) for (const label of u.labels) add(label, u.q);
  counted.sort((a, b) => CONCRETE_SERVICES.indexOf(a.label) - CONCRETE_SERVICES.indexOf(b.label));
  const noException = adjacent || kinds.length > 0;
  let specialist: string | null = null;
  if (counted.length === 1 && !noException) {
    const label = counted[0]!.label;
    const words = SPECIALTY_WORDS[label];
    if (words && (words.test(input.businessName) || input.quotes.some((q) => SELF_SPECIALTY(words).test(quotedText(q.excerpt))))) specialist = label;
  }
  const strength = counted.length >= 2 || specialist ? "strong" : counted.length === 1 ? "weak" : "none";
  // Hitch installation only (no other adjacent trade such as trailer repair or welding, and no quoted vehicle repair).
  const outsideIcp = strength !== "strong" && counted.length === 0 && businessTrades.length > 0 && businessTrades.every((t) => t === "hitch");
  const named = counted.map((c) => c.label).join(", ");
  const reason =
    strength === "strong"
      ? specialist
        ? `Specialist: ${specialist} repair matches the business's stated specialty.`
        : `Concrete repair services, each quoted: ${named}.`
      : outsideIcp
        ? "Hitch installation without quoted vehicle repair is outside the initial ICP."
        : trades.size && counted.length === 0
          ? `Adjacent trade (${[...trades].join(", ")}): no quoted passenger-vehicle repair.`
          : counted.length === 1
            ? `Only one concrete repair service is quoted (${named})${noException ? ` and ${[...kinds, ...(adjacent ? ["adjacent trade"] : [])].join("/")} businesses need two` : ", and it is not the business's stated specialty"}.`
            : "Only generic repair language is quoted; no concrete repair service.";
  return { strength, counted, specialist, trades: [...trades], kinds, outsideIcp, reason };
}
