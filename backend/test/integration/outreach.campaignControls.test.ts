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
import { browserCampaignPayload, FORM_BROWSER } from "./browserForm.js";

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
  const drafts = async (n: number) => { const rows = []; for (let i = 0; i < n; i++) rows.push(await draft()); return rows; };
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

  const adminApp = async () => {
    const secret = "campaign-test-secret-0123456789";
    const cfg = loadConfig({ DATABASE_URL: "postgres://localhost/test", ADMIN_SECRET: secret, TRUST_PROXY_HOPS: "0",
      OUTREACH_SENDING_ENABLED: "1", OUTREACH_SENDER_NAME: CFG.outreachSender.name!, OUTREACH_SENDER_EMAIL: CFG.outreachSender.email!,
      OUTREACH_POSTAL_ADDRESS: CFG.outreachSender.postalAddress!, PUBLIC_API_URL: CFG.publicApiUrl! });
    const sender = mockSender(), app = await buildApp(cfg, db, false, { outreachSender: sender });
    const headers = { cookie: `rb_admin=${issueToken(secret)}`, "content-type": "application/x-www-form-urlencoded" };
    const post = (url: string, values: Record<string, string> | URLSearchParams, extra: Record<string, string> = {}) => app.inject({ method: "POST", url, headers: { ...headers, ...extra }, payload: new URLSearchParams(values).toString() });
    const controlPage = async () => (await app.inject({ method: "GET", url: "/admin/outreach", headers })).body;
    return { app, sender, headers, post, controlPage };
  };
  /** The campaign form's message checkboxes as a browser submits them: a missing value attribute is sent as "on". */
  const campaignCheckboxes = (page: string) => [...page.matchAll(/<input type="checkbox" name="(m:[^"]+)"([^>]*)>/g)]
    .map(([, name, attrs]) => ({ name: name!, value: /\bvalue="([^"]*)"/.exec(attrs!)?.[1] ?? "on", checked: /\bchecked\b/.test(attrs!) }));

  test("admin persists limits and explicitly approves only selected drafts; authentication and origin checks apply", async () => {
    const o = await draft(), outside = await draft();
    const { app, sender, headers, post } = await adminApp();
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

  test("admin form transmits nine selected existing messages by ID and queues exactly those nine", async () => {
    const rows = await drafts(9);
    const outside = await draft();
    const { app, sender, post, controlPage } = await adminApp();
    try {
      const boxes = campaignCheckboxes(await controlPage());
      assert.equal(boxes.length, 10);
      assert.ok(boxes.every(b => b.value === "1" && !b.checked), "every message checkbox submits 1 and none is preselected");
      const selected = boxes.filter(b => rows.some(o => b.name === `m:${o.id}`));
      assert.equal(selected.length, 9);
      const payload = new URLSearchParams({ name: "Batch 1 — October 2026", reason: "Reviewed recipients and copy" });
      for (const b of selected) payload.append(b.name, b.value);
      payload.append("confirm", "1");
      const res = await post("/admin/outreach/campaign/start", payload);
      assert.equal(res.statusCode, 303, res.body);
      assert.equal(res.headers.location, "/admin/outreach?done=campaign_started");
      assert.deepEqual((await db.outreach.findMany({ where: { status: "queued" }, select: { id: true } })).map(o => o.id).sort(), rows.map(o => o.id).sort());
      assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outside.id } })).status, "draft");
      assert.equal((await campaignControls(db)).active?.approved, 9);
      assert.equal((await sendingPolicy(db)).enabled, false);
      assert.equal(sender.calls.length, 0, "approval queues only; no provider call");
    } finally { await app.close(); }
  });

  test("rejected approval names the problem, keeps the form open with entered values, and queues nothing", async () => {
    const rows = await drafts(9), campaignsBefore = await db.outreachCampaign.count();
    const { app, sender, post } = await adminApp();
    try {
      // The pre-fix browser payload: checked boxes without a value attribute arrive as "on" and select nothing.
      const legacy = new URLSearchParams({ name: "Batch <1>", reason: "Reviewed", confirm: "1" });
      for (const o of rows) legacy.append(`m:${o.id}`, "on");
      const empty = await post("/admin/outreach/campaign/start", legacy);
      assert.equal(empty.statusCode, 400);
      assert.match(empty.body, /Select at least one existing message to approve\./);

      const unconfirmed = new URLSearchParams({ name: "Batch <1>", reason: 'Reviewed "copy"' });
      for (const o of rows) unconfirmed.append(`m:${o.id}`, "1");
      const res = await post("/admin/outreach/campaign/start", unconfirmed);
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /You must explicitly confirm approval/);
      assert.doesNotMatch(res.body, /Select at least one existing message/);
      assert.match(res.body, /<details open><summary>Approve and start a selected campaign/);
      assert.match(res.body, /id="campaign-name"[^>]*value="Batch &#60;1&#62;"/);
      assert.match(res.body, /id="campaign-reason"[^>]*value="Reviewed &#34;copy&#34;"/);
      assert.equal(campaignCheckboxes(res.body).filter(b => b.checked).length, 9);
      assert.doesNotMatch(res.body, /name="confirm" value="1" checked/);
      assert.equal(await db.outreach.count({ where: { status: "queued" } }), 0);
      assert.equal(await db.outreachCampaign.count(), campaignsBefore);
      assert.equal((await sendingPolicy(db)).activeCampaignId, null);
      assert.equal(sender.calls.length, 0);
    } finally { await app.close(); }
  });

  test("a real browser serializes the rendered form so nine selected messages are accepted", { skip: FORM_BROWSER ? false : "no Chromium browser found (set FORM_BROWSER)" }, async () => {
    const rows = await drafts(9);
    const outside = await draft();
    const { app, sender, post, controlPage } = await adminApp();
    try {
      const payload = await browserCampaignPayload(await controlPage(), { name: "Batch 1 — October 2026",
        reason: "Reviewed recipients and copy", messageIds: rows.map(o => o.id), confirm: true });
      const fields = [...payload].filter(([k]) => k.startsWith("m:"));
      assert.deepEqual(fields.map(([k]) => k.slice(2)).sort(), rows.map(o => o.id).sort());
      assert.ok(fields.every(([, v]) => v === "1"), `checkbox values: ${fields.map(([, v]) => v).join(",")}`);
      assert.equal((await post("/admin/outreach/campaign/start", payload)).statusCode, 303);
      assert.equal(await db.outreach.count({ where: { status: "queued" } }), 9);
      assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outside.id } })).status, "draft");
      assert.equal((await sendingPolicy(db)).enabled, false);
      assert.equal(sender.calls.length, 0);
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
