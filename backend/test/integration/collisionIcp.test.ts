import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { createStagedProvider, runImport } from "../../src/discovery/staging.js";
import { categoryTierFor } from "../../src/discovery/categories.js";
import { addCandidateEvidence, approveCandidate, assessCandidateApproval, runDiscovery, processDiscoveryRun, setCandidateCategory, updateCandidate } from "../../src/discovery/service.js";
import { changeStatus, createProspect, listProspects } from "../../src/prospects.js";
import { enqueueResearch, processResearch } from "../../src/research/service.js";
import { previewOutreachDraft } from "../../src/outreach/service.js";
import { fixtureWeb, page } from "../fixtures/researchSite.js";
import { freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { OPTS } from "./outreachHelpers.js";

describe("collision/body segment of the automotive repair ICP: full acquisition path (local PostgreSQL, fixture web)", { skip: skipReason }, () => {
  let db: Db; const originalFetch = globalThis.fetch;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); globalThis.fetch = (async () => { throw new Error("Real network forbidden."); }) as typeof fetch; });
  afterEach(async () => { globalThis.fetch = originalFetch; assert.equal(await db.outreach.count(), 0); assert.equal(await db.outreachControlChange.count(), 0); assert.equal(await db.emailSuppression.count(), 0); });
  after(async () => { await db?.$disconnect(); });
  function web(services: string) {
    return fixtureWeb({
      "https://harbor.example.com/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
      "https://harbor.example.com/": { body: page("Harbor Collision", '<h1>Harbor Collision</h1><p>(805) 555-0101</p><a href="/collision">Collision</a>') },
      "https://harbor.example.com/collision": { body: page("Collision services", `<h1>Our services</h1><p>${services}</p>`) },
      "https://harbor.example.com/contact-us": { body: page("Contact", '<p>hello@harbor.example.com</p>') },
    });
  }
  const candidate = () => db.discoveryCandidate.findFirstOrThrow({ include: { signals: true, evidence: true } });
  async function discover() {
    const importer = { provider: "fixture-icp", label: "Fixture ICP", async *fetch() {
      yield [{ externalId: "body-1", businessName: "Harbor Collision", website: "https://harbor.example.com/", phone: "(805) 555-0101", city: "Ventura", state: "CA", county: "Ventura County", category: "auto_body_shop", categoryTier: categoryTierFor("overture", "auto_body_shop"), confidence: 0.9 }];
    } };
    await runImport(db, importer, "fixture-v1", { region: "US-CA", county: "Ventura County" });
    const provider = createStagedProvider(db, { name: "fixture-icp", label: "Fixture ICP" });
    const providers = new Map([[provider.name, provider]]);
    const run = await runDiscovery(db, providers, { provider: provider.name, region: "Ventura County, CA" });
    await processDiscoveryRun(db, providers, run.id);
    return candidate();
  }
  async function research(id: string, services: string) {
    const queued = await enqueueResearch(db, [id], "admin");
    return processResearch(db, queued.queued[0]!.researchId, { makeFetcher: web(services).makeFetcher, today: new Date("2026-10-05T12:00:00Z") });
  }
  for (const services of ["We offer collision repair.", "We provide collision repair, brakes and oil changes.", "We provide brake repair and oil changes for cars and trucks."]) {
    test(`default discovery to eligible prospect: ${services}`, async () => {
      const c = await discover(); assert.equal(c.categoryTier, "core"); assert.equal(c.categoryVerdict, "unclear");
      assert.ok(!c.signals.some(s => s.key === "collision_repair_services"));
      await research(c.id, services);
      const after = await candidate(); assert.equal(after.status, "approved", JSON.stringify(await assessCandidateApproval(db, c.id))); assert.equal(after.categoryVerdict, "in_target");
      // Fit rests on sourced repair evidence; collision/body evidence exists only when the site offers it.
      assert.ok(after.evidence.some(e => e.signalKey === "automotive_repair_services" && e.sourceUrl.endsWith("/collision") && e.excerpt));
      assert.equal(after.evidence.some(e => e.signalKey === "collision_repair_services"), /collision/.test(services));
      assert.ok(after.prospectId);
      await changeStatus(db, after.prospectId!, "qualified", null); await changeStatus(db, after.prospectId!, "ready_to_contact", null);
      const list = await listProspects(db, { qualification: "meets_criteria" }); assert.equal(list.total, 1); assert.equal(list.rows[0]!.result.qualification, "meets_criteria");
      const preview = await previewOutreachDraft(db, after.prospectId!, OPTS); assert.deepEqual(preview.errors, []); assert.ok(preview.message);
    });
  }
  for (const services of ["We provide auto glass and tint.", "We do not provide collision repair.", "Collision repair is not offered here.", "We outsource collision repair.", "We sell collision repair products.", "We supply collision repair equipment.", "We sell new vehicles. We offer collision repair.", "We provide automotive paintless dent repair."]) {
    test(`non-primary or possible services cannot be automatically approved: ${services}`, async () => {
      const c = await discover(); await research(c.id, services); const after = await candidate();
      assert.notEqual(after.status, "approved"); assert.equal(after.prospectId, null);
    });
  }
  test("manual category decisions remain protected from new positive website findings", async () => {
    const c = await discover(); await setCandidateCategory(db, c.id, "wrong_category", "Verified human decision.");
    await research(c.id, "We offer collision repair."); const after = await candidate();
    assert.equal(after.categorySource, "manual"); assert.equal(after.categoryVerdict, "wrong_category"); assert.equal(after.prospectId, null);
  });
  test("a known contradictory research result cannot be bypassed by manual approval", async () => {
    const c = await discover(); await research(c.id, "We provide collision repair and we do not offer collision repair.");
    await setCandidateCategory(db, c.id, "in_target", "Manual category classification only.");
    await assert.rejects(approveCandidate(db, c.id), /contradictory collision\/body evidence/);
    await db.candidateResearch.create({ data: { candidateId: c.id, version: "r12", trigger: "admin", status: "failed", queuedAt: new Date(Date.now() + 1000), warnings: [] } });
    await assert.rejects(approveCandidate(db, c.id), /contradictory collision\/body evidence/, "a failed rerun cannot hide a known contradiction");
    assert.equal(await db.prospect.count(), 0);
  });
  test("research contradicting a protected manual collision Yes also blocks manual approval", async () => {
    const c = await discover();
    await updateCandidate(db, c.id, readyForm({ businessName: c.businessName, website: c.website!, signal_independent_shop: "unknown", signal_general_repair_services: "unknown", signal_digital_inspections: "unknown", signal_no_online_booking: "unknown" }));
    await addCandidateEvidence(db, c.id, { signalKey: "collision_repair_services", sourceUrl: `${c.website}collision`, excerpt: "Previously verified collision repair." });
    await setCandidateCategory(db, c.id, "in_target", "Previously verified manual category.");
    await research(c.id, "We do not offer collision repair.");
    const after = await candidate();
    assert.ok(after.signals.some(s => s.key === "collision_repair_services" && s.value === "yes" && s.origin === "manual"));
    await assert.rejects(approveCandidate(db, c.id), /contradictory collision\/body evidence/);
    assert.equal(await db.prospect.count(), 0);
  });
  test("historical mechanical/ownership Yes values remain stored and cannot qualify under v3", async () => {
    const p = await createProspect(db, readyForm({ signal_collision_repair_services: "unknown", email: "hello@legacy.example.com", emailSourceUrl: "https://legacy.example.com/contact" }));
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /Unverified/);
    const row = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true } });
    assert.ok(row.signals.some(s => s.key === "general_repair_services" && s.value === "yes"));
    assert.ok(!row.signals.some(s => s.key === "collision_repair_services"));
    assert.equal((await listProspects(db, { qualification: "unverified" })).total, 1);
    assert.equal((await listProspects(db, { qualification: "meets_criteria" })).total, 0);
    assert.ok((await previewOutreachDraft(db, p.id, OPTS)).errors.length);
  });
});
