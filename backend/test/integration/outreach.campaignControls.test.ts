import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createDb, type Db } from "../../src/db.js";
import { createProspect } from "../../src/prospects.js";
import { createOutreachDraft, queueOutreach, unsubscribeOutreach } from "../../src/outreach/service.js";
import { campaignControls, startCampaign } from "../../src/outreach/campaigns.js";
import { setDailyLimit, sendingPolicy } from "../../src/outreach/policy.js";
import { dailyCapacity, dispatchQueued, setSendingSwitch } from "../../src/outreach/dispatch.js";
import { addFixtureCollisionEvidence, freshDb, readyForm, skipReason, truncate, TEST_DATABASE_URL } from "./helpers.js";
import { CFG, OPTS, mockSender } from "./outreachHelpers.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { issueToken } from "../../src/admin/auth.js";

describe("persisted admin campaign controls", { skip: skipReason }, () => {
  let db: Db;
  let sequence = 0;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); sequence = 0; });
  after(async () => { await db?.$disconnect(); });
  const draft = async (email = `owner${++sequence}@shop.example.com`) => {
    const p = await createProspect(db, readyForm({ businessName: `Shop ${sequence}`, email, emailSourceUrl: "https://smithauto.example.com/contact" }));
    await addFixtureCollisionEvidence(db, p);
    return (await createOutreachDraft(db, p.id, OPTS)).outreach;
  };
  const start = (ids: string[], confirm = true) => startCampaign(db, { name: "Batch 1", messageIds: ids, confirm, reason: "Reviewed recipients and copy" }, CFG);
  const on = (sender: ReturnType<typeof mockSender>) => setSendingSwitch(db, true, "Explicit send authorization", CFG, sender);
  const clock = () => { let t = Date.now(); return () => new Date(t += 61_000); };

  test("25 persists through switch changes and legacy environment ceiling 1 is ignored", async () => {
    const o = await draft();
    await setDailyLimit(db, "25", "Launch ceiling");
    assert.equal((await sendingPolicy(db)).dailyLimit, 25);
    assert.equal((await sendingPolicy(db)).enabled, false);
    assert.equal(await db.outreach.count({ where: { status: "queued" } }), 0);
    assert.deepEqual(await dailyCapacity(db, { outreachDailyLimit: 1 }, new Date()), { used: 0, limit: 25, remaining: 25 });
    await start([o.id]);
    const sender = mockSender(); await on(sender);
    await setSendingSwitch(db, false, "Pause", CFG, sender);
    assert.equal((await sendingPolicy(db)).dailyLimit, 25);
  });

  test("saving a limit preserves OFF, active selection, and an empty queue; validation is atomic", async () => {
    await draft(); const p = await sendingPolicy(db);
    for (const value of [0, 26.5, "25garbage", 501]) await assert.rejects(setDailyLimit(db, value, "Invalid"));
    assert.deepEqual(await sendingPolicy(db), p);
    await setDailyLimit(db, 30, "Reviewed higher ceiling");
    const restarted = createDb(TEST_DATABASE_URL);
    try {
      assert.equal((await sendingPolicy(restarted)).dailyLimit, 30);
      assert.equal((await dailyCapacity(restarted, { outreachDailyLimit: 1 }, new Date())).limit, 30);
    } finally { await restarted.$disconnect(); }
    assert.equal((await sendingPolicy(db)).enabled, false);
    assert.equal((await sendingPolicy(db)).activeCampaignId, null);
    assert.equal(await db.outreach.count({ where: { status: "queued" } }), 0);
  });

  test("admin persists limits and explicitly approves only selected drafts; authentication and origin checks apply", async () => {
    const o = await draft(), outside = await draft();
    const secret = "campaign-test-secret-0123456789";
    const cfg = loadConfig({ DATABASE_URL: "postgres://localhost/test", ADMIN_SECRET: secret, TRUST_PROXY_HOPS: "0",
      OUTREACH_SENDING_ENABLED: "1", OUTREACH_SENDER_NAME: CFG.outreachSender.name!, OUTREACH_SENDER_EMAIL: CFG.outreachSender.email!,
      OUTREACH_POSTAL_ADDRESS: CFG.outreachSender.postalAddress!, PUBLIC_API_URL: CFG.publicApiUrl! });
    const sender = mockSender(), app = await buildApp(cfg, db, false, { outreachSender: sender });
    const headers = { cookie: `rb_admin=${issueToken(secret)}`, "content-type": "application/x-www-form-urlencoded" };
    const post = (url: string, values: Record<string, string>, extra: Record<string, string> = {}) => app.inject({ method: "POST", url, headers: { ...headers, ...extra }, payload: new URLSearchParams(values).toString() });
    try {
      assert.equal((await app.inject({ method: "POST", url: "/admin/outreach/limit", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "dailyLimit=25" })).statusCode, 303);
      assert.equal((await post("/admin/outreach/limit", { dailyLimit: "25", reason: "Launch" }, { origin: "https://evil.example" })).statusCode, 403);
      assert.equal((await post("/admin/outreach/limit", { dailyLimit: "25garbage", reason: "Bad" })).statusCode, 400);
      assert.equal((await post("/admin/outreach/limit", { dailyLimit: "25", reason: "Launch" })).statusCode, 303);
      assert.equal((await sendingPolicy(db)).dailyLimit, 25);
      assert.equal((await sendingPolicy(db)).enabled, false);
      assert.equal(await db.outreach.count({ where: { status: "queued" } }), 0);
      const values = { name: "Batch <1>", reason: "Reviewed", [`m:${o.id}`]: "1" };
      assert.equal((await post("/admin/outreach/campaign/start", values)).statusCode, 400);
      assert.equal((await post("/admin/outreach/campaign/start", { ...values, confirm: "1" })).statusCode, 303);
      assert.equal(await db.outreach.count({ where: { status: "queued" } }), 1);
      assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outside.id } })).status, "draft");
      const page = await app.inject({ method: "GET", url: "/admin/outreach", headers });
      assert.match(page.body, /name="dailyLimit"[^>]*value="25"/);
      assert.match(page.body, /Campaign: Batch &#60;1&#62;/);
      assert.equal((await sendingPolicy(db)).enabled, false);
      assert.equal(sender.calls.length, 0, "admin routes queue only; no provider call");
    } finally { await app.close(); }
  });

  test("one previously sent plus nine drafts gives 24 capacity; explicit start selects only those nine", async () => {
    const rows = []; for (let i = 0; i < 10; i++) rows.push(await draft());
    const outside = await draft();
    await db.outreach.update({ where: { id: rows[0]!.id }, data: { status: "sent", sentAt: new Date(), sendStartedAt: new Date(), sendAttempts: 1, openForProspectId: null } });
    const before = await dailyCapacity(db, { outreachDailyLimit: 1 }, new Date());
    assert.deepEqual(before, { used: 1, limit: 25, remaining: 24 });
    assert.ok(before.remaining >= 9);
    assert.equal(await db.outreach.count({ where: { status: "queued" } }), 0);
    await assert.rejects(start(rows.map(o => o.id), false), /explicitly confirm/);
    await start(rows.map(o => o.id));
    assert.equal(await db.outreach.count({ where: { status: "queued" } }), 9);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outside.id } })).status, "draft");
    assert.equal((await sendingPolicy(db)).enabled, false);
    assert.deepEqual((await campaignControls(db)).active, { id: (await sendingPolicy(db)).activeCampaignId, name: "Batch 1", approved: 10, drafts: 0, sent: 1, remaining: 9 });
  });

  test("hard ceiling: 25 accepted, 26th blocked, next rolling window resumes without a restart", async () => {
    const rows = []; for (let i = 0; i < 26; i++) rows.push(await draft());
    await start(rows.map(o => o.id)); const sender = mockSender(); await on(sender);
    const result = await dispatchQueued(db, { config: CFG, sender, limit: 26, now: clock() });
    assert.equal(result.sent.length, 25); assert.match(result.stoppedBecause!, /daily sending limit/);
    assert.equal(sender.calls.length, 25);
    assert.equal(await db.outreach.count({ where: { status: "queued" } }), 1);
    assert.equal((await dailyCapacity(db, CFG, new Date(Date.now() + 60 * 60_000))).remaining, 0);
    const later = new Date(Date.now() + 25 * 60 * 60_000);
    const next = await dispatchQueued(db, { config: CFG, sender, now: () => later });
    assert.equal(next.sent.length, 1); assert.equal(sender.calls.length, 26);
    await dispatchQueued(db, { config: CFG, sender, now: () => later });
    assert.equal(sender.calls.length, 26, "no duplicate campaign sends");
  });

  test("global OFF and absent explicit campaign approval both block provider calls", async () => {
    const o = await draft(); const sender = mockSender();
    await queueOutreach(db, o.id, CFG);
    await assert.rejects(on(sender), /Approve and start/);
    assert.ok((await dispatchQueued(db, { config: CFG, sender })).blockers.length);
    await start([o.id]);
    assert.ok((await dispatchQueued(db, { config: CFG, sender })).blockers.some(e => /switch is off/.test(e)));
    assert.equal(sender.calls.length, 0);
  });

  test("concurrent jobs cannot overshoot the 25th slot; lowering the limit preserves approval and switch state", async () => {
    const past = new Date(Date.now() - 120_000);
    for (let i = 0; i < 24; i++) {
      const o = await draft();
      await db.outreach.update({ where: { id: o.id }, data: { status: "sent", sentAt: past, sendStartedAt: past, sendAttempts: 1, openForProspectId: null } });
    }
    const a = await draft(), b = await draft(); await start([a.id, b.id]);
    const sender = mockSender(); await on(sender); const now = new Date();
    await Promise.all([1, 2, 3, 4].map(() => dispatchQueued(db, { config: CFG, sender, now: () => now })));
    assert.equal(sender.calls.length, 1);
    assert.deepEqual(await dailyCapacity(db, CFG, now), { used: 25, limit: 25, remaining: 0 });
    assert.equal(await db.outreach.count({ where: { status: "queued" } }), 1);
    const policy = await sendingPolicy(db);
    await setDailyLimit(db, 10, "Lower ceiling while preserving controls");
    assert.equal((await sendingPolicy(db)).enabled, policy.enabled);
    assert.equal((await sendingPolicy(db)).activeCampaignId, policy.activeCampaignId);
    assert.equal((await dailyCapacity(db, CFG, now)).remaining, 0);
    await dispatchQueued(db, { config: CFG, sender, now: () => new Date(now.getTime() + 61_000) });
    assert.equal(sender.calls.length, 1);
  });

  test("unapproved outside messages remain unsent even if separately queued", async () => {
    const approved = await draft(), outside = await draft();
    await start([approved.id]);
    await queueOutreach(db, outside.id, CFG);
    const sender = mockSender(); await on(sender);
    await dispatchQueued(db, { config: CFG, sender, now: clock() });
    assert.deepEqual(sender.calls.map(m => m.outreachId), [approved.id]);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outside.id } })).sendAttempts, 0);
  });

  test("duplicate recipients, missing messages, unqualified shops, suppression, and changed reviewed copy are blocked", async () => {
    const a = await draft("shared@shop.example.com"), b = await draft("shared@shop.example.com");
    await assert.rejects(start([a.id, b.id]), /recipient appears more than once/);
    await assert.rejects(start(["00000000-0000-4000-8000-000000000000"]), /no longer exists/);
    const p = await createProspect(db, { businessName: "Unqualified", email: "no@shop.example.com", emailSourceUrl: "https://smithauto.example.com/contact" });
    await assert.rejects(createOutreachDraft(db, p.id, OPTS), /Qualification/);
    await start([a.id]); const sender = mockSender(); await on(sender);
    await db.outreach.update({ where: { id: a.id }, data: { body: a.body + "\nUnreviewed addition" } });
    assert.match((await dispatchQueued(db, { config: CFG, sender })).stoppedBecause!, /changed after campaign approval/);
    assert.equal(sender.calls.length, 0);
    await setSendingSwitch(db, false, "Pause", CFG, sender);
    await unsubscribeOutreach(db, b.id, "Opt out");
    const blocked = await draft(); await unsubscribeOutreach(db, blocked.id, "Opt out");
    await assert.rejects(start([blocked.id]));
  });

  test("concurrent dispatchers enforce shared pacing and capacity; the next job continues", async () => {
    const a = await draft(), b = await draft(); await start([a.id, b.id]);
    const sender = mockSender(); await on(sender); const t = new Date();
    await Promise.all([1, 2, 3].map(() => dispatchQueued(db, { config: CFG, sender, now: () => t })));
    assert.equal(sender.calls.length, 1);
    const paced = await dispatchQueued(db, { config: CFG, sender, now: () => new Date(t.getTime() + 59_999) });
    assert.match(paced.stoppedBecause!, /Sending pace/);
    await dispatchQueued(db, { config: CFG, sender, now: () => new Date(t.getTime() + 60_000) });
    assert.equal(sender.calls.length, 2);
  });

  test("rejection consumes one unit; unknown outcome is not retried; provider-unavailable undoes the claim", async () => {
    const rejected = await draft(); await start([rejected.id]);
    let sender = mockSender(() => ({ status: "rejected", reason: "Refused", invalidRecipient: true })); await on(sender);
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal((await dailyCapacity(db, CFG, new Date())).used, 1);
    await dispatchQueued(db, { config: CFG, sender }); assert.equal(sender.calls.length, 1);
    assert.ok(await db.emailSuppression.findUnique({ where: { email: rejected.recipientEmail } }));
    await setSendingSwitch(db, false, "Pause", CFG, sender);
    const unknown = await draft(); await start([unknown.id]); sender = mockSender(() => ({ status: "uncertain", reason: "Timeout" })); await on(sender);
    await dispatchQueued(db, { config: CFG, sender, now: clock() }); await dispatchQueued(db, { config: CFG, sender, now: clock() });
    assert.equal(sender.calls.length, 1);
    await setSendingSwitch(db, false, "Pause", CFG, sender);
    await assert.rejects(start([unknown.id]), /cannot be restarted/);
    // A fresh isolated database avoids deliberately unresolved queued messages from the previous case.
    await truncate(db); const unavailable = await draft(); await start([unavailable.id]);
    sender = mockSender(() => ({ status: "unavailable", reason: "Authorization expired" })); await on(sender);
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal((await dailyCapacity(db, CFG, new Date())).used, 0);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: unavailable.id } })).sendAttempts, 0);
  });
});
