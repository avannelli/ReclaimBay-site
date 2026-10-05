import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { issueToken } from "../../src/admin/auth.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { ingestEmailedUnsubscribe, listUnsubscribeReviews, resolveUnsubscribeReview } from "../../src/outreach/emailedUnsubscribe.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { inboxLogLines } from "../../src/outreach/inboxLog.js";
import { outreachMetrics } from "../../src/outreach/metrics.js";
import { createOutreachDraft, unsubscribeByToken } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { ACCOUNT, FakeGoogle, aliasGoogle, fakeGmail, inbound } from "../fixtures/fakeGmail.js";
import { freshDb, readyForm, skipReason, TEST_DATABASE_URL, truncate } from "./helpers.js";
import { OPTS } from "./outreachHelpers.js";

const AT = new Date("2026-10-15T12:00:00Z");
const SECRET = "unsubscribe-review-local-secret-0123456789";
const COOKIE = `rb_admin=${issueToken(SECRET)}`;
const FORM = { cookie: COOKIE, "content-type": "application/x-www-form-urlencoded" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

describe("ambiguous emailed unsubscribe (real PostgreSQL, fake Gmail)", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let seq = 0;
  const logs: string[] = [];
  const boxes: FakeGoogle[] = [];
  const realFetch = globalThis.fetch;
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0", ALLOWED_ORIGIN: OPTS.siteUrl }), db, true, { logStream: { write: (line) => { logs.push(line); } } });
  });
  beforeEach(async () => { await truncate(db); boxes.length = 0; logs.length = 0; globalThis.fetch = (async () => { throw new Error("Real network forbidden."); }) as typeof fetch; });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    assert.ok(boxes.every((b) => b.sendCalls.length === 0));
    assert.equal(await db.outreachControlChange.count(), 0, "fixtures never change sending controls");
  });
  after(async () => { await app?.close(); await db?.$disconnect(); });

  async function sent(email?: string) {
    const n = ++seq;
    const site = `https://unsubscribe${n}.example.com`;
    const p = await createProspect(db, readyForm({ website: site, businessName: `Unsubscribe ${n} Auto`, phoneSourceUrl: `${site}/contact`, emailSourceUrl: `${site}/contact`, email: email ?? `owner@unsubscribe${n}.example.com` }));
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    const draft = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    const o = await db.outreach.update({ where: { id: draft.id }, data: { status: "sent", sentAt: new Date(AT.getTime() - 60_000), openForProspectId: null, provider: "gmail", providerMessageId: `out-${draft.id}` } });
    await db.prospect.update({ where: { id: p.id }, data: { status: "contacted" } });
    return { p, o };
  }
  function mailbox(messages: Awaited<ReturnType<typeof sent>>[], from: string, id = "in-unsubscribe", at = AT) {
    const f = fakeGmail(aliasGoogle()); boxes.push(f.google);
    const thread = "shared-thread";
    for (const { o } of messages) f.google.sent.push({ id: o.providerMessageId!, threadId: thread, marker: o.id, raw: "" });
    f.google.inbox.push(inbound(id, thread, { From: from, Subject: "Re: unsubscribe" }, [], "Private inbound text", at));
    return f;
  }
  const ingest = (f: ReturnType<typeof mailbox>, apply = true) => pollGmailInbox(db, f.client, { apply, now: () => AT });
  const reviews = () => db.emailedUnsubscribeReview.findMany({ include: { candidates: true } });
  const row = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });
  const optoutEvents = () => db.outreachEvent.count({ where: { type: "unsubscribed" } });
  async function unchanged() {
    assert.equal(await db.emailSuppression.count(), 0);
    assert.equal(await optoutEvents(), 0);
    assert.equal(await db.outreachReply.count(), 0);
    assert.equal(await db.prospectStatusChange.count({ where: { toStatus: { in: ["do_not_contact", "engaged"] } } }), 0);
  }
  async function ambiguous() {
    const a = await sent(); const b = await sent();
    const f = mailbox([a, b], b.p.email!);
    assert.equal((await ingest(f)).items[0]!.result, "review_open");
    const [review] = await reviews();
    assert.ok(review);
    return { a, b, f, review };
  }

  for (const thread of [true, false]) {
    test(`correct expected identity (${thread ? "same thread" : "new thread"}) keeps exact-subject unsubscribe and duplicate semantics`, async () => {
      const a = await sent();
      const f = mailbox([a], `Owner <${a.p.email!.toUpperCase()}>`);
      if (!thread) f.google.inbox[0]!.threadId = "new-thread";
      assert.equal((await ingest(f)).items[0]!.result, "recorded");
      assert.equal((await ingest(f)).items[0]!.result, "duplicate");
      assert.equal(await db.emailSuppression.count(), 1);
      assert.equal(await optoutEvents(), 1);
      assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: a.p.id } })).status, "do_not_contact");
      assert.equal((await reviews()).length, 0);
    });
  }
  test("two workers process a legitimate unsubscribe once", async () => {
    const a = await sent(); const f = mailbox([a], a.p.email!);
    const results = await Promise.all([ingest(f), ingest(f)]);
    assert.deepEqual(results.map((r) => r.items[0]!.result).sort(), ["duplicate", "recorded"]);
    assert.equal(await db.emailSuppression.count(), 1); assert.equal(await optoutEvents(), 1);
  });
  test("different sender in one outbound thread creates an unassigned review, never suppression", async () => {
    const a = await sent(); const f = mailbox([a], "delegate@shop.example");
    const before = await row(a.o.id);
    const metrics = await outreachMetrics(db);
    const result = (await ingest(f)).items[0]!;
    assert.equal(result.result, "review_open"); assert.equal(result.outreachId, null);
    const [r] = await reviews();
    assert.equal(r!.reason, "sender_conflict"); assert.equal(r!.mailboxAccount, ACCOUNT);
    assert.equal(r!.senderEmail, "delegate@shop.example"); assert.equal(r!.receivedAt?.getTime(), AT.getTime());
    assert.deepEqual(r!.candidates.map((c) => c.outreachId), [a.o.id]);
    assert.deepEqual(await row(a.o.id), before); assert.deepEqual(await outreachMetrics(db), metrics);
    await unchanged();
  });
  test("A and B on the same thread, sender B: neither suppressed and both durable candidates visible", async () => {
    const { a, b, review } = await ambiguous();
    assert.equal(review.reason, "multiple_candidates");
    assert.deepEqual(review.candidates.map((c) => c.outreachId).sort(), [a.o.id, b.o.id].sort());
    for (const p of [a.p, b.p]) assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "contacted");
    await unchanged();
    const page = await app.inject({ url: "/admin/outreach/unsubscribe-reviews", headers: { cookie: COOKIE } });
    assert.equal(page.statusCode, 200); assert.match(page.body, /Automatic suppression was intentionally NOT performed/);
    for (const id of [a.o.id, b.o.id]) assert.ok(page.body.includes(`/admin/outreach/${id}`));
    assert.ok(page.body.includes(b.p.email!)); assert.ok(!page.body.includes("in-unsubscribe")); assert.ok(!page.body.includes(ACCOUNT));
    assert.ok(!page.body.includes("Private inbound text"));
    const control = await app.inject({ url: "/admin/outreach", headers: { cookie: COOKIE } });
    assert.match(control.body, /Emailed unsubscribe reviews \(1 open\)/);
  });
  test("thread A plus address candidate B is a conflict, never fallback selection of B", async () => {
    const a = await sent(); const b = await sent(); const f = mailbox([a], b.p.email!);
    await ingest(f);
    assert.equal((await reviews())[0]!.candidates.length, 2); await unchanged();
  });
  test("multiple address candidates in a new thread are reviewed, not selected by latest timestamp", async () => {
    const a = await sent("shared@shop.example"); const b = await sent();
    // Install legacy/conflicting evidence directly; new drafting already refuses shared-business recipients.
    await db.outreach.update({ where: { id: b.o.id }, data: { recipientEmail: a.p.email! } });
    const f = mailbox([], a.p.email!);
    await ingest(f);
    assert.deepEqual((await reviews())[0]!.candidates.map((c) => c.outreachId).sort(), [a.o.id, b.o.id].sort()); await unchanged();
  });
  test("multiple quoted markers are all candidates, even when the first marker and sender agree", async () => {
    const a = await sent(); const b = await sent(); const f = mailbox([], a.p.email!);
    f.google.inbox[0]!.payload!.parts = [{ mimeType: "text/plain", body: { data: Buffer.from(`X-ReclaimBay-Outreach: ${a.o.id}\nX-ReclaimBay-Outreach: ${b.o.id}`).toString("base64url") } }];
    await ingest(f);
    assert.deepEqual((await reviews())[0]!.candidates.map((c) => c.outreachId).sort(), [a.o.id, b.o.id].sort()); await unchanged();
  });
  test("a single quoted marker and expected identity still safely unsubscribe", async () => {
    const a = await sent(); const f = mailbox([], a.p.email!);
    f.google.inbox[0]!.payload!.parts = [{ mimeType: "text/plain", body: { data: Buffer.from(`X-ReclaimBay-Outreach: ${a.o.id}`).toString("base64url") } }];
    await db.outreach.update({ where: { id: a.o.id }, data: { providerMessageId: null } });
    assert.equal((await ingest(f)).items[0]!.result, "recorded");
    assert.equal(await db.emailSuppression.count(), 1); assert.equal((await reviews()).length, 0);
  });
  test("repeated and concurrent ambiguous ingestion creates one review; another inbound ID creates another", async () => {
    const { f } = await ambiguous();
    await Promise.all([ingest(f), ingest(f)]); await ingest(f);
    assert.equal((await reviews()).length, 1);
    f.google.inbox.push({ ...f.google.inbox[0]!, id: "second-inbound" });
    await ingest(f); assert.equal((await reviews()).length, 2); await unchanged();
  });
  test("two workers creating a previously unseen ambiguity create one durable review", async () => {
    const a = await sent(); const f = mailbox([a], "other@shop.example");
    await Promise.all([ingest(f), ingest(f)]);
    assert.equal((await reviews()).length, 1); assert.equal(await db.emailedUnsubscribeCandidate.count(), 1); await unchanged();
  });
  test("dry-run reports review without writing and without choosing an outreach", async () => {
    const a = await sent(); const f = mailbox([a], "other@shop.example");
    const result = (await ingest(f, false)).items[0]!;
    assert.equal(result.result, "would review"); assert.equal(result.outreachId, null);
    assert.equal((await reviews()).length, 0); await unchanged();
  });
  test("operator explicitly selects A; only A is suppressed and the decision is idempotent", async () => {
    const { a, b, f, review } = await ambiguous();
    assert.equal(await resolveUnsubscribeReview(db, review.id, "resolve", a.o.id, AT), "resolved");
    assert.equal(await resolveUnsubscribeReview(db, review.id, "resolve", a.o.id, AT), "already_processed");
    assert.equal((await ingest(f)).items[0]!.result, "review_resolved");
    assert.equal(await db.emailSuppression.count(), 1); assert.equal(await optoutEvents(), 1);
    assert.ok(await db.emailSuppression.findUnique({ where: { email: a.p.email! } }));
    assert.equal(await db.emailSuppression.findUnique({ where: { email: b.p.email! } }), null);
    const r = (await reviews())[0]!; assert.equal(r.state, "resolved"); assert.equal(r.resolvedOutreachId, a.o.id); assert.equal(r.resolvedAt?.getTime(), AT.getTime());
    assert.equal(await db.outreachReply.count(), 0);
  });
  test("operator cannot supply an unrelated message or replace a prior choice", async () => {
    const { a, b, review } = await ambiguous(); const outside = await sent();
    await assert.rejects(resolveUnsubscribeReview(db, review.id, "resolve", outside.o.id), /stored candidates/);
    await unchanged();
    await resolveUnsubscribeReview(db, review.id, "resolve", a.o.id);
    await assert.rejects(resolveUnsubscribeReview(db, review.id, "resolve", b.o.id), /already been processed/);
    await assert.rejects(resolveUnsubscribeReview(db, review.id, "dismiss", undefined), /already been processed/);
    assert.equal(await db.emailSuppression.count(), 1);
  });
  test("dismissal does not suppress, and ingestion cannot reopen or auto-resolve it", async () => {
    const { f, review } = await ambiguous();
    assert.equal(await resolveUnsubscribeReview(db, review.id, "dismiss", undefined, AT), "dismissed");
    assert.equal(await resolveUnsubscribeReview(db, review.id, "dismiss", undefined, AT), "already_processed");
    assert.equal((await ingest(f)).items[0]!.result, "review_dismissed");
    assert.equal((await reviews()).length, 1); await unchanged();
  });
  for (const stale of ["recipient", "prospect", "timestamp", "status", "deleted"] as const) {
    test(`operator selection revalidates stale ${stale} without suppression`, async () => {
      const { a, b, review } = await ambiguous();
      if (stale === "recipient") await db.outreach.update({ where: { id: a.o.id }, data: { recipientEmail: "changed@shop.example" } });
      if (stale === "prospect") await db.outreach.update({ where: { id: a.o.id }, data: { prospectId: b.p.id } });
      if (stale === "timestamp") await db.outreach.update({ where: { id: a.o.id }, data: { sentAt: new Date(AT.getTime() + 1) } });
      if (stale === "status") await db.outreach.update({ where: { id: a.o.id }, data: { status: "cancelled" } });
      if (stale === "deleted") await db.outreach.delete({ where: { id: a.o.id } });
      await assert.rejects(resolveUnsubscribeReview(db, review.id, "resolve", a.o.id), /no longer valid|stored candidates/);
      assert.equal((await reviews())[0]!.state, "open"); await unchanged();
    });
  }
  test("resolution and a paused Inbox reread commute without a second suppression", async () => {
    const { a, f, review } = await ambiguous();
    const reached = deferred(); const release = deferred(); const read = f.client.getThread.bind(f.client);
    f.client.getThread = async (id) => { const t = await read(id); reached.resolve(); await release.promise; return t; };
    const run = ingest(f); await reached.promise;
    await resolveUnsubscribeReview(db, review.id, "resolve", a.o.id, AT);
    release.resolve(); assert.equal((await run).items[0]!.result, "review_resolved");
    assert.equal(await db.emailSuppression.count(), 1); assert.equal(await optoutEvents(), 1); assert.equal((await reviews()).length, 1);
  });
  test("competing explicit resolutions cannot suppress both candidates", async () => {
    const { a, b, review } = await ambiguous();
    const results = await Promise.allSettled([resolveUnsubscribeReview(db, review.id, "resolve", a.o.id), resolveUnsubscribeReview(db, review.id, "resolve", b.o.id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(await db.emailSuppression.count(), 1); assert.equal(await optoutEvents(), 1);
  });
  test("two identical operator resolutions are idempotent", async () => {
    const { a, review } = await ambiguous();
    const results = await Promise.all([resolveUnsubscribeReview(db, review.id, "resolve", a.o.id), resolveUnsubscribeReview(db, review.id, "resolve", a.o.id)]);
    assert.deepEqual(results.sort(), ["already_processed", "resolved"]);
    assert.equal(await db.emailSuppression.count(), 1); assert.equal(await optoutEvents(), 1);
  });
  test("dismissal racing an explicit resolution records exactly one decision", async () => {
    const { a, review } = await ambiguous();
    const results = await Promise.allSettled([resolveUnsubscribeReview(db, review.id, "dismiss", undefined), resolveUnsubscribeReview(db, review.id, "resolve", a.o.id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const decided = (await reviews())[0]!;
    assert.notEqual(decided.state, "open");
    assert.equal(await db.emailSuppression.count(), decided.state === "resolved" ? 1 : 0);
    assert.equal(await optoutEvents(), decided.state === "resolved" ? 1 : 0);
  });
  test("attribution is decided after waiting for the send gate, with new candidates included", async () => {
    const a = await sent(); const b = await sent(); const f = mailbox([a], a.p.email!);
    const held = deferred(); const release = deferred(); const reached = deferred();
    const hold = db.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(73160201)`; held.resolve(); await release.promise; }, { timeout: 30_000 });
    await held.promise;
    const waiting = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction((tx) => work(new Proxy(tx, { get(t, k) {
        if (k !== "$executeRaw") return Reflect.get(t, k);
        return (...args: unknown[]) => { reached.resolve(); return Reflect.apply(t.$executeRaw, t, args); };
      } })));
    } });
    const run = pollGmailInbox(waiting, f.client, { apply: true });
    try { await reached.promise; await db.outreach.update({ where: { id: b.o.id }, data: { recipientEmail: a.p.email! } }); }
    finally { release.resolve(); await hold; }
    assert.equal((await run).items[0]!.result, "review_open");
    assert.equal((await reviews())[0]!.candidates.length, 2); await unchanged();
  });
  test("resolution transaction rollback undoes suppression, cancellation, status and review decision", async () => {
    const { a, review } = await ambiguous();
    const followup = (await createOutreachDraft(db, a.p.id, { ...OPTS, followUpOfId: a.o.id })).outreach;
    const failing = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async (tx) => { await work(tx); throw new Error("Force rollback."); });
    } });
    await assert.rejects(resolveUnsubscribeReview(failing, review.id, "resolve", a.o.id), /Force rollback/);
    assert.equal((await reviews())[0]!.state, "open"); assert.equal((await row(followup.id)).status, "draft"); await unchanged();
  });
  test("review and all candidate records roll back together", async () => {
    const a = await sent(); const f = mailbox([a], "other@shop.example");
    const failing = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async (tx) => { await work(tx); throw new Error("Force review rollback."); });
    } });
    await assert.rejects(pollGmailInbox(failing, f.client, { apply: true }), /Force review rollback/);
    assert.equal((await reviews()).length, 0); assert.equal(await db.emailedUnsubscribeCandidate.count(), 0); await unchanged();
  });
  test("ambiguous requests leave unsent followups alone; explicit valid resolution cancels only the selected prospect", async () => {
    const { a, b, review } = await ambiguous();
    const fa = (await createOutreachDraft(db, a.p.id, { ...OPTS, followUpOfId: a.o.id })).outreach;
    const fb = (await createOutreachDraft(db, b.p.id, { ...OPTS, followUpOfId: b.o.id })).outreach;
    assert.equal((await row(fa.id)).status, "draft"); assert.equal((await row(fb.id)).status, "draft");
    await resolveUnsubscribeReview(db, review.id, "resolve", a.o.id);
    assert.equal((await row(fa.id)).status, "cancelled"); assert.equal((await row(fb.id)).status, "draft");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: b.p.id } })).status, "contacted");
  });
  test("legitimate emailed unsubscribe retains unsent cancellation and permanent suppression", async () => {
    const a = await sent(); const followup = (await createOutreachDraft(db, a.p.id, { ...OPTS, followUpOfId: a.o.id })).outreach;
    const f = mailbox([a], a.p.email!); await ingest(f);
    assert.equal((await row(followup.id)).status, "cancelled");
    await assert.rejects(createOutreachDraft(db, a.p.id, { ...OPTS, followUpOfId: a.o.id }), /suppressed|Do not contact/i);
    assert.equal(await db.emailSuppression.count(), 1); assert.equal(await optoutEvents(), 1);
  });
  test("one-click unsubscribe remains independent and idempotent, without creating a review", async () => {
    const a = await sent();
    assert.equal((await unsubscribeByToken(db, a.o.unsubscribeToken!)).result, "recorded");
    assert.equal((await unsubscribeByToken(db, a.o.unsubscribeToken!)).result, "duplicate");
    assert.equal(await db.emailSuppression.count(), 1); assert.equal(await optoutEvents(), 1); assert.equal((await reviews()).length, 0);
  });
  for (const fault of ["duplicate_from", "missing_time", "historical_thread", "unverified_send"] as const) {
    test(`${fault} fails closed with an operator review`, async () => {
      const a = await sent(); const f = mailbox([a], a.p.email!);
      if (fault === "duplicate_from") f.google.inbox[0]!.payload!.headers!.push({ name: "From", value: "other@shop.example" });
      if (fault === "missing_time") delete f.google.inbox[0]!.internalDate;
      if (fault === "historical_thread") f.google.inbox[0]!.internalDate = String(a.o.sentAt!.getTime() - 1);
      if (fault === "unverified_send") await db.outreach.update({ where: { id: a.o.id }, data: { sentAt: null } });
      assert.equal((await ingest(f)).items[0]!.result, "review_open"); await unchanged();
    });
  }
  test("historical new-thread unsubscribe remains unmatched and cannot suppress", async () => {
    const a = await sent(); const f = mailbox([], a.p.email!, "old-unsubscribe", new Date(a.o.sentAt!.getTime() - 1));
    assert.equal((await ingest(f)).items[0]!.result, "unmatched"); assert.equal((await reviews()).length, 0); await unchanged();
  });
  test("normal delegated replies and multiple chronological OutreachReply records retain existing semantics", async () => {
    const a = await sent(); const f = mailbox([a], "delegate@shop.example");
    f.google.inbox[0]!.payload!.headers!.find((h) => h.name === "Subject")!.value = "Re: Hello";
    f.google.inbox.push(inbound("second-reply", "shared-thread", { From: "other@shop.example", Subject: "Re: Hello" }, [], "Second reply", new Date(AT.getTime() + 1)));
    const r = await ingest(f); assert.ok(r.items.every((i) => i.result === "recorded"));
    const replies = await db.outreachReply.findMany({ orderBy: { receivedAt: "asc" } });
    assert.deepEqual(replies.map((r) => r.gmailMessageId), ["in-unsubscribe", "second-reply"]);
    assert.equal((await row(a.o.id)).status, "replied"); assert.equal((await reviews()).length, 0); assert.equal(await db.emailSuppression.count(), 0);
    assert.equal((await outreachMetrics(db)).at(-1)!.replied, 1);
  });
  test("admin actions require authentication, same origin, explicit confirmation and a stored candidate", async () => {
    const { a, review } = await ambiguous(); const outside = await sent();
    const path = `/admin/outreach/unsubscribe-reviews/${review.id}`;
    assert.equal((await app.inject({ method: "POST", url: path, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `action=resolve&outreachId=${a.o.id}&confirm=1` })).statusCode, 303);
    assert.equal((await app.inject({ method: "POST", url: path, headers: { ...FORM, origin: "https://evil.example" }, payload: `action=resolve&outreachId=${a.o.id}&confirm=1` })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: path, headers: FORM, payload: `action=resolve&outreachId=${a.o.id}` })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: path, headers: FORM, payload: `action=resolve&outreachId=${outside.o.id}&candidates=${outside.o.id}&confirm=1` })).statusCode, 400);
    await unchanged();
    assert.equal((await app.inject({ method: "POST", url: path, headers: FORM, payload: `action=resolve&outreachId=${a.o.id}&confirm=1` })).statusCode, 303);
    assert.equal((await reviews())[0]!.state, "resolved");
  });
  test("admin dismissal is an explicit action with no suppression", async () => {
    const { review } = await ambiguous();
    const result = await app.inject({ method: "POST", url: `/admin/outreach/unsubscribe-reviews/${review.id}`, headers: FORM, payload: "action=dismiss&confirm=1" });
    assert.equal(result.statusCode, 303); assert.equal((await reviews())[0]!.state, "dismissed"); await unchanged();
  });
  test("body, token URLs and inbound IDs never reach stored review evidence or actual log destination", async () => {
    const a = await sent(); const f = mailbox([a], "other@shop.example");
    const token = /\/invite#([A-Za-z0-9_-]+)/.exec(a.o.body)![1]!;
    const privateText = `Private mail https://reclaimbay.com/invite#${token} https://api.example/u/${a.o.unsubscribeToken}`;
    f.google.inbox[0]!.snippet = privateText;
    f.google.inbox[0]!.payload!.body = { data: Buffer.from(privateText).toString("base64url") };
    const r = await ingest(f);
    for (const line of inboxLogLines(r, { apply: true, mailbox: ACCOUNT })) app.log.info(line);
    await app.inject({ url: "/admin/outreach/unsubscribe-reviews", headers: { cookie: COOKIE } });
    const stored = JSON.stringify(await reviews()); const projected = JSON.stringify(await listUnsubscribeReviews(db)); const output = logs.join("");
    for (const secret of ["Private mail", token, a.o.unsubscribeToken!, "https://api.example/u/"]) {
      assert.ok(!stored.includes(secret)); assert.ok(!projected.includes(secret)); assert.ok(!output.includes(secret));
    }
    assert.ok(!output.includes("in-unsubscribe")); assert.ok(!output.includes("other@shop.example")); assert.equal(await db.outreachReply.count(), 0);
  });
  test("an existing open review cannot become an automatic suppression when later evidence changes", async () => {
    const { a, f, review } = await ambiguous();
    await db.outreach.updateMany({ where: { id: { not: a.o.id } }, data: { providerMessageId: null, sentAt: null } });
    f.google.inbox[0]!.payload!.headers!.find((h) => h.name === "From")!.value = a.p.email!;
    assert.equal((await ingest(f)).items[0]!.result, "review_open"); assert.equal((await reviews())[0]!.id, review.id); await unchanged();
  });
  test("review identity is scoped to the authorized account, not the Send As alias", async () => {
    const a = await sent();
    const input = { mailboxAccount: ACCOUNT, gmailMessageId: "same-id", senderEmail: "other@shop.example", receivedAt: AT, threadMessageIds: [a.o.providerMessageId!], markerOutreachIds: [] };
    await ingestEmailedUnsubscribe(db, input, true);
    await ingestEmailedUnsubscribe(db, { ...input, mailboxAccount: "another-account@example.com" }, true);
    assert.equal((await reviews()).length, 2); await unchanged();
  });
});
