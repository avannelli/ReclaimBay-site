import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { revokeInvitationForOutreach } from "../../src/invitations/service.js";
import { confirmStuckSent, dailyCapacity, dispatchQueued, setSendingSwitch } from "../../src/outreach/dispatch.js";
import { gmailSender } from "../../src/outreach/gmail.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { reconcileSent } from "../../src/outreach/reconcile.js";
import { SEND_GATE } from "../../src/outreach/records.js";
import type { OutreachSender, SendResult } from "../../src/outreach/sender.js";
import { createOutreachDraft, discardOutreach, queueOutreach, recordReply } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { aliasGoogle, fakeGmail, inbound } from "../fixtures/fakeGmail.js";
import { freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS } from "./outreachHelpers.js";

const CLAIM = new Date(Date.now() - 3_600_000);
const SENT = new Date(CLAIM.getTime() + 1_000);
const LATER = new Date(CLAIM.getTime() + 3_600_000);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("provider-verified send reconciliation (real PostgreSQL, fake Gmail)", { skip: skipReason }, () => {
  let db: Db;
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => {
    await truncate(db);
    networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls++; throw new Error("Real network forbidden."); }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; assert.equal(networkCalls, 0); });
  after(async () => { await db?.$disconnect(); });

  let seq = 0;
  async function queued() {
    const g = fakeGmail(aliasGoogle());
    g.google.now = () => SENT;
    const cfg = { ...CFG, ...g.config, outreachDailyLimit: 1 };
    const sender = gmailSender(g.client);
    const n = ++seq;
    const website = `https://reconcile${n}.example.com`;
    const p = await createProspect(db, readyForm({ businessName: `Recovery ${n} Auto`, website, email: `service@reconcile${n}.example.com`, emailSourceUrl: `${website}/contact`, phoneSourceUrl: `${website}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${website}/about`, excerpt: "Family owned." });
    const { outreach: o } = await createOutreachDraft(db, p.id, OPTS);
    await queueOutreach(db, o.id, cfg);
    await setSendingSwitch(db, true, "Local integration test.", cfg, sender);
    return { ...g, cfg, sender, p, o };
  }
  const row = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });
  const sentEvents = (id: string) => db.outreachEvent.count({ where: { outreachId: id, type: "sent" } });

  /** Fail after acceptance, either before opening the result transaction or inside it. */
  function interruptedDb(rollback: boolean): Db {
    let transactions = 0;
    return new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (...args: unknown[]) => {
        if (++transactions !== 2) return Reflect.apply(target.$transaction, target, args);
        if (!rollback) throw new Error("Process interrupted after Gmail acceptance.");
        const work = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
        return target.$transaction(async (tx) => { await work(tx); throw new Error("Result transaction failed."); });
      };
    } });
  }
  async function unresolved(rollback = false) {
    const f = await queued();
    await assert.rejects(dispatchQueued(interruptedDb(rollback), { config: f.cfg, sender: f.sender, now: () => CLAIM }), /interrupted|transaction failed/);
    assert.equal((await row(f.o.id)).status, "queued");
    assert.equal((await row(f.o.id)).providerMessageId, null);
    assert.equal(f.google.sendCalls.length, 1);
    assert.equal(await sentEvents(f.o.id), 0);
    return f;
  }
  async function assertRecovered(f: Awaited<ReturnType<typeof queued>>) {
    const stored = await row(f.o.id);
    assert.equal(stored.status, "sent");
    assert.equal(stored.provider, "gmail");
    assert.equal(stored.providerMessageId, f.google.sent[0]!.id);
    assert.equal(stored.sentAt?.getTime(), SENT.getTime());
    assert.equal(stored.sendStartedAt?.getTime(), CLAIM.getTime());
    assert.equal(stored.sendAttempts, 1);
    assert.equal(stored.lastSendError, null);
    assert.equal(await sentEvents(f.o.id), 1);
    assert.equal((await dailyCapacity(db, f.cfg, LATER)).used, 1);
    assert.equal(f.google.sendCalls.length, 1);
  }

  for (const rollback of [false, true]) {
    test(`${rollback ? "result transaction rollback" : "crash immediately after acceptance"}: provider identity and time recovered without another send`, async () => {
      const f = await unresolved(rollback);
      await assert.rejects(confirmStuckSent(db, f.o.id, "gmail", LATER), /result has not been recorded/);
      await setSendingSwitch(db, false, "Keep sending off during recovery.", f.cfg, f.sender);
      assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "reconciled");
      await assertRecovered(f);
      assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "already_recorded");
      assert.equal(await sentEvents(f.o.id), 1);
    });
  }
  test("no provider evidence leaves the claim unresolved and never retries it", async () => {
    const f = await unresolved();
    f.google.sent.length = 0;
    const before = await row(f.o.id);
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "not_found");
    assert.deepEqual(await row(f.o.id), before);
    await dispatchQueued(db, { config: f.cfg, sender: f.sender, now: () => LATER });
    assert.equal(f.google.sendCalls.length, 1);
    assert.equal(await sentEvents(f.o.id), 0);
  });
  test("multiple marker candidates are ambiguous, including copies with different bodies", async () => {
    const f = await unresolved();
    const original = f.google.sent[0]!;
    f.google.sent.push({ ...original, id: "another-id", raw: "" });
    const before = await row(f.o.id);
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "ambiguous");
    assert.deepEqual(await row(f.o.id), before);
    assert.equal(await sentEvents(f.o.id), 0);
    assert.equal(f.google.sendCalls.length, 1);
  });
  for (const mismatch of ["recipient", "sender", "body", "subject", "timestamp", "label"] as const) {
    test(`a marker with mismatched ${mismatch} cannot verify the send`, async () => {
      const f = await unresolved();
      const sent = f.google.sent[0]!;
      const m = await f.client.getMessage(sent.id, "full");
      const h = (name: string, value: string) => { m.payload!.headers!.find((x) => x.name === name)!.value = value; };
      if (mismatch === "recipient") h("To", "different@shop.example");
      if (mismatch === "sender") h("From", "different@reclaimbay.example");
      if (mismatch === "subject") h("Subject", "Another subject");
      if (mismatch === "body") m.payload!.body!.data = Buffer.from("Same subject, different body.").toString("base64url");
      if (mismatch === "timestamp") m.internalDate = String(CLAIM.getTime() - 3_600_000);
      if (mismatch === "label") m.labelIds = ["DRAFT"];
      f.google.messageOverrides.set(sent.id, m);
      const before = await row(f.o.id);
      assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "not_found");
      assert.deepEqual(await row(f.o.id), before);
      assert.equal(f.google.sendCalls.length, 1);
    });
  }
  test("lookup failure is safe and does not leak provider diagnostics", async () => {
    const f = await unresolved();
    const before = await row(f.o.id);
    const sender = { ...f.sender, lookupSent: async () => { throw new Error(`private content ${f.o.body}`); } };
    assert.equal(await reconcileSent(db, f.o.id, sender, LATER), "unavailable");
    assert.deepEqual(await row(f.o.id), before);
    assert.equal(f.google.sendCalls.length, 1);
  });
  test("two concurrent reconciliations record one send and consume capacity once", async () => {
    const f = await unresolved();
    const results = await Promise.all([reconcileSent(db, f.o.id, f.sender, LATER), reconcileSent(db, f.o.id, f.sender, LATER)]);
    assert.deepEqual(results.sort(), ["already_recorded", "reconciled"]);
    await assertRecovered(f);
  });
  test("a provider ID already owned by another outreach message is ambiguous", async () => {
    const f = await unresolved();
    const other = await queued();
    await db.outreach.update({ where: { id: other.o.id }, data: { status: "sent", openForProspectId: null, sentAt: SENT, provider: "gmail", providerMessageId: f.google.sent[0]!.id } });
    const before = await row(f.o.id);
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "ambiguous");
    assert.deepEqual(await row(f.o.id), before);
    assert.equal(await sentEvents(f.o.id), 0);
    assert.equal(f.google.sendCalls.length, 1);
  });
  test("another reconciliation wins even when this lookup later fails", async () => {
    const f = await unresolved();
    const reached = deferred<void>();
    const release = deferred<void>();
    const sender: OutreachSender = { ...f.sender, lookupSent: async () => { reached.resolve(); await release.promise; throw new Error("Lookup failed."); } };
    const run = reconcileSent(db, f.o.id, sender, LATER);
    await reached.promise;
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "reconciled");
    release.resolve();
    assert.equal(await run, "already_recorded");
    await assertRecovered(f);
  });
  test("failed messages and new drafts cannot be reconciled", async () => {
    const f = await queued();
    f.google.sendAnswers = [{ status: 400, body: { error: { message: "Invalid message." } } }];
    await dispatchQueued(db, { config: f.cfg, sender: f.sender, now: () => CLAIM });
    const before = await row(f.o.id);
    assert.equal(before.status, "failed");
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "ineligible");
    assert.deepEqual(await row(f.o.id), before);
    const draft = (await createOutreachDraft(db, f.p.id, OPTS)).outreach;
    assert.equal(await reconcileSent(db, draft.id, f.sender, LATER), "ineligible");
    assert.equal(f.google.sent.length, 0);
    assert.equal(f.google.sendCalls.length, 1);
  });
  for (const order of ["manual_first", "reconciliation_first"] as const) {
    test(`manual confirmation race (${order}) preserves provider ID/time and one event`, async () => {
      const f = await queued();
      f.google.sendAnswers = ["network"];
      await dispatchQueued(db, { config: f.cfg, sender: f.sender, now: () => CLAIM });
      if (order === "manual_first") {
        const reached = deferred<void>();
        const release = deferred<void>();
        const sender: OutreachSender = { ...f.sender, lookupSent: async (q) => { const evidence = await f.sender.lookupSent!(q); reached.resolve(); await release.promise; return evidence; } };
        const run = reconcileSent(db, f.o.id, sender, LATER);
        await reached.promise;
        await confirmStuckSent(db, f.o.id, "gmail", LATER);
        release.resolve();
        assert.equal(await run, "reconciled");
      } else {
        assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "reconciled");
        assert.equal((await confirmStuckSent(db, f.o.id, "gmail", LATER)).changed, false);
      }
      await assertRecovered(f);
    });
  }
  for (const outcome of ["accepted", "rejected", "uncertain", "unavailable"] as const) {
    test(`a late dispatcher ${outcome} cannot overwrite verified evidence`, async () => {
      const f = await queued();
      const reached = deferred<void>();
      const response = deferred<SendResult>();
      const sender: OutreachSender = { ...f.sender, send: async (m) => { await f.sender.send(m); reached.resolve(); return response.promise; } };
      const run = dispatchQueued(db, { config: f.cfg, sender, now: () => CLAIM });
      await reached.promise;
      const competing = await dispatchQueued(db, { config: f.cfg, sender: f.sender, now: () => LATER });
      assert.equal(competing.sent.length, 0);
      assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "reconciled");
      response.resolve(outcome === "accepted" ? { status: "accepted", providerMessageId: f.google.sent[0]!.id } : outcome === "rejected" ? { status: "rejected", reason: "Late rejection.", invalidRecipient: true } : { status: outcome, reason: "Late provider response." });
      const report = await run;
      assert.equal(report.sent.length, 1);
      assert.deepEqual([report.failed, report.uncertain, report.unavailable], [[], [], []]);
      assert.equal(await db.emailSuppression.count(), 0);
      await assertRecovered(f);
    });
  }
  test("dispatcher completion during lookup is returned idempotently", async () => {
    const f = await queued();
    const reached = deferred<void>();
    const response = deferred<void>();
    const sender: OutreachSender = { ...f.sender, send: async (m) => { const r = await f.sender.send(m); reached.resolve(); await response.promise; return r; } };
    const dispatch = dispatchQueued(db, { config: f.cfg, sender, now: () => SENT });
    await reached.promise;
    const lookupReached = deferred<void>();
    const release = deferred<void>();
    const observer: OutreachSender = { ...f.sender, lookupSent: async (q) => { const r = await f.sender.lookupSent!(q); lookupReached.resolve(); await release.promise; return r; } };
    const reconcile = reconcileSent(db, f.o.id, observer, LATER);
    await lookupReached.promise;
    response.resolve(); await dispatch;
    release.resolve();
    assert.equal(await reconcile, "already_recorded");
    assert.equal(await sentEvents(f.o.id), 1);
    assert.equal(f.google.sendCalls.length, 1);
  });
  test("cancelled messages are not reopened, including cancellation during lookup", async () => {
    const f = await unresolved();
    const reached = deferred<void>();
    const release = deferred<void>();
    const sender: OutreachSender = { ...f.sender, lookupSent: async (q) => { const r = await f.sender.lookupSent!(q); reached.resolve(); await release.promise; return r; } };
    const run = reconcileSent(db, f.o.id, sender, LATER);
    await reached.promise;
    await discardOutreach(db, f.o.id, "Discard interrupted attempt.", LATER);
    release.resolve();
    assert.equal(await run, "ineligible");
    const before = await row(f.o.id);
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "ineligible");
    assert.deepEqual(await row(f.o.id), before);
    assert.equal(before.status, "cancelled");
    assert.equal(await sentEvents(f.o.id), 0);
  });
  test("revocation after a claim stays revoked while historical provider evidence is recovered", async () => {
    const f = await unresolved();
    await revokeInvitationForOutreach(db, f.o.id, "Revoked after claim.", LATER);
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "reconciled");
    assert.ok((await db.invitation.findUniqueOrThrow({ where: { outreachId: f.o.id } })).revokedAt);
    await assertRecovered(f);
  });
  test("an unclaimed revoked queue cannot be reconciled or sent", async () => {
    const f = await queued();
    await revokeInvitationForOutreach(db, f.o.id, "Stop before claim.", LATER);
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "ineligible");
    await dispatchQueued(db, { config: f.cfg, sender: f.sender, now: () => CLAIM });
    assert.equal((await row(f.o.id)).status, "cancelled");
    assert.equal(f.google.sendCalls.length, 0);
  });
  test("an existing provider ID causes no lookup, state change, or duplicate event", async () => {
    const f = await queued();
    await dispatchQueued(db, { config: f.cfg, sender: f.sender, now: () => CLAIM });
    const before = await row(f.o.id);
    const sender: OutreachSender = { ...f.sender, lookupSent: async () => { throw new Error("Must not look up."); } };
    assert.equal(await reconcileSent(db, f.o.id, sender, LATER), "already_recorded");
    assert.deepEqual(await row(f.o.id), before);
    assert.equal(await sentEvents(f.o.id), 1);
  });
  for (const kind of ["reply", "unsubscribe"] as const) {
    for (const threaded of [true, false]) {
      test(`${kind} received before reconciliation recovers through ${threaded ? "Gmail ID" : "actual send-time address matching"}`, async () => {
        const f = await unresolved();
        const original = f.google.sent[0]!;
        const received = new Date(SENT.getTime() + 5_000);
        f.google.inbox.push(inbound(`in-${kind}`, threaded ? original.threadId : "new-thread", { From: f.p.email!, Subject: kind === "reply" ? "Re: Hello" : "unsubscribe" }, [], "Synthetic reply", received));
        assert.equal((await pollGmailInbox(db, f.client, { apply: true })).items[0]!.result, "unmatched");
        assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "reconciled");
        const first = await pollGmailInbox(db, f.client, { apply: true });
        assert.equal(first.items[0]!.outreachId, f.o.id);
        assert.equal(first.items[0]!.result, "recorded");
        assert.equal((await pollGmailInbox(db, f.client, { apply: true })).items[0]!.result, "duplicate");
        assert.equal(await sentEvents(f.o.id), 1);
        if (kind === "reply") assert.equal(await db.outreachReply.count({ where: { outreachId: f.o.id } }), 1);
        else assert.ok(await db.emailSuppression.findUnique({ where: { email: f.p.email! } }));
        assert.equal(f.google.sendCalls.length, 1);
      });
    }
  }
  test("reconciliation waits for the send gate and performs provider reads outside it", async () => {
    const f = await unresolved();
    const acquired = deferred<void>();
    const release = deferred<void>();
    const hold = db.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEND_GATE})`; acquired.resolve(); await release.promise; }, { timeout: 30_000 });
    await acquired.promise;
    const lookup = deferred<void>();
    const sender: OutreachSender = { ...f.sender, lookupSent: async (q) => { const r = await f.sender.lookupSent!(q); lookup.resolve(); return r; } };
    const run = reconcileSent(db, f.o.id, sender, LATER);
    try {
      await lookup.promise; // Gmail lookup completes even while another session holds the gate.
      const deadline = Date.now() + 10_000;
      while (!(await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${SEND_GATE} AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0]!.n) {
        if (Date.now() > deadline) throw new Error("Reconciliation did not wait for gate.");
        await delay(5);
      }
      assert.equal((await row(f.o.id)).status, "queued");
    } finally { release.resolve(); await hold; }
    assert.equal(await run, "reconciled");
    await assertRecovered(f);
  });
  test("recording also waits for a separately held message row lock", async () => {
    const f = await unresolved();
    const acquired = deferred<void>();
    const release = deferred<void>();
    const hold = db.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "Outreach" WHERE id = ${f.o.id}::uuid FOR UPDATE`; acquired.resolve(); await release.promise; }, { timeout: 30_000 });
    await acquired.promise;
    const run = reconcileSent(db, f.o.id, f.sender, LATER);
    try {
      const deadline = Date.now() + 10_000;
      while (!(await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`)[0]!.n) {
        if (Date.now() > deadline) throw new Error("Reconciliation did not wait for row lock.");
        await delay(5);
      }
      assert.equal(await sentEvents(f.o.id), 0);
    } finally { release.resolve(); await hold; }
    assert.equal(await run, "reconciled");
    await assertRecovered(f);
  });
  test("repair of a manual send preserves an existing classified reply and suppression", async () => {
    const f = await queued();
    f.google.sendAnswers = ["network"];
    await dispatchQueued(db, { config: f.cfg, sender: f.sender, now: () => CLAIM });
    await confirmStuckSent(db, f.o.id, "gmail", LATER);
    await recordReply(db, f.o.id, { outcome: "do_not_contact", summary: "Please stop." }, LATER);
    const before = await row(f.o.id);
    assert.equal(await reconcileSent(db, f.o.id, f.sender, LATER), "reconciled");
    const after = await row(f.o.id);
    assert.equal(after.status, "replied");
    assert.equal(after.replyOutcome, before.replyOutcome);
    assert.equal(after.repliedAt?.getTime(), before.repliedAt?.getTime());
    assert.equal(after.sentAt?.getTime(), SENT.getTime());
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: f.p.id } })).status, "do_not_contact");
    assert.ok(await db.emailSuppression.findUnique({ where: { email: f.p.email! } }));
    assert.equal(await sentEvents(f.o.id), 1);
    assert.equal(f.google.sendCalls.length, 1);
  });
  test("admin recovery is authenticated, same-origin, explicit, and works with sending OFF", async () => {
    const f = await unresolved();
    const logs: string[] = [];
    const config = { ...loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ADMIN_SECRET: "recovery-test-secret-at-least-24", ALLOWED_ORIGIN: "https://reclaimbay.com" }), ...f.cfg };
    await setSendingSwitch(db, false, "Keep sending off.", f.cfg, f.sender);
    const app = await buildApp(config, db, true, { googleFetch: f.google.fetch, outreachSender: f.sender, logStream: { write: (line: string) => { logs.push(line); } } });
    try {
      const path = `/admin/outreach/${f.o.id}/reconcile-sent`;
      assert.equal((await app.inject({ method: "POST", url: path })).statusCode, 303);
      assert.equal((await row(f.o.id)).status, "queued");
      const login = await app.inject({ method: "POST", url: "/admin/login", payload: "secret=recovery-test-secret-at-least-24", headers: { "content-type": "application/x-www-form-urlencoded" } });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const page = await app.inject({ url: `/admin/outreach/${f.o.id}`, headers: { cookie } });
      assert.match(page.body, /Verify with Gmail/);
      assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie, origin: "https://evil.example" } })).statusCode, 403);
      const lookup = f.sender.lookupSent!;
      f.sender.lookupSent = async () => { throw new Error(`Sensitive provider diagnostic: ${f.o.body}`); };
      assert.match(String((await app.inject({ method: "POST", url: path, headers: { cookie } })).headers.location), /done=unavailable$/);
      assert.equal((await row(f.o.id)).status, "queued");
      f.sender.lookupSent = lookup;
      const run = await app.inject({ method: "POST", url: path, headers: { cookie } });
      assert.equal(run.statusCode, 303);
      assert.match(String(run.headers.location), /done=reconciled$/);
      assert.match((await app.inject({ url: String(run.headers.location), headers: { cookie } })).body, /Provider send verified/);
      assert.match(String((await app.inject({ method: "POST", url: path, headers: { cookie } })).headers.location), /done=already_recorded$/);
      const output = logs.join("");
      assert.ok(!output.includes("Sensitive provider diagnostic"));
      assert.ok(!output.includes(f.o.body));
      assert.ok(!output.includes(f.o.unsubscribeToken!));
      assert.ok(!output.includes(/\/invite#([A-Za-z0-9_-]+)/.exec(f.o.body)![1]!));
      await assertRecovered(f);
    } finally { await app.close(); }
  });
});
