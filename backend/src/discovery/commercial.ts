import { assessCommercialFit, type CommercialQuote } from "../policies/reclaimbay/commercial.js";
import { evidencePageAllowed } from "../research/location.js";
import { businessKinds } from "../research/serviceEvidence.js";
import { isOnBusinessSite } from "./normalize.js";
import type { AutomationCandidate } from "./automationPolicy.js";

/** Adapt retained, successful sources into policy evidence. Never fetches or mutates a record. */
export function commercialCandidate(c: AutomationCandidate) {
  const run = c.research[0];
  const quotes: CommercialQuote[] = [];
  const identity = run?.facts.find(f => f.field === "location_identity")?.value;
  const allowed = (url: string) => {
    if (!run || run.status !== "completed" || run.outcome !== "website_verified" || !c.websiteVerifiedAt ||
      (run.subjectWebsite !== null && run.subjectWebsite !== c.website) || !isOnBusinessSite(url, c.website)) return false;
    return run.sources.some(s => s.ok && s.kind === "website" && [s.url, s.finalUrl].includes(url) &&
      evidencePageAllowed(run.facts.find(f => f.field === "page_location" && f.sourceId === s.id)?.value as never, identity));
  };
  for (const e of c.evidence) if ((run ? e.researchId === run.id && allowed(e.sourceUrl) : e.origin === "manual" && isOnBusinessSite(e.sourceUrl, c.website)) &&
    ["automotive_repair_services", "collision_repair_services", "independent_shop"].includes(e.signalKey)) {
    quotes.push({ sourceUrl: e.sourceUrl, excerpt: e.excerpt, evidenceId: e.id, ...(e.researchId ? { researchId: e.researchId } : {}) });
  }
  for (const f of run?.facts ?? []) {
    const source = run!.sources.find(s => s.id === f.sourceId);
    if (["commercial_quote", "business_type"].includes(f.field) && f.excerpt && source && f.state === "verified" && allowed(source.finalUrl ?? source.url)) {
      quotes.push({ sourceUrl: source.finalUrl ?? source.url, excerpt: f.excerpt, factId: f.id, researchId: run!.id, sourceId: source.id });
    }
  }
  const result = assessCommercialFit({ quotes, ownership: run?.facts.find(f => f.field === "ownership_class")?.value,
    siteLocations: Number(run?.facts.find(f => f.field === "site_locations")?.value ?? 0),
    tireRetailHint: businessKinds(c.businessName).includes("tire") });
  if (result.disposition === "exclude" && !result.findings.some(f => f.code === "commercial.multi_store_tire_retail")) {
    const historical: CommercialQuote[] = c.evidence.filter(e => e.researchId !== run?.id && isOnBusinessSite(e.sourceUrl, c.website) &&
      ["automotive_repair_services", "collision_repair_services"].includes(e.signalKey) &&
      (e.origin === "manual" || c.research.some(r => r.id === e.researchId && r.status === "completed" && r.outcome === "website_verified" &&
        r.sources.some(s => s.ok && s.kind === "website" && [s.url, s.finalUrl].includes(e.sourceUrl)))))
      .map(e => ({ sourceUrl: e.sourceUrl, excerpt: e.excerpt, evidenceId: e.id, ...(e.researchId ? { researchId: e.researchId } : {}) }));
    if (assessCommercialFit({ quotes: historical }).disposition === "fit") return { ...result, disposition: "review" as const, confidence: "low" as const,
      autonomousHandling: false, requiresHumanReview: true, findings: [...result.findings, { code: "commercial.historical_conflict",
        reason: "Earlier attributable normal repair evidence conflicts with the current scope exclusion; both sources remain and require review.", evidence: historical }] };
  }
  return result;
}

/** Valid JSON chunks within the existing Candidate/Prospect note limit, with every evidence reference retained. */
export function commercialAuditEntries(assessment: ReturnType<typeof commercialCandidate>, context: { candidateId: string; researchId?: string; action: string }): string[] {
  const references = [...new Set(assessment.findings.flatMap(f => f.evidence.map(e => JSON.stringify({ evidenceId: e.evidenceId, factId: e.factId, researchId: e.researchId, sourceId: e.sourceId }))))].map(s => JSON.parse(s) as unknown);
  const chunks = Math.max(1, Math.ceil(references.length / 6));
  return Array.from({ length: chunks }, (_, i) => JSON.stringify({ type: "commercial_assessment", ...context, rules: assessment.rules,
    disposition: assessment.disposition, confidence: assessment.confidence,
    findings: assessment.findings.map(f => ({ code: f.code, reason: f.reason })),
    part: i + 1, parts: chunks, references: references.slice(i * 6, (i + 1) * 6) }));
}
