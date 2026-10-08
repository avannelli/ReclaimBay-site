import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  evaluatePolicy, validatePolicyInput, validateQualificationEvidence,
  type QualificationPolicy, type StoredSignalValue,
} from "../../src/qualification/policy.js";

// A deliberately small, unrelated policy. No website, contact, prospect, or repair fields.
interface LibraryInput { publicAccess?: StoredSignalValue; seats: number }
const libraryPolicy: QualificationPolicy<LibraryInput, "public_access" | "capacity", { charter: string }> = {
  policyId: "synthetic.library",
  version: "test-v1",
  signals: [
    { key: "public_access", label: "Open to the public", weight: 0, kind: "observation", requiredCriterion: true },
    { key: "capacity", label: "Reading seats", weight: 80, kind: "derived" },
  ],
  bandThresholds: { high: 80, medium: 40 },
  bandLabels: { high: "Large", medium: "Medium", low: "Small" },
  qualificationLabels: { meets_criteria: "Eligible library", unverified: "Check access", disqualified: "Private library" },
  resolveSignals: (input) => ({ public_access: input.publicAccess ?? "unknown", capacity: input.seats >= 20 ? "yes" : "no" }),
  explainSignal: (key, state) => `${key}: ${state}`,
  consistencyErrors: (input) => input.seats < 0 ? ["Seat count cannot be negative."] : [],
  evidenceErrors: (input) => input.charter.includes("public access") ? [] : ["A public-access charter is required."],
};

describe("generic policy execution with an unrelated library policy", () => {
  test("qualifies independently of priority, with the supplied identity, labels and explanations", () => {
    const result = evaluatePolicy(libraryPolicy, { publicAccess: "yes", seats: 2 });
    assert.equal(result.policyId, "synthetic.library");
    assert.equal(result.version, "test-v1");
    assert.equal(result.qualification, "meets_criteria");
    assert.equal(result.score, 0);
    assert.equal(result.maxScore, 80, "no fixed 100-point assumption");
    assert.equal(result.band, "low");
    assert.equal(result.breakdown[0]?.label, "Open to the public");
    assert.equal(result.breakdown[0]?.reason, "public_access: yes");
  });

  test("high priority cannot override a failed or unknown criterion", () => {
    const failed = evaluatePolicy(libraryPolicy, { publicAccess: "no", seats: 25 });
    assert.equal(failed.band, "high");
    assert.equal(failed.score, 80);
    assert.equal(failed.qualification, "disqualified");
    assert.deepEqual(failed.disqualifiedBy, ["public_access"]);
    const unknown = evaluatePolicy(libraryPolicy, { seats: 25 });
    assert.equal(unknown.qualification, "unverified");
    assert.deepEqual(unknown.unverifiedCriteria, ["public_access"]);
    assert.equal(unknown.known, 1);
  });

  test("uses each supplied policy version and thresholds without global state", () => {
    const revised = { ...libraryPolicy, version: "test-v2", bandThresholds: { high: 90, medium: 70 } };
    const input = { seats: 25 };
    assert.equal(evaluatePolicy(revised, input).band, "medium");
    assert.equal(evaluatePolicy(revised, input).version, "test-v2");
    assert.equal(evaluatePolicy(libraryPolicy, input).band, "high");
    assert.equal(evaluatePolicy(libraryPolicy, input).version, "test-v1");
  });

  test("validation and evidence results also carry identity; scoring is not evidence approval", () => {
    assert.deepEqual(validatePolicyInput(libraryPolicy, { seats: -1 }), {
      policyId: "synthetic.library", version: "test-v1", errors: ["Seat count cannot be negative."],
    });
    assert.deepEqual(validateQualificationEvidence(libraryPolicy, { charter: "" }), {
      policyId: "synthetic.library", version: "test-v1", errors: ["A public-access charter is required."],
    });
    assert.deepEqual(validateQualificationEvidence(libraryPolicy, { charter: "Charter: public access" }).errors, []);
  });

  test("is deterministic and does not mutate business input", () => {
    const input = Object.freeze({ publicAccess: "yes" as const, seats: 25 });
    assert.deepEqual(evaluatePolicy(libraryPolicy, input), evaluatePolicy(libraryPolicy, input));
    assert.deepEqual(input, { publicAccess: "yes", seats: 25 });
  });

  test("core has no business imports, identifiers, database, or process access", () => {
    const source = readFileSync(new URL("../../src/qualification/policy.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bimport\b|\brequire\s*\(|\bprocess\.|\bfetch\s*\(|prisma/i);
    assert.doesNotMatch(source, /reclaimbay|automotive|collision|revenue recovery|has_website|public_business_contact/i);
  });
});
