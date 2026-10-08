/** Pure qualification/scoring execution. Business rules enter only through a policy. */
export interface PolicyIdentity {
  readonly policyId: string;
  readonly version: string;
}

export type SignalState = "yes" | "no" | "unknown";
export type StoredSignalValue = "yes" | "no";
export type ScoreBand = "high" | "medium" | "low";
export type Qualification = "meets_criteria" | "unverified" | "disqualified";

export interface CriterionDefinition<Key extends string = string> {
  readonly key: Key;
  readonly label: string;
  readonly weight: number;
  readonly kind: "observation" | "derived";
  readonly requiredCriterion?: boolean;
}

/**
 * Trusted, synchronous business code: no database or provider access in these hooks.
 * Input is deliberately unconstrained: execution knows no business fields or signal keys.
 * Resolving observations and explaining them belong to the same versioned policy.
 */
export interface ScoringPolicy<Input, Key extends string = string> extends PolicyIdentity {
  readonly signals: readonly CriterionDefinition<Key>[];
  readonly bandThresholds: Readonly<{ high: number; medium: number }>;
  readonly bandLabels: Readonly<Record<ScoreBand, string>>;
  readonly qualificationLabels: Readonly<Record<Qualification, string>>;
  readonly resolveSignals: (input: Input) => Readonly<Record<Key, SignalState>>;
  readonly explainSignal: (key: Key, state: SignalState, input: Input) => string;
  readonly consistencyErrors: (input: Input) => string[];
}

/** Evidence validation is separate from scoring; the caller retains the write/approval gate. */
export interface QualificationPolicy<Input, Key extends string, EvidenceInput> extends ScoringPolicy<Input, Key> {
  readonly evidenceErrors: (input: EvidenceInput) => string[];
}

export interface SignalResult<Key extends string = string> {
  key: Key;
  label: string;
  weight: number;
  state: SignalState;
  points: number;
  derived: boolean;
  reason: string;
}

export interface ScoreResult<Key extends string = string> extends PolicyIdentity {
  score: number;
  maxScore: number;
  band: ScoreBand;
  qualification: Qualification;
  disqualifiedBy: Key[];
  unverifiedCriteria: Key[];
  known: number;
  total: number;
  breakdown: SignalResult<Key>[];
}

export interface PolicyValidationResult extends PolicyIdentity {
  errors: string[];
}

export function bandFor(score: number, thresholds: ScoringPolicy<unknown>["bandThresholds"]): ScoreBand {
  if (score >= thresholds.high) return "high";
  if (score >= thresholds.medium) return "medium";
  return "low";
}

export function qualificationFor(failed: number, unknown: number): Qualification {
  if (failed > 0) return "disqualified";
  return unknown > 0 ? "unverified" : "meets_criteria";
}

/** Qualification and priority are independent; a high score never overrides a required criterion. */
export function evaluatePolicy<Input, Key extends string>(policy: ScoringPolicy<Input, Key>, input: Input): ScoreResult<Key> {
  const states = policy.resolveSignals(input);
  const breakdown: SignalResult<Key>[] = policy.signals.map((def) => {
    // Fail closed: an observation the policy omits or can't state is unknown, never satisfied.
    const resolved: unknown = states[def.key];
    const state: SignalState = resolved === "yes" || resolved === "no" ? resolved : "unknown";
    return {
      key: def.key,
      label: def.label,
      weight: def.weight,
      state,
      points: state === "yes" ? def.weight : 0,
      derived: def.kind === "derived",
      reason: policy.explainSignal(def.key, state, input),
    };
  });
  const score = breakdown.reduce((sum, s) => sum + s.points, 0);
  const requiredKeys = new Set(policy.signals.filter((s) => s.requiredCriterion).map((s) => s.key));
  const required = breakdown.filter((s) => requiredKeys.has(s.key));
  const disqualifiedBy = required.filter((s) => s.state === "no").map((s) => s.key);
  const unverifiedCriteria = required.filter((s) => s.state === "unknown").map((s) => s.key);
  return {
    policyId: policy.policyId,
    version: policy.version,
    score,
    maxScore: policy.signals.reduce((sum, s) => sum + s.weight, 0),
    band: bandFor(score, policy.bandThresholds),
    qualification: qualificationFor(disqualifiedBy.length, unverifiedCriteria.length),
    disqualifiedBy,
    unverifiedCriteria,
    known: breakdown.filter((s) => s.state !== "unknown").length,
    total: breakdown.length,
    breakdown,
  };
}

export function validatePolicyInput<Input>(policy: Pick<ScoringPolicy<Input>, "policyId" | "version" | "consistencyErrors">, input: Input): PolicyValidationResult {
  return { policyId: policy.policyId, version: policy.version, errors: policy.consistencyErrors(input) };
}

export function validateQualificationEvidence<Input>(policy: PolicyIdentity & { evidenceErrors: (input: Input) => string[] }, input: Input): PolicyValidationResult {
  return { policyId: policy.policyId, version: policy.version, errors: policy.evidenceErrors(input) };
}
