import { scoreCandidate, researchGateErrors } from "./approval.js";
import { commercialCandidate } from "./commercial.js";
import { fitBasis, fitEvidenceErrors } from "../research/repairFit.js";
import { isStrongIdentity } from "../research/location.js";
import { RESEARCH_VERSION } from "../research/researcher.js";
import { isOnBusinessSite } from "./normalize.js";
import type { AutomationCandidate, Protection } from "./automationPolicy.js";

export const ACQUISITION_RULES = "reclaimbay.acquisition@v1";
export interface AcquisitionGate { pass: boolean; code: string; reason: string }
/** Read-only readiness contract for a future creator. This module cannot approve, enqueue, fetch or send. */
export function assessAcquisition(c: AutomationCandidate, protection: Protection) {
  const run = c.research[0];
  const commercial = commercialCandidate(c);
  const identityPass = Boolean(run?.version === RESEARCH_VERSION && run.status === "completed" && run.outcome === "website_verified" &&
    c.websiteVerifiedAt && run.subjectWebsite === c.website && isStrongIdentity(run.facts.find(f => f.field === "location_identity")?.value));
  const fit = fitBasis(c.signals);
  const technicalPass = scoreCandidate(c).qualification === "meets_criteria" && !researchGateErrors(c.signals, c.evidence).length &&
    !fitEvidenceErrors(c, fit, c.evidence).length && c.categoryVerdict === "in_target" &&
    !(Array.isArray(run?.warnings) && run.warnings.some(w => typeof w === "string" && /contradictory|conflict/i.test(w)));
  const account = protection.account;
  const duplicatePass = !protection.duplicateTargetConflict && !protection.relationships.blocking.length &&
    !c.duplicateHold && !c.possibleDuplicateCandidateId && !c.possibleDuplicateProspectId;
  const emailFact = run?.facts.find(f => f.field === "email" && f.state === "verified" && f.value === c.email);
  const contactPass = Boolean(c.email && c.emailSourceUrl && emailFact?.sourceId && isOnBusinessSite(c.emailSourceUrl, c.website) &&
    run?.sources.some(s => s.id === emailFact.sourceId && s.ok && s.kind === "website" && [s.url, s.finalUrl].includes(c.emailSourceUrl)));
  const gate = (pass: boolean, code: string, reason: string): AcquisitionGate => ({ pass, code, reason });
  const gates = {
    identity: gate(identityPass, identityPass ? "identity.verified" : "identity.unverified", "Autonomy requires a current successful run for this physical business/location."),
    technical: gate(technicalPass, technicalPass ? "technical.fit" : "technical.incomplete", "Existing technical qualification and evidence rules remain authoritative."),
    commercial: gate(commercial.disposition === "fit" && commercial.confidence === "high", `commercial.${commercial.disposition}`, commercial.findings.map(f => f.reason).join(" ")),
    account: gate(duplicatePass && Boolean(account?.clear), account?.code ?? "account.unassessed", account?.reason ?? "Account relationships have not been assessed."),
    contact: gate(contactPass, contactPass ? "contact.verified_email" : "contact.incomplete", "A verified, source-linked recipient for this current location is required; a provider phone is insufficient."),
    protection: gate(!protection.protected, protection.protected ? "protection.protected" : "protection.clear", "Existing Prospect, outreach, suppression and unsubscribe identities cannot enter Discovery automation."),
    lifecycle: gate(c.status === "researched" && !c.notes.some(n => n.body.startsWith("Reopened by a person")), "lifecycle.researched", "Human holds, reopened and terminal records require their existing review path."),
  };
  return { rules: ACQUISITION_RULES, technicalQualification: scoreCandidate(c).qualification, commercial, account,
    gates, eligibleForAutonomousProspecting: Object.values(gates).every(g => g.pass),
    prospectCreationEnabled: false as const, requiresHumanApproval: true as const,
    outreachAuthorization: "not_evaluated_no_send_permission" as const };
}
