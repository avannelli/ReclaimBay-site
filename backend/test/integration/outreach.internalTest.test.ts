import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadProspectRows, loadSummary } from "../../src/admin/stats.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { openInvitation } from "../../src/invitations/service.js";
import { dailyCapacity, dispatchQueued } from "../../src/outreach/dispatch.js";
import { gmailSender } from "../../src/outreach/gmail.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { outreachMetrics } from "../../src/outreach/metrics.js";
import { createOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { INTERNAL_TEST_NOTE, ProspectError, addEvidence, changeStatus, createInternalTestProspect, createProspect, updateProspect } from "../../src/prospects.js";
import { fakeGmail, inbound } from "../fixtures/fakeGmail.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, draftedInvitation, mockSender, switchOn } from "./outreachHelpers.js";

/*
 * The internal outreach test (5F): a prospect marked internalTest at creation,
 * sent through exactly the same path as any prospect (eligibility, the three
 * keys, the daily limit, recipient and suppression rules, the send gate, the
 * Gmail adapter, the inbox reader), and left out of the business metrics.
 * A fake Google and a disposable PostgreSQL: no real mailbox, no network.
 */

let n = 0;
/** A qualified prospect's form, with a published email and evidence-ready site. */
const form = (over: Record<string, string> = {}) => {
  const i = ++n;
  const site = `https://shop${i}.example.com`;
  return readyForm({ businessName: `Shop ${i} Auto`, website: site, phoneSourceUrl: `${site}/c`, email: `owner@shop${i}.example.com`, emailSourceUrl: `${site}/c`, ...over });
};

describe("internal outreach test (service)", { skip: skipReason }, () => {
  let db: Db;
  let realCalls: string[] = [];
  const realFetch = globalThis.fetch;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    realCalls = [];
    globalThis.fetch = (async (url: unknown) => {
      realCalls.push(String(url));
      throw new Error("real network call");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    assert.deepEqual(realCalls, [], "no real network call");
  });
  after(async () => db?.$disconnect());

  const withEvidence = async <P extends { id: string; website: string | null }>(p: P) => {
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${p.website}/about`, excerpt: "Family owned." });
    return p;
  };
  const real = async (over: Record<string, string> = {}) => withEvidence(await createProspect(db, form(over)));
  const internal = async (over: Record<string, string> = {}) => withEvidence(await createInternalTestProspect(db, form({ confirmInternalTest: "yes", ...over })));
  const queuedFor = async (p: { id: string }) => {
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueOutreach(db, outreach.id, CFG);
    return outreach;
  };
  const row = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });

  // ---------- 1, 7: an explicit, permanent designation; no convention ----------

  test("only its own creation path, with the explicit confirmation, marks a prospect as an internal test; nothing changes it later", async () => {
    await assert.rejects(createInternalTestProspect(db, form()), (e: unknown) => e instanceof ProspectError && /Confirm that this is ReclaimBay's own internal outreach test/.test(e.messages.join(" ")));
    assert.equal(await db.prospect.count(), 0, "refused: nothing created");

    const t = await createInternalTestProspect(db, form({ confirmInternalTest: "yes" }));
    assert.equal(t.internalTest, true);
    const history = await db.prospectStatusChange.findMany({ where: { prospectId: t.id } });
    assert.deepEqual(history.map((h) => h.reason), ["Created as an internal outreach test"]);
    assert.deepEqual((await db.prospectNote.findMany({ where: { prospectId: t.id } })).map((x) => x.body), [INTERNAL_TEST_NOTE]);

    // The normal path ignores any attempt to set it, and edits never touch it either way.
    const r = await createProspect(db, form({ internalTest: "true", confirmInternalTest: "yes" }));
    assert.equal(r.internalTest, false, "the normal create path never marks a prospect");
    await updateProspect(db, r.id, form({ internalTest: "true", confirmInternalTest: "yes", email: "", emailSourceUrl: "" }));
    await updateProspect(db, t.id, form({ internalTest: "false", email: "", emailSourceUrl: "" }));
    await changeStatus(db, t.id, "qualified", null);
    const [r2, t2] = await Promise.all([db.prospect.findUniqueOrThrow({ where: { id: r.id } }), db.prospect.findUniqueOrThrow({ where: { id: t.id } })]);
    assert.deepEqual([r2.internalTest, t2.internalTest], [false, true], "permanent both ways");
  });

  test("no name or email convention: the flag alone decides", async () => {
    const lookalike = await createProspect(db, form({ businessName: "ReclaimBay Internal Test", email: "internal-test@reclaimbay.example", emailSourceUrl: "https://reclaimbay.example/test" }));
    const ordinary = await createInternalTestProspect(db, form({ confirmInternalTest: "yes" }));
    assert.equal(lookalike.internalTest, false, "a test-looking name and address make nothing internal");
    assert.equal(ordinary.internalTest, true, "an ordinary-looking record is internal because it was created as one");
  });

  // ---------- 4, 5: the same dispatch path, every gate ----------

  test("every sending gate still applies to an internal test: the arm, the switch, suppression", async () => {
    const sender = mockSender();
    const t = await internal();
    const o = await queuedFor(t);

    const unarmed = await dispatchQueued(db, { config: { ...CFG, outreachSendingArmed: false }, sender });
    assert.ok(unarmed.blockers.some((b) => /OUTREACH_SENDING_ENABLED/.test(b)), "not armed: blocked");
    const off = await dispatchQueued(db, { config: CFG, sender });
    assert.ok(off.blockers.some((b) => /switch is off/.test(b)), "switch off: blocked");
    assert.equal(sender.calls.length, 0);
    assert.equal((await row(o.id)).status, "queued");

    await db.emailSuppression.create({ data: { email: t.email!, reason: "unsubscribed", detail: "Integration test." } });
    await switchOn(db, sender);
    const r = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 0, "a suppressed address is never sent to, internal test or not");
    assert.equal(r.cancelled.length, 1);
    assert.equal((await row(o.id)).status, "cancelled");
  });

  test("an internal test goes through the real dispatcher and Gmail adapter, and uses the daily limit like any send", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const t = await internal();
    const p = await real();
    const to = await queuedFor(t);
    const tp = await queuedFor(p);
    await switchOn(db, sender);
    const limitOne = { ...CFG, outreachDailyLimit: 1 };
    const first = await dispatchQueued(db, { config: limitOne, sender });
    assert.deepEqual(first.sent.map((s) => s.outreachId), [to.id], "the internal test (queued first) is sent through Gmail");
    assert.equal(google.sent.length, 1);
    assert.equal(google.sent[0]!.marker, to.id, "carries the usual outreach marker");
    const sentRow = await row(to.id);
    assert.equal(sentRow.status, "sent");
    assert.ok(sentRow.providerMessageId && sentRow.sendStartedAt && sentRow.provider === "gmail", "the usual audit fields");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: t.id } })).status, "contacted");

    // It used the day's only slot: the internal test isn't exempt from the limit.
    assert.deepEqual(await dailyCapacity(db, limitOne, new Date()), { used: 1, limit: 1, remaining: 0 });
    const second = await dispatchQueued(db, { config: limitOne, sender });
    assert.equal(second.sent.length, 0);
    assert.equal((await row(tp.id)).status, "queued", "the real message waits for tomorrow's limit");
  });

  test("recipient ownership applies: an internal test can't reach an address already contacted for a real business", async () => {
    const sender = mockSender();
    const p = await real();
    await queuedFor(p);
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 1);

    const t = await internal({ email: p.email!, emailSourceUrl: `${p.website}/c` });
    const attempt = async () => {
      const { outreach } = await createOutreachDraft(db, t.id, OPTS);
      await queueOutreach(db, outreach.id, CFG);
      return dispatchQueued(db, { config: CFG, sender });
    };
    await attempt().catch((e: unknown) => assert.ok(e instanceof ProspectError, "refused before sending"));
    assert.equal(sender.calls.length, 1, "never a second email to that address");
  });

  test("two dispatchers at once send an internal test exactly once", async () => {
    const sender = mockSender();
    const t = await internal();
    const o = await queuedFor(t);
    await switchOn(db, sender);
    await Promise.all([dispatchQueued(db, { config: CFG, sender }), dispatchQueued(db, { config: CFG, sender })]);
    assert.equal(sender.calls.length, 1);
    assert.equal((await row(o.id)).status, "sent");
  });

  // ---------- 2, 3, 6: metrics and the inbox ----------

  test("the inbox records the internal test's reply on its message; the funnel and analytics leave it out, and real numbers are unchanged", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const p = await real();
    const po = await queuedFor(p);
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    const thread = (o: { id: string }) => google.sent.find((s) => s.marker === o.id)!.threadId;
    google.inbox.push(inbound("real-reply", thread(po), { From: `Owner <${p.email}>`, Subject: "Re: Declined work" }, [{ mimeType: "text/plain", text: "Tell me more." }], "Tell me more."));
    await pollGmailInbox(db, client, { apply: true });
    // A real visitor through the real invitation, with a real scan.
    const realInv = await draftedInvitation(db, po);
    const realSession = randomUUID();
    await openInvitation(db, { token: realInv.token, sessionId: realSession });
    const session = await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: realSession } });
    await db.productEvent.create({ data: { sessionId: session.id, prospectId: p.id, eventType: "scan_completed" } });

    const before = { metrics: await outreachMetrics(db), summary: await loadSummary(db), rows: await loadProspectRows(db) };
    assert.equal(before.metrics.find((m) => m.campaign === "all")!.sent, 1);

    // The internal test, end to end: sent, replied, its invitation opened, a scan, a contact click.
    const t = await internal();
    const to = await queuedFor(t);
    await dispatchQueued(db, { config: CFG, sender });
    google.inbox.push(inbound("test-reply", thread(to), { From: `Me <${t.email}>`, Subject: "Re: Declined work" }, [{ mimeType: "text/plain", text: "Internal test reply." }], "Internal test reply."));
    const inbox = await pollGmailInbox(db, client, { apply: true });
    assert.deepEqual(inbox.items.filter((i) => i.gmailId === "test-reply").map((i) => [i.kind, i.result, i.outreachId]), [["reply", "recorded", to.id]], "matched by thread, like any reply");
    assert.equal((await row(to.id)).status, "replied");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: t.id } })).status, "engaged");
    const testInv = await draftedInvitation(db, to);
    const testSession = randomUUID();
    await openInvitation(db, { token: testInv.token, sessionId: testSession });
    const ts = await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: testSession } });
    assert.equal(ts.prospectId, t.id, "attributed to the internal test, as any invitation is");
    await db.productEvent.createMany({
      data: [
        { sessionId: ts.id, prospectId: t.id, eventType: "landing_view" },
        { sessionId: ts.id, prospectId: t.id, eventType: "scan_completed" },
        { sessionId: ts.id, prospectId: t.id, eventType: "contact_clicked" },
      ],
    });

    // Business metrics: exactly as before the internal test.
    assert.deepEqual(await outreachMetrics(db), before.metrics, "the outreach funnel leaves the internal test out");
    assert.deepEqual(await loadSummary(db), before.summary, "the analytics summary leaves it out");
    const rows = await loadProspectRows(db);
    assert.equal(rows.find((r) => r.id === t.id), undefined, "no intent row for the internal test");
    assert.deepEqual(rows, before.rows, "real prospect rows unchanged");

    // Operations still see it: the daily limit counts it, and its records are all there.
    assert.equal((await dailyCapacity(db, CFG, new Date())).used, 2);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: to.id, type: "replied" } }), 1);
  });
});

describe("internal outreach test (admin HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }), db, false);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, data: Record<string, string>) => app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: new URLSearchParams(data).toString() });

  test("its own form, an explicit confirmation, and an unmistakable mark everywhere it is shown", async () => {
    const page = (await get("/admin/prospects/internal-test")).body;
    assert.match(page, /Add internal outreach test/);
    assert.match(page, /name="confirmInternalTest" value="yes"/);

    const refused = await post("/admin/prospects/internal-test", form());
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /Confirm that this is ReclaimBay&#39;s own internal outreach test|Confirm that this is ReclaimBay's own internal outreach test/);
    assert.equal(await db.prospect.count(), 0);

    // The normal form never marks a prospect, whatever it is sent.
    const normal = await post("/admin/prospects", form({ internalTest: "true", confirmInternalTest: "yes" }));
    assert.equal(normal.statusCode, 303);
    assert.equal(await db.prospect.count({ where: { internalTest: true } }), 0);

    const created = await post("/admin/prospects/internal-test", form({ confirmInternalTest: "yes" }));
    assert.equal(created.statusCode, 303);
    const t = await db.prospect.findFirstOrThrow({ where: { internalTest: true } });
    assert.match(String(created.headers.location), new RegExp(`/admin/prospects/${t.id}`));

    const detail = (await get(`/admin/prospects/${t.id}`)).body;
    assert.match(detail, />Internal test</);
    assert.match(detail, /<b>Internal outreach test\.<\/b>/);
    const list = (await get("/admin/prospects")).body;
    assert.equal((list.match(/>Internal test</g) ?? []).length, 1, "only the internal test is tagged in the list");

    // An edit through the normal form keeps the mark.
    await post(`/admin/prospects/${t.id}`, form({ internalTest: "false" }));
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: t.id } })).internalTest, true);
  });
});
