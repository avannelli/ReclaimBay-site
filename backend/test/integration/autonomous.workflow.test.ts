import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { assessDiscovery, automationInclude } from "../../src/discovery/automationPolicy.js";
import { authorizeAutonomousCampaign, createProspectAutonomously, refusals, stopAutonomousCampaign } from "../../src/discovery/autonomous.js";
import { candidateProtection, protectionIndex } from "../../src/discovery/protection.js";
import { emergencyStop, launchAutonomousCampaign, runAutonomousCampaign } from "../../src/outreach/autonomousCampaign.js";
import { approvedMessageHash } from "../../src/outreach/campaigns.js";
import { dispatchQueued } from "../../src/outreach/dispatch.js";
import { sendingPolicy } from "../../src/outreach/policy.js";
import type { OutreachSender } from "../../src/outreach/sender.js";
import { classifyReply, createOutreachDraft, recordInboundReply } from "../../src/outreach/service.js";
import { enqueueResearch, processResearch, runAutoResearch } from "../../src/research/service.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import { fixtureWeb, independentShop } from "../fixtures/researchSite.js";
import { CFG, OPTS, mockSender, type MockSender } from "./outreachHelpers.js";
import { freshDb, skipReason, truncate, TEST_DATABASE_URL } from "./helpers.js";

/* M3: the autonomous campaign orchestration in the research worker, end to end with mocked web and Gmail. */

const DAY = 24 * 60 * 60 * 1000;
const gmail = (): MockSender & OutreachSender => Object.assign(mockSender(), { name: "gmail", check: async () => null });
const launchInput = (over: Record<string, unknown> = {}) => ({ name: "Workflow launch", prospectCap: 10, messageCap: 10, expiresAt: new Date(Date.now() + 7 * DAY), reason: "Mocked end-to-end run.", confirm: true, ...over });
const run = (db: Db, over: Partial<Parameters<typeof runAutonomousCampaign>[1]> = {}) => runAutonomousCampaign(db, { draft: OPTS, compliance: CFG, ...over });

describe("autonomous acquisition orchestration", { skip: skipReason }, () => {
  let db: Db, seq = 0;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); });
  after(async () => { await db?.$disconnect(); });

  /** A researched candidate passing the automatic-creation gate (stored as a current-rules read). */
  async function eligible(over: { email?: string } = {}) {
    const n = ++seq;
    const website = `https://flow${n}.example.com/`;
    const email = over.email ?? `service@flow${n}.example.com`;
    const c = await db.discoveryCandidate.create({ data: { businessName: `Harbor Garage ${n}`, nameKey: `harbor garage ${n}`, provider: "manual", city: "Ventura", state: "CA",
      streetAddress: `${n} Main St`, website, status: "researched", categoryVerdict: "in_target", categorySource: "website", websiteVerifiedAt: new Date(), email, emailSourceUrl: website } });
    const r = await db.candidateResearch.create({ data: { candidateId: c.id, version: RESEARCH_VERSION, status: "completed", outcome: "website_verified", trigger: "cli", subjectWebsite: website, warnings: [], finishedAt: new Date() } });
    const source = await db.researchSource.create({ data: { researchId: r.id, kind: "website", url: website, ok: true } });
    for (const [field, value, excerpt] of [["location_identity", "verified_location", null], ["ownership_class", "unknown", null], ["site_locations", "1", null], ["page_location", "own_location", null],
      ["commercial_quote", "observed", "We service all makes and models."], ["email", email, null]] as const)
      await db.researchFact.create({ data: { researchId: r.id, field, value, excerpt, state: "verified", sourceId: source.id } });
    await db.candidateSignal.create({ data: { candidateId: c.id, key: "automotive_repair_services", value: "yes", origin: "research" } });
    for (const excerpt of ["Names brakes: Brake repair for cars.", "Names engine: Engine repair for cars."])
      await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "automotive_repair_services", sourceUrl: website, excerpt, origin: "research", researchId: r.id } });
    return c;
  }
  const launch = (over: Record<string, unknown> = {}) => launchAutonomousCampaign(db, launchInput(over), CFG, gmail());
  const integrity = async () => ({
    prospects: await db.prospect.count(), campaignProspects: await db.outreachCampaignProspect.count(), drafts: await db.outreach.count({ where: { status: "draft" } }),
    queued: await db.outreach.count({ where: { status: "queued" } }), members: await db.outreachCampaignMessage.count(), campaigns: await db.outreachCampaign.count(),
  });

  test("Discovery → research → automatic prospect → personalized draft → campaign membership → Gmail dispatch → reply → stop", async () => {
    // Discovery and research (mocked website): a real current-rules read, nothing stored by hand.
    const c = await db.discoveryCandidate.create({ data: { businessName: "Saviers Road Auto Repair", nameKey: "saviers road auto repair", provider: "manual", city: "Oxnard", state: "CA",
      website: "https://saviersauto.example.com/", providerPhone: "8055550101", streetAddress: "5577 Saviers Rd" } });
    const web = fixtureWeb(independentShop());
    const queued = await enqueueResearch(db, [c.id], "scheduled");
    await processResearch(db, queued.queued[0]!.researchId, { makeFetcher: web.makeFetcher });
    const full = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: automationInclude });
    const decision = assessDiscovery(full, candidateProtection(full, await protectionIndex(db)));
    assert.deepEqual([decision.action, decision.code], ["ready", "qualified"], decision.reason);

    // One-click launch, then one armed worker run (the research pass finds nothing new; the campaign step runs).
    const sender = gmail();
    const campaign = await launchAutonomousCampaign(db, launchInput(), CFG, sender);
    let report: Awaited<ReturnType<typeof runAutonomousCampaign>> | null = null;
    const research = await runAutoResearch(db, { enabled: true, databaseUrl: TEST_DATABASE_URL, limit: 5, reserveMs: 60_000,
      afterResearch: async ({ shouldStop, deadline }) => { report = await run(db, { shouldStop, deadline }); } });
    assert.equal(research.outcome === "disabled" || research.outcome === "locked", false);
    assert.ok(report); const r = report as Awaited<ReturnType<typeof runAutonomousCampaign>>;
    assert.equal(r.outcome, "done"); assert.equal(r.created.length, 1); assert.equal(r.prepare!.committed.length, 1);

    const prospect = await db.prospect.findUniqueOrThrow({ where: { id: r.created[0]! } });
    assert.equal(prospect.status, "ready_to_contact"); assert.equal(prospect.email, "service@saviersauto.example.com");
    const [member] = await db.outreachCampaignMessage.findMany({ where: { campaignId: campaign.id }, include: { outreach: true } });
    assert.equal(member!.messageHash, approvedMessageHash(member!.outreach));
    assert.match(member!.outreach.body, /Saviers Road Auto Repair/, "personalized from the verified record");
    assert.match(member!.outreach.body, /reclaimbay\.com\/invite#/, "its invitation link");
    assert.equal(sender.calls.length, 0, "the worker never sends");

    // The existing sender job sends it through the (mock) Gmail provider.
    const sent = await dispatchQueued(db, { config: CFG, sender, limit: 5 });
    assert.equal(sent.sent.length, 1); assert.equal(sender.calls[0]!.to, "service@saviersauto.example.com");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).status, "contacted");

    // A reply arrives and asks not to be contacted: the prospect is closed and the address suppressed.
    await recordInboundReply(db, { fromEmail: "service@saviersauto.example.com", outreachId: member!.outreachId, summary: "Please remove us.", at: new Date() });
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).status, "engaged");
    await classifyReply(db, member!.outreachId, "do_not_contact");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).status, "do_not_contact");
    assert.ok(await db.emailSuppression.findFirst({ where: { email: "service@saviersauto.example.com" } }));

    // Emergency stop: nothing further is created, prepared or sent.
    await eligible();
    await emergencyStop(db, "End of the rehearsal.");
    const after = await run(db);
    assert.equal(after.outcome, "no_campaign"); assert.equal(after.created.length, 0);
    assert.deepEqual((await dispatchQueued(db, { config: CFG, sender, limit: 5 })).blockers, ["The global sending switch is off."]);
    assert.equal(sender.calls.length, 1);
  });

  describe("idempotence and concurrency", () => {
    test("repeated runs create, draft and queue nothing twice", async () => {
      for (let i = 0; i < 3; i++) await eligible();
      await launch();
      const first = await run(db);
      assert.equal(first.created.length, 3); assert.equal(first.prepare!.committed.length, 3);
      const state = await integrity();
      for (let i = 0; i < 3; i++) { const again = await run(db); assert.equal(again.created.length, 0); assert.equal(again.prepare!.committed.length, 0); }
      assert.deepEqual(await integrity(), state);
    });
    test("concurrent workers never duplicate prospects, drafts, memberships or queued messages", async () => {
      for (let i = 0; i < 4; i++) await eligible();
      await launch({ prospectCap: 3, messageCap: 3 });
      await Promise.allSettled([run(db), run(db), run(db)]);
      const s = await integrity();
      assert.deepEqual([s.prospects, s.campaignProspects, s.members, s.queued, s.campaigns], [3, 3, 3, 3, 1]);
      const open = await db.outreach.groupBy({ by: ["prospectId"], where: { status: { in: ["draft", "queued"] } }, _count: { _all: true } });
      assert.ok(open.every((g) => g._count._all === 1), "one open message per prospect");
    });
    test("an interrupted run (prospect created, draft made, not committed) is completed without duplication", async () => {
      const c = await eligible();
      const campaign = await launch();
      const { prospect } = await createProspectAutonomously(db, c.id, campaign.id);
      const { outreach } = await createOutreachDraft(db, prospect.id, OPTS);
      const r = await run(db);
      assert.deepEqual(r.prepare!.committed.map((x) => x.outreachId), [outreach.id]);
      assert.equal(await db.outreach.count({ where: { prospectId: prospect.id } }), 1);
    });
  });

  describe("failures, caps and halts", () => {
    test("one failing candidate is held and recorded; the others proceed; it is not retried until it changes", async () => {
      const bad = await eligible({ email: "not-an-email" });
      await eligible(); await eligible();
      const campaign = await launch();
      const r = await run(db);
      assert.equal(r.created.length, 2);
      assert.deepEqual(r.held.map((h) => h.candidateId), [bad.id]);
      const notes = refusals(await db.candidateNote.findMany({ where: { candidateId: bad.id } }));
      assert.equal(notes.length, 1); assert.equal(notes[0]!.campaignId, campaign.id);
      const again = await run(db);
      assert.deepEqual([again.held.length, again.failed.length, again.created.length], [0, 0, 0], "no retry loop");
      assert.equal(refusals(await db.candidateNote.findMany({ where: { candidateId: bad.id } })).length, 1);
      await db.discoveryCandidate.update({ where: { id: bad.id }, data: { researchRevision: { increment: 1 } } });
      assert.equal((await run(db)).held.length, 1, "a changed candidate is tried once more");
    });
    test("the prospect cap and message cap bound what the worker does", async () => {
      for (let i = 0; i < 3; i++) await eligible();
      await launch({ prospectCap: 2, messageCap: 1 });
      const r = await run(db);
      assert.equal(r.created.length, 2); assert.equal(r.prepare!.committed.length, 1); assert.match(r.prepare!.stoppedBecause ?? "", /message cap/);
      assert.equal((await run(db)).created.length, 0);
    });
    test("time budget and shutdown signals stop it between candidates", async () => {
      for (let i = 0; i < 3; i++) await eligible();
      await launch();
      let calls = 0;
      const stopped = await run(db, { shouldStop: () => ++calls > 1 });
      assert.equal(stopped.outcome, "shutdown"); assert.equal(stopped.created.length, 1); assert.equal(stopped.prepare, null);
      const late = await run(db, { deadline: Date.now() - 1 });
      assert.equal(late.outcome, "time_budget"); assert.equal(late.created.length, 0);
    });
    test("a stopped or expired campaign halts at once; an unlaunched one is never processed", async () => {
      await eligible();
      const authorized = await authorizeAutonomousCampaign(db, { ...launchInput(), via: "service" });
      assert.equal((await run(db)).outcome, "not_launched");
      assert.equal(await db.prospect.count(), 0);
      await stopAutonomousCampaign(db, authorized.id, "Not this one.");
      const campaign = await launch();
      const expiredAt = new Date(campaign.expiresAt!.getTime() + 1000);
      const expired = await run(db, { clock: () => expiredAt });
      assert.equal(expired.outcome, "no_campaign", "an expired campaign is no longer active"); assert.equal(await db.prospect.count(), 0);
      await stopAutonomousCampaign(db, campaign.id, "Operator pause.");
      assert.equal((await run(db)).outcome, "no_campaign"); assert.equal(await db.prospect.count(), 0);
    });
    test("the disarmed worker never runs the campaign step", async () => {
      await eligible(); await launch();
      let ran = false;
      const r = await runAutoResearch(db, { enabled: false, databaseUrl: TEST_DATABASE_URL, limit: 1, afterResearch: async () => { ran = true; } });
      assert.equal(r.outcome, "disabled"); assert.equal(ran, false); assert.equal(await db.prospect.count(), 0);
    });
  });
});

describe("autonomous campaign status on the Outreach page (HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  let db: Db, app: FastifyInstance, cookie = "";
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0",
      OUTREACH_SENDER_NAME: CFG.outreachSender.name!, OUTREACH_SENDER_EMAIL: CFG.outreachSender.email!, OUTREACH_POSTAL_ADDRESS: CFG.outreachSender.postalAddress!,
      PUBLIC_API_URL: CFG.publicApiUrl!, OUTREACH_SENDING_ENABLED: "1" }), db, false, { outreachSender: gmail() });
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => { await app?.close(); await db?.$disconnect(); });
  const page = async () => (await app.inject({ method: "GET", url: "/admin/outreach", headers: { cookie } })).body;

  test("shows authorization, caps, messages, replies and held candidates; after a stop, how to resolve queued messages", async () => {
    let n = 0;
    const make = async (email?: string) => {
      const website = `https://status${++n}.example.com/`;
      const mail = email ?? `service@status${n}.example.com`;
      const c = await db.discoveryCandidate.create({ data: { businessName: `Status Garage ${n}`, nameKey: `status garage ${n}`, provider: "manual", city: "Ventura", state: "CA", streetAddress: `${n} Oak St`,
        website, status: "researched", categoryVerdict: "in_target", categorySource: "website", websiteVerifiedAt: new Date(), email: mail, emailSourceUrl: website } });
      const r = await db.candidateResearch.create({ data: { candidateId: c.id, version: RESEARCH_VERSION, status: "completed", outcome: "website_verified", trigger: "cli", subjectWebsite: website, warnings: [], finishedAt: new Date() } });
      const s = await db.researchSource.create({ data: { researchId: r.id, kind: "website", url: website, ok: true } });
      for (const [field, value, excerpt] of [["location_identity", "verified_location", null], ["ownership_class", "unknown", null], ["site_locations", "1", null], ["page_location", "own_location", null],
        ["commercial_quote", "observed", "We service all makes and models."], ["email", mail, null]] as const)
        await db.researchFact.create({ data: { researchId: r.id, field, value, excerpt, state: "verified", sourceId: s.id } });
      await db.candidateSignal.create({ data: { candidateId: c.id, key: "automotive_repair_services", value: "yes", origin: "research" } });
      for (const excerpt of ["Names brakes: Brake repair for cars.", "Names engine: Engine repair for cars."])
        await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "automotive_repair_services", sourceUrl: website, excerpt, origin: "research", researchId: r.id } });
    };
    await make(); await make(); await make("not-an-email");
    await launchAutonomousCampaign(db, launchInput({ name: "Status launch", prospectCap: 5, messageCap: 4 }), CFG, gmail());
    await run(db);
    const live = await page();
    for (const s of ["Autonomous campaign: Status launch", "Authorization", "2 of 5 created", "2 of 4 committed", "2 queued", "0 sent", "Held candidates", "Status Garage 3 (held)", "Emergency stop"]) assert.ok(live.includes(s), s);
    await emergencyStop(db, "Status page check.");
    const stopped = await page();
    assert.match(stopped, /2 message\(s\) of this stopped campaign are still queued/);
    assert.match(stopped, /href="\/admin\/outreach\/messages\?status=queued"/);
    assert.match(stopped, /Nothing already queued/, "the next launch's preflight names the blocker");
    assert.equal((await sendingPolicy(db)).enabled, false);
  });
});
