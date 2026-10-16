import { evidencePageAllowed, isStrongIdentity, type PageLocation } from "../research/location.js";
import { RESEARCH_VERSION } from "../research/researcher.js";
import { assessServiceEvidence, type ServiceAssessment } from "../research/serviceEvidence.js";
import { commercialCandidate } from "./commercial.js";
import type { AutomationCandidate, Protection } from "./automationPolicy.js";
import { isOnBusinessSite } from "./normalize.js";

/*
 * READY TO APPROVE (research r16, automation discovery@d2): a person can approve this business
 * as a ReclaimBay Prospect without doing basic identity or service research themselves.
 * The base conditions (in-target category, required criterion met, every signal quoted, no
 * blocking warning, verified run on the current website) are checked by assessDiscovery; this
 * adds, in order:
 *
 *   rules      the run is research r16 (an older run gets one current-rules re-read; its
 *              evidence stays untouched and is never reinterpreted into Ready)
 *   identity   this physical location is verified (research/location.ts), and a single-location
 *              identity is not enough when another candidate uses the same website elsewhere
 *   duplicates no unresolved duplicate relationship (discovery/relationships.ts)
 *   ownership  an allowed ownership class (policies/reclaimbay/readiness.ts)
 *   service    strong concrete service evidence from THIS run's quotes on attributable pages
 *
 * Contact quality is reported as warnings: qualification and outreach contact are separate.
 */

export type ReadinessCode = "stale_rules" | "location_identity" | "duplicate_relationship" | "ownership" | "outside_icp" | "adjacent_trade" | "service_evidence";

export interface Readiness {
  ready: boolean;
  code: ReadinessCode | null;
  reason: string;
  warnings: string[];
  service: ServiceAssessment | null;
}

type Run = AutomationCandidate["research"][number];

const FIT_KEYS = ["automotive_repair_services", "collision_repair_services"];

const sameUrl = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
    const path = (u: URL) => u.pathname.replace(/\/+$/, "");
    return host(x) === host(y) && path(x) === path(y);
  } catch {
    return a === b;
  }
};

export function assessReadiness(c: AutomationCandidate, protection: Protection, run: Run): Readiness {
  const fail = (code: ReadinessCode, reason: string, service: ServiceAssessment | null = null): Readiness => ({ ready: false, code, reason, warnings: [], service });
  if (run.version !== RESEARCH_VERSION) {
    return fail("stale_rules", `Evaluated under research ${run.version}; Ready requires a current ${RESEARCH_VERSION} read of this website.`);
  }
  const fact = (field: string) => run.facts.find((f) => f.field === field);
  const relationships = protection.relationships;
  const warnings = [...relationships.warnings];

  const identity = fact("location_identity")?.value ?? null;
  if (!isStrongIdentity(identity)) return fail("location_identity", fact("location_identity")?.note ?? "This location's identity is not verified on its website.");
  if (identity === "single_location_site" && relationships.multiLocationPeers.length) {
    return fail("location_identity", `Another candidate uses this website at a different address (${relationships.multiLocationPeers.join(", ")}): this location's street address must appear on its pages.`);
  }

  if (relationships.blocking.length) return fail("duplicate_relationship", `${relationships.blocking.join(" ")} A person resolves the duplicate question before approval.`);

  const commercial = commercialCandidate(c);
  if (commercial.findings.some(f => ["commercial.ownership_unresolved", "commercial.multi_store_tire_retail", "commercial.tire_retail_locations", "commercial.dealer_manufacturer"].includes(f.code)))
    return fail("ownership", commercial.findings.map(f => f.reason).join(" "));
  const ownership = fact("ownership_class")?.value ?? "unknown";
  const siteTitle = fact("business_name")?.value ?? null;
  if (ownership === "unknown") warnings.push("Ownership is not stated on the website.");

  // Each page_location fact points at the run's stored source for that page (its fetched and final URL).
  const pages = run.facts.filter((f) => f.field === "page_location" && f.sourceId);
  const pageOf = (url: string) =>
    pages.find((p) => {
      const source = run.sources.find((s) => s.id === p.sourceId);
      return Boolean(source) && (sameUrl(source!.url, url) || (source!.finalUrl !== null && sameUrl(source!.finalUrl, url)));
    });
  const quotes = c.evidence
    .filter((e) => e.researchId === run.id && FIT_KEYS.includes(e.signalKey) && isOnBusinessSite(e.sourceUrl, c.website))
    .flatMap((e) => {
      const page = pageOf(e.sourceUrl);
      return evidencePageAllowed(page?.value as PageLocation | undefined, identity) ? [{ url: e.sourceUrl, excerpt: e.excerpt, title: page?.excerpt ?? null }] : [];
    });
  const trades = (fact("trade_context")?.value ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const service = assessServiceEvidence({ businessName: c.businessName, quotes, trades, siteTitles: [siteTitle] });
  if (service.strength !== "strong") {
    return fail(service.outsideIcp ? "outside_icp" : service.trades.length && !service.counted.length ? "adjacent_trade" : "service_evidence", service.reason, service);
  }

  if (fact("phone")?.state !== "verified") warnings.push("No phone is tied to this verified location: never use a phone for outreach until one is.");
  if (fact("email")?.state !== "verified") warnings.push("No email on the business's own website: outreach still needs a verified recipient.");
  return { ready: true, code: null, reason: service.reason, warnings, service };
}
