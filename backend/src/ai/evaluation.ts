/*
 * Gold-set evaluation: blind human labels against AI shadow decisions, and
 * against the deterministic rules on the same pages. Read-only.
 *
 * The evaluation unit is the cohort case, and the population is every case
 * with a blind label: the AI and the rules are scored on exactly the same
 * cases. A case without a usable AI answer (no decision for the version, an
 * error, an invalid answer) stays in the population as "no usable answer";
 * it is never dropped.
 *
 * The gold label is the BLIND label (revision 1). Adjudications made after
 * review are counted separately and never replace it in the metrics.
 * Every result names its cohort and sampling version, the decision kind, and
 * one AI model and prompt version: decisions from different versions are
 * never mixed. A rate is reported only from MIN_SAMPLE observations; below
 * that it is unavailable, never 0%. The model's confidence is not assumed to
 * be calibrated: accuracy is measured per confidence band.
 */
import type { Db } from "../db.js";
import { COLLISION_FIT_KIND } from "./collisionFitJudge.js";
import { isHumanLabel, type HumanLabel } from "./goldSet.js";

export const MIN_SAMPLE = 20;
export const LABELS: readonly HumanLabel[] = ["collision_primary", "specialty_body", "dealership_body_dept", "not_collision", "insufficient_evidence"];
const POSITIVE: readonly HumanLabel[] = ["collision_primary", "specialty_body", "dealership_body_dept"];

export const CONFIDENCE_BANDS: readonly { label: string; min: number; max: number }[] = [
  { label: "below 0.50", min: 0, max: 0.5 },
  { label: "0.50–0.59", min: 0.5, max: 0.6 },
  { label: "0.60–0.69", min: 0.6, max: 0.7 },
  { label: "0.70–0.79", min: 0.7, max: 0.8 },
  { label: "0.80–0.89", min: 0.8, max: 0.9 },
  { label: "0.90–0.94", min: 0.9, max: 0.95 },
  { label: "0.95–1.00", min: 0.95, max: 1.000001 },
];

/** A count and its base; the rate only when the base is large enough. */
export interface Rate {
  num: number;
  den: number;
  rate: number | null;
}
export const rate = (num: number, den: number, min = MIN_SAMPLE): Rate => ({ num, den, rate: den >= min && den > 0 ? num / den : null });

/** The rules' verdict (collisionFit) in the label taxonomy. A contradiction is an abstention. */
export const RULE_AS_LABEL: Record<string, HumanLabel> = { primary: "collision_primary", possible: "specialty_body", negative: "not_collision", unknown: "insufficient_evidence", conflict: "insufficient_evidence" };
/** Specialty and dealership are one class for the rules, which can't tell them apart. */
const ruleClassMatches = (gold: HumanLabel, rule: HumanLabel) => gold === rule || (rule === "specialty_body" && gold === "dealership_body_dept");

/** No usable AI answer for a labeled case: no decision for this version, an error, or an invalid answer. */
export const NO_ANSWER = "no_answer" as const;
/** What a classifier (the AI, or the rules) contributed for one case. */
export type Prediction = HumanLabel | typeof NO_ANSWER;
export const PREDICTIONS: readonly Prediction[] = [...LABELS, NO_ANSWER];

/** Whose answer a set of metrics scores. Never interchangeable. */
export type Scorer = "ai_vs_human" | "rules_vs_human";

export interface BinaryMetrics {
  truePositive: number;
  falsePositive: number;
  /** Gold positives the classifier didn't call positive, including abstentions and cases with no usable answer. */
  falseNegative: number;
  /** Of the false negatives, how many had no usable answer. */
  missedWithoutAnswer: number;
  /** TP / (TP + FP): over the classifier's positive calls on decisive gold labels. */
  precision: Rate;
  /** TP / (decisive gold positives in the population): every gold positive counts, answered or not. */
  recall: Rate;
}

export interface ClassifierMetrics {
  scorer: Scorer;
  /** The evaluation population: every case with a blind label. Identical for the AI and the rules. */
  population: number;
  /** confusion[gold][prediction], with a "no usable answer" column. */
  confusion: Record<HumanLabel, Record<Prediction, number>>;
  /** Exact agreement (the rules: specialty and dealership are one class), over the whole population. */
  agreement: Rate;
  /** Collision primary, over decisive gold labels (not "can't tell"). */
  primary: BinaryMetrics;
  /** Any collision/body fit (primary, specialty, dealership) against not collision, over decisive gold labels. */
  fit: BinaryMetrics;
  /** Answered "insufficient evidence" (a deliberate abstention), over the whole population. */
  abstention: Rate;
  /** No usable answer (missing, error, invalid), over the whole population. */
  noAnswer: Rate;
}

/**
 * Scores predictions against blind gold labels. Every pair is one case of the
 * population; nothing is dropped. A case without a usable answer stays in
 * every denominator that covers the population (agreement, abstention, no
 * answer, recall) and is never a positive call, so it never inflates
 * precision. `same` decides agreement (exact by default). Pure.
 */
export function classifierMetrics(
  scorer: Scorer,
  pairs: readonly { gold: HumanLabel; predicted: Prediction }[],
  same: (gold: HumanLabel, predicted: HumanLabel) => boolean = (a, b) => a === b,
): ClassifierMetrics {
  const confusion = Object.fromEntries(LABELS.map((g) => [g, Object.fromEntries(PREDICTIONS.map((p) => [p, 0]))])) as ClassifierMetrics["confusion"];
  let agree = 0;
  for (const { gold, predicted } of pairs) {
    confusion[gold][predicted]++;
    if (predicted !== NO_ANSWER && same(gold, predicted)) agree++;
  }
  const decisive = pairs.filter((p) => p.gold !== "insufficient_evidence");
  const binary = (isPos: (l: HumanLabel) => boolean): BinaryMetrics => {
    const called = (p: Prediction) => p !== NO_ANSWER && isPos(p);
    const tp = decisive.filter((p) => called(p.predicted) && isPos(p.gold)).length;
    const fp = decisive.filter((p) => called(p.predicted) && !isPos(p.gold)).length;
    const fn = decisive.filter((p) => !called(p.predicted) && isPos(p.gold));
    return {
      truePositive: tp,
      falsePositive: fp,
      falseNegative: fn.length,
      missedWithoutAnswer: fn.filter((p) => p.predicted === NO_ANSWER).length,
      precision: rate(tp, tp + fp),
      recall: rate(tp, tp + fn.length),
    };
  };
  return {
    scorer,
    population: pairs.length,
    confusion,
    agreement: rate(agree, pairs.length),
    primary: binary((l) => l === "collision_primary"),
    fit: binary((l) => POSITIVE.includes(l)),
    abstention: rate(pairs.filter((p) => p.predicted === "insufficient_evidence").length, pairs.length),
    noAnswer: rate(pairs.filter((p) => p.predicted === NO_ANSWER).length, pairs.length),
  };
}

export interface EvalAiDecision {
  status: string;
  decision: string | null;
  confidence: number | null;
  ruleDecision: string | null;
  agreement: string | null;
  validationErrors: unknown;
  costMicroUsd: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
}

export interface EvalCase {
  caseId: string;
  candidateId: string;
  stratum: string;
  /** The blind label (revision 1), the gold label. */
  gold: HumanLabel | null;
  /** The latest adjudication after review, if any. Never the gold label. */
  adjudicated: HumanLabel | null;
  /** The newest decision of the evaluated AI version for this candidate, or null. */
  ai: EvalAiDecision | null;
}

const INVALID_EVIDENCE = /quote|source URL|word for word|different page|evidence gate|needs evidence|sourceUrl/i;

export type AiOutcome = "valid" | "invalid" | "error" | "missing";

/** The AI's contribution for a case: its valid decision, or no usable answer. */
export function aiPrediction(c: EvalCase): { prediction: Prediction; outcome: AiOutcome } {
  if (!c.ai) return { prediction: NO_ANSWER, outcome: "missing" };
  if (c.ai.status === "valid" && isHumanLabel(c.ai.decision)) return { prediction: c.ai.decision, outcome: "valid" };
  return { prediction: NO_ANSWER, outcome: c.ai.status === "error" ? "error" : "invalid" };
}

/**
 * The rules' verdict for a case: the collision classifier on the same pages,
 * recorded with the AI decision. A contradiction is an abstention. Without an
 * AI row (the site was never read for this version), the rules have no
 * verdict either: no usable answer.
 */
export function rulePrediction(c: EvalCase): Prediction {
  const r = c.ai?.ruleDecision ? RULE_AS_LABEL[c.ai.ruleDecision] : undefined;
  return r ?? NO_ANSWER;
}

export interface StratumMetrics {
  stratum: string;
  cases: number;
  labeled: number;
  ai: { valid: number; abstained: number; noAnswer: number };
  aiVsHuman: ClassifierMetrics;
  rulesVsHuman: ClassifierMetrics;
}

export interface Metrics {
  /** Every case in the cohort. */
  cases: number;
  /** The evaluation population: cases with a blind label. Both the AI and the rules are scored on exactly these. */
  population: number;
  /** AI outcomes across the population. */
  aiOutcomes: { valid: number; abstained: number; invalid: number; error: number; missing: number };
  /** Rules outcomes across the population. */
  ruleOutcomes: { verdict: number; abstained: number; noVerdict: number };
  /** Human labels across the population. */
  humanLabels: { definite: number; cantTell: number };
  /** Invalid answers over the population. */
  invalid: Rate;
  /** Invalid answers whose failure was the evidence or a quote, over the population. */
  invalidEvidence: Rate;
  aiVsHuman: ClassifierMetrics;
  rulesVsHuman: ClassifierMetrics;
  /** Where both gave a valid verdict on the population (agreement with the rules is not accuracy). */
  aiVsRules: { agree: number; disagree: number; notComparable: number };
  /** Valid AI decisions on the population, by confidence. */
  bands: { label: string; decisions: number; accuracy: Rate }[];
  averageConfidence: number | null;
  costPerDecisionMicroUsd: number | null;
  averageLatencyMs: number | null;
  adjudicated: { cases: number; changedFromBlind: number };
  byStratum: StratumMetrics[];
}

/**
 * All metrics for one cohort and one AI version. Pure.
 *
 * The evaluation unit is the cohort case. The population is every case with a
 * blind label; the AI and the rules are scored on exactly that set, each case
 * once. A case without a usable AI answer is kept and counted as such.
 * Everything AI-derived on the page (outcomes, bands, confidence, cost) is
 * computed over the population only, so a case still awaiting its blind label
 * contributes nothing but the cohort's case count.
 */
export function computeMetrics(cases: readonly EvalCase[]): Metrics {
  const population = cases.filter((c) => c.gold);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const score = (set: readonly EvalCase[]) => ({
    aiVsHuman: classifierMetrics("ai_vs_human", set.map((c) => ({ gold: c.gold!, predicted: aiPrediction(c).prediction }))),
    rulesVsHuman: classifierMetrics("rules_vs_human", set.map((c) => ({ gold: c.gold!, predicted: rulePrediction(c) })), ruleClassMatches),
  });
  const outcomes = population.map((c) => ({ c, ...aiPrediction(c) }));
  const valid = outcomes.filter((o) => o.outcome === "valid").map((o) => o.c);
  const invalid = outcomes.filter((o) => o.outcome === "invalid").map((o) => o.c);
  const rules = population.map(rulePrediction);
  const confidences = valid.map((c) => c.ai!.confidence).filter((x): x is number => typeof x === "number");
  const calls = population.filter((c) => c.ai && ((c.ai.latencyMs ?? 0) > 0 || (c.ai.inputTokens ?? 0) > 0));
  const strata = [...new Set(cases.map((c) => c.stratum))].sort();
  return {
    cases: cases.length,
    population: population.length,
    aiOutcomes: {
      valid: valid.length,
      abstained: valid.filter((c) => c.ai!.decision === "insufficient_evidence").length,
      invalid: invalid.length,
      error: outcomes.filter((o) => o.outcome === "error").length,
      missing: outcomes.filter((o) => o.outcome === "missing").length,
    },
    ruleOutcomes: {
      verdict: rules.filter((r) => r !== NO_ANSWER && r !== "insufficient_evidence").length,
      abstained: rules.filter((r) => r === "insufficient_evidence").length,
      noVerdict: rules.filter((r) => r === NO_ANSWER).length,
    },
    humanLabels: { definite: population.filter((c) => c.gold !== "insufficient_evidence").length, cantTell: population.filter((c) => c.gold === "insufficient_evidence").length },
    invalid: rate(invalid.length, population.length),
    invalidEvidence: rate(invalid.filter((c) => strs(c.ai!.validationErrors).some((e) => INVALID_EVIDENCE.test(e))).length, population.length),
    ...score(population),
    aiVsRules: {
      agree: valid.filter((c) => c.ai!.agreement === "agree").length,
      disagree: valid.filter((c) => c.ai!.agreement === "disagree").length,
      notComparable: valid.filter((c) => c.ai!.agreement !== "agree" && c.ai!.agreement !== "disagree").length,
    },
    bands: CONFIDENCE_BANDS.map((b) => {
      const inBand = valid.filter((c) => typeof c.ai!.confidence === "number" && c.ai!.confidence >= b.min && c.ai!.confidence < b.max);
      return { label: b.label, decisions: inBand.length, accuracy: rate(inBand.filter((c) => c.gold === c.ai!.decision).length, inBand.length) };
    }),
    averageConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
    costPerDecisionMicroUsd: calls.length ? Math.round(calls.reduce((s, c) => s + (c.ai!.costMicroUsd ?? 0), 0) / calls.length) : null,
    averageLatencyMs: calls.length ? Math.round(calls.reduce((s, c) => s + (c.ai!.latencyMs ?? 0), 0) / calls.length) : null,
    adjudicated: { cases: cases.filter((c) => c.adjudicated).length, changedFromBlind: cases.filter((c) => c.adjudicated && c.gold && c.adjudicated !== c.gold).length },
    byStratum: strata.map((s) => {
      const all = cases.filter((c) => c.stratum === s);
      const pop = all.filter((c) => c.gold);
      const ai = pop.map(aiPrediction);
      return {
        stratum: s,
        cases: all.length,
        labeled: pop.length,
        ai: { valid: ai.filter((a) => a.outcome === "valid").length, abstained: ai.filter((a) => a.prediction === "insufficient_evidence").length, noAnswer: ai.filter((a) => a.prediction === NO_ANSWER).length },
        ...score(pop),
      };
    }),
  };
}

type EvalDb = {
  aiEvalCohort: Pick<Db["aiEvalCohort"], "findUnique">;
  aiEvalCase: Pick<Db["aiEvalCase"], "findMany">;
  aiDecision: Pick<Db["aiDecision"], "findMany">;
};

export interface Disagreement {
  caseId: string;
  candidateId: string;
  gold: HumanLabel;
  aiDecision: HumanLabel;
  abstained: boolean;
  confidence: number | null;
  evidence: { sourceUrl: string; quote: string }[];
  reasons: string[];
  concerns: string[];
  ruleDecision: string | null;
}

export interface CohortEvaluation {
  cohort: { id: string; name: string; kind: string; samplingVersion: string; seed: string; createdAt: Date };
  /** Every AI model and prompt version with decisions in this cohort. */
  versions: { model: string; promptVersion: string; decisions: number }[];
  /** The version evaluated, or null when the cohort has no AI decisions yet. */
  version: { model: string; promptVersion: string } | null;
  metrics: Metrics;
  /** Only labeled cases: AI output is never shown for a case awaiting its blind label. */
  disagreements: Disagreement[];
}

/** Evaluates one cohort against one AI version (by default the one with the most decisions). Reads only. */
export async function evaluateCohort(db: EvalDb, cohortId: string, want?: { model?: string; promptVersion?: string }): Promise<CohortEvaluation | null> {
  const cohort = await db.aiEvalCohort.findUnique({ where: { id: cohortId }, select: { id: true, name: true, kind: true, samplingVersion: true, seed: true, createdAt: true } });
  if (!cohort) return null;
  const cases = await db.aiEvalCase.findMany({ where: { cohortId }, orderBy: { position: "asc" }, select: { id: true, candidateId: true, stratum: true, labels: { orderBy: { revision: "asc" }, select: { revision: true, source: true, label: true } } } });
  const decisions = cases.length
    ? await db.aiDecision.findMany({ where: { kind: COLLISION_FIT_KIND, subjectType: "candidate", subjectId: { in: cases.map((c) => c.candidateId) } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })
    : [];
  const versionCounts = new Map<string, { model: string; promptVersion: string; decisions: number }>();
  for (const d of decisions) {
    const k = `${d.model}\n${d.promptVersion}`;
    versionCounts.set(k, { model: d.model, promptVersion: d.promptVersion, decisions: (versionCounts.get(k)?.decisions ?? 0) + 1 });
  }
  const versions = [...versionCounts.values()].sort((a, b) => b.decisions - a.decisions || a.model.localeCompare(b.model) || a.promptVersion.localeCompare(b.promptVersion));
  const version = versions.find((v) => (!want?.model || v.model === want.model) && (!want?.promptVersion || v.promptVersion === want.promptVersion)) ?? null;
  // The newest decision of the chosen version per candidate.
  const latest = new Map<string, (typeof decisions)[number]>();
  if (version) for (const d of decisions) if (d.model === version.model && d.promptVersion === version.promptVersion && !latest.has(d.subjectId)) latest.set(d.subjectId, d);

  const evalCases: EvalCase[] = cases.map((c) => {
    const blind = c.labels.find((l) => l.revision === 1 && l.source === "blind");
    const adj = [...c.labels].reverse().find((l) => l.source === "adjudicated");
    const d = latest.get(c.candidateId);
    return {
      caseId: c.id,
      candidateId: c.candidateId,
      stratum: c.stratum,
      gold: blind && isHumanLabel(blind.label) ? blind.label : null,
      adjudicated: adj && isHumanLabel(adj.label) ? adj.label : null,
      ai: d ? { status: d.status, decision: d.decision, confidence: d.confidence, ruleDecision: d.ruleDecision, agreement: d.agreement, validationErrors: d.validationErrors, costMicroUsd: d.costMicroUsd, latencyMs: d.latencyMs, inputTokens: d.inputTokens } : null,
    };
  });
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const disagreements: Disagreement[] = [];
  for (const c of evalCases) {
    const d = latest.get(c.candidateId);
    if (!c.gold || !d || d.status !== "valid" || !isHumanLabel(d.decision) || d.decision === c.gold) continue;
    disagreements.push({
      caseId: c.caseId,
      candidateId: c.candidateId,
      gold: c.gold,
      aiDecision: d.decision,
      abstained: d.decision === "insufficient_evidence",
      confidence: d.confidence,
      evidence: (Array.isArray(d.evidence) ? (d.evidence as { sourceUrl?: unknown; quote?: unknown }[]) : []).filter((e) => typeof e?.sourceUrl === "string" && typeof e?.quote === "string").map((e) => ({ sourceUrl: e.sourceUrl as string, quote: e.quote as string })),
      reasons: strs(d.reasons),
      concerns: strs(d.concerns),
      ruleDecision: d.ruleDecision,
    });
  }
  return { cohort, versions, version: version ? { model: version.model, promptVersion: version.promptVersion } : null, metrics: computeMetrics(evalCases), disagreements };
}
