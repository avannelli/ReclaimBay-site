import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { GmailError } from "../../src/outreach/gmail.js";
import { pollGmailInbox, type InboxReport } from "../../src/outreach/gmailInbox.js";
import { inboxLogLines } from "../../src/outreach/inboxLog.js";
import { aliasGoogle, fakeGmail, inbound } from "../fixtures/fakeGmail.js";

/*
 * One Gmail thread that can't be read (production: threads.get answered
 * "400 failedPrecondition: Precondition check failed.") must not end the
 * inbox run, and must never become evidence. Fake Google, no network, and a
 * database that answers only attribution's read and fails on anything else.
 */

const AT = new Date("2026-10-16T12:00:00Z");
const FAILED_PRECONDITION = { status: 400, body: { error: { code: 400, message: "Precondition check failed.", errors: [{ reason: "failedPrecondition" }] } } };

/** Attribution's one read, answered with no candidates; any write, transaction, or unsubscribe ingestion fails the test. */
const readOnlyDb = () => new Proxy({ outreach: { findMany: async () => [], count: async () => 0 } } as Record<string, unknown>, {
  get(target, key) {
    if (key === "outreach") return target.outreach;
    if (key === "then") return undefined;
    throw new Error(`unexpected database access: ${String(key)}`);
  },
}) as unknown as Db;

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error("Real network forbidden."); }) as typeof fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

/** Three inbound messages in their own threads, newest first as Gmail lists them: A healthy, B the one under test, C healthy. */
function mailbox(b: "reply" | "bounce" | "unsubscribe") {
  const f = fakeGmail(aliasGoogle());
  const reply = (id: string, thread: string, from: string) => inbound(id, thread, { From: from, Subject: "Re: Hello" }, [{ mimeType: "text/plain", text: "Thanks" }], "Thanks", AT);
  f.google.inbox.push(reply("a", "thread-a", "owner@a.example.com"));
  f.google.inbox.push(
    b === "reply" ? reply("b", "thread-b", "owner@b.example.com")
    : b === "bounce" ? inbound("b", "thread-b", { From: "mailer-daemon@example.com", Subject: "Delivery failure" }, [{ mimeType: "message/delivery-status", text: "Action: failed\nStatus: 5.1.1\nFinal-Recipient: rfc822; owner@b.example.com" }], "", AT)
    : inbound("b", "thread-b", { From: "owner@b.example.com", Subject: "Re: unsubscribe" }, [], "Private inbound text", AT),
  );
  f.google.inbox.push(reply("c", "thread-c", "owner@c.example.com"));
  return f;
}
const threadReads = (f: ReturnType<typeof mailbox>) => f.google.calls.filter((c) => /\/threads\//.test(c.url)).map((c) => /\/threads\/([^?]+)/.exec(c.url)![1]);
const byId = (r: InboxReport) => Object.fromEntries(r.items.map((i) => [i.gmailId, i]));

describe("one unreadable Gmail thread", () => {
  for (const kind of ["reply", "bounce"] as const) {
    test(`a ${kind} whose thread Gmail refuses is left for review; the messages around it are processed and the run completes`, async () => {
      // The same mailbox with every thread readable: what A and C should come to.
      const healthy = mailbox(kind);
      const baseline = byId(await pollGmailInbox(readOnlyDb(), healthy.client, { apply: true, now: () => AT }));

      const f = mailbox(kind);
      f.google.threadAnswers.set("thread-b", FAILED_PRECONDITION);
      const r = await pollGmailInbox(readOnlyDb(), f.client, { apply: true, now: () => AT });
      const items = byId(r);

      assert.equal(r.checked, 3);
      assert.equal(r.unreadableThreads, 1);
      assert.deepEqual(threadReads(f), ["thread-a", "thread-b", "thread-c"], "every thread was asked for, C after B's failure");
      // B: never attributed, nothing recorded (the read-only database would have thrown).
      assert.equal(items.b!.kind, kind);
      assert.equal(items.b!.result, "unresolved");
      assert.equal(items.b!.outreachId, null);
      assert.equal(items.b!.attribution?.reason, "invalid_identity");
      // A and C exactly as when nothing failed.
      for (const id of ["a", "c"]) {
        assert.equal(items[id]!.result, baseline[id]!.result);
        assert.deepEqual(items[id]!.attribution, baseline[id]!.attribution);
      }
      assert.equal(baseline.b!.attribution?.reason === "invalid_identity", false, "B's review comes from the unreadable thread, not its content");
    });
  }

  test("an unsubscribe whose thread Gmail refuses is never ingested: no opt-out from partial evidence", async () => {
    const f = mailbox("unsubscribe");
    f.google.threadAnswers.set("thread-b", FAILED_PRECONDITION);
    // Ingesting would touch emailedUnsubscribeReview or open a transaction: the read-only database throws.
    const r = await pollGmailInbox(readOnlyDb(), f.client, { apply: true, now: () => AT });
    const b = byId(r).b!;
    assert.equal(b.kind, "unsubscribe");
    assert.equal(b.result, "unresolved");
    assert.equal(b.outreachId, null);
    assert.equal(r.unreadableThreads, 1);
    assert.deepEqual(threadReads(f), ["thread-a", "thread-b", "thread-c"]);
  });

  test("the run report says so, with counts only", async () => {
    const f = mailbox("reply");
    f.google.threadAnswers.set("thread-b", FAILED_PRECONDITION);
    const r = await pollGmailInbox(readOnlyDb(), f.client, { apply: true, now: () => AT });
    const out = inboxLogLines(r, { apply: true, mailbox: f.client.account }).join("\n");
    assert.match(out, /Gmail couldn't read 1 thread: its message is left for review below, nothing recorded\./);
    assert.match(out, /Inbox needs operator review 1: .*\n {2}reply unresolved \(invalid_identity\)/);
    assert.doesNotMatch(out, /thread-b|owner@b\.example\.com|Re: Hello|Thanks|failedPrecondition/);
    assert.doesNotMatch(inboxLogLines({ ...r, unreadableThreads: 0 }, { apply: true, mailbox: f.client.account }).join("\n"), /couldn't read/);
  });
});

describe("failures that aren't about one thread still end the run", () => {
  const cases: [string, { status: number; body: unknown } | "network", GmailError["kind"]][] = [
    ["401 (authorization revoked mid-run)", { status: 401, body: { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } } }, "auth"],
    ["403 (permission)", { status: 403, body: { error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } } }, "quota"],
    ["429 (rate limit)", { status: 429, body: { error: { code: 429, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } } }, "quota"],
    ["503 (Gmail unavailable)", { status: 503, body: { error: { code: 503, message: "Backend Error", errors: [{ reason: "backendError" }] } } }, "server"],
    ["a network failure", "network", "network"],
  ];
  for (const [what, answer, kind] of cases) {
    test(`${what} on a thread read fails the run`, async () => {
      const f = mailbox("reply");
      f.google.threadAnswers.set("thread-b", answer);
      await assert.rejects(pollGmailInbox(readOnlyDb(), f.client, { apply: true, now: () => AT }), (e: unknown) => e instanceof GmailError && e.kind === kind);
      assert.ok(!threadReads(f).includes("thread-c"), "nothing after the systemic failure is processed");
    });
  }

  test("an authorization failure before any thread is read still fails the run", async () => {
    const f = mailbox("reply");
    f.google.validRefreshTokens.clear();
    f.google.expireAccessTokens();
    await assert.rejects(pollGmailInbox(readOnlyDb(), f.client, { apply: true }), (e: unknown) => e instanceof GmailError && e.kind === "auth");
  });
});
