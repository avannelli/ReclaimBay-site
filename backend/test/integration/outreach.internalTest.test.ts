import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadProspectRows, loadSummary } from "../../src/admin/stats.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { INTERNAL_TEST_IDENTITY } from "../../src/internalTest.js";
import { openInvitation } from "../../src/invitations/service.js";
import { dailyCapacity, dispatchQueued } from "../../src/outreach/dispatch.js";
import { gmailSender } from "../../src/outreach/gmail.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { outreachMetrics } from "../../src/outreach/metrics.js";
import { prepareSelectedOutreach } from "../../src/outreach/prepare.js";
import { classifyReply, createOutreachDraft, previewOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { INTERNAL_TEST_NOTE, ProspectError, addEvidence, changeStatus, createInternalTestProspect, createProspect, updateProspect } from "../../src/prospects.js";
import { fakeGmail, inbound } from "../fixtures/fakeGmail.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, draftedInvitation, mockSender, switchOn } from "./outreachHelpers.js";

/*
 * The internal outreach test: ReclaimBay's own controlled identity, marked
 * internalTest at creation. It isn't a business, so it needs no business
 * qualification or collision/body evidence and is held to its fixed identity
 * instead; everything else (eligibility, the three keys, the daily limit,
 * recipient and suppression rules, the send gate, the Gmail adapter, the
 * inbox reader) is the same path as any prospect, and it is left out of the
 * business metrics. A fake Google and a disposable PostgreSQL: no real
 * mailbox, no network.
 */

const { businessName: NAME, email: MAILBOX, emailSourceUrl: CONTACT_PAGE } = INTERNAL_TEST_IDENTITY;
const CONFIRM = { confirmInternalTest: "yes" };

let n = 0;
/** A qualified prospect's form, with a published email and evidence-ready site. */
const form = (over: Record<string, string> = {}) => {
  const i = ++n;
  const site = `https://shop${i}.example.com`;
  return readyForm({ businessName: `Shop ${i} Auto`, website: site, phoneSourceUrl: `${site}/c`, email: `owner@shop${i}.example.com`, emailSourceUrl: `${site}/c`, ...over });
};
const messages = (e: unknown) => (e instanceof ProspectError ? e.messages.join(" ") : String(e));

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

  const real = async (over: Record<string, string> = {}) => {
    const p = await createProspect(db, form(over));
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${p.website}/about`, excerpt: "Family owned." });
    return p;
  };
  const internal = () => createInternalTestProspect(db, CONFIRM);
  const queuedFor = async (p: { id: string }) => {
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueOutreach(db, outreach.id, CFG);
    return outreach;
  };
  const row = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });
  const prospect = (id: string) => db.prospect.findUniqueOrThrow({ where: { id }, include: { signals: true, evidence: true, notes: true } });

  // ---------- creation: the controlled identity, once, permanently marked ----------

  test("created only by its own path, with the confirmation, as exactly the controlled identity", async () => {
    await assert.rejects(createInternalTestProspect(db, {}), (e: unknown) => /Confirm that this is ReclaimBay's own internal outreach test/.test(messages(e)));
    await assert.rejects(createInternalTestProspect(db, { ...CONFIRM, email: "owner@smithauto.example.com", emailSourceUrl: "https://smithauto.example.com/contact" }), (e: unknown) => /Email of an internal test is always reclaimbay\.test@gmail\.com/.test(messages(e)), "a real business's address is refused");
    await assert.rejects(createInternalTestProspect(db, form(CONFIRM)), (e: unknown) => /isn't a business/.test(messages(e)), "business details are refused");
    assert.equal(await db.prospect.count(), 0, "refused: nothing created");

    const t = await internal();
    const stored = await prospect(t.id);
    assert.equal(stored.internalTest, true);
    assert.deepEqual(
      { name: stored.businessName, email: stored.email, source: stored.emailSourceUrl, website: stored.website, phone: stored.phone, city: stored.city, state: stored.state, status: stored.status },
      { name: NAME, email: MAILBOX, source: CONTACT_PAGE, website: null, phone: null, city: null, state: null, status: "new" },
    );
    assert.deepEqual([stored.signals.length, stored.evidence.length], [0, 0], "no business signals or evidence: nothing fabricated");
    assert.deepEqual(stored.notes.map((x) => x.body), [INTERNAL_TEST_NOTE]);
    assert.match(INTERNAL_TEST_NOTE, /not a business[\s\S]*reclaimbay\.test@gmail\.com[\s\S]*https:\/\/reclaimbay\.com\/internal-test-contact/);
    assert.deepEqual((await db.prospectStatusChange.findMany({ where: { prospectId: t.id } })).map((h) => h.reason), ["Created as an internal outreach test"]);

    await assert.rejects(internal(), (e: unknown) => e instanceof ProspectError && e.kind === "conflict" && /already exists/.test(messages(e)), "exactly one");
    assert.equal(await db.prospect.count({ where: { internalTest: true } }), 1);
  });

  test("its mark and identity are permanent: no edit, no evidence; no business can take its mailbox or name", async () => {
    const t = await internal();
    await assert.rejects(updateProspect(db, t.id, form()), /controlled identity is fixed/);
    await assert.rejects(updateProspect(db, t.id, { businessName: NAME, email: MAILBOX, emailSourceUrl: CONTACT_PAGE, internalTest: "false" }), /internal-test mailbox|controlled identity is fixed/);
    await assert.rejects(addEvidence(db, t.id, { signalKey: "collision_repair_services", sourceUrl: "https://smithauto.example.com/services", excerpt: "We offer collision repair." }), /controlled identity is fixed/);
    await changeStatus(db, t.id, "qualified", null);
    const stored = await prospect(t.id);
    assert.deepEqual([stored.internalTest, stored.email, stored.evidence.length], [true, MAILBOX, 0]);

    await assert.rejects(createProspect(db, form({ email: MAILBOX, emailSourceUrl: CONTACT_PAGE })), /internal-test mailbox/);
    await assert.rejects(createProspect(db, form({ businessName: NAME })), /internal outreach test's name/);
    const r = await createProspect(db, form({ internalTest: "true", confirmInternalTest: "yes" }));
    assert.equal(r.internalTest, false, "the normal create path never marks a prospect");
    await assert.rejects(updateProspect(db, r.id, form({ email: MAILBOX, emailSourceUrl: CONTACT_PAGE })), /internal-test mailbox/);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: r.id } })).internalTest, false);
  });

  // ---------- eligibility: its identity instead of business qualification ----------

  test("it is prepared, queued, and made Ready to contact without collision/body evidence, by the normal path", async () => {
    const t = await internal();
    const preview = await previewOutreachDraft(db, t.id, OPTS);
    assert.deepEqual(preview.errors, [], "eligible for preparation through its identity");
    const [prepared] = await prepareSelectedOutreach(db, [t.id], { draft: OPTS });
    assert.equal(prepared!.outcome, "prepared");
    await queueOutreach(db, prepared!.outreachId!, CFG);
    const stored = await prospect(t.id);
    assert.equal(stored.status, "ready_to_contact");
    assert.equal(stored.evidence.length, 0);
    const o = await row(prepared!.outreachId!);
    assert.deepEqual([o.status, o.recipientEmail, o.recipientSourceUrl], ["queued", MAILBOX, CONTACT_PAGE]);
  });

  test("its stored facts state what it is, never that a business publishes the mailbox", async () => {
    const t = await internal();
    const { outreach } = await createOutreachDraft(db, t.id, OPTS);
    const facts = outreach.evidence as { key: string; statement: string; sourceUrl: string | null }[];
    assert.deepEqual(facts.map((f) => [f.key, f.sourceUrl]), [["internal_test", CONTACT_PAGE]]);
    assert.match(facts[0]!.statement, /^This is ReclaimBay's internal outreach test, not a business\. Its recipient, reclaimbay\.test@gmail\.com, is a mailbox ReclaimBay controls, documented at https:\/\/reclaimbay\.com\/internal-test-contact\.$/);
    assert.doesNotMatch(JSON.stringify(facts), /publishes|business email|The business is called/);
    assert.equal(outreach.subject, `A quick question about ${NAME}`);
    assert.ok(outreach.body.includes(`If you'd rather not receive emails from ReclaimBay, reply "no thanks".`));

    // A business keeps its facts exactly.
    const p = await real();
    const { outreach: po } = await createOutreachDraft(db, p.id, OPTS);
    const businessFacts = po.evidence as { key: string; statement: string }[];
    assert.deepEqual(businessFacts.slice(0, 2).map((f) => f.statement), [`The business is called ${p.businessName}.`, `It publishes ${p.email} as its business email.`]);
  });

  test("real prospects still need sourced collision/body evidence; nothing about the internal path reaches them", async () => {
    const p = await createProspect(db, form());
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await assert.rejects(queueOutreach(db, outreach.id, CFG), /sourced collision\/body evidence/);
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /sourced collision\/body evidence/);
    // Even a business with the internal test's look (no signals, a test-like name) needs qualification.
    const lookalike = await createProspect(db, form({ businessName: "ReclaimBay Test Shop", signal_collision_repair_services: "unknown" }));
    await assert.rejects(changeStatus(db, lookalike.id, "qualified", null), /Meets criteria/);
    await addFixtureCollisionEvidence(db, p);
    await queueOutreach(db, outreach.id, CFG);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "ready_to_contact");
  });

  test("its recipient provenance must hold at every step: a changed identity is refused at queue and cancelled at send", async () => {
    const sender = mockSender();
    const t = await internal();
    const { outreach } = await createOutreachDraft(db, t.id, OPTS);
    // Simulates a record that no longer matches (no supported path can do this).
    await db.prospect.update({ where: { id: t.id }, data: { emailSourceUrl: "https://smithauto.example.com/contact" } });
    await assert.rejects(queueOutreach(db, outreach.id, CFG), /controlled internal-test identity: An internal test's recipient must be documented at https:\/\/reclaimbay\.com\/internal-test-contact/);
    await db.prospect.update({ where: { id: t.id }, data: { emailSourceUrl: CONTACT_PAGE } });
    await queueOutreach(db, outreach.id, CFG);
    await db.prospect.update({ where: { id: t.id }, data: { businessName: "Smith Auto Body" } });
    await switchOn(db, sender);
    const r = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 0, "never sent");
    assert.equal(r.cancelled.length, 1);
    assert.equal((await row(outreach.id)).status, "cancelled");
  });

  test("an earlier internal test record is never rewritten, and isn't eligible under the controlled identity", async () => {
    const legacy = await db.prospect.create({
      data: { referralCode: "legacytest001", businessName: "Shop Legacy Auto", website: "https://legacy.example.com", email: "me@legacy.example.com", emailSourceUrl: "https://legacy.example.com/c", internalTest: true },
    });
    await db.prospectNote.create({ data: { prospectId: legacy.id, body: "Internal outreach test: ReclaimBay's own mailbox standing in for a business." } });
    await db.prospectEvidence.create({ data: { prospectId: legacy.id, signalKey: "collision_repair_services", sourceUrl: "https://legacy.example.com/s", excerpt: "Shop Legacy Auto: We offer automotive collision repair." } });
    const before = await prospect(legacy.id);

    const t = await internal();
    await createOutreachDraft(db, t.id, OPTS);
    const preview = await previewOutreachDraft(db, legacy.id, OPTS);
    assert.match(preview.errors.join(" "), /controlled internal-test identity/);
    await assert.rejects(updateProspect(db, legacy.id, form()), /controlled identity is fixed/);
    assert.deepEqual(await prospect(legacy.id), before, "fields, notes, and evidence unchanged");
  });

  // ---------- every sending control still applies ----------

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

    await db.emailSuppression.create({ data: { email: MAILBOX, reason: "unsubscribed", detail: "Integration test." } });
    await switchOn(db, sender);
    const r = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 0, "a suppressed address is never sent to, internal test or not");
    assert.equal(r.cancelled.length, 1);
    assert.equal((await row(o.id)).status, "cancelled");
    await assert.rejects(createOutreachDraft(db, t.id, OPTS), /is suppressed/, "and nothing new is prepared for it");
  });

  test("an opt-out reply suppresses the internal test's mailbox through the normal classification", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const t = await internal();
    const o = await queuedFor(t);
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    const thread = google.sent.find((s) => s.marker === o.id)!.threadId;
    google.inbox.push(inbound("opt-out", thread, { From: `Test <${MAILBOX}>`, Subject: `Re: ${o.subject}` }, [{ mimeType: "text/plain", text: "no thanks" }], "no thanks"));
    await pollGmailInbox(db, client, { apply: true });
    const reply = await db.outreachReply.findFirstOrThrow({ where: { outreachId: o.id } });
    await classifyReply(db, o.id, "do_not_contact", new Date(), reply.id);
    assert.ok(await db.emailSuppression.findUnique({ where: { email: MAILBOX } }), "the mailbox is suppressed");
    await assert.rejects(createOutreachDraft(db, t.id, OPTS), /suppressed|never be contacted|already sent/);
  });

  test("an internal test goes through the real dispatcher and Gmail adapter, to its mailbox only, and uses the daily limit like any send", async () => {
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
    assert.match(Buffer.from(google.sent[0]!.raw, "base64url").toString("utf8"), /^To: reclaimbay\.test@gmail\.com\r?$/m, "addressed to the controlled mailbox");
    const sentRow = await row(to.id);
    assert.equal(sentRow.status, "sent");
    assert.ok(sentRow.providerMessageId && sentRow.sendStartedAt && sentRow.provider === "gmail", "the usual audit fields");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: t.id } })).status, "contacted");

    // It used the day's only slot: the internal test isn't exempt from the limit.
    assert.deepEqual(await dailyCapacity(db, limitOne, new Date()), { used: 1, limit: 1, remaining: 0 });
    const second = await dispatchQueued(db, { config: limitOne, sender });
    assert.equal(second.sent.length, 0);
    assert.equal((await row(tp.id)).status, "queued", "the real message waits for tomorrow's limit");
    await assert.rejects(createOutreachDraft(db, t.id, OPTS), /already sent/, "no second first message");
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

  // ---------- metrics and the inbox ----------

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
    google.inbox.push(inbound("test-reply", thread(to), { From: `Me <${MAILBOX}>`, Subject: "Re: Declined work" }, [{ mimeType: "text/plain", text: "Internal test reply." }], "Internal test reply."));
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

  test("its own form shows the fixed identity and asks only for the explicit confirmation", async () => {
    const page = (await get("/admin/prospects/internal-test")).body;
    assert.match(page, /Add internal outreach test/);
    assert.match(page, /name="confirmInternalTest" value="yes"/);
    assert.match(page, /ReclaimBay Internal Test/);
    assert.match(page, /reclaimbay\.test@gmail\.com/);
    assert.match(page, /href="https:\/\/reclaimbay\.com\/internal-test-contact"/);
    assert.doesNotMatch(page, /name="email"|name="businessName"|name="signal_/, "no business fields");

    const refused = await post("/admin/prospects/internal-test", {});
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /Confirm that this is ReclaimBay(&#39;|')s own internal outreach test/);
    const realEmail = await post("/admin/prospects/internal-test", { ...{ confirmInternalTest: "yes" }, email: "owner@smithauto.example.com" });
    assert.equal(realEmail.statusCode, 400);
    assert.equal(await db.prospect.count(), 0);

    // The normal form never marks a prospect, whatever it is sent.
    const normal = await post("/admin/prospects", form({ internalTest: "true", confirmInternalTest: "yes" }));
    assert.equal(normal.statusCode, 303);
    assert.equal(await db.prospect.count({ where: { internalTest: true } }), 0);

    const created = await post("/admin/prospects/internal-test", { confirmInternalTest: "yes" });
    assert.equal(created.statusCode, 303);
    const t = await db.prospect.findFirstOrThrow({ where: { internalTest: true } });
    assert.match(String(created.headers.location), new RegExp(`/admin/prospects/${t.id}`));
    assert.deepEqual([t.businessName, t.email, t.emailSourceUrl], [NAME, MAILBOX, CONTACT_PAGE]);
    assert.equal((await post("/admin/prospects/internal-test", { confirmInternalTest: "yes" })).statusCode, 409, "only one");

    const detail = (await get(`/admin/prospects/${t.id}`)).body;
    assert.match(detail, />Internal test</);
    assert.match(detail, /<b>Internal outreach test\.<\/b>/);
    assert.match(detail, /Internal test identity/);
    assert.doesNotMatch(detail, /href="\/admin\/prospects\/[^"]+\/edit"/, "no Edit");
    assert.doesNotMatch(detail, /action="\/admin\/prospects\/[^"]+\/evidence"/, "no evidence form");
    assert.doesNotMatch(detail, /class="card verdict/, "no business qualification verdict");
    const list = (await get("/admin/prospects")).body;
    assert.equal((list.match(/>Internal test</g) ?? []).length, 1, "only the internal test is tagged in the list");

    // No edit page, and an edit posted anyway is refused; the mark stays.
    const edit = await get(`/admin/prospects/${t.id}/edit`);
    assert.equal(edit.statusCode, 303);
    assert.equal((await post(`/admin/prospects/${t.id}`, form({ internalTest: "false" }))).statusCode, 400);
    const after = await db.prospect.findUniqueOrThrow({ where: { id: t.id } });
    assert.deepEqual([after.internalTest, after.email], [true, MAILBOX]);
  });
});
