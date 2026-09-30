import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  OUTREACH_ELIGIBLE,
  STATUSES,
  TRANSITIONS,
  statusRequirementErrors,
  transitionErrors,
  type StatusContext,
} from "../../src/prospectStatus.js";

const ready: StatusContext = { businessName: "Smith Auto", hasPublicContact: true, qualification: "meets_criteria" };

describe("status transitions", () => {
  test("every status has a transition entry", () => {
    for (const s of STATUSES) assert.ok(Array.isArray(TRANSITIONS[s]), s);
  });

  test("the main path is allowed step by step", () => {
    const path = ["new", "qualified", "ready_to_contact", "contacted", "engaged", "customer"] as const;
    for (let i = 1; i < path.length; i++) {
      assert.deepEqual(transitionErrors(path[i - 1]!, path[i]!, ready, null), [], `${path[i - 1]} -> ${path[i]}`);
    }
  });

  test("skipping steps is refused", () => {
    assert.equal(transitionErrors("new", "contacted", ready, null).length, 1);
    assert.equal(transitionErrors("new", "ready_to_contact", ready, null).length, 1);
    assert.equal(transitionErrors("qualified", "customer", ready, null).length, 1);
  });

  test("do_not_contact is reachable from every other status and is terminal", () => {
    for (const s of STATUSES.filter((s) => s !== "do_not_contact")) {
      assert.deepEqual(transitionErrors(s, "do_not_contact", ready, "Asked by phone"), [], s);
    }
    assert.deepEqual(TRANSITIONS.do_not_contact, []);
    for (const s of STATUSES) {
      assert.match(transitionErrors("do_not_contact", s, ready, "x")[0]!, /permanent|Already/);
    }
  });

  test("do_not_contact is never outreach-eligible", () => {
    assert.ok(!OUTREACH_ELIGIBLE.includes("do_not_contact"));
  });

  test("do_not_contact and not_a_fit require a reason", () => {
    assert.match(transitionErrors("new", "do_not_contact", ready, " ").join(), /requires a reason/);
    assert.match(transitionErrors("new", "not_a_fit", ready, null).join(), /requires a reason/);
    assert.deepEqual(transitionErrors("new", "archived", ready, null), []);
  });

  test("archived and not_a_fit can be reopened to new", () => {
    assert.deepEqual(transitionErrors("archived", "new", ready, null), []);
    assert.deepEqual(transitionErrors("not_a_fit", "new", ready, null), []);
  });

  test("same-status change is refused", () => {
    assert.equal(transitionErrors("new", "new", ready, null).length, 1);
  });
});

describe("status requirements", () => {
  test("qualified needs a business name and Qualification = Meets criteria", () => {
    assert.equal(statusRequirementErrors("qualified", { ...ready, businessName: " " }).length, 1);
    assert.match(
      statusRequirementErrors("qualified", { ...ready, qualification: "disqualified" }).join(),
      /requires Qualification "Meets criteria"; this prospect is Disqualified/,
    );
    assert.match(
      statusRequirementErrors("qualified", { ...ready, qualification: "unverified" }).join(),
      /requires Qualification "Meets criteria"; this prospect is Unverified/,
    );
    assert.deepEqual(statusRequirementErrors("qualified", { ...ready, hasPublicContact: false }), []);
  });

  test("Unverified and Disqualified are blocked from qualified and ready_to_contact, via transitions too", () => {
    for (const qualification of ["unverified", "disqualified"] as const) {
      const ctx = { ...ready, qualification };
      for (const status of ["qualified", "ready_to_contact"] as const) {
        assert.equal(statusRequirementErrors(status, ctx).length, 1, `${qualification} -> ${status}`);
      }
      assert.equal(transitionErrors("new", "qualified", ctx, null).length, 1);
      assert.equal(transitionErrors("qualified", "ready_to_contact", ctx, null).length, 1);
    }
  });

  test("the status rules have no access to the score", () => {
    // StatusContext carries qualification, never a score or band.
    assert.deepEqual(Object.keys(ready).sort(), ["businessName", "hasPublicContact", "qualification"]);
  });

  test("ready_to_contact also needs public contact", () => {
    assert.match(
      statusRequirementErrors("ready_to_contact", { ...ready, hasPublicContact: false }).join(),
      /public business phone or email/,
    );
    assert.deepEqual(statusRequirementErrors("ready_to_contact", ready), []);
  });

  test("gates apply to transitions", () => {
    const noContact = { ...ready, hasPublicContact: false };
    assert.equal(transitionErrors("qualified", "ready_to_contact", noContact, null).length, 1);
  });

  test("later statuses carry no field requirements", () => {
    const empty: StatusContext = { businessName: null, hasPublicContact: false, qualification: "disqualified" };
    for (const s of ["contacted", "engaged", "customer", "archived", "not_a_fit", "do_not_contact", "new"] as const) {
      assert.deepEqual(statusRequirementErrors(s, empty), [], s);
    }
  });
});

describe("documentation", () => {
  test("PROSPECTS.md transition table matches TRANSITIONS", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile(new URL("../../PROSPECTS.md", import.meta.url), "utf8");
    for (const s of STATUSES) {
      const to = TRANSITIONS[s].length ? TRANSITIONS[s].join(", ") : "*(none)*";
      assert.ok(doc.includes(`| ${s} | ${to} |`), `${s} row out of date`);
    }
  });
});
