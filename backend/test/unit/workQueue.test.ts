import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nextStep, stepReason, type QueueInput } from "../../src/discovery/workQueue.js";

/** A researched, in-category candidate meeting both criteria: ready to approve. */
const ready = (over: Partial<QueueInput> = {}): QueueInput => ({
  status: "researched",
  duplicate: "none",
  outsideTarget: false,
  categoryVerdict: "in_target",
  providerStatus: null,
  qualification: "meets_criteria",
  unverifiedCriteria: [],
  disqualifiedBy: [],
  approvalBlockers: [],
  research: { pending: false, latest: { status: "completed", outcome: "website_verified" } },
  ...over,
});
const step = (over: Partial<QueueInput>) => {
  const s = nextStep(ready(over));
  return [s.lane, s.kind, s.action];
};

describe("the work queue: one next step per candidate", () => {
  test("handled candidates are out of the active queue", () => {
    assert.deepEqual(step({ status: "approved" }), ["handled", "approved", "open"]);
    assert.deepEqual(step({ status: "rejected" }), ["handled", "disregarded", "open"]);
    assert.deepEqual(step({ status: "duplicate", duplicate: "duplicate" }), ["handled", "duplicate_closed", "open"]);
  });

  test("an open duplicate question comes first, whatever else is true", () => {
    assert.deepEqual(step({ status: "needs_review", duplicate: "possible", qualification: "disqualified", disqualifiedBy: ["independent_shop"] }), ["decision", "duplicate", "review_duplicate"]);
    assert.deepEqual(step({ status: "needs_review", duplicate: "unresolved" }), ["decision", "duplicate", "review_duplicate"]);
  });

  test("a resolved 'not a duplicate' is no longer duplicate work", () => {
    assert.deepEqual(step({ duplicate: "not_duplicate" }), ["ready", "ready", "approve"]);
    assert.deepEqual(step({ status: "needs_review", duplicate: "not_duplicate" }), ["decision", "on_hold", "review"], "a person's own hold still asks for them");
  });

  test("outside the category or a criterion observed as No: disregard is the next step", () => {
    assert.deepEqual(step({ outsideTarget: true, categoryVerdict: "wrong_category", approvalBlockers: ["outside"] }), ["decision", "outside_target", "disregard"]);
    assert.deepEqual(step({ qualification: "disqualified", disqualifiedBy: ["general_repair_services"] }), ["decision", "disqualified", "disregard"]);
  });

  test("other decisions only a person can make", () => {
    assert.deepEqual(step({ categoryVerdict: "unclear" }), ["decision", "category_unclear", "review"]);
    assert.deepEqual(step({ providerStatus: "permanently_closed" }), ["decision", "provider_closed", "review"]);
    assert.deepEqual(step({ status: "needs_review" }), ["decision", "on_hold", "review"]);
  });

  test("research: not run, running, failed, or found too little", () => {
    const blocked = { status: "discovered" as const, approvalBlockers: ["Status is Discovered"], qualification: "unverified" as const, unverifiedCriteria: ["independent_shop"] };
    assert.deepEqual(step({ ...blocked, research: { pending: false, latest: null } }), ["research", "not_researched", "run_research"]);
    assert.deepEqual(step({ ...blocked, research: { pending: true, latest: null } }), ["research", "research_running", "wait"]);
    assert.deepEqual(step({ ...blocked, research: { pending: false, latest: { status: "failed", outcome: null } } }), ["research", "research_failed", "run_research"]);
    assert.deepEqual(step({ ...blocked, research: { pending: false, latest: { status: "completed", outcome: "no_website" } } }), ["research", "research_incomplete", "review"]);
  });

  test("research re-running on a ready candidate doesn't take its approval away", () => {
    assert.deepEqual(step({ research: { pending: true, latest: null } }), ["ready", "ready", "approve"]);
  });

  test("researched but a required criterion unknown: verify that criterion", () => {
    const s = nextStep(ready({ qualification: "unverified", unverifiedCriteria: ["independent_shop", "general_repair_services"] }));
    assert.deepEqual([s.lane, s.kind, s.action, s.criterion], ["verify", "unverified", "verify", "independent_shop"]);
  });

  test("ready only when nothing blocks approval and both criteria are confirmed", () => {
    assert.deepEqual(step({}), ["ready", "ready", "approve"]);
    assert.deepEqual(step({ status: "needs_review", duplicate: "not_duplicate", approvalBlockers: [] }), ["decision", "on_hold", "review"]);
  });
});

describe("why, in one plain sentence", () => {
  const base = { unverifiedCriteria: [] as string[], disqualifiedBy: [] as string[] };
  test("names the criterion, the match reason, or the research outcome", () => {
    assert.equal(stepReason(nextStep(ready({ qualification: "unverified", unverifiedCriteria: ["independent_shop"] })), { ...base, unverifiedCriteria: ["independent_shop"] }), "Independent shop hasn't been verified yet.");
    assert.equal(stepReason(nextStep(ready({ qualification: "disqualified", disqualifiedBy: ["general_repair_services"] })), { ...base, disqualifiedBy: ["general_repair_services"] }), "Offers general repair is No.");
    assert.equal(stepReason(nextStep(ready({ duplicate: "possible", status: "needs_review" })), { ...base, duplicateReasonText: "Same name in the same city" }), "It may be the same business as another record: same name in the same city.");
    assert.equal(
      stepReason(nextStep(ready({ status: "discovered", approvalBlockers: ["x"], research: { pending: false, latest: { status: "completed", outcome: "no_website" } } })), { ...base, latestOutcome: "no_website" }),
      "No website known, so research found too little to go on.",
    );
  });
});
