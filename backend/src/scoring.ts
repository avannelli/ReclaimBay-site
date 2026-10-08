/**
 * Compatibility entry point for the current application's ReclaimBay policy.
 * Generic execution lives in the AOS engine (@avannelli/aos/qualification); business rules live in
 * policies/reclaimbay/. Existing callers and stored v3 snapshots are preserved.
 */
import { bandFor as policyBandFor, evaluatePolicy, validatePolicyInput } from "@avannelli/aos/qualification";
import { BAND_THRESHOLDS, reclaimBayScoringPolicy, type ScoringInput, type SignalKey } from "./policies/reclaimbay/scoring.js";

export { qualificationFor } from "@avannelli/aos/qualification";
export type { Qualification, ScoreBand, SignalState, StoredSignalValue } from "@avannelli/aos/qualification";
export {
  POLICY_ID, SCORING_VERSION, SIGNALS, SIGNAL_KEYS, MAX_SCORE, BAND_THRESHOLDS,
  BAND_LABELS, QUALIFICATION_LABELS, REQUIRED_CRITERIA, FIT_CRITERION, FIT_SIGNALS,
  establishedBy, isSignalKey, signalDefinition, hasPublicContact, resolveSignals,
} from "./policies/reclaimbay/scoring.js";
export type { ScoringInput, SignalKey, SignalDefinition } from "./policies/reclaimbay/scoring.js";
export type SignalResult = import("@avannelli/aos/qualification").SignalResult<SignalKey>;
export type ScoreResult = import("@avannelli/aos/qualification").ScoreResult<SignalKey>;

export const bandFor = (score: number) => policyBandFor(score, BAND_THRESHOLDS);
export const scoreProspect = (input: ScoringInput): ScoreResult => evaluatePolicy(reclaimBayScoringPolicy, input);
export const signalConsistencyErrors = (input: ScoringInput): string[] => validatePolicyInput(reclaimBayScoringPolicy, input).errors;
