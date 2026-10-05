import type { Page } from "./analyze.js";
import { isOnBusinessSite, normalizeDomain, normalizeName } from "../discovery/normalize.js";

/** Public services evidence only. Names/categories/ownership never imply product fit. */
export interface CollisionFit {
  status: "primary" | "possible" | "negative" | "conflict" | "unknown";
  sourceUrl: string | null;
  excerpt: string | null;
}

const PRIMARY = /\b(?:(?:collision|accident)(?:[- ]damage)?\s+repairs?|auto(?:motive)?[- ]?body(?:\s+(?:and|&)\s+paint)?\s+(?:repairs?|services?)|(?:vehicle|automotive|car)\s+(?:body|panel|structural|frame)\s+repairs?|body\s+repairs?)\b/i;
const SPECIALTY = /\b(?:paintless\s+dent\s+repair|(?:dent|panel|structural|frame)\s+repair|automotive\s+(?:paint|painting|refinishing))\b/i;
const AUTOMOTIVE = /\b(?:automotive|auto|vehicles?|cars?|collision|accident)\b/i;
const EXTERNAL = /\b(?:suppl(?:y|ies|iers?)|equipment|software|products?|materials?|tools?|outsource\w*|subcontract\w*|director(?:y|ies)|providers?|listings?|marketplace|coverage|polic(?:y|ies)|near\s+me|training|courses?|careers?|jobs?|partner\w*|refer(?:ral|rals)?|refer\s+(?:you|customers)|other\s+(?:shops|businesses)|recommend\w*)\b/i;
const NEGATIVE = /\b(?:do\s+not|don't|does\s+not|doesn't|not\s+(?:offer(?:ed|ing|s)?|provid(?:e|ed|ing|es)|perform(?:ed|ing|s)?|available)|unavailable|no\s+longer|no\s+(?:collision|accident|auto\s*body|body)\s+repairs?|never\s+(?:offer|provide|perform)|cannot|can't|unable\s+to)\b/i;
const OFFERING = /\b(?:we\s+(?:offer|provide|perform|handle|speciali[sz]e|repair)|our\s+(?:services|shop|team|technicians|collision|body)|services\s+(?:include|offered)|speciali[sz]ing\s+in)\b/i;

export function collisionFit(businessName: string, pages: readonly { url: string; role: Page["role"]; parsed: Pick<Page["parsed"], "text"> }[]): CollisionFit {
  const positive: { sourceUrl: string; excerpt: string }[] = [];
  const negative: typeof positive = [];
  const specialty: typeof positive = [];
  const escapedName = businessName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const page of pages) {
    // A business called "Harbor Collision Repair" is still only a name.
    const text = page.parsed.text.replace(new RegExp(escapedName, "gi"), " ").replace(/[’‘]/g, "'");
    for (const chunk of text.split(/(?<=[.!?;])\s+|\n+|\bbut\b|\band\s+(?=(?:we|our|this\s+shop|(?:collision|accident|auto\s*body|body)\s+repairs?\s+(?:is|are))\b)/i)) {
      const match = PRIMARY.exec(chunk) ?? SPECIALTY.exec(chunk);
      if (!match) continue;
      const context = chunk.slice(Math.max(0, match.index - 140), match.index + match[0].length + 140);
      if (EXTERNAL.test(context) || (!AUTOMOTIVE.test(context) && !/auto(?:motive)?[- ]?body|collision|accident/i.test(match[0]))) continue;
      const evidence = { sourceUrl: page.url, excerpt: context.trim().slice(0, 280) };
      if (NEGATIVE.test(context)) {
        // Only an explicit statement about this business's offering is No.
        if (/\b(?:we|our|this\s+shop|here)\b/i.test(context) || page.role === "services") negative.push(evidence);
      } else if (page.role === "services" || OFFERING.test(context)) {
        (PRIMARY.test(match[0]) ? positive : specialty).push(evidence);
      }
    }
  }
  const answer = (status: CollisionFit["status"], ev?: { sourceUrl: string; excerpt: string }): CollisionFit => ({ status, sourceUrl: ev?.sourceUrl ?? null, excerpt: ev?.excerpt ?? null });
  if (negative.length && (positive.length || specialty.length)) return answer("conflict", negative[0]);
  if (positive.length) return answer("primary", positive[0]);
  if (negative.length) return answer("negative", negative[0]);
  if (specialty.length) return answer("possible", specialty[0]);
  return answer("unknown");
}

/** The same collision findings, applied to stored excerpts rather than fetched pages. */
export function collisionEvidenceErrors(
  business: { businessName: string | null; website: string | null },
  evidence: readonly { signalKey: string; sourceUrl: string; excerpt: string }[],
): string[] {
  const missing = "Qualification requires sourced collision/body evidence attributed to this business, with a public source URL and supporting excerpt.";
  const name = business.businessName?.trim();
  if (!name) return [missing];
  const items = evidence.filter(e => e.signalKey === "collision_repair_services");
  if (!items.length) return [missing];
  const pages: Parameters<typeof collisionFit>[1][number][] = [];
  for (const e of items) {
    try {
      const source = new URL(e.sourceUrl);
      if (!/^https?:$/.test(source.protocol) || source.username || source.password || !source.hostname.includes(".") || !e.excerpt.trim() || e.sourceUrl.length > 500 || e.excerpt.length > 280) return [missing];
      if (normalizeDomain(business.website)) {
        if (!isOnBusinessSite(e.sourceUrl, business.website)) return [missing];
      } else if (!normalizeName(name) || !` ${normalizeName(e.excerpt)} `.includes(` ${normalizeName(name)} `)) {
        // Without a recorded website, the public excerpt must identify the business itself.
        return [missing];
      }
      pages.push({ url: source.href, role: "services", parsed: { text: e.excerpt } });
    } catch { return [missing]; }
  }
  const fit = collisionFit(name, pages);
  if (fit.status === "negative" || fit.status === "conflict") return ["Resolve contradictory collision/body evidence before qualification or Ready to contact."];
  // Specialty/dealership fit may be verified by a human, who still must explicitly record Yes.
  return fit.status === "primary" || fit.status === "possible" ? [] : [missing];
}

export const hasCollisionResearchConflict = (warnings: unknown): boolean =>
  Array.isArray(warnings) && warnings.some(w => typeof w === "string" && /Collision\/body evidence is contradictory|Research found "collision_repair_services" = (?:yes|no), but a person recorded (?:yes|no)/.test(w));
