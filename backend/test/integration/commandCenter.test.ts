import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { commandActivity, loadOverview } from "../../src/admin/commandCenter.js";
import { overviewPage } from "../../src/admin/commandViews.js";
import { loadSendingFacts } from "../../src/admin/sendingState.js";
import { stuckMessages, setSendingSwitch } from "../../src/outreach/dispatch.js";
import { mockSender } from "./outreachHelpers.js";
import { listMessages, listReplies, parseMessageFilters } from "../../src/outreach/operations.js";
import { createOutreachDraft } from "../../src/outreach/service.js";
import { freshDb, readyForm, skipReason, TEST_DATABASE_URL, truncate, WEBSITE } from "./helpers.js";
import { OPTS } from "./outreachHelpers.js";

const SECRET = "command-center-local-test-secret-12345";
const paths = ["/admin", "/admin/analytics", "/admin/research", "/admin/campaigns", "/admin/activity", "/admin/system", "/admin/diagnostic"];
describe("Acquisition Command Center (read-only pages)", { skip: skipReason }, () => {
  let db: Db, app: FastifyInstance, cookie: string;
  const cfg = () => loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ADMIN_SECRET: SECRET, OUTREACH_DAILY_LIMIT: "1", TRUST_PROXY_HOPS: "0" });
  before(async () => { db = await freshDb(); app = await buildApp(cfg(), db, false); const login = await app.inject({ method: "POST", url: "/admin/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ secret: SECRET }).toString() }); cookie = String(login.headers["set-cookie"]).split(";")[0]!; });
  beforeEach(async () => truncate(db));
  after(async () => { await app?.close(); await db?.$disconnect(); });
  const get = (url: string) => app.inject({ url, headers: { cookie } });
  const prospect = async (name = "Fictional Harbor Collision") => { const p = await createProspect(db, readyForm({ businessName: name, email: "owner@fixture.example", emailSourceUrl: `${WEBSITE}/contact` })); await addEvidence(db, p.id, { signalKey: "collision_repair_services", sourceUrl: WEBSITE, excerpt: "We offer automotive collision repair." }); return p; };
  const counts = async () => Promise.all([db.prospect.count(), db.outreach.count(), db.invitation.count(), db.outreachEvent.count(), db.outreachControlChange.count(), db.emailSuppression.count(), db.candidateResearch.count()]);

  test("all added workspaces require authentication and preserve CSP", async () => {
    for (const url of paths) {
      const denied = await app.inject({ url }); assert.equal(denied.statusCode, 303, url); assert.equal(denied.headers.location, "/admin/login");
      const allowed = await get(url); assert.equal(allowed.statusCode, 200, url); assert.equal(allowed.body.match(/<h1[ >]/g)?.length, 1, url);
      assert.match(allowed.body, /Acquisition.*Command Center/); assert.match(String(allowed.headers["content-security-policy"]), /default-src 'none'/);
      assert.doesNotMatch(allowed.body, /<script|javascript:|\sonclick=/i);
    }
  });
  test("navigation visits perform no database mutations", async () => {
    await prospect(); const before = await counts();
    for (const url of [...paths, "/admin/outreach/messages", "/admin/prospects"]) assert.equal((await get(url)).statusCode, 200, url);
    assert.deepEqual(await counts(), before);
  });
  test("Overview shows the real OFF state, capacity and honest missing heartbeats", async () => {
    const html = (await get("/admin")).body;
    assert.match(html, /SENDING OFF/); assert.match(html, /remaining &middot; rolling 24h/); assert.match(html, /Not observable/);
    assert.match(html, /ALL CLEAR/); assert.doesNotMatch(html, /Everything is running normally|Worker healthy/);
    assert.equal(await db.outreachControlChange.count(), 0);
  });
  test("business identity is escaped in lists and recorded activity", async () => {
    const p = await prospect('<script>bad()</script>');
    for (const url of ["/admin", "/admin/activity", "/admin/prospects", `/admin/prospects/${p.id}`]) {
      const html = (await get(url)).body; assert.doesNotMatch(html, /<script>bad/); assert.match(html, /&#60;script&#62;bad/);
    }
  });
  test("current inventory and sourced repair records remain separate from score", async () => {
    const p = await prospect(); const html = (await get("/admin/prospects")).body;
    assert.match(html, /Repair evidence/); assert.match(html, /1 source record/); assert.match(html, /Not contacted/);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "new");
  });
  test("campaigns use stored version/counts without creating a cohort engine", async () => {
    const p = await prospect(); await createOutreachDraft(db, p.id, OPTS);
    const html = (await get("/admin/campaigns")).body;
    assert.match(html, /outreach-intro-t4/); assert.match(html, /intro@t4/); assert.match(html, /cohort management are not implemented/);
    assert.equal(await db.outreachControlChange.count(), 0); assert.equal(await db.outreach.count({ where: { status: "queued" } }), 0);
  });
  test("activity does not expose free-text invitation tokens", async () => {
    const p = await prospect(); const o = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    const token = "z".repeat(43); await db.outreachEvent.create({ data: { outreachId: o.id, type: "replied", detail: `Classified reply https://reclaimbay.com/invite#${token}`, createdAt: new Date() } });
    const html = (await get("/admin/activity")).body; assert.match(html, /Reply classified/); assert.ok(!html.includes(token));
  });
  test("message search, prospect and UTC date bounds filter actual stored records", async () => {
    const a = await prospect("Harbor Fixture"), b = await prospect("Other Fixture");
    const x = (await createOutreachDraft(db, a.id, OPTS)).outreach, y = (await createOutreachDraft(db, b.id, OPTS)).outreach;
    await db.outreach.update({ where: { id: x.id }, data: { generatedAt: new Date("2026-10-01T23:59:59Z") } });
    await db.outreach.update({ where: { id: y.id }, data: { generatedAt: new Date("2026-10-02T00:00:00Z") } });
    const rows = await listMessages(db, parseMessageFilters({ q: "Harbor", prospect: a.id, from: "2026-10-01", to: "2026-10-01" }));
    assert.equal(rows.total, 1); assert.equal(rows.rows[0]!.id, x.id);
    assert.equal((await listMessages(db, parseMessageFilters({ from: "2026-10-02", to: "2026-10-02" }))).total, 1);
  });
  test("separate replies retain separate identities with received-date filtering", async () => {
    const p = await prospect(), o = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    await db.outreach.update({ where: { id: o.id }, data: { status: "replied" } });
    await db.outreachReply.createMany({ data: [1, 2].map(n => ({ outreachId: o.id, receivedAt: new Date(`2026-10-0${n}T12:00:00Z`), summary: `Fixture reply ${n}` })) });
    assert.equal((await listReplies(db, parseMessageFilters({ view: "replies", from: "2026-10-01", to: "2026-10-01" }))).total, 1);
    assert.equal((await listReplies(db, parseMessageFilters({ view: "replies" }))).total, 2);
  });
  test("anonymous real product events appear, sample events do not", async () => {
    const s = await db.analyticsSession.create({ data: { anonymousSessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" } });
    await db.productEvent.createMany({ data: [{ sessionId: s.id, eventType: "scan_completed", isSample: false }, { sessionId: s.id, eventType: "scan_completed", isSample: true }] });
    const activity = await commandActivity(db); assert.equal(activity.filter(x => x.kind === "product").length, 1);
    assert.equal(activity.find(x => x.kind === "product")!.name, "Direct visitor");
  });
  test("disabled admin also disables the added routes", async () => {
    const disabled = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL }), db, false);
    try { for (const url of paths) assert.equal((await disabled.inject({ url })).statusCode, 503); } finally { await disabled.close(); }
  });
  test("unresolved uses stuckMessages, excluding an active provider attempt", async () => {
    const p = await prospect(), o = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    const now = new Date();
    await db.outreach.update({ where: { id: o.id }, data: { status: "queued", sendStartedAt: now, sendAttempts: 1 } });
    const active = await loadSendingFacts(db, cfg(), now);
    assert.equal(active.queued, 1); assert.equal(active.stuck.length, 0);
    await db.outreach.update({ where: { id: o.id }, data: { sendStartedAt: new Date(now.getTime() - 86400000) } });
    assert.deepEqual((await loadSendingFacts(db, cfg(), now)).stuck, await stuckMessages(db, now));
    assert.equal((await loadSendingFacts(db, cfg(), now)).stuck.length, 1);
  });
  test("business eligibility uses the dry run, excludes internal tests, and rejects unsupported Yes", async () => {
    await prospect("Eligible while New");
    const internal = await prospect("Internal fixture");
    await db.prospect.update({ where: { id: internal.id }, data: { internalTest: true } });
    await createProspect(db, readyForm({ businessName: "Unsupported Yes" }));
    const data = await loadOverview(db, cfg(), mockSender(), undefined);
    assert.equal(data.attention.find(i => i.key === "eligible")?.count, 1);
    assert.equal(await db.outreach.count(), 0); assert.equal(await db.invitation.count(), 0);
    assert.ok(data.funnel.ok); assert.equal(data.funnel.value.prospects, 2);
  });
  test("current inventory differs from recorded history and skipped stages are not invented", async () => {
    const p = await prospect();
    await db.prospectStatusChange.create({ data: { prospectId: p.id, fromStatus: "new", toStatus: "meeting" } });
    await db.prospect.update({ where: { id: p.id }, data: { status: "archived" } });
    const data = await loadOverview(db, cfg(), mockSender(), undefined);
    assert.ok(data.funnel.ok);
    assert.equal(data.funnel.value.inventory.archived, 1);
    assert.equal(data.funnel.value.everReached("meeting"), 1);
    assert.equal(data.funnel.value.everReached("qualified"), 0);
    assert.equal(data.funnel.value.everReached("ready_to_contact"), 0);
  });
  test("failed reads render unavailable instead of zero or sensitive error details", async () => {
    const broken = new Proxy(db, { get(target, key) { return key === "$queryRaw" ? async () => { throw new Error("private-provider-secret-canary"); } : Reflect.get(target, key); } });
    const data = await loadOverview(broken, cfg(), mockSender(), undefined);
    assert.equal(data.product.ok, false); assert.equal(data.funnel.ok, false);
    const html = overviewPage(data);
    assert.match(html, /Acquisition funnel could not be loaded/);
    assert.match(html, /Product activity could not be loaded/);
    assert.match(html, />Down</); assert.doesNotMatch(html, /private-provider-secret-canary/);
  });
  test("Overview reuses the Sending page's live authorization failure without another provider call", async () => {
    let checks = 0;
    const sender = { ...mockSender(), name: "gmail", check: async () => { checks++; return "Authorization revoked."; } };
    const config = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ADMIN_SECRET: SECRET,
      OUTREACH_PROVIDER: "gmail", OUTREACH_SENDING_ENABLED: "1", OUTREACH_DAILY_LIMIT: "1",
      GOOGLE_OAUTH_CLIENT_ID: "fixture-client", GOOGLE_OAUTH_CLIENT_SECRET: "fixture-secret",
      GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), PUBLIC_API_URL: "https://api.fixture.example",
      OUTREACH_SENDER_EMAIL: "operator@fixture.example", OUTREACH_SENDER_NAME: "Fixture Operator",
      OUTREACH_POSTAL_ADDRESS: "123 Fixture St, Example City, CA 90000" });
    await setSendingSwitch(db, true, "Disposable test only.", config, sender);
    const local = await buildApp(config, db, false, { outreachSender: sender });
    try {
      const before = await local.inject({ url: "/admin", headers: { cookie } });
      assert.match(before.body, /Not verified here/); assert.equal(checks, 0);
      const sending = await local.inject({ url: "/admin/outreach", headers: { cookie } });
      assert.match(sending.body, /Authorization revoked/); assert.equal(checks, 1);
      const overview = await local.inject({ url: "/admin", headers: { cookie } });
      assert.match(overview.body, /SENDING BLOCKED/); assert.match(overview.body, /Authorization revoked/);
      assert.equal(checks, 1); assert.equal(sender.calls.length, 0);
    } finally { await local.close(); }
  });
});
