import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { hashInvitationToken } from "../../src/invitations/tokens.js";
import { ingestBusinesses } from "../../src/discovery/service.js";
import type { OutreachFact } from "../../src/outreach/compose.js";
import {
  createOutreachDraft,
  discardOutreach,
  previewOutreachDraft,
  applyProviderEvent,
  queueOutreach,
  recordReply,
} from "../../src/outreach/service.js";
import { addEvidence, changeStatus, createProspect } from "../../src/prospects.js";
import { enqueueResearch, processResearch } from "../../src/research/service.js";
import { fixtureWeb, independentShop } from "../fixtures/researchSite.js";
import { TEST_DATABASE_URL, WEBSITE, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, mockSender, queueAndSend } from "./outreachHelpers.js";

/*
 * Outreach through the real service and admin, against a disposable
 * database. Nothing here reaches a real provider: messages are sent only
 * through the dispatcher with the mock sender, and any network call made
 * while drafting fails the test.
 */

const EMAIL = "service@smithauto.example.com";
const emailForm = (over: Record<string, string> = {}) => readyForm({ email: EMAIL, emailSourceUrl: `${WEBSITE}/contact`, ...over });

/** Fails the test on any network call while it is installed. */
function forbidNetwork() {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    throw new Error("network call during outreach");
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

describe("outreach (service)", { skip: skipReason }, () => {
  let db: Db;
  let net: ReturnType<typeof forbidNetwork>;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    net = forbidNetwork();
  });
  afterEach(() => {
    net.restore();
    assert.deepEqual(net.calls, [], "no network call was made");
  });
  after(async () => db?.$disconnect());

  /** A qualified prospect with a published email and evidence for its signals. */
  const prospect = async (over: Record<string, string> = {}, evidence = true) => {
    const p = await createProspect(db, emailForm(over));
    if (evidence) {
      await addFixtureCollisionEvidence(db, p);
      await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${WEBSITE}/about`, excerpt: "Family owned and operated since 1998." });
      await addEvidence(db, p.id, { signalKey: "general_repair_services", sourceUrl: `${WEBSITE}/services`, excerpt: "Brakes, diagnostics, and A/C repair." });
    }
    return p;
  };
  const toReady = async (id: string) => {
    await changeStatus(db, id, "qualified", null);
    await changeStatus(db, id, "ready_to_contact", null);
  };
  /** A draft queued and sent through the real dispatcher, with the mock provider. */
  const sent = async (id: string) => {
    const { outreach } = await createOutreachDraft(db, id, OPTS);
    const report = await queueAndSend(db, outreach.id);
    assert.equal(report.sent.length, 1, JSON.stringify(report));
    return outreach;
  };

  test("a qualified prospect with a published email gets a stored draft, tied to it", async () => {
    const p = await prospect();
    const { outreach: o, created } = await createOutreachDraft(db, p.id, OPTS);
    assert.equal(created, true);
    assert.equal(o.prospectId, p.id);
    assert.equal(o.status, "draft");
    assert.equal(o.kind, "initial");
    assert.equal(o.template, "intro@t2");
    assert.equal(o.campaign, "outreach-intro-t2");
    assert.equal(o.recipientEmail, EMAIL);
    assert.equal(o.recipientSourceUrl, `${WEBSITE}/contact`);
    assert.equal(o.subject, "Quick question about Smith Auto");
    // Its one link is its own invitation, made with it: the stored hash is the hash of the token in the link.
    const token = /https:\/\/reclaimbay\.com\/invite#([A-Za-z0-9_-]{43})\n/.exec(o.body)?.[1];
    assert.ok(token, "the message links its invitation");
    const invitation = await db.invitation.findUniqueOrThrow({ where: { outreachId: o.id } });
    assert.equal(invitation.tokenHash, hashInvitationToken(token));
    assert.equal(invitation.campaign, "outreach-intro-t2");
    assert.ok(!o.body.includes("?ref="), "no referral link alongside it");
    assert.equal(o.openForProspectId, p.id);
    assert.ok(o.generatedAt instanceof Date);
    assert.equal(o.sentAt, null);

    const stored = await db.outreach.findUniqueOrThrow({ where: { id: o.id }, include: { events: true } });
    assert.equal(stored.body, o.body);
    assert.deepEqual(stored.events.map((e) => e.type), ["drafted"]);
  });

  test("the draft rests only on supported evidence", async () => {
    // digital_inspections is "yes" in the form but has no evidence: it must not appear.
    const p = await prospect();
    const { outreach: o } = await createOutreachDraft(db, p.id, OPTS);
    const facts = o.evidence as unknown as OutreachFact[];
    // intro@t2 relies on the business, its address, that it is independent, and its city, in the order it says them.
    assert.deepEqual(facts.map((f) => f.key), ["business_name", "recipient", "independent_shop", "location"]);
    assert.doesNotMatch(o.body, /inspection/i);
    const evidence = await db.prospectEvidence.findMany({ where: { prospectId: p.id } });
    // General repair is still evidenced and still supports a fact; intro@t2 just doesn't mention services.
    assert.ok(evidence.some((e) => e.signalKey === "general_repair_services"), "the prospect's general-repair evidence is kept");
    assert.ok(!facts.some((f) => f.key === "general_repair_services"));
    assert.doesNotMatch(o.body, /brakes|diagnostics|general repair/i, "the message names no services");
    for (const f of facts.filter((f) => f.signalKey)) {
      assert.ok(evidence.some((e) => e.signalKey === f.signalKey && e.sourceUrl === f.sourceUrl && e.excerpt === f.excerpt), f.key);
    }
  });

  test("drafting changes nothing about the prospect", async () => {
    const p = await prospect();
    const before = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true, evidence: true, notes: true, statusChanges: true } });
    await createOutreachDraft(db, p.id, OPTS);
    const after = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true, evidence: true, notes: true, statusChanges: true } });
    assert.deepEqual(after, before);
  });

  test("repeating the draft, even concurrently, returns the one open draft", async () => {
    const p = await prospect();
    const first = await createOutreachDraft(db, p.id, OPTS);
    const again = await createOutreachDraft(db, p.id, OPTS);
    assert.equal(again.created, false);
    assert.equal(again.outreach.id, first.outreach.id);
    const racing = await Promise.all([1, 2, 3].map(() => createOutreachDraft(db, p.id, OPTS)));
    assert.ok(racing.every((r) => r.outreach.id === first.outreach.id && !r.created));
    assert.equal(await db.outreach.count(), 1);
    assert.equal(await db.outreachEvent.count(), 1);

    const q = await prospect({ businessName: "Other Auto", website: "https://otherauto.example.com", phoneSourceUrl: "https://otherauto.example.com/contact" });
    const both = await Promise.all([1, 2, 3, 4].map(() => createOutreachDraft(db, q.id, OPTS)));
    assert.equal(both.filter((r) => r.created).length, 1);
    assert.equal(await db.outreach.count({ where: { prospectId: q.id } }), 1);
  });

  test("attempts coexist and history is never overwritten", async () => {
    const p = await prospect();
    const first = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    await discardOutreach(db, first.id, "Wrong tone.");
    const second = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    assert.notEqual(second.id, first.id);

    const old = await db.outreach.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(old.status, "cancelled");
    assert.equal(old.cancelReason, "Wrong tone.");
    assert.equal(old.body, first.body);
    assert.equal(old.openForProspectId, null);
    assert.equal(await db.outreach.count({ where: { prospectId: p.id } }), 2);
    assert.equal((await discardOutreach(db, first.id)).changed, false, "discarding twice is a no-op");
  });

  test("the lifecycle: queue -> sent (prospect Contacted) -> delivered -> follow-up -> reply", async () => {
    const p = await prospect();
    const first = await sent(p.id);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "contacted", "a send moves Ready to contact to Contacted");
    await applyProviderEvent(db, { provider: "mock", type: "delivered", providerMessageId: `msg-${first.id}` });

    const repeat = await applyProviderEvent(db, { provider: "mock", type: "delivered", providerMessageId: `msg-${first.id}` });
    assert.equal(repeat.result, "duplicate", "a repeated provider report is a no-op");

    const follow = await createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: first.id });
    assert.equal(follow.created, true);
    assert.equal(follow.outreach.kind, "follow_up");
    assert.equal(follow.outreach.followUpOfId, first.id);
    assert.equal(follow.outreach.subject, "Re: Quick question about Smith Auto");
    const dup = await createOutreachDraft(db, p.id, OPTS);
    assert.equal(dup.created, false, "the open follow-up is returned, not a second message");
    assert.equal(dup.outreach.id, follow.outreach.id);

    const original = await db.outreach.findUniqueOrThrow({ where: { id: first.id }, include: { events: { orderBy: { createdAt: "asc" } } } });
    assert.equal(original.status, "delivered");
    assert.equal(original.body, first.body, "the first message is untouched");
    assert.deepEqual(original.events.map((e) => e.type), ["drafted", "queued", "sent", "delivered"]);
    assert.equal(original.providerMessageId, `msg-${first.id}`);

    await recordReply(db, first.id, { outcome: "interested", summary: "Asked for a demo." });
    const replied = await db.outreach.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(replied.status, "replied");
    assert.equal(replied.replyOutcome, "interested");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "engaged");
    const history = await db.prospectStatusChange.findMany({ where: { prospectId: p.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(history.map((h) => h.toStatus), ["new", "qualified", "ready_to_contact", "contacted", "engaged"]);
    assert.match(history.at(-1)!.reason!, /Replied to outreach: Interested/);
  });

  test("outcomes after a reply: Meeting, Proposal, Customer by hand; Not interested -> Lost", async () => {
    const p = await prospect();
    const o = await sent(p.id);
    await recordReply(db, o.id, { outcome: "other" });
    for (const s of ["meeting", "proposal", "customer"]) await changeStatus(db, p.id, s, null);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "customer");

    // Another business, with its own address: an address is only ever emailed for one business.
    const q = await prospect({ businessName: "Lost Auto", email: "service@lostauto.example.com" });
    const m = await sent(q.id);
    await recordReply(db, m.id, { outcome: "not_interested" });
    const lost = await db.prospect.findUniqueOrThrow({ where: { id: q.id }, include: { statusChanges: { orderBy: { createdAt: "desc" }, take: 1 } } });
    assert.equal(lost.status, "lost");
    assert.match(lost.statusChanges[0]!.reason!, /Not interested/);
  });

  test("'asked not to be contacted' makes the prospect Do not contact and cancels anything open", async () => {
    const p = await prospect();
    const o = await sent(p.id);
    const follow = (await createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: o.id })).outreach;
    // The follow-up is open; the reply to the first message arrives.
    await recordReply(db, o.id, { outcome: "do_not_contact", summary: "Please remove us." });
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "do_not_contact");
    const cancelled = await db.outreach.findUniqueOrThrow({ where: { id: follow.id } });
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.cancelReason!, /suppressed \(unsubscribed\)|Do not contact/);
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: EMAIL } })).reason, "unsubscribed");
    await assert.rejects(createOutreachDraft(db, p.id, OPTS), /must never be contacted/);
  });

  test("a person moving the prospect out of outreach cancels its open draft", async () => {
    const p = await prospect();
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await changeStatus(db, p.id, "archived", null);
    const o = await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } });
    assert.equal(o.status, "cancelled");
    assert.equal(o.openForProspectId, null);
    await assert.rejects(queueOutreach(db, outreach.id, CFG), /this one is Archived|from Cancelled to Queued/);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } })).status, "cancelled");
  });

  test("ineligible prospects can't enter outreach", async () => {
    const unverified = await prospect({ businessName: "Unverified Auto", signal_collision_repair_services: "unknown" });
    await assert.rejects(createOutreachDraft(db, unverified.id, OPTS), /Outreach requires Qualification "Meets criteria"; this prospect is Unverified/);

    const phoneOnly = await createProspect(db, readyForm({ businessName: "Phone Only Auto" }));
    await assert.rejects(createOutreachDraft(db, phoneOnly.id, OPTS), /public business email/);

    const dnc = await prospect({ businessName: "Never Auto" });
    await changeStatus(db, dnc.id, "do_not_contact", "Asked by phone.");
    await assert.rejects(createOutreachDraft(db, dnc.id, OPTS), /must never be contacted/);

    const contacted = await prospect({ businessName: "Called Auto" });
    await toReady(contacted.id);
    await changeStatus(db, contacted.id, "contacted", null);
    await assert.rejects(createOutreachDraft(db, contacted.id, OPTS), /only prepared for New, Qualified, Ready to contact/);

    assert.equal(await db.outreach.count(), 0);
    await assert.rejects(createOutreachDraft(db, "00000000-0000-4000-8000-000000000000", OPTS), /Prospect not found/);
  });

  test("a draft can't skip the lifecycle; queueing moves the prospect to Ready to contact", async () => {
    const p = await prospect();
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "sent", outreachId: outreach.id, providerMessageId: "x" })).result, "ignored", "a draft was never handed over");
    await assert.rejects(recordReply(db, outreach.id, { outcome: "interested" }), /from Draft to Replied/);
    const preview = await previewOutreachDraft(db, p.id, { ...OPTS, followUpOfId: outreach.id });
    assert.ok(preview.errors.some((e) => /Only a sent message without a reply can be followed up; that one is Draft/.test(e)));
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } })).status, "draft");

    await queueOutreach(db, outreach.id, CFG);
    const history = await db.prospectStatusChange.findMany({ where: { prospectId: p.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(history.map((h) => h.toStatus), ["new", "qualified", "ready_to_contact"]);
    assert.match(history.at(-1)!.reason!, /Outreach queued \(intro@t2\)/);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } })).status, "queued");
  });

  test("after a bounce, no new message goes to the same address; a first message is never repeated", async () => {
    const p = await prospect();
    const o = await sent(p.id);
    await applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: `msg-${o.id}`, reason: "550 mailbox unavailable" });
    const bounced = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(bounced.failureReason, "550 mailbox unavailable");
    await assert.rejects(createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: o.id }), /bounced/);

    // The bounced address is suppressed everywhere, even on another prospect.
    const sameAddress = await prospect({ businessName: "Same Inbox Auto" });
    await assert.rejects(createOutreachDraft(db, sameAddress.id, OPTS), /suppressed \(bounced\)/);

    const q = await prospect({ businessName: "Second Auto", email: "hello@secondauto.example.com" });
    const m = await sent(q.id);
    const preview = await previewOutreachDraft(db, q.id, OPTS);
    assert.ok(preview.errors.some((e) => /only prepared for New/.test(e)));
    assert.ok(preview.errors.some((e) => /A first message was already sent on/.test(e)));
    assert.equal(m.kind, "initial");
  });

  test("approval behaves as before: an automatically approved prospect gets no outreach", async () => {
    net.restore();
    const HOST = "saviersauto.example.com";
    const b = {
      externalId: "ab000000-0000-4000-8000-000000000001",
      businessName: "Saviers Road Auto Repair",
      website: `https://${HOST}/`,
      streetAddress: "5577 Saviers Rd",
      city: "Oxnard",
      state: "CA",
      postalCode: "93033",
      country: "US",
      phone: "+18055550101",
      category: "automotive_repair",
      categoryTier: "core" as const,
    };
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [b]);
    const c = await db.discoveryCandidate.findFirstOrThrow({ where: { externalId: b.externalId } });
    const [q] = (await enqueueResearch(db, [c.id], "admin")).queued;
    await processResearch(db, q!.researchId, { makeFetcher: fixtureWeb(independentShop(HOST)).makeFetcher, today: new Date("2026-10-01T12:00:00Z") });
    const approved = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(approved.status, "approved");
    const pr = await db.prospect.findUniqueOrThrow({ where: { id: approved.prospectId! } });
    assert.equal(pr.status, "new");
    assert.equal(await db.outreach.count(), 0);
    net = forbidNetwork();
  });
});

describe("outreach (admin HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  let net: ReturnType<typeof forbidNetwork>;
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }), db, false);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => {
    await truncate(db);
    net = forbidNetwork();
  });
  afterEach(() => {
    net.restore();
    assert.deepEqual(net.calls, [], "no network call was made");
  });
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, body: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: new URLSearchParams(body).toString() });

  test("an administrator prepares a draft from the prospect page, reads it, and repeating changes nothing", async () => {
    const p = await createProspect(db, emailForm());
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${WEBSITE}/about`, excerpt: "Family owned." });

    const page = (await get(`/admin/prospects/${p.id}`)).body;
    assert.match(page, /<h2 id="outreach-h">Outreach/);
    assert.match(page, /Prepare outreach draft/);
    assert.match(page, /Nothing is emailed unless sending is switched on/);

    const res = await post(`/admin/prospects/${p.id}/outreach`);
    assert.equal(res.statusCode, 303);
    const o = await db.outreach.findFirstOrThrow({ where: { prospectId: p.id } });
    assert.equal(res.headers.location, `/admin/outreach/${o.id}?done=drafted`);

    const view = (await get(`/admin/outreach/${o.id}?done=drafted`)).body;
    assert.match(view, /Draft prepared from the stored evidence\. Nothing was sent\./);
    assert.match(view, /Quick question about Smith Auto/);
    assert.match(view, /I came across Smith Auto while researching independent shops in Springfield\./);
    assert.match(view, /Evidence used/);
    assert.match(view, /Family owned\./);
    assert.match(view, /<code>intro@t2<\/code>/);
    assert.match(view, /Discard/);
    assert.doesNotMatch(view, /Record a reply/, "a draft has no reply to record");

    const again = await post(`/admin/prospects/${p.id}/outreach`);
    assert.equal(again.headers.location, `/admin/outreach/${o.id}?done=existing`);
    assert.equal(await db.outreach.count(), 1);

    const after = (await get(`/admin/prospects/${p.id}`)).body;
    assert.match(after, /An unsent message is open/);
    assert.doesNotMatch(after, /Prepare outreach draft<\/button>/);
  });

  test("an ineligible prospect's page says why, and a draft request is refused", async () => {
    const p = await createProspect(db, readyForm());
    const page = (await get(`/admin/prospects/${p.id}`)).body;
    assert.match(page, /No draft can be prepared/);
    assert.match(page, /public business email/);
    const res = await post(`/admin/prospects/${p.id}/outreach`);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /public business email/);
    assert.equal(await db.outreach.count(), 0);
  });

  test("discarding keeps the record; there is no route that queues or sends", async () => {
    const p = await createProspect(db, emailForm());
    await post(`/admin/prospects/${p.id}/outreach`);
    const o = await db.outreach.findFirstOrThrow();
    const res = await post(`/admin/outreach/${o.id}/discard`, { reason: "Not now.", confirm: "1" });
    assert.equal(res.statusCode, 303);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: o.id } })).status, "cancelled");
    for (const path of ["send", "dispatch"]) assert.equal((await post(`/admin/outreach/${o.id}/${path}`)).statusCode, 404, path);
    assert.equal((await post(`/admin/outreach/${o.id}/queue`)).statusCode, 400, "a discarded message can't be queued");
    assert.equal((await get("/admin/outreach/not-a-uuid")).statusCode, 404);
  });

  test("a reply recorded in the admin moves the prospect", async () => {
    const p = await createProspect(db, emailForm());
    await addFixtureCollisionEvidence(db, p);
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueAndSend(db, outreach.id, mockSender());

    const view = (await get(`/admin/outreach/${outreach.id}`)).body;
    assert.match(view, /Record a reply/);
    assert.match(view, /Prepare follow-up draft/);
    assert.equal((await post(`/admin/outreach/${outreach.id}/reply`, { outcome: "" })).statusCode, 400);
    const res = await post(`/admin/outreach/${outreach.id}/reply`, { outcome: "interested", summary: "Wants to try it." });
    assert.equal(res.statusCode, 303);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "engaged");
  });
});
