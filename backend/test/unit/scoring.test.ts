import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BAND_THRESHOLDS,
  MAX_SCORE,
  SIGNALS,
  SIGNAL_KEYS,
  SCORING_VERSION,
  REQUIRED_CRITERIA,
  bandFor,
  qualificationFor,
  resolveSignals,
  scoreProspect,
  signalConsistencyErrors,
  type ScoringInput,
  type SignalDefinition,
} from "../../src/scoring.js";

const WEBSITE = "https://smithauto.example";
const allObservationsYes = Object.fromEntries(
  SIGNALS.filter((s) => s.kind === "observation").map((s) => [s.key, "yes" as const]),
);
const full: ScoringInput = {
  signals: allObservationsYes,
  website: WEBSITE,
  phone: "555-0100",
  phoneSourceUrl: `${WEBSITE}/contact`,
};

describe("signal definitions", () => {
  test("keys are unique", () => {
    assert.equal(new Set(SIGNAL_KEYS).size, SIGNAL_KEYS.length);
  });

  test("weights are positive integers summing to 100", () => {
    for (const s of SIGNALS) assert.ok(Number.isInteger(s.weight) && s.weight > 0, s.key);
    assert.equal(MAX_SCORE, 100);
  });

  test("every signal documents label, question, yes/no/unknown rules and rationale", () => {
    for (const s of SIGNALS) {
      for (const field of ["label", "question", "yes", "no", "unknown", "rationale"] as const) {
        assert.ok(s[field].trim().length > 0, `${s.key}.${field}`);
      }
    }
  });

  test("required criteria are plain observations (the list's SQL qualification filter relies on this)", () => {
    const required: SignalDefinition[] = SIGNALS.filter((s: SignalDefinition) => s.requiredCriterion);
    assert.deepEqual(required.map((s) => s.key), [...REQUIRED_CRITERIA]);
    assert.deepEqual([...REQUIRED_CRITERIA], ["independent_shop", "general_repair_services"]);
    for (const s of required) assert.ok(s.kind === "observation" && !s.requiresWebsite, s.key);
  });

  test("no geographic signal in v1", () => {
    for (const s of SIGNALS) assert.doesNotMatch(`${s.key} ${s.label}`, /region|state|metro|city|location/i);
  });
});

describe("scoreProspect", () => {
  test("empty prospect: everything unknown, score 0, low band, unverified", () => {
    const r = scoreProspect({ signals: {} });
    assert.equal(r.score, 0);
    assert.equal(r.band, "low");
    assert.equal(r.qualification, "unverified");
    assert.deepEqual(r.unverifiedCriteria, ["independent_shop", "general_repair_services"]);
    assert.equal(r.known, 0);
    assert.equal(r.total, SIGNALS.length);
    assert.ok(r.breakdown.every((s) => s.state === "unknown" && s.points === 0));
    assert.equal(r.version, SCORING_VERSION);
  });

  test("every signal yes scores the maximum", () => {
    const r = scoreProspect(full);
    assert.equal(r.score, 100);
    assert.equal(r.band, "high");
    assert.equal(r.qualification, "meets_criteria");
    assert.equal(r.known, SIGNALS.length);
  });

  test("score is the sum of weights of yes signals only", () => {
    const r = scoreProspect({
      signals: { independent_shop: "yes", general_repair_services: "no", multiple_bays_or_staff: "yes" },
    });
    assert.equal(r.score, 25 + 15);
    assert.equal(r.breakdown.find((s) => s.key === "general_repair_services")?.points, 0);
  });

  test("qualification and score are independent: disqualified with a high score", () => {
    const r = scoreProspect({ ...full, signals: { ...allObservationsYes, independent_shop: "no" } });
    assert.equal(r.qualification, "disqualified");
    assert.deepEqual(r.disqualifiedBy, ["independent_shop"]);
    assert.equal(r.score, 75);
    assert.equal(r.band, "high", "band reflects the score only");
  });

  test("meets criteria with a low score", () => {
    const r = scoreProspect({ signals: { independent_shop: "yes", general_repair_services: "yes" } });
    assert.equal(r.qualification, "meets_criteria");
    assert.equal(r.score, 45);
    assert.equal(r.band, "medium");
  });

  test("one required criterion unknown means unverified", () => {
    const r = scoreProspect({ ...full, signals: { ...allObservationsYes, general_repair_services: undefined } });
    assert.equal(r.qualification, "unverified");
    assert.deepEqual(r.unverifiedCriteria, ["general_repair_services"]);
    assert.equal(r.band, "high");
  });

  test("a no on a non-required signal never affects qualification", () => {
    const r = scoreProspect({ ...full, signals: { ...allObservationsYes, multiple_bays_or_staff: "no" } });
    assert.equal(r.qualification, "meets_criteria");
    assert.deepEqual(r.disqualifiedBy, []);
  });

  test("qualificationFor", () => {
    assert.equal(qualificationFor(1, 1), "disqualified", "a no outweighs an unknown");
    assert.equal(qualificationFor(0, 1), "unverified");
    assert.equal(qualificationFor(0, 0), "meets_criteria");
  });

  test("has_website is derived from the website field", () => {
    assert.equal(resolveSignals({ signals: {}, website: WEBSITE }).has_website, "yes");
    assert.equal(resolveSignals({ signals: {} }).has_website, "unknown");
    assert.equal(resolveSignals({ signals: { has_website: "no" } }).has_website, "no");
    // A stored "no" can't override a stored website.
    assert.equal(resolveSignals({ signals: { has_website: "no" }, website: WEBSITE }).has_website, "yes");
    // A hand-recorded "yes" without a website is not trusted.
    assert.equal(resolveSignals({ signals: { has_website: "yes" } }).has_website, "unknown");
  });

  test("public contact needs a value AND its source URL", () => {
    const base = { signals: {} };
    assert.equal(resolveSignals({ ...base, phone: "555-0100" }).public_business_contact, "unknown");
    assert.equal(
      resolveSignals({ ...base, phone: "555-0100", phoneSourceUrl: WEBSITE }).public_business_contact,
      "yes",
    );
    assert.equal(
      resolveSignals({ ...base, email: "shop@example.com", emailSourceUrl: WEBSITE }).public_business_contact,
      "yes",
    );
    assert.equal(resolveSignals({ ...base, email: "  ", emailSourceUrl: WEBSITE }).public_business_contact, "unknown");
  });

  test("website-only observations count only when a website is stored", () => {
    const signals = { no_online_booking: "yes", website_not_https: "yes", digital_inspections: "yes" } as const;
    const without = scoreProspect({ signals });
    assert.equal(without.score, 0);
    assert.match(without.breakdown.find((s) => s.key === "no_online_booking")!.reason, /No website stored/);
    assert.equal(scoreProspect({ signals, website: WEBSITE }).score, 5 + 5 + 10 + 5 /* has_website */);
  });

  test("unknown signal keys are ignored", () => {
    assert.equal(scoreProspect({ signals: { in_target_region: "yes" } }).score, 0);
  });

  test("band thresholds", () => {
    assert.equal(bandFor(BAND_THRESHOLDS.high), "high");
    assert.equal(bandFor(BAND_THRESHOLDS.high - 1), "medium");
    assert.equal(bandFor(BAND_THRESHOLDS.medium), "medium");
    assert.equal(bandFor(BAND_THRESHOLDS.medium - 1), "low");
    assert.equal(bandFor(0), "low");
  });

  test("deterministic and does not mutate its input", () => {
    const input = structuredClone(full);
    const snapshot = JSON.stringify(input);
    assert.deepEqual(scoreProspect(input), scoreProspect(input));
    assert.equal(JSON.stringify(input), snapshot);
  });

  test("every breakdown row explains itself", () => {
    for (const r of [scoreProspect(full), scoreProspect({ signals: {} })]) {
      for (const s of r.breakdown) assert.ok(s.reason.length > 0, s.key);
    }
  });
});

describe("signalConsistencyErrors", () => {
  test("accepts consistent observations", () => {
    assert.deepEqual(signalConsistencyErrors(full), []);
    assert.deepEqual(signalConsistencyErrors({ signals: { has_website: "no", public_business_contact: "no" } }), []);
  });

  test("rejects hand-recorded yes for derived signals", () => {
    assert.equal(signalConsistencyErrors({ signals: { has_website: "yes" }, website: WEBSITE }).length, 1);
  });

  test("rejects a no that contradicts stored fields", () => {
    assert.equal(signalConsistencyErrors({ signals: { has_website: "no" }, website: WEBSITE }).length, 1);
    assert.equal(
      signalConsistencyErrors({ signals: { public_business_contact: "no" }, phone: "1", phoneSourceUrl: WEBSITE })
        .length,
      1,
    );
  });

  test("rejects website observations without a website", () => {
    assert.match(signalConsistencyErrors({ signals: { website_not_https: "no" } })[0]!, /only be observed on a website/);
  });

  test("rejects unknown keys and bad values", () => {
    assert.equal(signalConsistencyErrors({ signals: { made_up: "yes" } }).length, 1);
    assert.equal(signalConsistencyErrors({ signals: { independent_shop: "maybe" as "yes" } }).length, 1);
  });
});

describe("documentation", () => {
  test("PROSPECTS.md lists every signal with its current label and weight", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile(new URL("../../PROSPECTS.md", import.meta.url), "utf8");
    assert.ok(doc.includes(`## Scoring (${SCORING_VERSION})`), "scoring version heading out of date");
    for (const s of SIGNALS) {
      assert.ok(doc.includes(`| \`${s.key}\` | ${s.label} | ${s.weight} |`), `${s.key} row out of date`);
    }
  });

  test("PROSPECTS.md names exactly the required criteria and keeps qualification out of the bands", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile(new URL("../../PROSPECTS.md", import.meta.url), "utf8");
    const section = doc.slice(doc.indexOf("### Qualification"), doc.indexOf("### Opportunity score"));
    for (const key of REQUIRED_CRITERIA) assert.ok(section.includes(`\`${key}\``), key);
    const bands = doc.slice(doc.indexOf("### Opportunity score"), doc.indexOf("### Changing the scoring"));
    assert.doesNotMatch(bands.split("**The two are independent.**")[0]!, /disqualif/i);
  });
});
