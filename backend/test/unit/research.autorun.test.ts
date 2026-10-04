import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import {
  AUTO_TIME_BUDGET_MS,
  MAX_RESEARCH_ATTEMPTS,
  RETRY_AFTER_MS,
  drainWithBudget,
  retryDecision,
  runAutoResearch,
  type RunHistoryEntry,
} from "../../src/research/service.js";

/*
 * The automatic research worker's pure parts: which candidates it tries
 * again, and when it stops. No database, no network, a fake clock.
 */

const NOW = new Date("2026-10-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const run = (over: Partial<RunHistoryEntry> = {}): RunHistoryEntry => ({ status: "failed", outcome: null, queuedAt: hoursAgo(26), finishedAt: hoursAgo(25), ...over });

describe("retryDecision: bounded retries of transient failures", () => {
  test("a failed or interrupted run, 24 hours or more ago: retried", () => {
    assert.equal(retryDecision([run()], NOW).retry, true);
    assert.equal(retryDecision([run({ finishedAt: hoursAgo(24) })], NOW).retry, true, "exactly 24 hours");
  });

  test("a website that couldn't be reached: retried", () => {
    assert.equal(retryDecision([run({ outcome: "website_unreachable" })], NOW).retry, true);
  });

  test("fewer than 24 hours since the last attempt: not yet", () => {
    const d = retryDecision([run({ finishedAt: hoursAgo(23.9) })], NOW);
    assert.equal(d.retry, false);
    assert.match(d.reason, /24 hours/);
    // An interrupted run without a finish time counts from when it was queued.
    assert.equal(retryDecision([run({ finishedAt: null, queuedAt: hoursAgo(2) })], NOW).retry, false);
  });

  test(`at most ${MAX_RESEARCH_ATTEMPTS} attempts per candidate, the first included`, () => {
    assert.equal(retryDecision([run(), run()], NOW).retry, true, "two attempts: one more");
    const three = retryDecision([run(), run(), run()], NOW);
    assert.equal(three.retry, false);
    assert.match(three.reason, /3 attempts/);
  });

  test("research's final word is never retried", () => {
    for (const outcome of ["no_website", "access_blocked", "robots_disallowed", "website_mismatch", "website_unconfirmed", "website_verified"]) {
      assert.equal(retryDecision([run({ status: "completed", outcome })], NOW).retry, false, outcome);
    }
  });

  test("ambiguous: a failed run with any outcome but unreachable, or a completed one, is not retried", () => {
    assert.equal(retryDecision([run({ status: "failed", outcome: "website_mismatch" })], NOW).retry, false);
    assert.equal(retryDecision([run({ status: "completed", outcome: "website_unreachable" })], NOW).retry, false);
    assert.equal(retryDecision([run({ status: "completed", outcome: null })], NOW).retry, false);
  });

  test("only the latest run counts: a failure after a verified run is retried; a verified run after a failure is not", () => {
    assert.equal(retryDecision([run(), run({ status: "completed", outcome: "website_verified" })], NOW).retry, true);
    assert.equal(retryDecision([run({ status: "completed", outcome: "website_verified" }), run()], NOW).retry, false);
  });

  test("never researched, or research queued or running: not a retry", () => {
    assert.equal(retryDecision([], NOW).retry, false);
    assert.equal(retryDecision([run({ status: "queued", finishedAt: null }), run()], NOW).retry, false);
    assert.equal(retryDecision([run({ status: "running", finishedAt: null }), run()], NOW).retry, false);
  });

  test("the spacing is 24 hours", () => assert.equal(RETRY_AFTER_MS, 24 * 60 * 60 * 1000));
});

describe("drainWithBudget: limit, time budget, and stop requests", () => {
  /** Items that each take `stepMs` on a fake clock; records which ones started. */
  const harness = (stepMs: number, items = 100) => {
    let t = 0;
    const started: number[] = [];
    let n = 0;
    return {
      started,
      clock: () => t,
      sleep: async (ms: number) => void (t += ms),
      next: async () => {
        if (n >= items) return null;
        started.push(n);
        t += stepMs;
        return { result: n++ };
      },
    };
  };

  test("stops when nothing is left", async () => {
    const h = harness(1000, 3);
    const r = await drainWithBudget({ ...h, limit: 10, budgetMs: AUTO_TIME_BUDGET_MS, shouldStop: () => false, pauseMs: 1000 });
    assert.deepEqual(r, { results: [0, 1, 2], stoppedBy: "done" });
  });

  test("stops at the limit", async () => {
    const h = harness(1000);
    const r = await drainWithBudget({ ...h, limit: 4, budgetMs: AUTO_TIME_BUDGET_MS, shouldStop: () => false, pauseMs: 1000 });
    assert.deepEqual(r, { results: [0, 1, 2, 3], stoppedBy: "limit" });
  });

  test("starts no new item once 10 minutes are spent; the item in progress always finishes", async () => {
    // 4 minutes per item: started at 0, 4m+1s, 8m+2s; the next would start at 12m+3s, past the budget.
    const h = harness(4 * 60 * 1000);
    const r = await drainWithBudget({ ...h, limit: 10, budgetMs: AUTO_TIME_BUDGET_MS, shouldStop: () => false, pauseMs: 1000 });
    assert.equal(r.stoppedBy, "budget");
    assert.deepEqual(r.results, [0, 1, 2], "the third item started before 10 minutes and finished after them");
    assert.ok(h.clock() > AUTO_TIME_BUDGET_MS);
  });

  test("a stop request (SIGTERM) lets the item in progress finish, then starts nothing new", async () => {
    const h = harness(1000);
    let stop = false;
    const next = async () => {
      const item = await h.next();
      if (h.started.length === 2) stop = true; // the signal arrives while the second item runs
      return item;
    };
    const r = await drainWithBudget({ ...h, next, limit: 10, budgetMs: AUTO_TIME_BUDGET_MS, shouldStop: () => stop, pauseMs: 1000 });
    assert.deepEqual(r, { results: [0, 1], stoppedBy: "signal" });
    assert.deepEqual(h.started, [0, 1]);
  });

  test("a stop requested before anything started: nothing starts", async () => {
    const h = harness(1000);
    const r = await drainWithBudget({ ...h, limit: 10, budgetMs: AUTO_TIME_BUDGET_MS, shouldStop: () => true, pauseMs: 1000 });
    assert.deepEqual(r, { results: [], stoppedBy: "signal" });
  });
});

describe("runAutoResearch: the arm and the lock come first", () => {
  /** A database that fails the test if touched. */
  const untouchable = new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : assert.fail(`the database was used (${String(key)})`)) }) as unknown as Db;

  test("disarmed (RESEARCH_AUTORUN_ENABLED is not 1): exits at once, touching nothing, not even the lock", async () => {
    const r = await runAutoResearch(untouchable, { enabled: false, databaseUrl: "unused", limit: 10, lock: async () => assert.fail("the lock was taken") });
    assert.equal(r.outcome, "disabled");
    assert.equal(r.queuedFresh + r.queuedRetries + r.completed + r.failed, 0);
  });

  test("another worker holds the lock: exits cleanly, touching nothing", async () => {
    const r = await runAutoResearch(untouchable, { enabled: true, databaseUrl: "unused", limit: 10, lock: async () => null });
    assert.equal(r.outcome, "locked");
  });
});
