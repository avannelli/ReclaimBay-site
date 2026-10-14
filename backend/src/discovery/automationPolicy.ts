import type { Prisma } from "../generated/prisma/client.js";
import { RESEARCH_VERSION } from "../research/researcher.js";
import { fitBasis, fitEvidenceErrors, repairFit } from "../research/repairFit.js";
import { scoreCandidate, researchGateErrors } from "./approval.js";
import { CRITICAL_WARNINGS, NOTED_WARNINGS } from "./autoApproval.js";
import { auditedCategoryCorrection } from "./categoryReassessment.js";
import { nameOutsideTerms } from "./categories.js";
import { duplicatePending } from "./duplicateReview.js";
import { isOnBusinessSite, isOwnWebsiteHost } from "./normalize.js";
import type { candidateProtection } from "./protection.js";
import { unreviewedWarnings } from "./warningReview.js";

export const AUTOMATION_RULES = "discovery@d1";
export const automationInclude = {
  signals: { orderBy: { id: "asc" } }, evidence: { orderBy: { id: "asc" } }, notes: { orderBy: { id: "asc" } },
  research: { orderBy: [{ queuedAt: "desc" }, { finishedAt: { sort: "desc", nulls: "last" } }, { startedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }], include: { facts: { orderBy: { id: "asc" } }, sources: { orderBy: { id: "asc" } } } },
} as const satisfies Prisma.DiscoveryCandidateInclude;
export type AutomationCandidate = Prisma.DiscoveryCandidateGetPayload<{ include: typeof automationInclude }>;
export type Protection = ReturnType<typeof candidateProtection>;
export type AutomationAction = "handled" | "protected" | "wait" | "category" | "link_duplicate" | "qualify" | "reject" | "research" | "ready" | "human";
export interface AutomationAssessment {
  action: AutomationAction;
  reason: string;
  code: string;
  evidenceIds?: string[];
  canonicalProspectId?: string;
  category?: NonNullable<ReturnType<typeof auditedCategoryCorrection>>;
  researchKind?: "fresh" | "retry" | "refresh" | "recovery";
}
const decision = (action: AutomationAction, code: string, reason: string, extra: Partial<AutomationAssessment> = {}): AutomationAssessment => ({ action, code, reason, ...extra });
const warningsOf = (w: unknown): string[] => Array.isArray(w) ? w.filter((s): s is string => typeof s === "string") : [];
export const blockingWarnings = (w: unknown) => warningsOf(w).filter(s => CRITICAL_WARNINGS.some(rule => rule.pattern.test(s)) || !NOTED_WARNINGS.some(rule => rule.pattern.test(s)));

/** Reinterpret actual, attributed excerpts, never a legacy Yes or a category label.
 * Only the latest verified identity's research can supply a new fit observation. */
function historicalFit(c: AutomationCandidate) {
  const run = c.research[0];
  if (!run || run.status !== "completed" || run.outcome !== "website_verified" || !c.websiteVerifiedAt ||
    (run.subjectWebsite !== null && run.subjectWebsite !== c.website) || blockingWarnings(unreviewedWarnings(run, c.notes, c)).length) return null;
  if (c.signals.some(s => ["automotive_repair_services", "collision_repair_services"].includes(s.key) && s.value === "no")) return null;
  if (/\b(?:dealership|fleet)\b/i.test(c.businessName) || run.facts.some(f => f.field === "business_type" && f.value === "dealership") ||
    c.evidence.some(e => e.signalKey === "independent_shop" && /\bdealership\b/i.test(e.excerpt))) return null;
  const evidence = c.evidence.filter(e => e.origin === "research" && e.researchId === run.id &&
    ["general_repair_services", "automotive_repair_services", "collision_repair_services"].includes(e.signalKey) &&
    isOnBusinessSite(e.sourceUrl, c.website) && run.sources.some(s => s.ok && s.kind === "website" && [s.url, s.finalUrl].includes(e.sourceUrl)));
  // Old machine-written service summaries are not quoted evidence of primary repair work.
  const fit = repairFit(c.businessName, evidence.map(e => ({ url: e.sourceUrl, role: "services" as const, parsed: { text: e.excerpt.replace(/^Names [^:]+:\s*/, "") } })));
  if (fit.status !== "primary" || (nameOutsideTerms(c.businessName).length && fit.services.length < 2)) return null;
  const mapped = evidence.map(e => ({ ...e, signalKey: "automotive_repair_services" }));
  const retained = c.evidence.filter(e => ["general_repair_services", "automotive_repair_services"].includes(e.signalKey))
    .map(e => ({ ...e, signalKey: "automotive_repair_services" }));
  if (fitEvidenceErrors(c, "repair", [...mapped, ...retained]).length) return null;
  return evidence;
}

/** Pure assessment used by preview, worker selection and transaction-time revalidation. */
export function assessDiscovery(c: AutomationCandidate, protection: Protection, now = new Date(), options: { recovery?: boolean } = {}): AutomationAssessment {
  if (["approved", "rejected", "duplicate"].includes(c.status)) return decision("handled", "terminal", c.decisionReason ?? "Historical decision preserved.");
  if (c.research.some(r => ["queued", "running"].includes(r.status))) return decision("wait", "pending", "Research is queued or running.");
  const confident = protection.matches.filter(m => m.strength === "confident");
  if (!c.prospectId && !protection.duplicateTargetConflict && c.status === "needs_review" && c.duplicateHold && c.duplicateDecision === null && confident.length === 1 &&
    protection.prospectIds.every(id => id === confident[0]!.id) &&
    (!c.possibleDuplicateProspectId || c.possibleDuplicateProspectId === confident[0]!.id)) {
    return decision("link_duplicate", "canonical_prospect", `Confident existing prospect match: ${confident[0]!.reason}. Protected identity: a person marks the duplicate on the candidate page; automation does not apply it.`, { canonicalProspectId: confident[0]!.id });
  }
  if (protection.protected) return decision("protected", "downstream_identity", "Prospect, outreach or opt-out identity is protected; review it through its existing record.");
  if (duplicatePending(c)) return decision("human", "duplicate", "An ambiguous duplicate requires an identity decision.");
  if (c.status === "needs_review" || c.notes.some(n => n.body.startsWith("Reopened by a person"))) return decision("human", "human_hold", "A person's hold or reopened decision is preserved.");
  if (c.providerStatus === "permanently_closed") return decision("human", "closure", "Provider closure needs source verification.");
  const correction = auditedCategoryCorrection(c);
  if (correction) return decision("category", "audited_category", "Reassess this audited stale name exclusion under the current category rules.", { category: correction });
  const run = c.research[0];
  const blockers = blockingWarnings(unreviewedWarnings(run, c.notes, c));
  const basis = fitBasis(c.signals);
  const retainedFit = repairFit(c.businessName, c.evidence.filter(e => ["general_repair_services", "automotive_repair_services", "collision_repair_services"].includes(e.signalKey))
    .map(e => ({ url: e.sourceUrl, role: "services" as const, parsed: { text: e.excerpt.replace(/^Names [^:]+:\s*/, "") } })));
  if (retainedFit.status === "conflict") return decision("human", "conflicting_evidence", "Retained repair sources disagree. A person must resolve the conflicting evidence before qualification or rejection.");
  const score = scoreCandidate(c);
  if (basis && score.qualification === "meets_criteria" && !researchGateErrors(c.signals, c.evidence).length &&
    !fitEvidenceErrors(c, basis, c.evidence).length && c.categoryVerdict === "in_target" && !blockers.length &&
    (run ? run.status === "completed" && run.outcome === "website_verified" && c.websiteVerifiedAt &&
    (run.subjectWebsite === null || run.subjectWebsite === c.website) : c.status === "researched" && c.signals.some(s => s.origin === "manual" && s.key === (basis === "repair" ? "automotive_repair_services" : "collision_repair_services")))) {
    return decision("ready", "qualified", "Sourced repair fit meets current rules. Human approval is required to create a prospect.");
  }
  if (c.categoryVerdict !== "wrong_category" && c.status === "researched" && (c.categorySource !== "manual" || c.categoryVerdict === "in_target")) {
    const evidence = historicalFit(c);
    if (!basis && evidence?.length) return decision("qualify", "sourced_historical_fit", "Current repair rules confirm explicit services in the latest verified site's retained excerpts.", { evidenceIds: evidence.map(e => e.id) });
  }
  // Rejection needs explicit current negative evidence, never a name/category or a missing fact.
  const negative = c.signals.find(s => s.key === "automotive_repair_services" && s.value === "no" && s.origin === "research");
  if (c.status === "researched" && negative && !basis && !blockers.length && run?.status === "completed" && run.version === RESEARCH_VERSION && run.outcome === "website_verified" && c.websiteVerifiedAt && run.subjectWebsite === c.website && c.categorySource !== "manual") {
    const evidence = c.evidence.filter(e => e.signalKey === negative.key && e.origin === "research" && e.researchId === run.id && isOnBusinessSite(e.sourceUrl, c.website) && run.sources.some(s => s.ok && s.kind === "website" && [s.url, s.finalUrl].includes(e.sourceUrl)));
    const fit = repairFit(c.businessName, evidence.map(e => ({ url: e.sourceUrl, role: "services" as const, parsed: { text: e.excerpt } })));
    const retained = c.evidence.filter(e => ["general_repair_services", "automotive_repair_services", "collision_repair_services"].includes(e.signalKey));
    const allFit = repairFit(c.businessName, retained.map(e => ({ url: e.sourceUrl, role: "services" as const, parsed: { text: e.excerpt.replace(/^Names [^:]+:\s*/, "") } })));
    if (fit.status === "negative" && allFit.status === "negative" && evidence.length) return decision("reject", "sourced_negative_fit", "Current verified-site evidence explicitly says this business performs no automotive repair.", { evidenceIds: evidence.map(e => e.id) });
  }
  if (c.categoryVerdict === "wrong_category") return decision("human", "category_evidence", "The exclusion requires source verification; it is not an automatic rejection.");
  if (c.signals.some(s => s.key === "automotive_repair_services" && s.value === "no" && s.origin === "manual")) return decision("human", "manual_negative_fit", "A person's negative repair observation requires a human decision.");
  if (!c.website || !isOwnWebsiteHost(c.website)) return decision("human", "missing_website", "Find and save this business's own website or add attributed public evidence in the candidate editor.");
  if (!run && c.status === "researched") return decision("human", "manual_verification", "Verify the remaining repair question using attributed evidence.");
  if (!run) return decision("research", "fresh", "Research this candidate's public website.", { researchKind: "fresh" });
  if (run.outcome === "no_website" && run.subjectWebsite === null && c.researchRevision > 0) return decision("research", "website_added", "A website was added after the previous run.", { researchKind: "fresh" });
  if (run.subjectWebsite && run.subjectWebsite !== c.website) return decision("research", "website_corrected", "The website was corrected; verify the new site.", { researchKind: "fresh" });
  if (["access_blocked", "robots_disallowed"].includes(run.outcome ?? "")) return decision("human", "blocked", "Automated access is blocked. Use a permitted public source and record the evidence; do not bypass access controls.");
  if (["website_mismatch", "website_unconfirmed"].includes(run.outcome ?? "")) {
    if (run.subjectWebsite && run.subjectWebsite !== c.website) return decision("research", "website_corrected", "The website identity was corrected; verify the new site.", { researchKind: "fresh" });
    return decision("human", "identity", "Verify or correct this business's website/location before further research.");
  }
  const transient = run.status === "failed" && (!run.outcome || run.outcome === "website_unreachable");
  if (transient) {
    const cooled = now.getTime() - (run.finishedAt ?? run.queuedAt).getTime() >= 24 * 60 * 60 * 1000;
    if (c.research.length < 3 && cooled) return decision("research", "retry", "Retry a transient failure after the 24-hour cooldown.", { researchKind: "retry" });
    if (c.research.length >= 3 && cooled && options.recovery && !c.research.some(r => r.trigger === "recovery")) return decision("research", "bounded_recovery", "One explicitly requested recovery attempt; previous attempts remain in history.", { researchKind: "recovery" });
    return decision("human", cooled ? "retry_exhausted" : "cooldown", cooled ? "Retry budget exhausted. The admin may request one bounded recovery attempt." : "Waiting for the retry cooldown.");
  }
  if (run.status === "completed" && run.outcome === "website_verified" && run.version !== RESEARCH_VERSION &&
    !c.research.some(r => r.version === RESEARCH_VERSION && r.subjectWebsite === c.website)) {
    return decision("research", "policy_refresh", "Refresh old verified-site research once under current rules, preserving prior evidence.", { researchKind: "refresh" });
  }
  return decision("human", "insufficient_evidence", blockers[0] ?? "Current research lacks sufficient attributed repair evidence; verify the remaining question.");
}
