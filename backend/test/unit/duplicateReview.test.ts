import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { duplicatePending, duplicateState, isDuplicateAnswer, matchReasons, type DuplicateFlag } from "../../src/discovery/duplicateReview.js";

const flag = (over: Partial<DuplicateFlag> = {}): DuplicateFlag => ({
  status: "needs_review",
  possibleDuplicateCandidateId: "a",
  possibleDuplicateProspectId: null,
  duplicateDecision: null,
  ...over,
});

describe("where a duplicate question stands", () => {
  test("possible until a person answers; the answer is kept next to the flag", () => {
    assert.equal(duplicateState(flag()), "possible");
    assert.equal(duplicateState(flag({ possibleDuplicateCandidateId: null, possibleDuplicateProspectId: "p" })), "possible", "a prospect match counts too");
    assert.equal(duplicateState(flag({ duplicateDecision: "unresolved" })), "unresolved");
    assert.equal(duplicateState(flag({ duplicateDecision: "not_duplicate", status: "researched" })), "not_duplicate");
    assert.equal(duplicateState(flag({ status: "duplicate" })), "duplicate", "a confirmed duplicate is the candidate status");
    assert.equal(duplicateState(flag({ possibleDuplicateCandidateId: null })), "none");
  });

  test("only an open question holds approval back", () => {
    assert.equal(duplicatePending(flag()), true);
    assert.equal(duplicatePending(flag({ duplicateDecision: "unresolved" })), true);
    assert.equal(duplicatePending(flag({ duplicateDecision: "not_duplicate" })), false);
    assert.equal(duplicatePending(flag({ status: "duplicate" })), false);
    assert.equal(duplicatePending(flag({ possibleDuplicateCandidateId: null })), false);
  });

  test("the three answers a person can give, and nothing else", () => {
    for (const a of ["not_duplicate", "duplicate", "unresolved"]) assert.equal(isDuplicateAnswer(a), true);
    for (const a of ["", "possible", "approved", "NOT_DUPLICATE"]) assert.equal(isDuplicateAnswer(a), false);
  });
});

describe("why it was flagged, in plain words", () => {
  test("each detection reason reads as a sentence, and says which record it matched", () => {
    assert.deepEqual(matchReasons("candidate: same name and city"), [{ kind: "candidate", text: "Same name in the same city" }]);
    assert.deepEqual(matchReasons("candidate: similar name nearby; prospect: same phone number"), [
      { kind: "candidate", text: "Similar name within 150 m" },
      { kind: "prospect", text: "Same phone number" },
    ]);
    assert.deepEqual(matchReasons("prospect: same website, location unconfirmed"), [{ kind: "prospect", text: "Same website; location not confirmed" }]);
  });

  test("an unrecognised reason is shown as written, never hidden", () => {
    assert.deepEqual(matchReasons("candidate: some future rule"), [{ kind: "candidate", text: "Some future rule" }]);
    assert.deepEqual(matchReasons(null), []);
  });
});
