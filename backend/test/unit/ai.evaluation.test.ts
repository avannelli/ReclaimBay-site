import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CONFIDENCE_BANDS, MIN_SAMPLE, NO_ANSWER, PREDICTIONS, RULE_AS_LABEL, aiPrediction, classifierMetrics, computeMetrics, rate, rulePrediction, type EvalCase, type Prediction } from "../../src/ai/evaluation.js";
import { DEFAULT_QUOTAS, HUMAN_LABELS, isHumanLabel, stratumOf, type HumanLabel } from "../../src/ai/goldSet.js";

let n = 0;
const kase = (gold: HumanLabel | null, ai: Partial<NonNullable<EvalCase["ai"]>> | null, adjudicated: HumanLabel | null = null, stratum = "verify"): EvalCase => ({
  caseId: `c${++n}`,
  candidateId: `k${n}`,
  stratum,
  gold,
  adjudicated,
  ai: ai ? { status: "valid", decision: null, confidence: 0.9, ruleDecision: null, agreement: null, validationErrors: null, costMicroUsd: 1000, latencyMs: 500, inputTokens: 10, ...ai } : null,
});
const many = <T>(k: number, make: () => T) => Array.from({ length: k }, make);
const pairs = (k: number, gold: HumanLabel, predicted: Prediction) => many(k, () => ({ gold, predicted }));

describe("evaluation metrics (pure)", () => {
  test("a rate needs enough observations; below that it is unavailable, never 0%", () => {
    assert.deepEqual(rate(0, 5), { num: 0, den: 5, rate: null });
    assert.deepEqual(rate(0, 0), { num: 0, den: 0, rate: null });
    assert.equal(rate(10, MIN_SAMPLE).rate, 10 / MIN_SAMPLE);
    assert.equal(MIN_SAMPLE, 20);
  });

  test("confusion matrix, agreement, precision, recall, false positives and negatives", () => {
    const m = classifierMetrics("ai_vs_human", [
      ...pairs(18, "collision_primary", "collision_primary"),
      ...pairs(2, "collision_primary", "insufficient_evidence"),
      ...pairs(3, "not_collision", "collision_primary"),
      ...pairs(5, "not_collision", "not_collision"),
      ...pairs(2, "insufficient_evidence", "collision_primary"),
    ]);
    assert.equal(m.scorer, "ai_vs_human");
    assert.equal(m.population, 30);
    assert.equal(m.confusion.collision_primary.collision_primary, 18);
    assert.equal(m.confusion.not_collision.collision_primary, 3);
    assert.equal(m.confusion.insufficient_evidence.collision_primary, 2);
    assert.deepEqual(m.agreement, { num: 23, den: 30, rate: 23 / 30 });
    // Precision and recall use decisive gold labels: "can't tell" is neither a hit nor a false positive.
    assert.deepEqual([m.primary.truePositive, m.primary.falsePositive, m.primary.falseNegative, m.primary.missedWithoutAnswer], [18, 3, 2, 0]);
    assert.deepEqual(m.primary.precision, { num: 18, den: 21, rate: 18 / 21 });
    assert.deepEqual(m.primary.recall, { num: 18, den: 20, rate: 18 / 20 });
    assert.deepEqual(m.abstention, { num: 2, den: 30, rate: 2 / 30 });
    assert.deepEqual(m.noAnswer, { num: 0, den: 30, rate: 0 });
  });

  test("no usable answer stays in every population denominator, is never a positive call, and counts as a miss for recall", () => {
    const m = classifierMetrics("ai_vs_human", [...pairs(10, "collision_primary", "collision_primary"), ...pairs(10, "collision_primary", NO_ANSWER), ...pairs(4, "not_collision", NO_ANSWER)]);
    assert.equal(m.population, 24);
    assert.equal(m.confusion.collision_primary.no_answer, 10);
    assert.deepEqual(m.agreement, { num: 10, den: 24, rate: 10 / 24 }, "no answer is never agreement");
    assert.deepEqual(m.primary.precision, { num: 10, den: 10, rate: null }, "precision is over positive calls only: 10, too few");
    assert.deepEqual(m.primary.recall, { num: 10, den: 20, rate: 0.5 }, "every gold positive counts, answered or not");
    assert.deepEqual([m.primary.falseNegative, m.primary.missedWithoutAnswer, m.primary.falsePositive], [10, 10, 0]);
    assert.deepEqual(m.noAnswer, { num: 14, den: 24, rate: 14 / 24 });
    assert.deepEqual(m.abstention, { num: 0, den: 24, rate: 0 }, "no answer isn't a deliberate abstention");
  });

  test("a human \"can't tell\" stays in agreement (matched only by an abstention) and stays out of precision and recall", () => {
    const m = classifierMetrics("ai_vs_human", [...pairs(10, "insufficient_evidence", "insufficient_evidence"), ...pairs(5, "insufficient_evidence", "collision_primary"), ...pairs(5, "insufficient_evidence", NO_ANSWER)]);
    assert.deepEqual(m.agreement, { num: 10, den: 20, rate: 0.5 });
    assert.deepEqual([m.primary.truePositive, m.primary.falsePositive, m.primary.falseNegative], [0, 0, 0]);
    assert.equal(m.primary.precision.den, 0);
  });

  test("any-fit precision treats specialty and dealership as fit", () => {
    const m = classifierMetrics("ai_vs_human", [...pairs(10, "specialty_body", "dealership_body_dept"), ...pairs(10, "dealership_body_dept", "dealership_body_dept")]);
    assert.equal(m.fit.precision.rate, 1);
    assert.equal(m.agreement.rate, 0.5, "exact agreement still distinguishes them");
  });

  test("small samples report counts but no rates", () => {
    const m = classifierMetrics("ai_vs_human", pairs(5, "collision_primary", "collision_primary"));
    assert.equal(m.agreement.rate, null);
    assert.equal(m.primary.precision.rate, null);
    assert.equal(m.primary.truePositive, 5);
  });

  test("the gold label is the blind label: an adjudication never changes the metrics", () => {
    const m = computeMetrics(many(20, () => kase("collision_primary", { decision: "not_collision" }, "not_collision")));
    assert.equal(m.aiVsHuman.agreement.rate, 0);
    assert.deepEqual(m.adjudicated, { cases: 20, changedFromBlind: 20 });
  });

  test("AI and rules are scored on the identical population: missing, invalid, and failed AI answers are kept", () => {
    const cases = [
      ...many(10, () => kase("collision_primary", { decision: "collision_primary", ruleDecision: "primary" })),
      ...many(4, () => kase("collision_primary", { status: "invalid", decision: "collision_primary", ruleDecision: "primary", validationErrors: ["evidence 1: the quote is not word for word in the supplied excerpts for its source URL."] })),
      ...many(2, () => kase("collision_primary", { status: "invalid", decision: null, ruleDecision: "unknown", validationErrors: ["The answer is not valid JSON."] })),
      ...many(3, () => kase("collision_primary", { status: "error", decision: null, ruleDecision: "primary" })),
      ...many(1, () => kase("collision_primary", null)),
      ...many(5, () => kase(null, { decision: "collision_primary", ruleDecision: "primary" })),
    ];
    const m = computeMetrics(cases);
    assert.deepEqual([m.cases, m.population], [25, 20]);
    assert.equal(m.aiVsHuman.population, 20);
    assert.equal(m.rulesVsHuman.population, 20, "the same 20 cases for both");
    assert.deepEqual(m.aiOutcomes, { valid: 10, abstained: 0, invalid: 6, error: 3, missing: 1 });
    assert.equal(m.aiVsHuman.confusion.collision_primary.no_answer, 10, "missing, invalid, and error answers are all kept");
    assert.deepEqual(m.aiVsHuman.primary.recall, { num: 10, den: 20, rate: 0.5 }, "not 10 of 10: the failed cases count");
    assert.deepEqual(m.rulesVsHuman.primary.recall, { num: 17, den: 20, rate: 17 / 20 }, "rules: primary on 17, unknown on 2, no verdict on the missing one");
    assert.deepEqual(m.ruleOutcomes, { verdict: 17, abstained: 2, noVerdict: 1 });
    assert.deepEqual(m.invalid, { num: 6, den: 20, rate: 0.3 });
    assert.deepEqual(m.invalidEvidence, { num: 4, den: 20, rate: 0.2 });
    assert.deepEqual(m.humanLabels, { definite: 20, cantTell: 0 });
  });

  test("abstention and no usable answer are distinct", () => {
    const m = computeMetrics([...many(15, () => kase("collision_primary", { decision: "collision_primary" })), ...many(5, () => kase("collision_primary", { decision: "insufficient_evidence" }))]);
    assert.deepEqual(m.aiVsHuman.abstention, { num: 5, den: 20, rate: 0.25 });
    assert.deepEqual(m.aiVsHuman.noAnswer, { num: 0, den: 20, rate: 0 });
    assert.equal(m.aiOutcomes.abstained, 5);
    assert.equal(m.aiVsHuman.primary.falseNegative, 5, "an abstention on a collision shop is a miss for recall");
    assert.equal(m.aiVsHuman.primary.missedWithoutAnswer, 0);
  });

  test("everything AI-derived is computed over labeled cases only: an unlabeled case contributes only its count", () => {
    const cases = [
      ...many(20, () => kase("collision_primary", { decision: "collision_primary", confidence: 0.97 })),
      ...many(5, () => kase("not_collision", { decision: "collision_primary", confidence: 0.96 })),
      ...many(4, () => kase("collision_primary", { decision: "collision_primary", confidence: 0.72 })),
      ...many(3, () => kase(null, { decision: "collision_primary", confidence: 0.55, costMicroUsd: 99999, ruleDecision: "primary", agreement: "agree" })),
    ];
    const m = computeMetrics(cases);
    const band = (label: string) => m.bands.find((b) => b.label === label)!;
    assert.deepEqual(band("0.95–1.00"), { label: "0.95–1.00", decisions: 25, accuracy: { num: 20, den: 25, rate: 0.8 } });
    assert.deepEqual(band("0.70–0.79").accuracy, { num: 4, den: 4, rate: null }, "4 labeled: unavailable");
    assert.equal(band("0.50–0.59").decisions, 0, "the unlabeled decisions don't appear");
    assert.equal(m.bands.length, CONFIDENCE_BANDS.length);
    assert.equal(m.bands.reduce((s, b) => s + b.decisions, 0), 29);
    assert.equal(m.costPerDecisionMicroUsd, 1000);
    assert.equal(m.aiVsRules.agree, 0);
  });

  test("rules vs human and AI vs human are separate metrics, and AI vs rules is neither", () => {
    const cases = [
      ...many(20, () => kase("collision_primary", { decision: "collision_primary", ruleDecision: "unknown", agreement: "disagree" })),
      ...many(5, () => kase("dealership_body_dept", { decision: "dealership_body_dept", ruleDecision: "possible", agreement: "agree" })),
    ];
    const m = computeMetrics(cases);
    assert.equal(m.aiVsHuman.scorer, "ai_vs_human");
    assert.equal(m.rulesVsHuman.scorer, "rules_vs_human");
    assert.equal(m.aiVsHuman.agreement.rate, 1);
    assert.equal(m.rulesVsHuman.agreement.rate, 5 / 25, "the rules abstained on 20; a possible counts as matching a dealership");
    assert.deepEqual(m.aiVsRules, { agree: 5, disagree: 20, notComparable: 0 });
    assert.equal(RULE_AS_LABEL.conflict, "insufficient_evidence");
  });

  test("per stratum: counts, the same denominators, and unavailable below 20", () => {
    const cases = [
      ...many(20, () => kase("collision_primary", { decision: "collision_primary", ruleDecision: "unknown" }, null, "verify")),
      ...many(2, () => kase("collision_primary", { status: "error", ruleDecision: "primary" }, null, "verify")),
      ...many(1, () => kase(null, null, null, "verify")),
      ...many(6, () => kase("not_collision", { decision: "insufficient_evidence", ruleDecision: "negative" }, null, "auto_rejected")),
      ...many(3, () => kase("not_collision", null, null, "auto_rejected")),
    ];
    const m = computeMetrics(cases);
    assert.deepEqual(m.byStratum.map((s) => s.stratum), ["auto_rejected", "verify"]);
    const v = m.byStratum.find((s) => s.stratum === "verify")!;
    assert.deepEqual([v.cases, v.labeled, v.ai.valid, v.ai.abstained, v.ai.noAnswer], [23, 22, 20, 0, 2]);
    assert.equal(v.aiVsHuman.population, v.rulesVsHuman.population);
    assert.deepEqual(v.aiVsHuman.primary.recall, { num: 20, den: 22, rate: 20 / 22 });
    assert.deepEqual(v.rulesVsHuman.primary.recall, { num: 2, den: 22, rate: 2 / 22 });
    assert.deepEqual(v.aiVsHuman.primary.precision, { num: 20, den: 20, rate: 1 });
    assert.equal(v.rulesVsHuman.primary.precision.rate, null, "2 positive calls: unavailable");
    const r = m.byStratum.find((s) => s.stratum === "auto_rejected")!;
    assert.deepEqual([r.cases, r.labeled, r.ai.valid, r.ai.abstained, r.ai.noAnswer], [9, 9, 6, 6, 3]);
    assert.deepEqual(r.aiVsHuman.agreement, { num: 0, den: 9, rate: null });
    assert.deepEqual(r.rulesVsHuman.agreement, { num: 6, den: 9, rate: null }, "9 cases: unavailable");
    assert.equal(m.byStratum.reduce((s, x) => s + x.labeled, 0), m.population);
  });

  test("cost and latency are per provider call; reused decisions don't dilute them", () => {
    const m = computeMetrics([kase("collision_primary", { decision: "collision_primary", costMicroUsd: 3000, latencyMs: 2000 }), kase("collision_primary", { decision: "collision_primary", costMicroUsd: 0, latencyMs: 0, inputTokens: 0 })]);
    assert.equal(m.costPerDecisionMicroUsd, 3000);
    assert.equal(m.averageLatencyMs, 2000);
    assert.equal(computeMetrics([kase("collision_primary", null)]).costPerDecisionMicroUsd, null);
  });

  test("the AI and rules contributions per case", () => {
    assert.deepEqual(aiPrediction(kase("collision_primary", null)), { prediction: NO_ANSWER, outcome: "missing" });
    assert.deepEqual(aiPrediction(kase("collision_primary", { status: "invalid", decision: "collision_primary" })), { prediction: NO_ANSWER, outcome: "invalid" }, "an invalid answer's decision is never used");
    assert.deepEqual(aiPrediction(kase("collision_primary", { status: "error" })), { prediction: NO_ANSWER, outcome: "error" });
    assert.deepEqual(aiPrediction(kase("collision_primary", { decision: "insufficient_evidence" })), { prediction: "insufficient_evidence", outcome: "valid" });
    assert.equal(rulePrediction(kase("collision_primary", null)), NO_ANSWER);
    assert.equal(rulePrediction(kase("collision_primary", { status: "error", ruleDecision: "possible" })), "specialty_body");
    assert.deepEqual(PREDICTIONS.at(-1), NO_ANSWER);
  });
});

describe("gold-set sampling rules (pure)", () => {
  const f = (over: Partial<Parameters<typeof stratumOf>[0]> = {}) => stratumOf({ status: "researched", decisionReason: null, manualCollision: false, anyCollisionSignal: false, warnings: [], ...over });
  test("strata, in precedence order, from the record and research only", () => {
    assert.equal(f(), "verify");
    assert.equal(f({ status: "needs_review" }), "verify");
    assert.equal(f({ anyCollisionSignal: true }), null, "research already decided: not left for a person");
    assert.equal(f({ warnings: ["Dealership or specialty collision/body services require human verification before qualification."] }), "specialty_or_uncertain");
    assert.equal(f({ status: "approved", decisionReason: "Automatically approved (approval@a2): ..." }), "auto_approved");
    assert.equal(f({ status: "approved", decisionReason: "Approved by a person." }), null);
    assert.equal(f({ status: "rejected", decisionReason: "Automatically rejected (rejection@r2): ..." }), "auto_rejected");
    assert.equal(f({ status: "approved", manualCollision: true, decisionReason: "Automatically approved" }), "person_decided", "a person's decision takes precedence");
    assert.equal(f({ status: "duplicate", warnings: ["Collision/body evidence is contradictory; inspect the source pages."] }), null);
  });

  test("the default gold set is about 150 cases, mostly where the rules defer to a person", () => {
    assert.equal(Object.values(DEFAULT_QUOTAS).reduce((a, b) => a + b, 0), 150);
    assert.ok(DEFAULT_QUOTAS.verify + DEFAULT_QUOTAS.specialty_or_uncertain > 75);
    assert.ok(DEFAULT_QUOTAS.person_decided < 20, "not mostly cases whose answer is already known");
  });

  test("the human taxonomy matches the AI's decisions", () => {
    const src = readFileSync(new URL("../../src/ai/collisionFitJudge.ts", import.meta.url), "utf8");
    for (const l of Object.keys(HUMAN_LABELS)) assert.ok(src.includes(`"${l}"`), l);
    assert.equal(isHumanLabel("collision_primary"), true);
    assert.equal(isHumanLabel("approve"), false);
  });

  test("nothing in the evaluation layer reaches for a database or production credentials itself", () => {
    for (const f of ["goldSet.ts", "evaluation.ts", "records.ts"]) {
      const src = readFileSync(new URL(`../../src/ai/${f}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /process\.env|createDb|DATABASE_URL/, f);
    }
  });
});
