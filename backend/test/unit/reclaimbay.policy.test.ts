import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  SIGNALS, SIGNAL_KEYS, BAND_THRESHOLDS, BAND_LABELS, QUALIFICATION_LABELS,
  POLICY_ID, SCORING_VERSION, scoreProspect, resolveSignals, signalConsistencyErrors, type ScoringInput,
} from "../../src/scoring.js";
import { validateQualificationEvidence } from "../../src/qualification/policy.js";
import { reclaimBayQualificationPolicy } from "../../src/policies/reclaimbay/qualification.js";

describe("ReclaimBay policy compatibility", () => {
  test("all 177,147 observation combinations match the pre-extraction v3 baseline", () => {
    // Captured from unmodified scoring.ts at ccf651e before the extraction.
    // Every ternary signal combination is covered, cycling five field contexts.
    // The digest covers definitions, labels, thresholds, full explanations,
    // qualification, scores, effective states and consistency errors. It excludes
    // only the newly added policyId; a future intentional policy change must
    // explicitly update the baseline/version, never regenerate it silently.
    const contexts: Omit<ScoringInput, "signals">[] = [
      {},
      { website: "https://fixture.example" },
      { website: "  ", phone: "555", phoneSourceUrl: "https://fixture.example/contact" },
      { website: "https://fixture.example", email: "team@fixture.example", emailSourceUrl: "https://fixture.example/contact" },
      { phone: "555", email: "team@fixture.example" },
    ];
    const digest = createHash("sha256");
    digest.update(JSON.stringify({ SIGNALS, BAND_THRESHOLDS, BAND_LABELS, QUALIFICATION_LABELS }));
    const count = 3 ** SIGNAL_KEYS.length;
    assert.equal(count, 177147);
    for (let i = 0; i < count; i++) {
      let n = i;
      const signals: ScoringInput["signals"] = {};
      for (const key of SIGNAL_KEYS) {
        const state = n % 3;
        n = Math.floor(n / 3);
        if (state) signals[key] = state === 1 ? "yes" : "no";
      }
      const input: ScoringInput = { ...contexts[i % contexts.length], signals };
      const { policyId, ...legacyResult } = scoreProspect(input);
      assert.equal(policyId, POLICY_ID);
      digest.update(JSON.stringify([legacyResult, resolveSignals(input), signalConsistencyErrors(input)]));
    }
    assert.equal(digest.digest("hex"), "c13bb79707ea3b0c6fb0a2f98d81c33eac62340c8b4befe2466f3053d09483d2");
  });

  test("score and evidence policy share identity while stored scoring version stays v3", () => {
    assert.equal(POLICY_ID, "reclaimbay.qualification");
    assert.equal(SCORING_VERSION, "v3");
    const result = scoreProspect({ signals: {} });
    assert.equal(result.policyId, reclaimBayQualificationPolicy.policyId);
    assert.equal(result.version, reclaimBayQualificationPolicy.version);
  });

  const subject = { businessName: "Harbor", website: "https://harbor.example" };
  const evidenceFor = (signalKey: string, excerpt: string) => ({ signalKey, sourceUrl: `${subject.website}/services`, excerpt });
  const assess = (signals: ScoringInput["signals"], evidence: ReturnType<typeof evidenceFor>[], researchWarnings?: unknown) =>
    validateQualificationEvidence(reclaimBayQualificationPolicy, { ...subject, signals, evidence, researchWarnings });

  test("a qualifying score cannot replace sourced fit evidence", () => {
    const signals = { automotive_repair_services: "yes" as const };
    assert.equal(scoreProspect({ signals }).qualification, "meets_criteria");
    const result = assess(signals, []);
    assert.equal(result.policyId, POLICY_ID);
    assert.equal(result.version, SCORING_VERSION);
    assert.deepEqual(result.errors, ["Qualification requires sourced automotive repair evidence attributed to this business, with a public source URL and supporting excerpt."]);
    assert.deepEqual(assess(signals, [evidenceFor("automotive_repair_services", "We offer automotive brake repair.")]).errors, []);
    assert.ok(assess(signals, [evidenceFor("automotive_repair_services", "We sell automotive brake repair tools.")]).errors.length);
  });

  test("preserves collision evidence compatibility and research conflict authority", () => {
    const signals = { collision_repair_services: "yes" as const };
    const evidence = [evidenceFor("collision_repair_services", "We offer collision repair.")];
    assert.deepEqual(assess(signals, evidence).errors, []);
    assert.deepEqual(assess(signals, evidence, ["Collision/body evidence is contradictory"]).errors,
      ["Resolve contradictory collision/body research before qualification or Ready to contact."]);
    const repair = [evidenceFor("automotive_repair_services", "We offer automotive brake repair.")];
    assert.deepEqual(assess({ automotive_repair_services: "yes" }, repair, ["Collision/body evidence is contradictory"]).errors, []);
    assert.deepEqual(assess({ automotive_repair_services: "yes" }, repair, ["Automotive repair evidence is contradictory"]).errors,
      ["Resolve contradictory automotive repair research before qualification or Ready to contact."]);
  });
});
