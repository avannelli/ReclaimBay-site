import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyMatch, flagReason, type IncomingKeys, type MatchKeys } from "../../src/discovery/dedupe.js";

const incoming = (over: Partial<IncomingKeys> = {}): IncomingKeys => ({
  provider: "fixture",
  externalId: "fx-1",
  domainKey: "smithauto.com",
  nameKey: "smith auto",
  locationKey: "springfield|IL",
  phoneKey: "5550100100",
  ...over,
});

const existing = (over: Partial<MatchKeys> = {}): MatchKeys => ({
  id: "c1",
  kind: "candidate",
  provider: "other",
  externalId: "zzz",
  domainKey: "unrelated.com",
  nameKey: "unrelated",
  locationKey: "elsewhere|TX",
  phoneKey: "5559999999",
  ...over,
});

describe("classifyMatch: CONFIDENT_DUPLICATE", () => {
  test("same provider and external ID", () => {
    const v = classifyMatch(incoming(), [existing({ provider: "fixture", externalId: "fx-1" })]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.deepEqual(v.duplicateOf, { kind: "candidate", id: "c1", reason: "same provider record" });
  });

  test("the same external ID under a different provider is NOT the same record", () => {
    const v = classifyMatch(incoming(), [existing({ provider: "other", externalId: "fx-1" })]);
    assert.equal(v.outcome, "NO_MATCH");
  });

  test("same website domain, even with a different name and city", () => {
    const v = classifyMatch(incoming({ externalId: null }), [existing({ domainKey: "smithauto.com" })]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(v.duplicateOf?.reason, "same website domain");
  });

  test("a matching domain on an existing prospect is also confident", () => {
    const v = classifyMatch(incoming(), [existing({ kind: "prospect", id: "p1", domainKey: "smithauto.com" })]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(v.duplicateOf?.kind, "prospect");
  });

  test("a missing domain never matches another missing domain", () => {
    const v = classifyMatch(incoming({ domainKey: null, externalId: null }), [existing({ domainKey: null })]);
    assert.equal(v.outcome, "NO_MATCH");
  });

  test("the first match wins, so list candidates before prospects", () => {
    const v = classifyMatch(incoming(), [
      existing({ id: "c1", domainKey: "smithauto.com" }),
      existing({ id: "p1", kind: "prospect", domainKey: "smithauto.com" }),
    ]);
    assert.equal(v.duplicateOf?.id, "c1");
  });
});

describe("classifyMatch: REVIEW_REQUIRED (weak evidence is never auto-skipped)", () => {
  test("same name in the same city, different website", () => {
    const v = classifyMatch(incoming({ externalId: "fx-2", domainKey: "other-site.com" }), [
      existing({ nameKey: "smith auto", locationKey: "springfield|IL" }),
    ]);
    assert.equal(v.outcome, "REVIEW_REQUIRED");
    assert.equal(v.duplicateOf, null);
    assert.deepEqual(v.possibleCandidate, { kind: "candidate", id: "c1", reason: "same name and city" });
  });

  test("shared phone number alone", () => {
    const v = classifyMatch(incoming({ externalId: null, domainKey: null }), [existing({ phoneKey: "5550100100" })]);
    assert.equal(v.outcome, "REVIEW_REQUIRED");
    assert.equal(v.possibleCandidate?.reason, "same phone number");
  });

  test("a weak match against an existing prospect is flagged on the prospect side", () => {
    const v = classifyMatch(incoming({ externalId: null, domainKey: null }), [
      existing({ kind: "prospect", id: "p1", nameKey: "smith auto", locationKey: "springfield|IL" }),
    ]);
    assert.equal(v.outcome, "REVIEW_REQUIRED");
    assert.equal(v.possibleProspect?.id, "p1");
    assert.equal(v.possibleCandidate, null);
  });

  test("candidate and prospect flags can both be set", () => {
    const v = classifyMatch(incoming({ externalId: null, domainKey: null }), [
      existing({ id: "c1", phoneKey: "5550100100" }),
      existing({ id: "p1", kind: "prospect", phoneKey: "5550100100" }),
    ]);
    assert.equal(v.possibleCandidate?.id, "c1");
    assert.equal(v.possibleProspect?.id, "p1");
    assert.match(flagReason(v)!, /candidate: same phone number; prospect: same phone number/);
  });

  test("a confident match outranks a weak one", () => {
    const v = classifyMatch(incoming(), [existing({ domainKey: "smithauto.com", phoneKey: "5550100100" })]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
  });

  test("the same name in a different city is a different business", () => {
    const v = classifyMatch(incoming({ externalId: null, domainKey: null, phoneKey: null }), [
      existing({ nameKey: "smith auto", locationKey: "fresno|CA" }),
    ]);
    assert.equal(v.outcome, "NO_MATCH");
  });

  test("a name with no city is too weak to flag", () => {
    const v = classifyMatch(incoming({ externalId: null, domainKey: null, phoneKey: null, locationKey: null }), [
      existing({ nameKey: "smith auto", locationKey: null }),
    ]);
    assert.equal(v.outcome, "NO_MATCH");
  });
});

describe("classifyMatch: NO_MATCH", () => {
  test("nothing overlaps", () => {
    const v = classifyMatch(incoming(), [existing()]);
    assert.deepEqual(v, { outcome: "NO_MATCH", duplicateOf: null, possibleCandidate: null, possibleProspect: null });
    assert.equal(flagReason(v), null);
  });

  test("empty existing list", () => {
    assert.equal(classifyMatch(incoming(), []).outcome, "NO_MATCH");
  });
});
