import type { Page } from "./analyze.js";
import { isOnBusinessSite, normalizeDomain, normalizeName } from "../discovery/normalize.js";
import { collisionEvidenceErrors, hasCollisionResearchConflict } from "./collisionFit.js";

/*
 * Automotive repair fit: does this business itself perform automotive
 * repair/service work? The same evidence rules as collisionFit (collision/body
 * is one segment here, not the requirement):
 *
 *   - only the business's own offering counts: a services page, or "we
 *     offer…", "our services…" wording; the business name is removed first;
 *   - suppliers, directories, referrals, training, jobs and coverage are
 *     ignored; a phrase needs automotive context ("A/C repair" alone could be
 *     a home HVAC company);
 *   - a negated service is never positive; contradicting statements about the
 *     same service cancel it; a statement that the business does no repairs at
 *     all (or is test-only) is the only "negative";
 *   - maintenance-only (oil changes, tune-ups) or cosmetic-only (dent, paint)
 *     evidence is "possible": a person verifies it.
 *
 * Names, provider categories and the opportunity score never imply fit.
 */
export interface RepairFit {
  status: "primary" | "possible" | "negative" | "conflict" | "unknown";
  sourceUrl: string | null;
  excerpt: string | null;
  /** The services the uncontradicted positive evidence names, in vocabulary order. */
  services: string[];
}

type Kind = "repair" | "maintenance" | "cosmetic";

/** Service vocabulary: label, kind, pattern. Labels are what reasons and business types read. */
export const REPAIR_SERVICES: readonly (readonly [string, Kind, RegExp])[] = [
  ["general repair", "repair", /\b(?:(?:auto(?:motive)?|car|vehicle|truck|mechanical|general(?:\s+auto(?:motive)?)?)\s+repairs?|(?:auto(?:motive)?|car)\s+mechanics?|complete\s+(?:auto|car)\s+care)\b/i],
  ["collision/body", "repair", /\b(?:(?:collision|accident)(?:[- ]damage)?\s+repairs?|auto(?:motive)?[- ]?body(?:\s+(?:and|&)\s+paint)?\s+(?:repairs?|services?|work)|(?:vehicle|automotive|car)\s+(?:body|panel|structural|frame)\s+repairs?|(?:body|frame|structural)\s+repairs?)\b/i],
  ["engine", "repair", /\bengine\s+(?:repairs?|rebuild(?:s|ing)?|replacements?|overhauls?)\b/i],
  ["transmission/drivetrain", "repair", /\b(?:transmissions?|clutch(?:es)?|drive\s?(?:train|line)|differentials?|(?:cv\s+)?axles?|transfer\s+cases?|4x4)\s+(?:repairs?|rebuild(?:s|ing)?|services?|replacements?)\b/i],
  ["brakes", "repair", /\bbrakes?\s+(?:repairs?|services?|replacements?|jobs?)\b/i],
  ["suspension/steering", "repair", /\b(?:suspension|steering|shocks?(?:\s+(?:and|&)\s+struts?)?|struts?)\s+(?:repairs?|services?|replacements?)\b/i],
  ["diagnostics", "repair", /\b(?:(?:engine|computer(?:ized)?|vehicle|automotive|car|electrical|drivability)\s+diagnos(?:tics?|is|es)|check[- ]engine[- ]lights?)\b/i],
  ["electrical", "repair", /\b(?:(?:auto(?:motive)?|vehicle|car)\s+)?electrical\s+(?:system\s+)?(?:repairs?|services?)\b|\b(?:alternators?|starters?)\s+(?:repairs?|replacements?)\b/i],
  ["diesel", "repair", /\bdiesel\s+(?:engine\s+)?(?:repairs?|services?|mechanics?)\b/i],
  ["A/C", "repair", /\b(?:a\/c|ac|air[- ]condition(?:ing|er))\s+(?:repairs?|services?|recharges?)\b/i],
  ["exhaust", "repair", /\b(?:exhaust|mufflers?|catalytic\s+converters?)\s+(?:repairs?|services?|replacements?)\b/i],
  ["cooling system", "repair", /\b(?:radiators?|cooling\s+systems?|water\s+pumps?)\s+(?:repairs?|services?|replacements?)\b/i],
  ["hybrid/EV", "repair", /\b(?:hybrid|electric\s+vehicle|ev)\s+(?:repairs?|services?)\b/i],
  ["smog repair", "repair", /\b(?:smog|emissions?)\s+repairs?\b/i],
  ["maintenance", "maintenance", /\b(?:oil\s+changes?|tune[- ]?ups?|(?:scheduled|factory|preventi(?:ve|tive)|routine)\s+maintenance|(?:auto(?:motive)?|car|vehicle)\s+maintenance|maintenance\s+services?|fluid\s+(?:services?|flush(?:es)?))\b/i],
  ["dent/paint", "cosmetic", /\b(?:paintless\s+dent\s+repair|dent\s+repairs?|automotive\s+(?:paint|painting|refinishing)|bumper\s+repairs?)\b/i],
];

/** A phrase that is automotive by itself ("auto repair", "collision repair", "check engine light"). */
const AUTOMOTIVE_PHRASE = /\b(?:auto(?:s|motive|mobiles?)?|cars?|vehicles?|trucks?|collision|accident|auto\s*body|check[- ]engine|smog|emissions?)\b/i;
/** Words around a component phrase ("engine repair", "A/C repair") that make it automotive, not small engines or home HVAC. */
const AUTOMOTIVE = /\b(?:auto(?:s|motive|mobiles?)?|cars?|vehicles?|trucks?|suvs?|fleets?|mechanics?|brakes?|transmissions?|engines?|collision|accident|auto\s*body|tires?|oil\s+changes?|smog)\b/i;
/** A site about vehicles at all: then its component phrases ("Brake Repair" in a services list) are automotive. */
const VEHICLE_SITE = /\b(?:auto(?:s|motive|mobiles?)?|cars?|vehicles?|trucks?|suvs?|fleets?|mechanics?|tires?|oil\s+changes?|smog|collision|auto\s*body)\b/i;
/** Not this business's own repair work: collisionFit's list, with sellers and job postings (not "brake jobs"). */
const EXTERNAL = /\b(?:suppl(?:y|ies|iers?)|equipment|software|products?|materials?|tools?|parts\s+store|sell(?:s|ing)?|for\s+sale|outsource\w*|subcontract\w*|director(?:y|ies)|providers?|listings?|marketplace|coverage|polic(?:y|ies)|near\s+me|training|courses?|careers?|job\s+(?:openings?|opportunit\w*|postings?)|employment|hiring|partner\w*|refer(?:ral|rals)?|refer\s+(?:you|customers)|other\s+(?:shops|businesses)|recommend\w*)\b/i;
/** A negated offering ("we don't offer…", "…is not available"), not any negative word ("don't ignore that light"). */
const NEGATIVE = /\b(?:(?:do\s+not|don't|does\s+not|doesn't|no\s+longer|never|cannot|can't|unable\s+to)\s+(?:currently\s+)?(?:offer|provide|perform|do|handle|repair|service|work\s+on|fix)|not\s+(?:offer(?:ed|ing|s)?|provid(?:e|ed|ing|es)|perform(?:ed|ing|s)?|available)|unavailable)\b/i;
/** This business does no repair work at all ("we do not perform repairs", test-only). "We don't repair boats" is not that. */
const NO_REPAIRS = /\b(?:(?:we|this\s+(?:shop|business|location|station)|our\s+(?:shop|business|station))\s+(?:do(?:es)?\s+not|don't|doesn't|never|no\s+longer|cannot|can't)\s+(?:do|perform|offer|provide|handle|make)?\s*(?:any\s+)?(?:auto(?:motive)?\s+|mechanical\s+|vehicle\s+|car\s+)?(?:repairs?|repair\s+work|mechanical\s+work)(?=\s*(?:[.!;:,)]|$|of\s+any\s+kind\b|here\b|on[- ]?site\b|at\s+this\s+location\b))|no\s+(?:auto(?:motive)?\s+|mechanical\s+|vehicle\s+)?repairs?\s+(?:are\s+)?(?:performed|offered|done|available)|(?:smog|emissions?|inspection)\s+test[- ]only|test[- ]only\s+(?:smog|emissions?|station|center|facility|inspections?)|(?:we\s+are|this\s+is)\s+not\s+an?\s+(?:repair\s+(?:shop|facility)|mechanic(?:al)?\s+shop|auto(?:motive)?\s+repair\s+(?:shop|facility)))/i;
const OFFERING = /\b(?:we\s+(?:offer|provide|perform|handle|speciali[sz]e|repair|do|fix|service|work\s+on)|we\s+can\s+(?:help|repair|fix)|our\s+(?:services|shop|team|technicians|mechanics|collision|body|repair)|our\s+(?:[\w-]+\s+){1,3}?(?:technicians|mechanics|team)\s+(?:offer|provide|perform|handle|speciali[sz]e|repair|fix|service)|services\s+(?:include|offered)|speciali[sz]ing\s+in|full[- ]service)\b/i;
/** The same sentence split collisionFit uses, plus "and we…" so a second clause stands alone. */
const CHUNKS = /(?<=[.!?;])\s+|\n+|\bbut\b|\band\s+(?=(?:we|our|this\s+shop)\b)/i;

const EXCERPT_MAX = 280;

/** At most `budget` characters of `text` around the match, trimmed. */
function around(text: string, index: number, length: number, budget: number): string {
  const pad = Math.max(0, Math.floor((budget - length) / 2));
  const start = Math.max(0, Math.min(index - pad, text.length - budget));
  return text.slice(start, start + budget).trim();
}

type Hit = { label: string; kind: Kind; sourceUrl: string; chunk: string; index: number; length: number };

export function repairFit(businessName: string, pages: readonly { url: string; role: Page["role"]; parsed: Pick<Page["parsed"], "text"> }[]): RepairFit {
  const positive: Hit[] = [];
  const negated = new Set<string>();
  let noRepairs: { sourceUrl: string; excerpt: string } | null = null;
  const escapedName = businessName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A business called "Harbor Transmission Repair" is still only a name.
  const texts = pages.map((page) => ({ page, text: (escapedName ? page.parsed.text.replace(new RegExp(escapedName, "gi"), " ") : page.parsed.text).replace(/[’‘]/g, "'") }));
  const vehicleSite = texts.some(({ text }) => VEHICLE_SITE.test(text));
  for (const { page, text } of texts) {
    for (const chunk of text.split(CHUNKS)) {
      if (!chunk.trim()) continue;
      const none = NO_REPAIRS.exec(chunk);
      if (none && !EXTERNAL.test(chunk) && (/\b(?:we|our|this)\b/i.test(chunk) || page.role === "services" || /test[- ]only/i.test(none[0]))) {
        noRepairs ??= { sourceUrl: page.url, excerpt: around(chunk, none.index, none[0].length, EXCERPT_MAX) };
        continue;
      }
      for (const [label, kind, pattern] of REPAIR_SERVICES) {
        const m = pattern.exec(chunk);
        if (!m) continue;
        const context = chunk.slice(Math.max(0, m.index - 140), m.index + m[0].length + 140);
        const nearby = chunk.slice(Math.max(0, m.index - 140), m.index) + " " + chunk.slice(m.index + m[0].length, m.index + m[0].length + 140);
        if (EXTERNAL.test(context) || !(AUTOMOTIVE_PHRASE.test(m[0]) || AUTOMOTIVE.test(nearby) || vehicleSite)) continue;
        if (NEGATIVE.test(context)) {
          // Only an explicit statement about this business's own offering counts as a contradiction.
          if (/\b(?:we|our|this\s+shop|here)\b/i.test(context) || page.role === "services") negated.add(label);
        } else if (page.role === "services" || OFFERING.test(context)) {
          positive.push({ label, kind, sourceUrl: page.url, chunk, index: m.index, length: m[0].length });
        }
      }
    }
  }
  const standing = positive.filter((h) => !negated.has(h.label));
  const contradicted = positive.some((h) => negated.has(h.label));
  const repair = standing.filter((h) => h.kind === "repair");
  const services = REPAIR_SERVICES.map(([label]) => label).filter((label) => standing.some((h) => h.label === label));
  const answer = (status: RepairFit["status"], hit?: Hit | null, ev?: { sourceUrl: string; excerpt: string } | null): RepairFit => {
    if (hit) {
      const named = services.filter((s) => (status === "primary" ? repair.some((h) => h.label === s) : true)).slice(0, 4);
      const prefix = `Names ${named.join(", ")}: `;
      return { status, sourceUrl: hit.sourceUrl, excerpt: prefix + around(hit.chunk, hit.index, hit.length, EXCERPT_MAX - prefix.length), services };
    }
    return { status, sourceUrl: ev?.sourceUrl ?? null, excerpt: ev?.excerpt ?? null, services };
  };
  if (noRepairs && positive.length) return answer("conflict", null, noRepairs);
  if (repair.length) return answer("primary", repair[0]);
  if (contradicted) return answer("conflict");
  if (noRepairs) return answer("negative", null, noRepairs);
  if (standing.length) return answer("possible", standing[0]);
  return answer("unknown");
}

/** The repair services a stored "Names …:" excerpt lists (research writes them; a person may not). */
export const namedServices = (excerpt: string): string[] => {
  const m = /^Names ([^:]+):/.exec(excerpt);
  const known = new Set(REPAIR_SERVICES.map(([label]) => label));
  return m ? m[1]!.split(",").map((s) => s.trim()).filter((s) => known.has(s)) : [];
};

/** A stored excerpt without its machine-written "Names …:" summary, so the summary can't confirm itself. */
const quoted = (excerpt: string) => excerpt.replace(/^Names [^:]+:\s*/, "");

/** The repair findings, applied to stored excerpts rather than fetched pages. */
export function repairEvidenceErrors(
  business: { businessName: string | null; website: string | null },
  evidence: readonly { signalKey: string; sourceUrl: string; excerpt: string }[],
): string[] {
  const missing = "Qualification requires sourced automotive repair evidence attributed to this business, with a public source URL and supporting excerpt.";
  const name = business.businessName?.trim();
  if (!name) return [missing];
  const items = evidence.filter((e) => e.signalKey === "automotive_repair_services");
  if (!items.length) return [missing];
  const pages: Parameters<typeof repairFit>[1][number][] = [];
  for (const e of items) {
    try {
      const source = new URL(e.sourceUrl);
      if (!/^https?:$/.test(source.protocol) || source.username || source.password || !source.hostname.includes(".") || !e.excerpt.trim() || e.sourceUrl.length > 500 || e.excerpt.length > EXCERPT_MAX) return [missing];
      if (normalizeDomain(business.website)) {
        if (!isOnBusinessSite(e.sourceUrl, business.website)) return [missing];
      } else if (!normalizeName(name) || !` ${normalizeName(e.excerpt)} `.includes(` ${normalizeName(name)} `)) {
        // Without a recorded website, the public excerpt must identify the business itself.
        return [missing];
      }
      // The name is part of the identity check above; the services are judged without it.
      pages.push({ url: source.href, role: "services", parsed: { text: quoted(e.excerpt) } });
    } catch {
      return [missing];
    }
  }
  const fit = repairFit(name, pages);
  if (fit.status === "negative" || fit.status === "conflict") return ["Resolve contradictory automotive repair evidence before qualification or Ready to contact."];
  // Dealership, fleet, maintenance-only and cosmetic-only fit may be verified by a person, who still must explicitly record Yes.
  return fit.status === "primary" || fit.status === "possible" ? [] : [missing];
}

/** Research said the repair evidence contradicts itself, or disagrees with a person's repair decision. */
export const hasRepairResearchConflict = (warnings: unknown): boolean =>
  Array.isArray(warnings) && warnings.some((w) => typeof w === "string" && /Automotive repair evidence is contradictory|Research found "automotive_repair_services" = (?:yes|no), but a person recorded (?:yes|no)/.test(w));

/**
 * What product fit rests on: a recorded automotive repair Yes, or (for
 * collision/body shops, including records from before automotive repair
 * existed) a recorded collision/body Yes. Null when neither is Yes.
 */
export type FitBasis = "repair" | "collision" | null;
export function fitBasis(signals: readonly { key: string; value: string }[] | Partial<Record<string, string>>): FitBasis {
  const value = (key: string) => (Array.isArray(signals) ? signals.find((s) => s.key === key)?.value : (signals as Partial<Record<string, string>>)[key]);
  if (value("automotive_repair_services") === "yes") return "repair";
  if (value("collision_repair_services") === "yes") return "collision";
  return null;
}

/** The sourced-evidence check for the basis of product fit. Collision evidence is checked by the unchanged collision rules. */
export function fitEvidenceErrors(
  business: { businessName: string | null; website: string | null },
  basis: FitBasis,
  evidence: readonly { signalKey: string; sourceUrl: string; excerpt: string }[],
): string[] {
  return basis === "collision" ? collisionEvidenceErrors(business, evidence) : repairEvidenceErrors(business, evidence);
}

/**
 * The contradiction that blocks approval and qualification, named by what it
 * is about, or null. Collision/body contradictions matter only while fit
 * doesn't rest on automotive repair evidence: a mechanic's verified repair
 * work doesn't wait on its body-shop wording.
 */
export function fitConflict(warnings: unknown, basis: FitBasis): "collision/body" | "automotive repair" | null {
  if (basis !== "repair" && hasCollisionResearchConflict(warnings)) return "collision/body";
  return hasRepairResearchConflict(warnings) ? "automotive repair" : null;
}
