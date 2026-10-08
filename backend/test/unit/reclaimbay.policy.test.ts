import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  SIGNALS, SIGNAL_KEYS, BAND_THRESHOLDS, BAND_LABELS, QUALIFICATION_LABELS,
  POLICY_ID, SCORING_VERSION, bandFor, scoreProspect, resolveSignals, signalConsistencyErrors, type ScoringInput,
} from "../../src/scoring.js";
import { bandFor as engineBandFor, evaluatePolicy, validatePolicyInput, validateQualificationEvidence } from "../../src/qualification/policy.js";
import { reclaimBayQualificationPolicy } from "../../src/policies/reclaimbay/qualification.js";
import { reclaimBayScoringPolicy } from "../../src/policies/reclaimbay/scoring.js";
import { fitBasis, fitConflict, fitEvidenceErrors } from "../../src/research/repairFit.js";

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

  test("existing scoring callers get exactly what the generic engine computes with the ReclaimBay policy", () => {
    const inputs: ScoringInput[] = [
      { signals: {} },
      { signals: { automotive_repair_services: "yes" } },
      { signals: { collision_repair_services: "yes", automotive_repair_services: "no" }, website: "https://x.example" },
      { signals: { automotive_repair_services: "no", independent_shop: "yes", has_website: "no" }, website: "https://x.example" },
      { signals: { public_business_contact: "no", digital_inspections: "yes" }, phone: "555", phoneSourceUrl: "https://x.example/c" },
      { signals: { made_up: "yes" as never } },
    ];
    for (const input of inputs) {
      assert.deepEqual(scoreProspect(input), evaluatePolicy(reclaimBayScoringPolicy, input));
      assert.deepEqual(signalConsistencyErrors(input), validatePolicyInput(reclaimBayScoringPolicy, input).errors);
    }
    for (const score of [0, 34, 35, 59, 60, 100]) assert.equal(bandFor(score), engineBandFor(score, BAND_THRESHOLDS));
  });

  test("the evidence gate equals the pre-extraction prospect composition, input for input", () => {
    // ccf651e prospects.ts: basis = fitBasis(signals); errors = fitEvidenceErrors(...); conflict = fitConflict(warnings, basis).
    const before = (input: Parameters<typeof reclaimBayQualificationPolicy.evidenceErrors>[0]) => {
      const basis = fitBasis(input.signals);
      const errors = fitEvidenceErrors(input, basis, input.evidence);
      const conflict = fitConflict(input.researchWarnings, basis);
      if (conflict) errors.push(`Resolve contradictory ${conflict} research before qualification or Ready to contact.`);
      return errors;
    };
    const site = "https://harbor.example";
    const evidences = [
      [],
      [{ signalKey: "automotive_repair_services", sourceUrl: `${site}/services`, excerpt: "We offer automotive brake repair." }],
      [{ signalKey: "automotive_repair_services", sourceUrl: "https://elsewhere.example/x", excerpt: "We offer automotive brake repair." }],
      [{ signalKey: "collision_repair_services", sourceUrl: `${site}/services`, excerpt: "We offer collision repair." }],
      [{ signalKey: "automotive_repair_services", sourceUrl: `${site}/services`, excerpt: "We do not perform repairs." }],
    ];
    const signalSets: ScoringInput["signals"][] = [{}, { automotive_repair_services: "yes" }, { collision_repair_services: "yes" }, { automotive_repair_services: "yes", collision_repair_services: "yes" }];
    const warnings = [undefined, [], ["Collision/body evidence is contradictory; verify product fit manually."], ["Automotive repair evidence is contradictory; verify product fit manually."], "not a list"];
    let compared = 0;
    for (const businessName of ["Harbor", null]) for (const website of [site, null]) for (const evidence of evidences) for (const signals of signalSets) for (const researchWarnings of warnings) {
      const input = { businessName, website, signals, evidence, researchWarnings };
      assert.deepEqual(validateQualificationEvidence(reclaimBayQualificationPolicy, input).errors, before(input));
      compared++;
    }
    assert.equal(compared, 400);
  });

  test("ReclaimBay depends on the generic engine, never the reverse", () => {
    const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(read("qualification/policy.ts"), /policies\/|reclaimbay|scoring\.js/i);
    assert.match(read("policies/reclaimbay/scoring.ts"), /from "\.\.\/\.\.\/qualification\/policy\.js"/);
    assert.match(read("policies/reclaimbay/qualification.ts"), /from "\.\.\/\.\.\/qualification\/policy\.js"/);
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
