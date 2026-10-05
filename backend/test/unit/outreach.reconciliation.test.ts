import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { buildRawMessage, lookupSentMessage } from "../../src/outreach/gmail.js";
import type { GmailMessage } from "../../src/outreach/gmail.js";
import type { OutgoingMessage, SentMessageQuery } from "../../src/outreach/sender.js";
import { aliasGoogle, fakeGmail, MAILBOX } from "../fixtures/fakeGmail.js";

const START = new Date("2026-10-05T10:00:00Z");
const AT = new Date(START.getTime() + 1_000);
const QUERY: SentMessageQuery = { outreachId: "0b7e9a52-4d1f-4c4e-9a7d-2f5b8c1d3e4f", fromEmail: MAILBOX, to: "service@shop.example", subject: "Hello Shop", text: "Hello\n\nExact reviewed text.", startedAt: START, checkedAt: new Date(AT.getTime() + 60_000) };
const message = (q: SentMessageQuery): OutgoingMessage => ({ outreachId: q.outreachId, idempotencyKey: q.outreachId, attempt: 1, firstAttemptAt: q.startedAt, to: q.to, from: { name: "Alex", email: q.fromEmail }, replyTo: q.fromEmail, subject: q.subject, text: q.text, headers: {} });
function fixture(q = QUERY) {
  const f = fakeGmail(aliasGoogle());
  f.google.sent.push({ id: "existing-gmail-id", threadId: "thread", marker: q.outreachId, raw: buildRawMessage(message(q)), internalDate: String(AT.getTime()) });
  return f;
}

describe("read-only Gmail recovery evidence", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  beforeEach(() => { calls = 0; globalThis.fetch = (async () => { calls++; throw new Error("Real network forbidden."); }) as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; assert.equal(calls, 0); });

  test("exact Sent evidence returns ID/time using only read-only Gmail calls", async () => {
    const f = fixture();
    assert.deepEqual(await lookupSentMessage(f.client, QUERY), { status: "found", providerMessageId: "existing-gmail-id", sentAt: AT });
    assert.equal(f.google.sendCalls.length, 0);
    assert.ok(f.google.calls.filter((c) => c.url.startsWith("https://gmail.googleapis.com/")).every((c) => c.method === "GET"));
  });
  test("UTF-8 subject and body match the actual encoded wire representation", async () => {
    const q = { ...QUERY, subject: "Hola — reparación", text: "Información\n\nGracias." };
    const f = fixture(q);
    assert.equal((await lookupSentMessage(f.client, q)).status, "found");
    assert.equal(f.google.sendCalls.length, 0);
  });
  for (const fault of ["missing_timestamp", "invalid_timestamp", "future_timestamp", "multipart", "invalid_utf8", "duplicate_to", "duplicate_marker", "additional_recipient", "cc", "missing_body", "wrong_marker"] as const) {
    test(`${fault} does not establish provider identity`, async () => {
      const f = fixture();
      const m = await f.client.getMessage("existing-gmail-id", "full");
      if (fault === "missing_timestamp") delete m.internalDate;
      if (fault === "invalid_timestamp") m.internalDate = "NaN";
      if (fault === "future_timestamp") m.internalDate = String(QUERY.checkedAt.getTime() + 3_600_000);
      if (fault === "multipart") m.payload!.parts = [{ mimeType: "text/html" }];
      if (fault === "invalid_utf8") m.payload!.body!.data = Buffer.from([0xff]).toString("base64url");
      if (fault === "duplicate_to") m.payload!.headers!.push({ name: "To", value: "other@example.com" });
      if (fault === "duplicate_marker") m.payload!.headers!.unshift({ name: "X-ReclaimBay-Outreach", value: "another-marker" });
      if (fault === "additional_recipient") m.payload!.headers!.find((h) => h.name === "To")!.value += ", other@example.com";
      if (fault === "cc") m.payload!.headers!.push({ name: "Cc", value: "other@example.com" });
      if (fault === "missing_body") delete m.payload!.body;
      if (fault === "wrong_marker") m.payload!.headers!.find((h) => h.name === "X-ReclaimBay-Outreach")!.value = "another-marker";
      f.google.messageOverrides.set(m.id, m);
      assert.equal((await lookupSentMessage(f.client, QUERY)).status, "not_found");
      assert.equal(f.google.sendCalls.length, 0);
    });
  }
  test("mailbox identity is reverified, not inferred from an earlier successful call", async () => {
    const f = fixture();
    await f.client.verifyIdentity();
    f.google.account = "other-account@example.com";
    await assert.rejects(lookupSentMessage(f.client, QUERY), /not .*the account/);
    assert.equal(f.google.sendCalls.length, 0);
  });
  test("a differently configured sender is unavailable before any lookup", async () => {
    const f = fixture();
    assert.deepEqual(await lookupSentMessage(f.client, { ...QUERY, fromEmail: "another@example.com" }), { status: "unavailable" });
    assert.equal(f.google.calls.length, 0);
  });
  test("a second page is checked before accepting the first matching marker", async () => {
    const f = fixture();
    const second: GmailMessage = { ...(await f.client.getMessage("existing-gmail-id", "full")), id: "second-id" };
    f.google.messageOverrides.set(second.id, second);
    let pages = 0;
    f.client.listMessages = async () => ++pages === 1 ? { messages: [{ id: "existing-gmail-id", threadId: "thread" }], nextPageToken: "next" } : { messages: [{ id: "second-id", threadId: "thread" }] };
    assert.deepEqual(await lookupSentMessage(f.client, QUERY), { status: "ambiguous" });
    assert.equal(pages, 2);
    assert.equal(f.google.sendCalls.length, 0);
  });
  test("an incomplete bounded search is unavailable, never a false unique match", async () => {
    const f = fixture();
    let pages = 0;
    f.client.listMessages = async () => ({ messages: [{ id: "existing-gmail-id", threadId: "thread" }], nextPageToken: String(++pages) });
    assert.deepEqual(await lookupSentMessage(f.client, QUERY), { status: "unavailable" });
    assert.equal(pages, 10);
    assert.equal(f.google.sendCalls.length, 0);
  });
  test("the same Gmail ID repeated across pages is one provider candidate", async () => {
    const f = fixture();
    let pages = 0;
    f.client.listMessages = async () => ({ messages: [{ id: "existing-gmail-id", threadId: "thread" }], ...(++pages === 1 ? { nextPageToken: "next" } : {}) });
    assert.equal((await lookupSentMessage(f.client, QUERY)).status, "found");
    assert.equal(pages, 2);
    assert.equal(f.google.sendCalls.length, 0);
  });
});
