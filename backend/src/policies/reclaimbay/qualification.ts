import type { QualificationPolicy } from "aos/qualification";
import { fitBasis, fitConflict, fitEvidenceErrors } from "../../research/repairFit.js";
import { reclaimBayScoringPolicy, type ScoringInput, type SignalKey } from "./scoring.js";

export interface QualificationEvidenceInput extends ScoringInput {
  businessName: string | null;
  website: string | null;
  evidence: readonly { signalKey: string; sourceUrl: string; excerpt: string }[];
  researchWarnings?: unknown;
}

/**
 * ReclaimBay's evidence authority, composed separately so scoring remains a leaf
 * dependency. The existing classifiers stay in place for research/approval/copy.
 * This policy never decides when a write, approval, or send is allowed.
 */
export const reclaimBayQualificationPolicy = {
  ...reclaimBayScoringPolicy,
  evidenceErrors(input: QualificationEvidenceInput): string[] {
    const basis = fitBasis(input.signals);
    const errors = fitEvidenceErrors(input, basis, input.evidence);
    const conflict = fitConflict(input.researchWarnings, basis);
    if (conflict) errors.push(`Resolve contradictory ${conflict} research before qualification or Ready to contact.`);
    return errors;
  },
} satisfies QualificationPolicy<ScoringInput, SignalKey, QualificationEvidenceInput>;
