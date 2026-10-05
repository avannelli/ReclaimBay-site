import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { issueToken } from "../../src/admin/auth.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { inboxLogLines } from "../../src/outreach/inboxLog.js";
import { outreachMetrics } from "../../src/outreach/metrics.js";
import { listReplies, parseMessageFilters } from "../../src/outreach/operations.js";
import { classifyReply, createOutreachDraft, getOutreachDetail, outreachAttention, recordInboundReply, recordReply, unsubscribeByToken } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { ACCOUNT, type FakeGoogle, MAILBOX, aliasGoogle, fakeGmail, inbound } from "../fixtures/fakeGmail.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { OPTS } from "./outreachHelpers.js";

const SECRET = "integration-replies-secret-0123456789";
const COOKIE = `rb_admin=${issueToken(SECRET)}`;
const FORM = { cookie: COOKIE, "content-type": "application/x-www-form-urlencoded" };
const AT = new Date("2026-10-14T12:00:00Z");

describe("individual outreach replies (PostgreSQL and fake Gmail)", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let seq = 0;
  const lines: string[] = [];
  const mailboxes: FakeGoogle[] = [];
  const realFetch = globalThis.fetch;
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0", ALLOWED_ORIGIN: OPTS.siteUrl }), db, true, {
      logStream: { write: (line) => { lines.push(line); } },
    });
  });
  beforeEach(async () => {
    await truncate(db);
    lines.length = 0;
    mailboxes.length = 0;
    globalThis.fetch = (async () => { throw new Error("No real network is allowed in reply tests."); }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    assert.ok(mailboxes.every((g) => g.sendCalls.length === 0), "reading/classifying replies never sends, even through the fake provider");
    assert.equal(await db.outreachControlChange.count(), 0, "these fixtures never change the sending switch");
  });
  after(async () => { await app?.close(); await db?.$disconnect(); });

  async function drafted(email?: string) {
    const n = ++seq;
    const site = `https://reply${n}.example.com`;
    const p = await createProspect(db, readyForm({ website: site, phoneSourceUrl: `${site}/contact`, businessName: `Reply ${n} Auto`, email: email ?? `owner@reply${n}.example.com`, emailSourceUrl: `${site}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return { p, o: (await createOutreachDraft(db, p.id, OPTS)).outreach };
  }
  // Install an already-sent fixture directly. No queue, switch, or sender call.
  async function sent(email?: string) {
    const { p, o: draft } = await drafted(email);
    const o = await db.outreach.update({ where: { id: draft.id }, data: { status: "sent", openForProspectId: null, sentAt: new Date(AT.getTime() - 60_000), statusChangedAt: AT, provider: "gmail", providerMessageId: `out-${draft.id}` } });
    await db.prospect.update({ where: { id: p.id }, data: { status: "contacted" } });
    return { p, o };
  }
  function mailbox(o: { id: string; providerMessageId: string | null }) {
    const g = fakeGmail(aliasGoogle());
    mailboxes.push(g.google);
    const thread = `thread-${o.id}`;
    g.google.sent.push({ id: o.providerMessageId!, threadId: thread, marker: o.id, raw: "" });
    return { ...g, thread };
  }
  const replies = (outreachId: string) => db.outreachReply.findMany({ where: { outreachId }, orderBy: [{ receivedAt: "asc" }, { id: "asc" }] });
  const events = (outreachId: string) => db.outreachEvent.count({ where: { outreachId, type: "replied" } });
  const snapshot = async (id: string) => {
    const o = await db.outreach.findUniqueOrThrow({ where: { id } });
    return { status: o.status, repliedAt: o.repliedAt, replySummary: o.replySummary, replyOutcome: o.replyOutcome };
  };
  const ingest = (o: { id: string }, email: string, gmailMessageId: string, summary = "Reply", at = AT, mailboxAccount = ACCOUNT) =>
    recordInboundReply(db, { outreachId: o.id, fromEmail: email, mailboxAccount, gmailMessageId, summary, at });
  const classify = (outreachId: string, replyId: string, outcome: string) => classifyReply(db, outreachId, outcome, new Date(AT.getTime() + 30_000), replyId);
  const page = async (url: string) => {
    const res = await app.inject({ url, headers: { cookie: COOKIE } });
    assert.equal(res.statusCode, 200);
    return res.body;
  };

  test("the first Gmail reply stores the real inbound ID and authorized account, not the Send As alias", async () => {
    const { p, o } = await sent();
    const { google, client, thread } = mailbox(o);
    google.inbox.push(inbound("in-first", thread, { From: p.email!, Subject: "Re: Hello" }, [], "I'm interested", AT));
    const report = await pollGmailInbox(db, client, { apply: true });
    assert.equal(report.items[0]!.result, "recorded");
    const [r] = await replies(o.id);
    assert.ok(r);
    assert.equal(r.mailboxAccount, ACCOUNT);
    assert.notEqual(r.mailboxAccount, MAILBOX);
    assert.equal(r.gmailMessageId, "in-first");
    assert.notEqual(r.gmailMessageId, o.providerMessageId);
    assert.deepEqual([r.summary, r.outcome, r.classifiedAt, r.receivedAt], ["I'm interested", null, null, AT]);
    assert.deepEqual(await snapshot(o.id), { status: "replied", repliedAt: AT, replySummary: "I'm interested", replyOutcome: null });
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "engaged");
  });

  test("repeated polling deduplicates the same Gmail ID without additional reply events or state changes", async () => {
    const { p, o } = await sent();
    const { google, client, thread } = mailbox(o);
    google.inbox.push(inbound("in-repeat", thread, { From: p.email!, Subject: "Re: Hello" }, [], "First", AT));
    assert.equal((await pollGmailInbox(db, client, { apply: true })).items[0]!.result, "recorded");
    const state = await snapshot(o.id);
    const history = await db.prospectStatusChange.count();
    for (let i = 0; i < 3; i++) assert.equal((await pollGmailInbox(db, client, { apply: true })).items[0]!.result, "duplicate");
    assert.equal((await replies(o.id)).length, 1);
    assert.equal(await events(o.id), 1);
    assert.equal(await db.prospectStatusChange.count(), history);
    assert.deepEqual(await snapshot(o.id), state);
  });

  test("concurrent real inbox polls record one row/event for the same inbound ID", async () => {
    const { p, o } = await sent();
    const { google, client, thread } = mailbox(o);
    google.inbox.push(inbound("in-concurrent", thread, { From: p.email!, Subject: "Re: Hello" }, [], "First", AT));
    const results = await Promise.all(Array.from({ length: 4 }, () => pollGmailInbox(db, client, { apply: true })));
    assert.deepEqual(results.map((r) => r.items[0]!.result).sort(), ["duplicate", "duplicate", "duplicate", "recorded"]);
    assert.equal((await replies(o.id)).length, 1);
    assert.equal(await events(o.id), 1);
  });

  test("two distinct Gmail IDs racing both persist; identical timestamps and text do not collapse them", async () => {
    const { p, o } = await sent();
    const results = await Promise.all(["in-A", "in-B"].map((id) => ingest(o, p.email!, id, "Same text", AT)));
    assert.deepEqual(results.map((r) => r.result), ["recorded", "recorded"]);
    const rows = await replies(o.id);
    assert.equal(rows.length, 2);
    assert.equal(await events(o.id), 2);
    const firstEvent = await db.outreachEvent.findFirstOrThrow({ where: { outreachId: o.id, detail: { startsWith: "First reply " } } });
    const first = rows.find((r) => firstEvent.detail!.startsWith(`First reply ${r.id}: `))!;
    const later = rows.find((r) => r.id !== first.id)!;
    await classify(o.id, later.id, "other");
    assert.equal((await snapshot(o.id)).replyOutcome, null, "classifying the later reply first cannot replace the original snapshot");
    await classify(o.id, first.id, "interested");
    assert.equal((await snapshot(o.id)).replyOutcome, "interested");
    assert.equal((await replies(o.id)).filter((r) => r.classifiedAt).length, 2);
  });

  test("a later opt-out stays visible after Interested, is independently classified, suppresses and cancels unsent outreach", async () => {
    const shared = "owner@reply-optout.example.com";
    // Both drafts can exist before either business is contacted. Represent
    // the waiting queue directly, without queueing or using sending controls.
    const other = await drafted(shared);
    const open = other.o;
    await db.outreach.update({ where: { id: open.id }, data: { status: "queued", queuedAt: AT } });
    const { p, o } = await sent(shared);
    const { google, client, thread } = mailbox(o);
    google.inbox.push(inbound("in-interest", thread, { From: p.email!, Subject: "Re: Hello" }, [], "I'm interested", AT));
    await pollGmailInbox(db, client, { apply: true });
    const first = (await replies(o.id))[0]!;
    await classify(o.id, first.id, "interested");
    const original = await snapshot(o.id);

    google.inbox.push(inbound("in-no-thanks", thread, { From: p.email!, Subject: "Re: Hello" }, [], "Actually, never mind. No thanks.", new Date(AT.getTime() + 1_000)));
    const report = await pollGmailInbox(db, client, { apply: true });
    assert.equal(report.items.find((r) => r.gmailId === "in-no-thanks")!.result, "recorded");
    const second = (await replies(o.id))[1]!;
    assert.deepEqual([second.outcome, second.classifiedAt], [null, null]);
    assert.deepEqual(await snapshot(o.id), original);
    assert.equal((await outreachAttention(db)).replyCount, 1);
    const list = await page("/admin/outreach/messages?view=replies");
    assert.ok(list.includes("Actually, never mind. No thanks."));
    assert.ok(list.includes(`#reply-${second.id}`));
    assert.ok(list.indexOf("Actually, never mind. No thanks.") < list.indexOf("I'm interested".replaceAll("'", "&#39;")));
    const detail = await page(`/admin/outreach/${o.id}`);
    assert.ok(detail.indexOf(`id="reply-${first.id}"`) < detail.indexOf(`id="reply-${second.id}"`), "history is chronological");
    assert.ok(detail.includes(`name="replyId" value="${second.id}"`));
    assert.ok(!detail.includes(`name="replyId" value="${first.id}"`), "classified replies have no second classification form");
    const response = await app.inject({ method: "POST", url: `/admin/outreach/${o.id}/classify`, headers: FORM, payload: new URLSearchParams({ replyId: second.id, outcome: "do_not_contact" }).toString() });
    assert.equal(response.statusCode, 303);
    const classified = await db.outreachReply.findUniqueOrThrow({ where: { id: second.id } });
    assert.equal(classified.outcome, "do_not_contact");
    assert.ok(classified.classifiedAt);
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: p.email! } })).reason, "unsubscribed");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "do_not_contact");
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: open.id } })).status, "cancelled");
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: open.id } })).openForProspectId, null);
    assert.deepEqual(await snapshot(o.id), original);
    assert.equal((await outreachAttention(db)).replyCount, 0);

    google.inbox.push(inbound("in-third", thread, { From: p.email!, Subject: "Re: Hello" }, [], "One more question", new Date(AT.getTime() + 2_000)));
    await pollGmailInbox(db, client, { apply: true });
    const third = (await replies(o.id))[2]!;
    await classify(o.id, third.id, "interested");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "do_not_contact", "later interest never reverses permanent suppression");
    assert.equal(await db.emailSuppression.count({ where: { email: p.email! } }), 1);
    const n = await events(o.id);
    await pollGmailInbox(db, client, { apply: true });
    assert.equal((await replies(o.id)).length, 3);
    assert.equal(await events(o.id), n);
    const total = (await outreachMetrics(db)).find((r) => r.campaign === "all")!;
    assert.deepEqual([total.replied, total.positive, total.negative, total.replyingProspects], [1, 1, 0, 1], "three inbound messages still represent one replying outbound message/prospect");
  });

  test("classification requires the selected reply to belong to that message; ambiguous and unauthenticated requests cannot classify", async () => {
    const a = await sent();
    const b = await sent();
    await ingest(a.o, a.p.email!, "a-first");
    await ingest(a.o, a.p.email!, "a-later");
    await ingest(b.o, b.p.email!, "b-first");
    const rows = await replies(a.o.id);
    const foreign = (await replies(b.o.id))[0]!;
    await assert.rejects(classify(a.o.id, foreign.id, "do_not_contact"), /individual reply/);
    await assert.rejects(classifyReply(db, a.o.id, "interested"), /individual reply/);
    await assert.rejects(classify(a.o.id, "not-a-uuid", "interested"), /individual reply/);
    const anonymous = await app.inject({ method: "POST", url: `/admin/outreach/${a.o.id}/classify`, headers: { "content-type": FORM["content-type"] }, payload: `replyId=${rows[0]!.id}&outcome=do_not_contact` });
    assert.equal(anonymous.statusCode, 303);
    assert.equal(anonymous.headers.location, "/admin/login");
    const crossOrigin = await app.inject({ method: "POST", url: `/admin/outreach/${a.o.id}/classify`, headers: { ...FORM, origin: "https://attacker.example" }, payload: `replyId=${rows[0]!.id}&outcome=do_not_contact` });
    assert.equal(crossOrigin.statusCode, 403);
    const wrongType = await app.inject({ method: "POST", url: `/admin/outreach/${a.o.id}/classify`, headers: { cookie: COOKIE }, payload: { replyId: [rows[0]!.id], outcome: "do_not_contact" } });
    assert.equal(wrongType.statusCode, 400, "an array cannot be coerced into a selected reply ID");
    assert.ok((await replies(a.o.id)).every((r) => r.outcome === null));
    assert.equal(await db.emailSuppression.count(), 0);
  });

  test("concurrent classification of one reply applies one outcome/event and suppression once", async () => {
    const { p, o } = await sent();
    await ingest(o, p.email!, "classify-once");
    const r = (await replies(o.id))[0]!;
    const result = await Promise.allSettled(Array.from({ length: 3 }, () => classify(o.id, r.id, "do_not_contact")));
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(result.filter((r) => r.status === "rejected").every((r) => /already classified/.test(String(r.reason))));
    assert.equal(await events(o.id), 2, "one receipt and one classification event");
    assert.equal(await db.emailSuppression.count(), 1);
    assert.equal(await db.prospectStatusChange.count({ where: { prospectId: p.id, toStatus: "do_not_contact" } }), 1);
  });

  test("deduplication is mailbox-scoped and reports the original match even when competing matches race", async () => {
    const a = await sent();
    const b = await sent();
    const competing = await Promise.all([a, b].map((x) => ingest(x.o, x.p.email!, "one-inbound-id")));
    assert.deepEqual(competing.map((r) => r.result).sort(), ["duplicate", "recorded"]);
    assert.equal(competing[0]!.outreachId, competing[1]!.outreachId);
    assert.equal(await db.outreachReply.count(), 1);
    assert.equal((await ingest(a.o, a.p.email!, "one-inbound-id", "Different mailbox", AT, "second@reclaimbay.example")).result, "recorded");
    assert.equal(await db.outreachReply.count(), 2, "the same provider-local ID in a different mailbox is a distinct message");
    await assert.rejects(db.outreachReply.create({ data: { outreachId: a.o.id, mailboxAccount: ACCOUNT, gmailMessageId: "one-inbound-id", receivedAt: AT } }), /Unique constraint/, "the database enforces identity even if a writer bypasses the service");
  });

  test("a database failure in suppression rolls back reply classification, its event, and the original snapshot", async () => {
    const { p, o } = await sent();
    await ingest(o, p.email!, "rollback-reply");
    const r = (await replies(o.id))[0]!;
    const original = await snapshot(o.id);
    const name = `fail_reply_suppression_${randomUUID().replaceAll("-", "")}`;
    // A real PostgreSQL error after the reply CAS/event, not a mocked transaction.
    await db.$executeRawUnsafe(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test suppression failure'; END; $$`);
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER "${name}" BEFORE INSERT ON "EmailSuppression" FOR EACH ROW EXECUTE FUNCTION "${name}"()`);
      await assert.rejects(classify(o.id, r.id, "do_not_contact"), /test suppression failure/);
      const unchanged = await db.outreachReply.findUniqueOrThrow({ where: { id: r.id } });
      assert.deepEqual([unchanged.outcome, unchanged.classifiedAt], [null, null]);
      assert.deepEqual(await snapshot(o.id), original);
      assert.equal(await events(o.id), 1);
      assert.equal(await db.emailSuppression.count(), 0);
      assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "engaged");
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "EmailSuppression"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${name}"()`);
    }
    await classify(o.id, r.id, "do_not_contact");
    assert.equal(await db.emailSuppression.count(), 1, "a safe retry after the failed transaction applies once");
  });

  test("a later reply after Other is independently unclassified and does not reset prospect state", async () => {
    const { p, o } = await sent();
    await ingest(o, p.email!, "other-first");
    await classify(o.id, (await replies(o.id))[0]!.id, "other");
    const original = await snapshot(o.id);
    const history = await db.prospectStatusChange.count();
    await ingest(o, p.email!, "other-later", "No thanks", new Date(AT.getTime() + 1_000));
    assert.equal((await replies(o.id))[1]!.outcome, null);
    assert.deepEqual(await snapshot(o.id), original);
    assert.equal(await db.prospectStatusChange.count(), history);
    assert.equal((await outreachAttention(db)).replyCount, 1);
  });

  test("the additive migration preserves legacy fields and copies only known data with null Gmail identities", async () => {
    const migration = readFileSync(new URL("../../prisma/migrations/20261014120000_outreach_replies/migration.sql", import.meta.url), "utf8");
    const schema = `reply_migration_${randomUUID().replaceAll("-", "")}`;
    const id = randomUUID();
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      await tx.$executeRawUnsafe('CREATE TABLE "Outreach" ("id" UUID PRIMARY KEY, "repliedAt" TIMESTAMP(3), "replySummary" VARCHAR(2000), "replyOutcome" public."ReplyOutcome")');
      await tx.$executeRaw`INSERT INTO "Outreach" ("id", "repliedAt", "replySummary", "replyOutcome") VALUES (${id}::uuid, ${AT}, 'Known legacy summary', 'interested'::public."ReplyOutcome")`;
      for (const statement of migration.split(";").filter((s) => s.trim())) await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRaw<{ id: string; outreachId: string; receivedAt: Date; summary: string; outcome: string; mailboxAccount: string | null; gmailMessageId: string | null; classifiedAt: Date | null }[]>`SELECT * FROM "OutreachReply"`;
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0]!.id, id);
      assert.deepEqual([rows[0]!.outreachId, rows[0]!.receivedAt, rows[0]!.summary, rows[0]!.outcome, rows[0]!.mailboxAccount, rows[0]!.gmailMessageId, rows[0]!.classifiedAt], [id, AT, "Known legacy summary", "interested", null, null, null]);
      const legacy = await tx.$queryRaw<{ repliedAt: Date; replySummary: string; replyOutcome: string }[]>`SELECT "repliedAt", "replySummary", "replyOutcome" FROM "Outreach"`;
      assert.deepEqual(legacy, [{ repliedAt: AT, replySummary: "Known legacy summary", replyOutcome: "interested" }]);
      throw new Error("rollback migration test schema");
    }), /rollback migration test schema/);
  });

  test("legacy/manual identity-less replies remain reviewable without fabricated IDs and later Gmail replies retain the legacy snapshot", async () => {
    const { p, o } = await sent();
    // Model a row backfilled by the migration, with no historical first-reply marker.
    await db.outreach.update({ where: { id: o.id }, data: { status: "replied", repliedAt: AT, replySummary: "Legacy summary", replyOutcome: null } });
    const legacy = await db.outreachReply.create({ data: { outreachId: o.id, receivedAt: AT, summary: "Legacy summary" } });
    await ingest(o, p.email!, "after-legacy", "Later message", new Date(AT.getTime() + 1_000));
    const later = (await replies(o.id))[1]!;
    await classify(o.id, later.id, "other");
    assert.equal((await snapshot(o.id)).replyOutcome, null);
    await classify(o.id, legacy.id, "interested");
    assert.deepEqual(await snapshot(o.id), { status: "replied", repliedAt: AT, replySummary: "Legacy summary", replyOutcome: "interested" });
    assert.deepEqual([legacy.mailboxAccount, legacy.gmailMessageId, legacy.classifiedAt], [null, null, null]);

    const manual = await sent();
    await recordReply(db, manual.o.id, { summary: "Phone reply", outcome: "other" }, AT);
    await recordReply(db, manual.o.id, { summary: "Duplicate manual recording", outcome: "interested" }, AT);
    const [r] = await replies(manual.o.id);
    assert.deepEqual([r!.mailboxAccount, r!.gmailMessageId, r!.outcome, r!.classifiedAt], [null, null, "other", AT]);
    assert.equal((await replies(manual.o.id)).length, 1);
  });

  test("Gmail summaries remain bounded; malformed/partial identities are rejected without logging private input", async () => {
    const { p, o } = await sent();
    const { google, client, thread } = mailbox(o);
    google.inbox.push(inbound("long-reply", thread, { From: p.email!, Subject: "Re: Hello" }, [], "x".repeat(5_000), AT));
    await pollGmailInbox(db, client, { apply: true });
    assert.equal((await replies(o.id))[0]!.summary, "x".repeat(500));
    await assert.rejects(ingest(o, p.email!, "too-long", "x".repeat(2_001)), /Reply summary/);
    for (const identity of [{ mailboxAccount: ACCOUNT }, { gmailMessageId: "private-id" }, { mailboxAccount: ACCOUNT, gmailMessageId: "" }, { mailboxAccount: ACCOUNT, gmailMessageId: "x".repeat(201) }]) {
      await assert.rejects(recordInboundReply(db, { fromEmail: p.email!, outreachId: o.id, ...identity }), /Invalid inbound message identity/);
    }
    await assert.rejects(db.outreachReply.create({ data: { outreachId: o.id, receivedAt: AT, mailboxAccount: ACCOUNT } }), /OutreachReply_identity_pair/);
    assert.equal((await replies(o.id)).length, 1);
  });

  test("historical/new-thread mail stays unmatched; a resolved thread match with no outbound provider ID remains that match", async () => {
    const { p, o } = await sent();
    const { google, client, thread } = mailbox(o);
    google.inbox.push(inbound("old", "old-thread", { From: p.email!, Subject: "Hello" }, [], "Historical", new Date(AT.getTime() - 120_000)));
    google.inbox.push({ ...inbound("invalid-date", "another-thread", { From: p.email!, Subject: "Hello" }), internalDate: "9e99" });
    let report = await pollGmailInbox(db, client, { apply: true });
    assert.ok(report.items.every((r) => r.result === "unmatched"));
    assert.equal(await db.outreachReply.count(), 0);
    assert.equal(await events(o.id), 0);
    // The quoted marker is an authoritative match, even if no outbound Gmail
    // ID was stored; ingestion must not rematch this onto another message.
    await db.outreach.update({ where: { id: o.id }, data: { providerMessageId: null } });
    google.sent.length = 0;
    google.inbox.push(inbound("marked", thread, { From: "other@shop.example", Subject: "Re: Hello" }, [{ mimeType: "text/plain", text: `X-ReclaimBay-Outreach: ${o.id}` }], "Matched by marker", AT));
    report = await pollGmailInbox(db, client, { apply: true });
    assert.deepEqual([report.items[2]!.result, report.items[2]!.outreachId], ["recorded", o.id]);
    assert.equal((await replies(o.id))[0]!.gmailMessageId, "marked");
  });

  test("bounce and exact-subject unsubscribe remain separate from reply records; one-click opt-out remains idempotent", async () => {
    const a = await sent();
    const b = await sent();
    const { google, client, thread } = mailbox(a.o);
    google.sent.push({ id: b.o.providerMessageId!, threadId: `thread-${b.o.id}`, marker: b.o.id, raw: "" });
    google.inbox.push(inbound("bounce", thread, { From: "mailer-daemon@example.com", Subject: "Delivery failure" }, [{ mimeType: "message/delivery-status", text: `Action: failed\nStatus: 5.1.1\nFinal-Recipient: rfc822; ${a.p.email}\nDiagnostic-Code: smtp; No mailbox` }], "", AT));
    google.inbox.push(inbound("unsubscribe", `thread-${b.o.id}`, { From: b.p.email!, Subject: "Re: unsubscribe" }, [], "", AT));
    const first = await pollGmailInbox(db, client, { apply: true });
    assert.deepEqual(first.items.map((r) => [r.kind, r.result]), [["bounce", "recorded"], ["unsubscribe", "recorded"]]);
    assert.equal(await db.outreachReply.count(), 0);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: a.o.id } })).status, "bounced");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: a.p.email! } })).reason, "bounced");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: b.p.email! } })).reason, "unsubscribed");
    assert.ok((await pollGmailInbox(db, client, { apply: true })).items.every((r) => r.result === "duplicate"));
    const c = await sent();
    assert.equal((await unsubscribeByToken(db, c.o.unsubscribeToken!)).result, "recorded");
    assert.equal((await unsubscribeByToken(db, c.o.unsubscribeToken!)).result, "duplicate");
    assert.equal(await db.outreachReply.count(), 0);
  });

  test("real inbox/admin execution omits private reply data and tokens while retaining existing CLI account diagnostics", async () => {
    const { p, o } = await sent();
    const token = /\/invite#([A-Za-z0-9_-]{43})/.exec(o.body)![1]!;
    const sensitive = `Private reply text https://reclaimbay.com/invite#${token} https://api.reclaimbay.example/u/${o.unsubscribeToken}`;
    const { google, client, thread } = mailbox(o);
    google.inbox.push(inbound("private-gmail-message-id", thread, { From: p.email!, Subject: "Private inbox subject" }, [], sensitive, AT));
    const report = await pollGmailInbox(db, client, { apply: true });
    // Use the same authorized-account argument as readOutreachInbox.ts.
    // That configured operator identity is an existing CLI diagnostic;
    // incoming addresses, provider IDs, subjects and content are private.
    const cli = inboxLogLines(report, { apply: true, mailbox: client.account });
    for (const line of cli) app.log.info(line);
    const r = (await replies(o.id))[0]!;
    const detail = await page(`/admin/outreach/${o.id}`);
    assert.ok(!detail.includes(token));
    assert.equal((await getOutreachDetail(db, o.id))!.replies[0]!.summary, sensitive, "the record retains the bounded source summary; logs do not receive it");
    const invalid = await app.inject({ method: "POST", url: `/admin/outreach/${o.id}/classify`, headers: FORM, payload: new URLSearchParams({ replyId: r.id, outcome: sensitive }).toString() });
    assert.equal(invalid.statusCode, 400);
    await classify(o.id, r.id, "interested");
    const output = lines.join("");
    for (const secret of ["Private reply text", "Private inbox subject", "private-gmail-message-id", p.email!, token, o.unsubscribeToken!]) assert.ok(!output.includes(secret), "private inbox data is absent from the destination");
    assert.ok(cli[0]!.includes(ACCOUNT), "the existing configured-account CLI diagnostic is preserved");
    const requests = lines.map((line) => JSON.parse(line)).filter((record) => record.reqId);
    assert.ok(!JSON.stringify(requests).includes(ACCOUNT), "request execution never receives mailbox identity fields");
    assert.ok(output.includes("reply recorded"));
    assert.ok(output.includes("request completed"));
    assert.ok(output.includes(o.id), "safe internal outreach ID remains available");
    const listed = await listReplies(db, parseMessageFilters({ view: "replies" }));
    assert.ok(!JSON.stringify(listed).includes("private-gmail-message-id"), "the operations read does not expose Gmail identity");
  });
});
