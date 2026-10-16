import { affirms, concreteServicesIn, quotedText } from "../../research/serviceEvidence.js";
import { REGIONAL_MAX_LOCATIONS } from "./readiness.js";

/*
 * Commercial fit (research r16, automation discovery@d2): is this business in ReclaimBay's
 * initial account segment? Independent of technical qualification (discovery/readiness.ts)
 * and never a decision on its own:
 *
 *   fit      concrete automotive repair, quoted. A single specialty, collision-only, hybrid or
 *            mechanical shop fits; breadth and workflow wording only raise confidence. Whether
 *            one service is the business's stated specialty is the Ready assessment's question.
 *   review   the scope is unclear or needs ownership/workflow context: a person decides.
 *   exclude  explicit business-site claims place it outside the initial segment (an exclusive
 *            non-passenger trade, a dealership/manufacturer, a national tire chain). Held for a
 *            person, NEVER rejected automatically; a person may approve it with a recorded reason.
 */

export const COMMERCIAL_RULES = "reclaimbay.commercial@v1";
export type CommercialDisposition = "fit" | "exclude" | "review";
export type CommercialConfidence = "high" | "medium" | "low";
export interface CommercialQuote {
  sourceUrl: string;
  excerpt: string;
  evidenceId?: string;
  factId?: string;
  researchId?: string;
  sourceId?: string;
}
export interface CommercialFinding {
  code: string;
  reason: string;
  evidence: CommercialQuote[];
}
export interface CommercialAssessment {
  rules: typeof COMMERCIAL_RULES;
  disposition: CommercialDisposition;
  confidence: CommercialConfidence;
  autonomousHandling: boolean;
  requiresHumanReview: boolean;
  findings: CommercialFinding[];
  services: string[];
  unknowns: readonly string[];
}
export interface CommercialInput {
  quotes: readonly CommercialQuote[];
  /** Derived observations can hold a decision, but cannot establish exclusion without a quote. */
  ownership?: string | null;
  siteLocations?: number;
  tireRetailHint?: boolean;
}

const ADJACENT = /\b(?:trailers?|hitch(?:es)?|welding|fabrication|machining|machine\s+shops?|rvs?|motorhomes?|campers?|boats?|marine|motorcycles?)\b/i;
/** Work that is not passenger-car repair when it is all a business does ("paint" is collision work, so it is not here). */
const NONREPAIR = /\b(?:detailing|ceramic\s+coatings?|window\s+tint(?:ing)?|vinyl\s+wraps?|paintless\s+dent)\b/i;
const PASSENGER = /\b(?:passenger\s+(?:cars?|vehicles?)|cars?|sedans?|suvs?|pickups?|light[- ]trucks?)\b/i;
const RACING = /\b(?:race\s+(?:cars?|car\s+fabrication)|racing|track\s+(?:cars?|setup)|motorsports|performance\s+tuning|custom\s+fabrication)\b/i;
const ROUTINE = /\b(?:routine|scheduled|preventive|regular)\s+(?:maintenance|repairs?|services?)\b|\b(?:daily[- ]drivers?|road[- ]cars?|foreign\s+and\s+domestic|all\s+makes\s+and\s+models)\b/i;
const WORKFLOW = /\b(?:(?:free|written)\s+(?:repair\s+)?estimates?|repair\s+estimates?|deferred\s+(?:repairs?|work)|declined\s+(?:repairs?|work)|customer\s+follow[- ]?up)\b/i;
const INDEPENDENT = /\b(?:independently\s+owned|independent\s+(?:auto(?:motive)?\s+)?(?:repair\s+)?(?:shop|facility|business)|family[- ]owned|family\s+owned|owner[- ]operated)\b/i;
/** "We only / exclusively / solely …": the clause that follows is the business's whole scope. */
const EXCLUSIVE_SCOPE = /\bwe\s+(?:are\s+|operate\s+|work\s+)?(?:only|exclusively|solely)\s+([^.;:!?]{1,120})/gi;
/** Where an exclusive clause stops: a comma or a contrast ("…cars and light trucks, no RVs"). */
const CLAUSE_END = /,|\s(?:no|not|never|but|except|excluding|without|other\s+than)\s/i;
const NEGATIVE = /\b(?:do\s+not|don't|no\s+longer|never)\s+(?:offer|perform|provide|do|handle)\s+(?:passenger[- ]car|car|automotive|vehicle)\s+repairs?\b/i;
const DEALER = /\b(?:we\s+(?:are|operate)\s+(?:a\s+)?(?:new[- ]car\s+)?dealership|manufacturer[- ]owned\s+(?:service|repair|facility|center)|our\s+dealership\s+(?:sells|offers\s+new\s+cars))\b/i;
const RETAIL = /\b(?:tire|wheel)\s+(?:retail(?:er|ing)?|stores?|chain)\b/i;
const MULTI = /\b(?:nationwide|national\s+chain|multi[- ]store|(?:multiple|other)\s+(?:stores?|locations?)|(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:stores?|locations?))\b/i;
/** A tire business that is plainly a chain, not a regional shop: national wording or more than REGIONAL_MAX_LOCATIONS stores. */
const NATIONAL = /\b(?:nationwide|national\s+chain|(?:tire|wheel|retail)\s+chain|franchise)\b/i;
const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COMMERCIAL_TERMS = /\b(?:independent\w*|family[- ]owned|owner[- ]operated|franchise\w*|dealership|manufacturer|nationwide|nationally)\b/i;

/** An exclusive scope that is a non-passenger trade or non-repair work, and names no passenger vehicle. */
function exclusiveNonfit(text: string): boolean {
  for (const m of text.matchAll(EXCLUSIVE_SCOPE)) {
    const clause = m[1]!.split(CLAUSE_END)[0]!;
    if ((ADJACENT.test(clause) || NONREPAIR.test(clause)) && !PASSENGER.test(clause)) return true;
  }
  return false;
}

const storeCount = (text: string) => {
  const m = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:stores?|locations?)\b/i.exec(text);
  return m ? (COUNT_WORDS[m[1]!.toLowerCase()] ?? Number(m[1])) : null;
};

/** Sentences worth keeping as commercial quotes: what can change a commercial finding, not general repair copy. */
const KEEP = [INDEPENDENT, WORKFLOW, ADJACENT, NONREPAIR, RACING, ROUTINE, NEGATIVE, DEALER, RETAIL, MULTI, COMMERCIAL_TERMS];
/** At most this many quotes from one page; research also caps a run at COMMERCIAL_QUOTES_PER_RUN, deduplicated. */
export const COMMERCIAL_QUOTES_PER_PAGE = 12;
export const COMMERCIAL_QUOTES_PER_RUN = 24;

/** Quote collection only. Research stores these as new run facts; no verdict or evidence mutation here.
 * Repair services are not collected here: research stores each one as its own quoted evidence row. */
export function commercialExcerpts(text: string): string[] {
  return [...new Set(text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 8 && (KEEP.some(rule => rule.test(s)) || exclusiveNonfit(s))).map(s => s.slice(0, 280)))]
    .slice(0, COMMERCIAL_QUOTES_PER_PAGE);
}

/** Pure, deterministic commercial policy. A business name/provider category is deliberately not an input. */
export function assessCommercialFit(input: CommercialInput): CommercialAssessment {
  const quotes = [...new Map(input.quotes.map(q => [JSON.stringify(q), { ...q, excerpt: quotedText(q.excerpt) }])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const matched = (rule: RegExp) => quotes.filter(q => rule.test(q.excerpt));
  const affirmed = (rule: RegExp) => quotes.filter(q => affirms(rule, q.excerpt));
  const findings: CommercialFinding[] = [];
  const add = (code: string, reason: string, evidence: CommercialQuote[]) => findings.push({ code, reason, evidence });
  const adjacent = affirmed(ADJACENT), racing = affirmed(RACING);
  // A quote that names an adjacent trade only to rule it out ("no RVs") is still ordinary repair evidence.
  const normal = quotes.filter(q => !adjacent.includes(q) && !racing.includes(q));
  const services = [...new Set(normal.flatMap(q => concreteServicesIn("", q.excerpt, q.sourceUrl)))].sort();
  const broad = services.filter(s => s !== "collision/body" && s !== "smog repair").length >= 2;
  const independent = matched(INDEPENDENT).filter(q => !/\b(?:not|never)\s+(?:an?\s+)?(?:independent|family[- ]owned|independently\s+owned)\b/i.test(q.excerpt));
  const ordinary = normal.filter(q => ROUTINE.test(q.excerpt));
  const workflow = normal.filter(q => WORKFLOW.test(q.excerpt));
  const passengerRepair = normal.some(q => PASSENGER.test(q.excerpt) && concreteServicesIn("", q.excerpt, q.sourceUrl).length > 0);
  const contrary = matched(NEGATIVE);
  const scopedNonfit = quotes.filter(q => exclusiveNonfit(q.excerpt));
  const dealer = matched(DEALER);
  const tireRetail = matched(RETAIL), multi = matched(MULTI).filter(q => !/\b(?:not|never|no)\s+(?:an?\s+)?(?:national|nationwide|multi[- ]store|multiple|other)\b/i.test(q.excerpt));
  const multiRetail = tireRetail.length > 0 && multi.length > 0;
  // Only a plain chain is an exclusion; a tire-and-repair shop with a few stores is regional and goes to a person.
  const nationalRetail = multiRetail && [...tireRetail, ...multi].some(q => NATIONAL.test(q.excerpt) || (storeCount(q.excerpt) ?? 0) > REGIONAL_MAX_LOCATIONS);
  let disposition: CommercialDisposition, confidence: CommercialConfidence;
  if ((contrary.length || scopedNonfit.length || dealer.length || nationalRetail) && broad) {
    add("commercial.conflicting_scope", "Normal repair evidence conflicts with an exclusion or account-segment claim; preserve both and resolve the scope.", [...normal, ...contrary, ...scopedNonfit, ...dealer, ...tireRetail, ...multi]);
    // Tire retailers can perform genuine normal repair and still be outside the account segment.
    if (nationalRetail && !contrary.length && !scopedNonfit.length && !dealer.length) {
      findings.length = 0;
      add("commercial.multi_store_tire_retail", "A sourced multi-store tire retail chain is outside the initial account segment despite mechanical services. A person decides.", [...tireRetail, ...multi]);
      disposition = "exclude"; confidence = "high";
    } else { disposition = "review"; confidence = "low"; }
  } else if (contrary.length || scopedNonfit.length || dealer.length || nationalRetail) {
    add(dealer.length ? "commercial.dealer_manufacturer" : nationalRetail ? "commercial.multi_store_tire_retail" : "commercial.exclusive_non_passenger_trade",
      "Explicit business-site evidence places this business outside the initial passenger-car repair/account segment. A person decides.", [...contrary, ...scopedNonfit, ...dealer, ...tireRetail, ...multi]);
    disposition = "exclude"; confidence = "high";
  } else if (multiRetail) {
    add("commercial.tire_retail_locations", "A tire retailer with several stores: a person checks whether it is a regional repair business or a chain.", [...tireRetail, ...multi]);
    disposition = "review"; confidence = "low";
  } else if (["chain", "dealership", "possible_dealership", "manufacturer"].includes(input.ownership ?? "") ||
    ((input.tireRetailHint || tireRetail.length > 0) && (input.siteLocations ?? 0) > 1)) {
    add("commercial.ownership_unresolved", "A derived ownership classification needs attributable business evidence before commercial inclusion or exclusion.", []);
    disposition = "review"; confidence = "low";
  } else if (racing.length && !(services.length && passengerRepair && ordinary.length)) {
    add("commercial.race_workflow_unverified", "Racing work needs quoted passenger-car repair and everyday customer work beside it.", [...racing, ...normal]);
    disposition = "review"; confidence = "low";
  } else if (adjacent.length && !(services.length && passengerRepair)) {
    add("commercial.passenger_workflow_unverified", "Adjacent-trade evidence needs quoted passenger-car repair beside it.", [...adjacent, ...normal]);
    disposition = "review"; confidence = "low";
  } else if (!services.length) {
    add("commercial.insufficient_service_evidence", "No concrete automotive repair is quoted; generic or workflow language cannot establish commercial fit.", normal);
    disposition = "review"; confidence = "low";
  } else {
    add("commercial.normal_repair", "Concrete automotive repair supports the initial commercial segment.", normal.filter(q => concreteServicesIn("", q.excerpt, q.sourceUrl).length > 0));
    if (independent.length) add("commercial.independent_ownership", "The business explicitly states independent, family or owner operation.", independent);
    else add("commercial.ownership_unstated", "Ownership remains unverified; human approval may consider this fit, autonomous creation may not.", []);
    if (workflow.length) add("commercial.repair_workflow", "The business describes repair estimates, deferred work or customer follow-up.", workflow);
    disposition = "fit"; confidence = independent.length ? "high" : "medium";
  }
  return { rules: COMMERCIAL_RULES, disposition, confidence, autonomousHandling: disposition === "fit" && confidence === "high",
    requiresHumanReview: disposition !== "fit" || confidence !== "high", findings, services,
    unknowns: ["declined_work_volume", "export_access", "buyer_willingness"] };
}
