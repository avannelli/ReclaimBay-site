import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { authorizeAutonomousCampaign, createProspectAutonomously, stopAutonomousCampaign } from "../../src/discovery/autonomous.js";
import { commitCampaignMessage, emergencyStop, launchAutonomousCampaign, launchPreflight, prepareCampaignOutreach } from "../../src/outreach/autonomousCampaign.js";
import { approvedMessageHash } from "../../src/outreach/campaigns.js";
import { dispatchQueued } from "../../src/outreach/dispatch.js";
import { appendSendingControlInTx, sendingPolicy, setDailyLimit } from "../../src/outreach/policy.js";
import { lockSendGate, suppressEmail } from "../../src/outreach/records.js";
import type { OutreachSender } from "../../src/outreach/sender.js";
import { createOutreachDraft, discardOutreach } from "../../src/outreach/service.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import { CFG, OPTS, mockSender, type MockSender } from "./outreachHelpers.js";
import { freshDb, skipReason, truncate, TEST_DATABASE_URL } from "./helpers.js";

/* M2: automatic campaign membership, one-click launch and emergency stop. No real provider exists here. */

const DAY = 24 * 60 * 60 * 1000;
const gmail = (problem: string | null = null): MockSender & OutreachSender => Object.assign(mockSender(), { name: "gmail", check: async () => problem });
const launchInput = (over: Record<string, unknown> = {}) => ({ name: "Ventura launch", prospectCap: 10, messageCap: 10, expiresAt: new Date(Date.now() + 7 * DAY), reason: "Bounded autonomous test.", confirm: true, ...over });
const prep = { draft: OPTS, compliance: CFG };

describe("autonomous campaigns: membership, launch and emergency stop", { skip: skipReason }, () => {
  let db: Db, seq = 0;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); });
  after(async () => { await db?.$disconnect(); });

  /** A researched candidate that passes the automatic-creation gate (as in the M1 tests). */
  async function eligible() {
    const n = ++seq;
    const website = `https://launch${n}.example.com/`;
    const email = `service@launch${n}.example.com`;
    const c = await db.discoveryCandidate.create({ data: { businessName: `Harbor Garage ${n}`, nameKey: `harbor garage ${n}`, provider: "manual", city: "Ventura", state: "CA",
      streetAddress: `${n} Main St`, website, status: "researched", categoryVerdict: "in_target", categorySource: "website", websiteVerifiedAt: new Date(), email, emailSourceUrl: website } });
    const run = await db.candidateResearch.create({ data: { candidateId: c.id, version: RESEARCH_VERSION, status: "completed", outcome: "website_verified", trigger: "cli", subjectWebsite: website, warnings: [], finishedAt: new Date() } });
    const source = await db.researchSource.create({ data: { researchId: run.id, kind: "website", url: website, ok: true } });
    for (const [field, value, excerpt] of [["location_identity", "verified_location", null], ["ownership_class", "unknown", null], ["site_locations", "1", null], ["page_location", "own_location", null],
      ["commercial_quote", "observed", "We service all makes and models."], ["email", email, null]] as const)
      await db.researchFact.create({ data: { researchId: run.id, field, value, excerpt, state: "verified", sourceId: source.id } });
    await db.candidateSignal.create({ data: { candidateId: c.id, key: "automotive_repair_services", value: "yes", origin: "research" } });
    for (const excerpt of ["Names brakes: Brake repair for cars.", "Names engine: Engine repair for cars."])
      await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "automotive_repair_services", sourceUrl: website, excerpt, origin: "research", researchId: run.id } });
    return c;
  }
  /** Launch, then create `n` prospects under the campaign. */
  async function launched(n: number, over: Record<string, unknown> = {}, sender = gmail()) {
    const candidates = []; for (let i = 0; i < n; i++) candidates.push(await eligible());
    const campaign = await launchAutonomousCampaign(db, launchInput(over), CFG, sender);
    const prospects = []; for (const c of candidates) prospects.push((await createProspectAutonomously(db, c.id, campaign.id)).prospect);
    return { campaign, prospects, sender };
  }
  const members = (campaignId: string) => db.outreachCampaignMessage.findMany({ where: { campaignId }, include: { outreach: true } });
  const controls = () => db.outreachControlChange.count();
  /** Dispatch at a time far enough after the last claim for the 60-second pacing. */
  const dispatch = async (sender: OutreachSender, at?: Date) => {
    const latest = await db.outreach.findFirst({ where: { sendStartedAt: { not: null } }, orderBy: { sendStartedAt: "desc" } });
    const now = at ?? new Date(Math.max(Date.now(), (latest?.sendStartedAt?.getTime() ?? 0) + 61_000));
    return dispatchQueued(db, { config: CFG, sender, limit: 1, now: () => now });
  };

  describe("preflight", () => {
    test("passes only when every blocking check passes", async () => {
      await eligible();
      const ok = await launchPreflight(db, CFG, gmail());
      assert.equal(ok.ok, true, ok.blockers.join(" "));
      assert.equal(ok.eligibleCandidates, 1); assert.equal(ok.commercialMinimum, "medium"); assert.equal(ok.capacity.limit, 25); assert.equal(ok.minSendIntervalSeconds, 60);
      assert.ok(ok.checks.some((c) => c.key === "scheduled_arm" && !c.blocking), "the other services' arms are stated, not assumed");
    });
    test("fails closed on each unsafe condition", async () => {
      assert.match((await launchPreflight(db, CFG, gmail())).blockers.join(" "), /Eligible candidates/, "nothing to send");
      await eligible();
      assert.match((await launchPreflight(db, { ...CFG, outreachSendingArmed: false }, gmail())).blockers.join(" "), /sending arm/);
      assert.match((await launchPreflight(db, CFG, gmail("Authorization revoked."))).blockers.join(" "), /Gmail provider: Authorization revoked/);
      assert.match((await launchPreflight(db, CFG, mockSender())).blockers.join(" "), /not Gmail/);
      assert.match((await launchPreflight(db, { ...CFG, outreachSender: { ...CFG.outreachSender, postalAddress: null } }, gmail())).blockers.join(" "), /Sender identity/);
      await setDailyLimit(db, 1, "Tight limit.");
      const p = await db.prospect.create({ data: { referralCode: "capacity-user", businessName: "Used capacity", city: "Ventura", state: "CA" } });
      await db.outreach.create({ data: { prospectId: p.id, kind: "initial", template: "fixture", subject: "s", body: "b", evidence: [], generatedAt: new Date(), recipientEmail: "used@example.com", recipientSourceUrl: "https://x.example.com", status: "queued", sendStartedAt: new Date(), sendAttempts: 1 } });
      const blocked = (await launchPreflight(db, CFG, gmail())).blockers.join(" ");
      assert.match(blocked, /Daily sending capacity/); assert.match(blocked, /Nothing already queued/);
    });
    test("a switch already on, or another active autonomous campaign, blocks", async () => {
      await eligible();
      await db.$transaction(async (tx) => { await lockSendGate(tx); await appendSendingControlInTx(tx, { enabled: true }, "On for another campaign.", new Date()); });
      assert.match((await launchPreflight(db, CFG, gmail())).blockers.join(" "), /Sending switch/);
      await db.$transaction(async (tx) => { await lockSendGate(tx); await appendSendingControlInTx(tx, { enabled: false }, "Off.", new Date()); });
      await authorizeAutonomousCampaign(db, { ...launchInput(), via: "service" });
      assert.match((await launchPreflight(db, CFG, gmail())).blockers.join(" "), /No other autonomous campaign/);
    });
  });

  describe("launch", () => {
    test("the confirmation authorizes the campaign and switches sending on for it, together", async () => {
      await eligible();
      const before = await controls();
      const campaign = await launchAutonomousCampaign(db, launchInput({ prospectCap: 3, messageCap: 2 }), CFG, gmail());
      assert.deepEqual([campaign.mode, campaign.authorizedVia, campaign.prospectCap, campaign.messageCap, campaign.commercialMinimum], ["autonomous", "admin", 3, 2, "medium"]);
      const policy = await sendingPolicy(db);
      assert.deepEqual([policy.enabled, policy.activeCampaignId], [true, campaign.id]);
      assert.match(policy.reason, /launched: up to 3 prospects and 2 messages/);
      assert.equal(await controls(), before + 1, "one switch change");
      assert.equal(await db.outreach.count(), 0, "launching prepares and sends nothing");
    });
    test("refused without confirmation or with a failing preflight: no campaign, no switch change", async () => {
      await eligible();
      await assert.rejects(launchAutonomousCampaign(db, launchInput({ confirm: false }), CFG, gmail()), /explicitly confirm/);
      await assert.rejects(launchAutonomousCampaign(db, launchInput(), { ...CFG, outreachSendingArmed: false }, gmail()), /can't be launched yet[\s\S]*sending arm/);
      await assert.rejects(launchAutonomousCampaign(db, launchInput({ prospectCap: 0 }), CFG, gmail()), /Prospect cap/);
      assert.equal(await db.outreachCampaign.count(), 0); assert.equal(await controls(), 0);
    });
    test("concurrent launches: exactly one campaign and one switch change", async () => {
      await eligible();
      const results = await Promise.allSettled([1, 2, 3].map((i) => launchAutonomousCampaign(db, launchInput({ name: `Launch ${i}` }), CFG, gmail())));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(await db.outreachCampaign.count(), 1); assert.equal(await controls(), 1);
    });
  });

  describe("membership and sending", () => {
    test("campaign prospects get the standard first message, queued with its fingerprint, and the dispatcher sends it", async () => {
      const { campaign, prospects, sender } = await launched(2);
      const r = await prepareCampaignOutreach(db, campaign.id, prep);
      assert.equal(r.committed.length, 2); assert.equal(r.stoppedBecause, null);
      for (const m of await members(campaign.id)) {
        assert.equal(m.outreach.status, "queued"); assert.equal(m.outreach.template, "intro@t4"); assert.equal(m.messageHash, approvedMessageHash(m.outreach));
        assert.ok(await db.invitation.findUnique({ where: { outreachId: m.outreachId } }), "its invitation");
      }
      for (const p of prospects) assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "ready_to_contact");
      assert.equal((await dispatch(sender)).sent.length, 1);
      assert.equal((await dispatch(sender)).sent.length, 1);
      assert.equal(sender.calls.length, 2);
      assert.deepEqual(new Set(sender.calls.map((c) => c.to)), new Set(prospects.map((p) => p.email)));
      assert.equal((await prepareCampaignOutreach(db, campaign.id, prep)).committed.length, 0, "repeating prepares nothing more");
    });
    test("fingerprint integrity: a message changed after commit is never sent", async () => {
      const { campaign, sender } = await launched(1);
      await prepareCampaignOutreach(db, campaign.id, prep);
      const [m] = await members(campaign.id);
      await db.outreach.update({ where: { id: m!.outreachId }, data: { body: `${m!.outreach.body}\nP.S. edited` } });
      const r = await dispatch(sender);
      assert.match(r.stoppedBecause ?? "", /changed after campaign approval/);
      assert.equal(sender.calls.length, 0);
    });
    test("unauthorized sending: an authorized but unlaunched campaign commits nothing; a message outside the campaign is never sent", async () => {
      const c = await eligible();
      const campaign = await authorizeAutonomousCampaign(db, { ...launchInput(), via: "service" });
      await createProspectAutonomously(db, c.id, campaign.id);
      const r = await prepareCampaignOutreach(db, campaign.id, prep);
      assert.match(r.stoppedBecause ?? "", /not the active sending campaign/); assert.equal(await db.outreach.count(), 0, "no draft for an unlaunched campaign");
      const sender = gmail();
      assert.equal((await dispatch(sender)).sent.length, 0);
      // Launched, but a queued message that never joined the campaign.
      await stopAutonomousCampaign(db, campaign.id, "Replaced.");
      await eligible();
      const { campaign: live } = await launched(0);
      const outsider = await db.prospect.create({ data: { referralCode: "outsider", businessName: "Outsider", city: "Ventura", state: "CA" } });
      await db.outreach.create({ data: { prospectId: outsider.id, kind: "initial", template: "intro@t4", campaign: live.attributionCampaign, subject: "s", body: "b", evidence: [], generatedAt: new Date(), recipientEmail: "outsider@example.com", recipientSourceUrl: "https://o.example.com", status: "queued", queuedAt: new Date() } });
      assert.equal((await dispatch(sender)).sent.length, 0); assert.equal(sender.calls.length, 0);
      await assert.rejects(commitCampaignMessage(db, live.id, (await db.outreach.findFirstOrThrow({ where: { prospectId: outsider.id } })).id, CFG), /not created by this campaign/);
    });
  });

  describe("message cap", () => {
    test("committed messages, including cancelled ones, count against the cap", async () => {
      const { campaign } = await launched(3, { messageCap: 2 });
      const r = await prepareCampaignOutreach(db, campaign.id, prep);
      assert.equal(r.committed.length, 2); assert.match(r.stoppedBecause ?? "", /message cap \(2\) is reached/);
      assert.equal(await db.outreach.count({ where: { status: "queued" } }), 2);
      const [first] = await members(campaign.id);
      await discardOutreach(db, first!.outreachId, "Operator discarded.");
      const again = await prepareCampaignOutreach(db, campaign.id, prep);
      assert.equal(again.committed.length, 0); assert.match(again.stoppedBecause ?? "", /message cap/);
      assert.equal((await members(campaign.id)).length, 2);
    });
    test("concurrent preparations never exceed the cap or commit a prospect twice", async () => {
      const { campaign } = await launched(4, { messageCap: 2 });
      await Promise.allSettled([1, 2, 3].map(() => prepareCampaignOutreach(db, campaign.id, prep)));
      const rows = await members(campaign.id);
      assert.equal(rows.length, 2);
      assert.equal(new Set(rows.map((m) => m.outreach.prospectId)).size, 2);
      assert.equal(await db.outreach.count({ where: { status: "queued" } }), 2);
      assert.equal(await db.outreach.count({ where: { status: { in: ["draft", "queued"] } } }) <= 4, true, "at most one open message per prospect");
    });
  });

  describe("recovery, stale authorization and stops", () => {
    test("an interrupted run's draft is reused and committed, never duplicated", async () => {
      const { campaign, prospects } = await launched(1);
      const { outreach } = await createOutreachDraft(db, prospects[0]!.id, OPTS);
      const r = await prepareCampaignOutreach(db, campaign.id, prep);
      assert.deepEqual(r.committed.map((x) => x.outreachId), [outreach.id]);
      assert.equal(await db.outreach.count({ where: { prospectId: prospects[0]!.id } }), 1);
      assert.equal((await commitCampaignMessage(db, campaign.id, outreach.id, CFG)).committed, false, "committing again is a no-op");
    });
    test("an expired campaign prepares and sends nothing more", async () => {
      const { campaign, sender } = await launched(2);
      await prepareCampaignOutreach(db, campaign.id, { ...prep, now: new Date() });
      const later = new Date(campaign.expiresAt!.getTime() + 1000);
      assert.match((await dispatch(sender, later)).stoppedBecause ?? "", /authorization has expired/);
      assert.equal(sender.calls.length, 0);
      assert.match((await prepareCampaignOutreach(db, campaign.id, { ...prep, now: later })).stoppedBecause ?? "", /expired/);
    });
    test("a campaign stopped (M1 stop) sends nothing more even while the switch is on", async () => {
      const { campaign, sender } = await launched(1);
      await prepareCampaignOutreach(db, campaign.id, prep);
      await stopAutonomousCampaign(db, campaign.id, "Paused by operator.");
      assert.equal((await sendingPolicy(db)).enabled, true);
      assert.match((await dispatch(sender)).stoppedBecause ?? "", /campaign was stopped: Paused by operator/);
      assert.equal(sender.calls.length, 0);
    });
    test("emergency stop: sending off and the campaign stopped together; idempotent; nothing further prepared or sent", async () => {
      const { campaign, sender } = await launched(2);
      await prepareCampaignOutreach(db, campaign.id, { ...prep, limit: 1 });
      await assert.rejects(emergencyStop(db, " "), /needs a reason/);
      const r = await emergencyStop(db, "Bad copy noticed.");
      assert.deepEqual(r, { stopped: [campaign.id], switchedOff: true });
      const c = await db.outreachCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
      assert.equal(c.stopReason, "Emergency stop: Bad copy noticed.");
      assert.equal((await sendingPolicy(db)).enabled, false);
      assert.deepEqual(await emergencyStop(db, "Again."), { stopped: [], switchedOff: false });
      assert.equal((await db.outreachCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).stopReason, "Emergency stop: Bad copy noticed.");
      assert.match((await prepareCampaignOutreach(db, campaign.id, prep)).stoppedBecause ?? "", /stopped/);
      assert.deepEqual((await dispatch(sender)).blockers, ["The global sending switch is off."]);
      assert.equal(sender.calls.length, 0);
      // Its queued member stays for a person to resolve, so a new launch fails closed until it is.
      await eligible();
      assert.match((await launchPreflight(db, CFG, gmail())).blockers.join(" "), /Nothing already queued/);
    });
    test("an emergency stop racing preparation and dispatch leaves nothing that can still go out", async () => {
      const { campaign, sender } = await launched(4, { messageCap: 4 });
      await Promise.allSettled([prepareCampaignOutreach(db, campaign.id, prep), emergencyStop(db, "Race stop."), dispatch(sender), prepareCampaignOutreach(db, campaign.id, prep)]);
      assert.equal((await sendingPolicy(db)).enabled, false);
      assert.ok((await db.outreachCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).stoppedAt);
      const committedAfter = (await members(campaign.id)).length;
      assert.equal((await prepareCampaignOutreach(db, campaign.id, prep)).committed.length, 0);
      assert.equal((await members(campaign.id)).length, committedAfter);
      const sentBefore = sender.calls.length;
      assert.ok(sentBefore <= 1, "at most a send already claimed before the stop");
      assert.equal((await dispatch(sender)).sent.length, 0); assert.equal(sender.calls.length, sentBefore);
    });
  });

  describe("existing protections still apply", () => {
    test("a suppressed recipient is never committed; the daily limit still paces sends", async () => {
      const { campaign, prospects, sender } = await launched(3);
      await db.$transaction(async (tx) => { await lockSendGate(tx); await suppressEmail(tx, prospects[0]!.email!, "unsubscribed", "Test opt-out.", null); });
      const r = await prepareCampaignOutreach(db, campaign.id, prep);
      assert.equal(r.committed.length, 2);
      assert.ok(r.skipped.some((s) => s.prospectId === prospects[0]!.id));
      await setDailyLimit(db, 1, "One a day.");
      assert.equal((await dispatch(sender)).sent.length, 1);
      assert.match((await dispatch(sender)).stoppedBecause ?? "", /daily sending limit is reached/);
      assert.equal(sender.calls.length, 1);
    });
  });
});

describe("autonomous campaign in the admin (HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  let db: Db, app: FastifyInstance, cookie = "";
  const sender = gmail();
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0",
      OUTREACH_SENDER_NAME: CFG.outreachSender.name!, OUTREACH_SENDER_EMAIL: CFG.outreachSender.email!, OUTREACH_POSTAL_ADDRESS: CFG.outreachSender.postalAddress!,
      PUBLIC_API_URL: CFG.publicApiUrl!, OUTREACH_SENDING_ENABLED: "1" }), db, false, { outreachSender: sender });
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => { await app?.close(); await db?.$disconnect(); });
  const post = (url: string, data: Record<string, string>) => app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: new URLSearchParams(data).toString() });

  test("the page shows the preflight and bounds; nothing to send keeps the launch refused", async () => {
    const page = (await app.inject({ method: "GET", url: "/admin/outreach", headers: { cookie } })).body;
    for (const s of ["Launch an autonomous campaign", "Preflight: not ready", "Eligible candidates", "commercial minimum <b>medium</b>", "Prospect cap (1–100)", "Message cap (1–250)", "Expires after (days, 1–30)"]) assert.ok(page.includes(s), s);
    const refused = await post("/admin/outreach/autonomous/launch", { name: "HTTP launch", prospectCap: "5", messageCap: "5", expiresInDays: "7", reason: "Test.", confirm: "1" });
    assert.equal(refused.statusCode, 400); assert.match(refused.body, /can&#39;t be launched yet|can't be launched yet/);
    assert.equal(await db.outreachCampaign.count(), 0);
  });
  test("launch and emergency stop through the admin", async () => {
    await db.discoveryCandidate.create({ data: { businessName: "Placeholder", nameKey: "placeholder", provider: "manual", status: "discovered" } });
    // Make one candidate eligible by reusing the service-level factory shape.
    const website = "https://http-launch.example.com/";
    const c = await db.discoveryCandidate.create({ data: { businessName: "HTTP Garage", nameKey: "http garage", provider: "manual", city: "Ventura", state: "CA", streetAddress: "9 Main St", website, status: "researched",
      categoryVerdict: "in_target", categorySource: "website", websiteVerifiedAt: new Date(), email: "service@http-launch.example.com", emailSourceUrl: website } });
    const run = await db.candidateResearch.create({ data: { candidateId: c.id, version: RESEARCH_VERSION, status: "completed", outcome: "website_verified", trigger: "cli", subjectWebsite: website, warnings: [], finishedAt: new Date() } });
    const source = await db.researchSource.create({ data: { researchId: run.id, kind: "website", url: website, ok: true } });
    for (const [field, value, excerpt] of [["location_identity", "verified_location", null], ["ownership_class", "unknown", null], ["site_locations", "1", null], ["page_location", "own_location", null],
      ["commercial_quote", "observed", "We service all makes and models."], ["email", "service@http-launch.example.com", null]] as const)
      await db.researchFact.create({ data: { researchId: run.id, field, value, excerpt, state: "verified", sourceId: source.id } });
    await db.candidateSignal.create({ data: { candidateId: c.id, key: "automotive_repair_services", value: "yes", origin: "research" } });
    for (const excerpt of ["Names brakes: Brake repair for cars.", "Names engine: Engine repair for cars."])
      await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "automotive_repair_services", sourceUrl: website, excerpt, origin: "research", researchId: run.id } });
    assert.equal((await post("/admin/outreach/autonomous/launch", { name: "HTTP launch", prospectCap: "5", messageCap: "5", expiresInDays: "7", reason: "Test." })).statusCode, 400, "no confirmation");
    const ok = await post("/admin/outreach/autonomous/launch", { name: "HTTP launch", prospectCap: "5", messageCap: "5", expiresInDays: "7", reason: "Test.", confirm: "1" });
    assert.equal(ok.statusCode, 303, ok.body);
    const page = (await app.inject({ method: "GET", url: "/admin/outreach", headers: { cookie } })).body;
    assert.match(page, /Autonomous campaign: HTTP launch/); assert.match(page, /Emergency stop/);
    assert.equal((await post("/admin/outreach/autonomous/stop", { reason: "Test stop." })).statusCode, 400, "the stop needs confirming");
    assert.equal((await post("/admin/outreach/autonomous/stop", { reason: "Test stop.", confirm: "1" })).statusCode, 303);
    assert.equal((await sendingPolicy(db)).enabled, false);
    assert.ok((await db.outreachCampaign.findFirstOrThrow()).stoppedAt);
    assert.equal(sender.calls.length, 0, "no route sends");
  });
});
