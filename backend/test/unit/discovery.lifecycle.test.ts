import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  APPROVABLE_FROM,
  CANDIDATE_STATUSES,
  CANDIDATE_TRANSITIONS,
  candidateTransitionErrors,
  researchedErrors,
  type CandidateStatus,
  type CandidateTransitionContext,
} from "../../src/discovery/candidateStatus.js";

const ok: CandidateTransitionContext = { evidenceCount: 2, unevidencedSignals: [] };
const errs = (from: CandidateStatus, to: CandidateStatus, ctx = ok, reason: string | null = null) =>
  candidateTransitionErrors(from, to, ctx, reason);

describe("candidate lifecycle", () => {
  test("every status has a transition entry", () => {
    for (const s of CANDIDATE_STATUSES) assert.ok(Array.isArray(CANDIDATE_TRANSITIONS[s]), s);
  });

  test("the research path is allowed step by step", () => {
    assert.deepEqual(errs("discovered", "researching"), []);
    assert.deepEqual(errs("researching", "researched"), []);
    assert.deepEqual(errs("researched", "needs_review"), []);
    assert.deepEqual(errs("needs_review", "researched"), []);
  });

  test("a discovered candidate can't skip straight to researched", () => {
    assert.match(errs("discovered", "researched").join(), /Can't move from Discovered to Researched/);
  });

  test("approved is never a status you can set, from anywhere", () => {
    for (const from of CANDIDATE_STATUSES) {
      assert.match(errs(from, "approved", ok, "x").join(), /Approve|already a prospect/, from);
    }
    for (const list of Object.values(CANDIDATE_TRANSITIONS)) assert.ok(!list.includes("approved"));
  });

  test("approved is terminal", () => {
    assert.deepEqual(CANDIDATE_TRANSITIONS.approved, []);
    for (const to of CANDIDATE_STATUSES) assert.equal(errs("approved", to, ok, "x").length, 1, to);
  });

  test("rejected and duplicate require a reason", () => {
    assert.match(errs("discovered", "rejected").join(), /requires a reason/);
    assert.match(errs("discovered", "duplicate", ok, "  ").join(), /requires a reason/);
    assert.deepEqual(errs("discovered", "rejected", ok, "Specialty shop"), []);
    assert.deepEqual(errs("needs_review", "duplicate", ok, "Same shop as X"), []);
  });

  test("rejected and duplicate can only be reopened to discovered", () => {
    assert.deepEqual(errs("rejected", "discovered"), []);
    assert.deepEqual(errs("duplicate", "discovered"), []);
    assert.equal(errs("rejected", "researched").length, 1);
    assert.equal(errs("duplicate", "needs_review").length, 1);
  });

  test("a rejected or duplicate candidate is not approvable", () => {
    assert.ok(!APPROVABLE_FROM.includes("rejected"));
    assert.ok(!APPROVABLE_FROM.includes("duplicate"));
    assert.ok(!APPROVABLE_FROM.includes("discovered"));
    assert.ok(!APPROVABLE_FROM.includes("researching"));
    assert.deepEqual([...APPROVABLE_FROM], ["researched", "needs_review"]);
  });

  test("same-status change is refused", () => {
    assert.equal(errs("discovered", "discovered").length, 1);
  });
});

describe("Researched means evidence-backed", () => {
  test("needs at least one evidence item", () => {
    assert.match(researchedErrors({ evidenceCount: 0, unevidencedSignals: [] }).join(), /at least one evidence/);
    assert.deepEqual(researchedErrors(ok), []);
  });

  test("every recorded signal needs its own evidence", () => {
    const e = researchedErrors({ evidenceCount: 3, unevidencedSignals: ["independent_shop", "digital_inspections"] });
    assert.equal(e.length, 1);
    assert.match(e[0]!, /independent_shop, digital_inspections/);
  });

  test("the gate applies to the transition into researched", () => {
    assert.equal(errs("researching", "researched", { evidenceCount: 0, unevidencedSignals: [] }).length, 1);
    assert.equal(errs("needs_review", "researched", { evidenceCount: 1, unevidencedSignals: ["independent_shop"] }).length, 1);
  });

  test("other moves don't need evidence", () => {
    const none: CandidateTransitionContext = { evidenceCount: 0, unevidencedSignals: [] };
    assert.deepEqual(errs("discovered", "researching", none), []);
    assert.deepEqual(errs("discovered", "needs_review", none), []);
  });
});

describe("documentation", () => {
  test("DISCOVERY.md lists every status and transition exactly as the code defines them", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile(new URL("../../DISCOVERY.md", import.meta.url), "utf8");
    for (const s of CANDIDATE_STATUSES) {
      const to = CANDIDATE_TRANSITIONS[s].length ? CANDIDATE_TRANSITIONS[s].join(", ") : "*(none)*";
      assert.ok(doc.includes(`| ${s} | ${to} |`), `${s} row out of date`);
      assert.ok(doc.includes(`| \`${s}\` |`), `${s} meaning row missing`);
    }
  });
});
