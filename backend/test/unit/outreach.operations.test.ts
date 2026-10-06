import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { messagesHref } from "../../src/admin/outreachViews.js";
import { NO_CAMPAIGN, STALE_QUEUE_MS, parseMessageFilters, queueLooksStale } from "../../src/outreach/operations.js";

/*
 * Stage 5A: the Outreach operations views' pure parts. The query string
 * becomes known filters only, links keep exactly the filters given, and the
 * stale-queue warning appears only when it means a stopped sender job.
 */

describe("operations view filters", () => {
  test("search, exact prospect and a valid UTC date range are retained", () => {
    const f = parseMessageFilters({ q: "  Harbor  ", prospect: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", from: "2026-10-01", to: "2026-10-05" });
    assert.equal(f.q, "Harbor");
    assert.equal(f.prospect, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    assert.equal(f.from, "2026-10-01");
    assert.equal(f.to, "2026-10-05");
  });
  test("invalid dates and inverted ranges never reach the database", () => {
    for (const value of ["2026-02-30", "0000-01-01", "2026-10-01;DROP", "tomorrow"]) assert.equal(parseMessageFilters({ from: value }).from, undefined);
    assert.equal(parseMessageFilters({ from: "2026-10-05", to: "2026-10-01" }).from, undefined);
    assert.equal(parseMessageFilters({ prospect: "not-a-prospect" }).prospect, undefined);
    assert.equal(parseMessageFilters({ q: "x".repeat(200) }).q?.length, 100);
  });
  test("the defaults: all messages, first page", () => {
    assert.deepEqual(parseMessageFilters({}), { view: "messages", status: null, kind: null, campaign: null, activated: false, sent: false, page: 1 });
  });

  test("known values are kept, using the repository's own names", () => {
    assert.deepEqual(parseMessageFilters({ view: "replies", status: "queued", kind: "follow_up", campaign: "outreach-intro-t2", activated: "1", sent: "1", page: "3" }), {
      view: "replies",
      status: "queued",
      kind: "follow_up",
      campaign: "outreach-intro-t2",
      activated: true,
      sent: true,
      page: 3,
    });
    assert.equal(parseMessageFilters({ campaign: NO_CAMPAIGN }).campaign, NO_CAMPAIGN, "the funnel's (none) row");
  });

  test("anything else is ignored, never trusted", () => {
    const f = parseMessageFilters({ view: "admin", status: "QUEUED", kind: "initial; drop", campaign: "<script>", activated: "yes", sent: "true", page: "-2" });
    assert.deepEqual(f, { view: "messages", status: null, kind: null, campaign: null, activated: false, sent: false, page: 1 });
    assert.equal(parseMessageFilters({ page: "0" }).page, 1);
    assert.equal(parseMessageFilters({ page: "1e9" }).page, 1);
    assert.equal(parseMessageFilters({ page: ["2"] as unknown as string }).page, 1, "a repeated parameter isn't a page");
    assert.equal(parseMessageFilters({ campaign: "a".repeat(65) }).campaign, null, "longer than a campaign can be");
  });
});

describe("operations links", () => {
  test("empty values are left out; the rest are encoded", () => {
    assert.equal(messagesHref({}), "/admin/outreach/messages");
    assert.equal(messagesHref({ view: "activity", campaign: NO_CAMPAIGN, activated: "1", status: null, kind: undefined, page: "" }), "/admin/outreach/messages?view=activity&campaign=%28none%29&activated=1");
    assert.equal(messagesHref({ campaign: "pilot-1", page: 2 }), "/admin/outreach/messages?campaign=pilot-1&page=2");
  });
});

describe("the stale-queue warning", () => {
  const now = new Date("2026-10-05T15:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const long = STALE_QUEUE_MS + 60_000;
  const stale = { sendingLive: true, switchedAt: ago(long), oldestQueuedAt: ago(long), lastSentAt: null, now };

  test("sending on and unblocked, a message waiting past the threshold, nothing sent within it", () => {
    assert.equal(STALE_QUEUE_MS, 2 * 60 * 60 * 1000, "documented as two hours");
    assert.equal(queueLooksStale(stale), true);
    assert.equal(queueLooksStale({ ...stale, lastSentAt: ago(long) }), true, "the last send was before the threshold too");
  });

  test("never while sending is off, blocked, or paused by the daily limit", () => {
    assert.equal(queueLooksStale({ ...stale, sendingLive: false }), false);
  });

  test("not a queue that is still draining, nor one that just started", () => {
    assert.equal(queueLooksStale({ ...stale, lastSentAt: ago(60_000) }), false, "something was sent recently: the job runs");
    assert.equal(queueLooksStale({ ...stale, switchedAt: ago(60_000) }), false, "switched on moments ago");
    assert.equal(queueLooksStale({ ...stale, oldestQueuedAt: ago(60_000) }), false, "queued moments ago");
    assert.equal(queueLooksStale({ ...stale, oldestQueuedAt: null }), false, "nothing is waiting");
    assert.equal(queueLooksStale({ ...stale, switchedAt: null }), false, "never switched on");
  });
});
