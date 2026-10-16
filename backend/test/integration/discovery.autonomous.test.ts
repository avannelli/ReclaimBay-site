import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { authorizeAutonomousCampaign, autonomousCampaignStatus, createProspectAutonomously, stopAutonomousCampaign, type AuthorizationInput } from "../../src/discovery/autonomous.js";
import { approveCandidate } from "../../src/discovery/service.js";
import { assessAcquisition } from "../../src/discovery/acquisition.js";
import { automationInclude } from "../../src/discovery/automationPolicy.js";
import { candidateProtection, protectionIndex } from "../../src/discovery/protection.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import { freshDb, skipReason, truncate } from "./helpers.js";

/* M1: bounded autonomous campaign authorization and prospect creation. All businesses are synthetic. */

const NOW = new Date("2026-10-16T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const MEDIUM = "We service all makes and models.";
const HIGH = "We are a family-owned shop. We service all makes and models.";

describe("autonomous campaigns: authorization and prospect creation", { skip: skipReason }, () => {
  let db: Db, seq = 0;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); });
  after(async () => { await db?.$disconnect(); });

  const authorize = (over: Partial<AuthorizationInput> = {}, now = NOW) => authorizeAutonomousCampaign(db, {
    name: `Launch ${++seq}`, prospectCap: 10, messageCap: 10, expiresAt: new Date(now.getTime() + 7 * 24 * HOUR), reason: "Bounded autonomous test run.", confirm: true, via: "service", ...over }, now);

  /** A candidate whose latest run is a current-rules read that passes every gate, unless told otherwise. */
  async function eligible(opts: { text?: string; ownership?: string; evidence?: string[]; email?: boolean; version?: string; website?: string; businessName?: string; phone?: string } = {}) {
    const n = ++seq;
    const website = opts.website ?? `https://autonomous${n}.example.com/`;
    const email = `service@autonomous${n}.example.com`;
    const c = await db.discoveryCandidate.create({ data: { businessName: opts.businessName ?? `Harbor Garage ${n}`, nameKey: `harbor garage ${n}`, provider: "manual", city: "Ventura", state: "CA",
      streetAddress: `${n} Main St`, website, phone: opts.phone ?? null, status: "researched", categoryVerdict: "in_target", categorySource: "website", websiteVerifiedAt: NOW,
      ...(opts.email === false ? {} : { email, emailSourceUrl: website }) } });
    const run = await db.candidateResearch.create({ data: { candidateId: c.id, version: opts.version ?? RESEARCH_VERSION, status: "completed", outcome: "website_verified", trigger: "cli", subjectWebsite: website, warnings: [], queuedAt: NOW, finishedAt: NOW } });
    const source = await db.researchSource.create({ data: { researchId: run.id, kind: "website", url: website, ok: true } });
    const facts: [string, string, string | null][] = [["location_identity", "verified_location", null], ["ownership_class", opts.ownership ?? "unknown", null], ["site_locations", "1", null],
      ["page_location", "own_location", null], ["commercial_quote", "observed", opts.text ?? MEDIUM], ...(opts.email === false ? [] : [["email", email, null] as [string, string, null]])];
    for (const [field, value, excerpt] of facts) await db.researchFact.create({ data: { researchId: run.id, field, value, excerpt, state: "verified", sourceId: source.id } });
    await db.candidateSignal.create({ data: { candidateId: c.id, key: "automotive_repair_services", value: "yes", origin: "research" } });
    for (const excerpt of opts.evidence ?? ["Names brakes: Brake repair for cars.", "Names engine: Engine repair for cars."])
      await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "automotive_repair_services", sourceUrl: website, excerpt, origin: "research", researchId: run.id } });
    return c;
  }
  const downstream = async () => Promise.all(["Outreach", "OutreachEvent", "OutreachCampaignMessage", "OutreachControlChange", "Invitation", "EmailSuppression"]
    .map((t) => db.$queryRawUnsafe(`SELECT row_to_json(t)::text AS r FROM "${t}" t ORDER BY 1`)));
  const refused = async (candidateId: string, campaignId: string, message: RegExp, now = NOW) => {
    const before = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: candidateId } });
    await assert.rejects(createProspectAutonomously(db, candidateId, campaignId, now), message);
    assert.deepEqual(await db.discoveryCandidate.findUniqueOrThrow({ where: { id: candidateId } }), before, "a refusal changes nothing");
  };

  describe("authorization", () => {
    test("records bounds and provenance; changes no sending control, message or draft", async () => {
      const before = await downstream();
      const c = await authorize({ prospectCap: 3, messageCap: 5 });
      assert.deepEqual([c.mode, c.prospectCap, c.messageCap, c.commercialMinimum, c.authorizedVia, c.attributionCampaign], ["autonomous", 3, 5, "medium", "service", "outreach-intro-t4"]);
      assert.equal(c.authorizedReason, "Bounded autonomous test run."); assert.ok(c.authorizedAt); assert.equal(c.stoppedAt, null);
      assert.deepEqual(c.policyVersions, { research: RESEARCH_VERSION, automation: "discovery@d2", commercial: "reclaimbay.commercial@v1", acquisition: "reclaimbay.acquisition@v1" });
      assert.deepEqual(await downstream(), before);
    });
    test("refuses invalid bounds, and a second active campaign until the first is stopped", async () => {
      await assert.rejects(authorize({ prospectCap: 0, reason: "", confirm: false }), /Prospect cap[\s\S]*reason is required[\s\S]*confirm/);
      const first = await authorize();
      await assert.rejects(authorize(), /still active/);
      await stopAutonomousCampaign(db, first.id, "Replaced by a new run.");
      assert.ok(await authorize());
    });
    test("concurrent authorizations leave exactly one active campaign", async () => {
      const results = await Promise.allSettled([authorize(), authorize(), authorize()]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(await db.outreachCampaign.count({ where: { mode: "autonomous", stoppedAt: null } }), 1);
    });
    test("the database itself refuses an autonomous campaign without bounds or a stop without a reason", async () => {
      await assert.rejects(db.outreachCampaign.create({ data: { name: "Raw", attributionCampaign: "outreach-intro-t4", mode: "autonomous" } }), /autonomous_bounds_check|check constraint/i);
      const c = await authorize();
      await assert.rejects(db.outreachCampaign.update({ where: { id: c.id }, data: { stoppedAt: NOW } }), /stop_reason_check|check constraint/i);
    });
  });

  describe("eligibility", () => {
    test("medium confidence (no independence language) with verified identity and repair evidence is created, with full provenance and nothing downstream", async () => {
      const campaign = await authorize();
      const c = await eligible();
      const before = await downstream();
      const { prospect } = await createProspectAutonomously(db, c.id, campaign.id, NOW);
      assert.equal(prospect.status, "new");
      const row = await db.outreachCampaignProspect.findUniqueOrThrow({ where: { candidateId: c.id } });
      assert.deepEqual([row.campaignId, row.prospectId, row.commercialDisposition, row.commercialConfidence], [campaign.id, prospect.id, "fit", "medium"]);
      assert.deepEqual(row.policyVersions, campaign.policyVersions);
      const candidate = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(candidate.status, "approved"); assert.equal(candidate.prospectId, prospect.id);
      assert.match(candidate.decisionReason!, new RegExp(`^Created automatically under autonomous campaign "${campaign.name}" \\(${campaign.id}; discovery@d2, research ${RESEARCH_VERSION}, reclaimbay.commercial@v1 minimum medium\\)`));
      const notes = (await db.prospectNote.findMany({ where: { prospectId: prospect.id } })).map((n) => n.body);
      assert.ok(notes.some((n) => n.startsWith(`Approved automatically (autonomous campaign "${campaign.name}"`)), "provenance note");
      const creation = JSON.parse(notes.find((n) => n.includes('"type":"autonomous_creation"'))!) as Record<string, unknown>;
      assert.equal(creation.campaignId, campaign.id); assert.deepEqual((creation.commercial as { confidence: string; minimum: string }), { rules: "reclaimbay.commercial@v1", disposition: "fit", confidence: "medium", minimum: "medium" });
      assert.ok(notes.some((n) => n.includes('"action":"autonomous_create"') && n.includes('"references":')), "commercial evidence references");
      assert.ok((await db.candidateNote.findMany({ where: { candidateId: c.id } })).some((n) => n.body.includes('"type":"autonomous_creation"')), "kept on the candidate too");
      assert.deepEqual(await downstream(), before, "no draft, queue, invitation or sending change");
    });
    test("high confidence is created too, recorded as high", async () => {
      const campaign = await authorize();
      const c = await eligible({ text: HIGH, ownership: "independent" });
      await createProspectAutonomously(db, c.id, campaign.id, NOW);
      assert.equal((await db.outreachCampaignProspect.findUniqueOrThrow({ where: { candidateId: c.id } })).commercialConfidence, "high");
    });
    test("the display contract still reports high as the default minimum", async () => {
      const c = await eligible();
      const full = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: automationInclude });
      const protection = candidateProtection(full, await protectionIndex(db));
      assert.equal(assessAcquisition(full, protection).gates.commercial.pass, false);
      assert.equal(assessAcquisition(full, protection, { commercialMinimum: "medium" }).gates.commercial.pass, true);
    });
    for (const ownership of ["chain", "dealership", "possible_dealership", "manufacturer"]) {
      test(`explicit ownership ${ownership} is never created`, async () => {
        const campaign = await authorize();
        await refused((await eligible({ ownership })).id, campaign.id, /ownership|Ownership|commercial/);
        assert.equal(await db.prospect.count(), 0);
      });
    }
    test("commercial review (conflicting dealer scope) and commercial exclusion are never created, and have no automatic override", async () => {
      const campaign = await authorize();
      await refused((await eligible({ text: "We are a dealership service center." })).id, campaign.id, /commercial/i);
      await refused((await eligible({ businessName: "Coast Brakes", text: "We only repair trailers.", evidence: ["Names brakes: Brake repair for cars."] })).id, campaign.id, /commercial/i);
      assert.equal(await db.prospect.count(), 0);
    });
    test("missing verified recipient, weak service evidence and older-rules runs are not created", async () => {
      const campaign = await authorize();
      await refused((await eligible({ email: false })).id, campaign.id, /contact/);
      await refused((await eligible({ evidence: ["Names brakes: Brake repair for cars."] })).id, campaign.id, /Not Ready/);
      await refused((await eligible({ version: "r15" })).id, campaign.id, /Not Ready|identity/);
    });
  });

  describe("duplicates, accounts and protection", () => {
    test("an inbound duplicate flag, an existing account and a protected identity are never created", async () => {
      const campaign = await authorize();
      const flagged = await eligible();
      await db.discoveryCandidate.create({ data: { businessName: "Neighbor", nameKey: "neighbor", provider: "manual", possibleDuplicateCandidateId: flagged.id, duplicateHold: true, status: "needs_review" } });
      await refused(flagged.id, campaign.id, /Unresolved possible-duplicate/);
      const account = await eligible({ website: "https://brand.example.com/ventura" });
      await db.prospect.create({ data: { referralCode: "existing-account", businessName: "Brand Other Location", website: "https://brand.example.com/simi", city: "Simi Valley", state: "CA" } });
      await refused(account.id, campaign.id, /already has a Prospect\/account/);
      const prot = await eligible();
      const p = await db.prospect.create({ data: { referralCode: "protected-outreach", businessName: prot.businessName, website: prot.website, city: "Ventura", state: "CA" } });
      await db.outreach.create({ data: { prospectId: p.id, kind: "initial", template: "fixture", subject: "Keep", body: "Keep", evidence: [], generatedAt: NOW, recipientEmail: "office@example.com", recipientSourceUrl: prot.website!, status: "sent" } });
      await refused(prot.id, campaign.id, /protection|existing prospect matches|already has a Prospect/);
      assert.equal(await db.outreachCampaignProspect.count(), 0);
    });
    test("a candidate is created at most once, in one campaign or across campaigns", async () => {
      const a = await authorize();
      const c = await eligible();
      await createProspectAutonomously(db, c.id, a.id, NOW);
      await assert.rejects(createProspectAutonomously(db, c.id, a.id, NOW), /already created automatically|Already approved/);
      await stopAutonomousCampaign(db, a.id, "Next campaign.");
      const b = await authorize();
      await assert.rejects(createProspectAutonomously(db, c.id, b.id, NOW), /already created automatically|Already approved/);
      assert.equal(await db.prospect.count(), 1);
    });
    test("a person's approval and an automatic creation of the same candidate never both succeed", async () => {
      const campaign = await authorize();
      const c = await eligible();
      const results = await Promise.allSettled([approveCandidate(db, c.id), createProspectAutonomously(db, c.id, campaign.id, NOW)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(await db.prospect.count(), 1);
    });
  });

  describe("caps, concurrency, stop and expiry", () => {
    test("the prospect cap is exhausted exactly", async () => {
      const campaign = await authorize({ prospectCap: 2 });
      const [a, b, c] = [await eligible(), await eligible(), await eligible()];
      await createProspectAutonomously(db, a.id, campaign.id, NOW);
      await createProspectAutonomously(db, b.id, campaign.id, NOW);
      await refused(c.id, campaign.id, /prospect cap \(2\) is reached/);
      assert.equal((await autonomousCampaignStatus(db, campaign.id, NOW))!.state, "exhausted");
    });
    test("concurrent creations never exceed the cap and never duplicate a candidate", async () => {
      const campaign = await authorize({ prospectCap: 2 });
      const candidates = [await eligible(), await eligible(), await eligible(), await eligible()];
      const results = await Promise.allSettled([...candidates, candidates[0]!, candidates[1]!].map((c) => createProspectAutonomously(db, c.id, campaign.id, NOW)));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
      assert.equal(await db.outreachCampaignProspect.count({ where: { campaignId: campaign.id } }), 2);
      assert.equal(await db.prospect.count(), 2);
      for (const r of results) if (r.status === "rejected") assert.match(String((r.reason as Error).message), /cap|already|Already|changed|same time/);
    });
    test("a stop takes effect immediately and for good; it is idempotent and needs a reason", async () => {
      const campaign = await authorize();
      const [a, b] = [await eligible(), await eligible()];
      await createProspectAutonomously(db, a.id, campaign.id, NOW);
      await assert.rejects(stopAutonomousCampaign(db, campaign.id, " "), /stop reason is required/i);
      const stopped = await stopAutonomousCampaign(db, campaign.id, "Emergency stop.", new Date(NOW.getTime() + 1000));
      await refused(b.id, campaign.id, /stopped: Emergency stop\./);
      const again = await stopAutonomousCampaign(db, campaign.id, "Another reason.");
      assert.deepEqual([again.stoppedAt, again.stopReason], [stopped.stoppedAt, "Emergency stop."]);
      assert.equal((await autonomousCampaignStatus(db, campaign.id))!.state, "stopped");
    });
    test("a stop racing creations: nothing is created after the stop", async () => {
      const campaign = await authorize();
      const candidates = [await eligible(), await eligible(), await eligible(), await eligible()];
      await Promise.allSettled([...candidates.map((c) => createProspectAutonomously(db, c.id, campaign.id, NOW)), stopAutonomousCampaign(db, campaign.id, "Stop during a run.", NOW)]);
      const stoppedAt = (await db.outreachCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).stoppedAt!;
      const rows = await db.outreachCampaignProspect.findMany({ where: { campaignId: campaign.id } });
      const prospectsAfter = await db.prospect.findMany({ where: { id: { in: rows.map((r) => r.prospectId) } } });
      assert.equal(prospectsAfter.length, rows.length);
      // Every creation either committed before the stop or saw it: none can follow it.
      await refused((await eligible()).id, campaign.id, /stopped/);
      assert.ok(stoppedAt);
    });
    test("an expired campaign creates nothing", async () => {
      const campaign = await authorize({ expiresAt: new Date(NOW.getTime() + HOUR) });
      const c = await eligible();
      await refused(c.id, campaign.id, /expired/, new Date(NOW.getTime() + HOUR));
      assert.equal((await autonomousCampaignStatus(db, campaign.id, new Date(NOW.getTime() + 2 * HOUR)))!.state, "expired");
      assert.ok(await authorize({}, new Date(NOW.getTime() + 2 * HOUR)), "an expired campaign no longer blocks a new authorization");
    });
  });

  describe("the human workflow is unchanged", () => {
    test("approveCandidate({ automatic }) still refuses; a selected campaign or a missing one authorizes nothing", async () => {
      const c = await eligible();
      await assert.rejects(approveCandidate(db, c.id, { automatic: true }), /Automatic prospect creation is disabled/);
      await assert.rejects(createProspectAutonomously(db, c.id, "00000000-0000-4000-8000-000000000000", NOW), /Campaign not found/);
      const selected = await db.outreachCampaign.create({ data: { name: "Selected", attributionCampaign: "outreach-intro-t4" } });
      await refused(c.id, selected.id, /does not authorize automatic prospect creation/);
    });
    test("a person's approval creates no campaign record and keeps its own provenance", async () => {
      await authorize();
      const c = await eligible();
      const { prospect } = await approveCandidate(db, c.id);
      assert.equal(await db.outreachCampaignProspect.count(), 0);
      const notes = (await db.prospectNote.findMany({ where: { prospectId: prospect.id } })).map((n) => n.body);
      assert.ok(notes.some((n) => n.startsWith("Approved by a human")));
      assert.ok(notes.some((n) => n.includes('"action":"human_approve"')));
      assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).decisionReason, null);
    });
  });
});
