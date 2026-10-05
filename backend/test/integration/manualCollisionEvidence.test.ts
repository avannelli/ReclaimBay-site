import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { addCandidateEvidence, addManualCandidate, approveCandidate, changeCandidateStatus, setCandidateCategory, updateCandidate } from "../../src/discovery/service.js";
import { addEvidence, changeStatus, createInternalTestProspect, createProspect, deleteEvidence, formValuesOf, updateProspect } from "../../src/prospects.js";
import { createOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { CFG, OPTS } from "./outreachHelpers.js";
import { freshDb, readyForm, skipReason, truncate, WEBSITE } from "./helpers.js";

describe("manual prospect collision evidence boundary (local PostgreSQL)", { skip: skipReason }, () => {
  let db: Db;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); });
  after(async () => { await db?.$disconnect(); });
  const create = (over: Record<string, string> = {}) => createProspect(db, readyForm({ email: "shop@smithauto.example.com", emailSourceUrl: `${WEBSITE}/contact`, ...over }));
  const add = (id: string, excerpt = "We offer collision repair.", sourceUrl = `${WEBSITE}/services`) => addEvidence(db, id, { signalKey: "collision_repair_services", sourceUrl, excerpt });
  const row = (id: string) => db.prospect.findUniqueOrThrow({ where: { id }, include: { signals: true, evidence: true } });

  test("manual Yes with zero evidence stays New and cannot qualify or be queued into Ready", async () => {
    const p = await create();
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /sourced collision\/body evidence/);
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await assert.rejects(queueOutreach(db, outreach.id, CFG), /sourced collision\/body evidence/);
    assert.equal((await row(p.id)).status, "new");
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } })).status, "draft");
    assert.equal((await row(p.id)).signals.find(s => s.key === "collision_repair_services")?.value, "yes");
  });
  test("a pre-existing Qualified fixture with no evidence cannot become Ready", async () => {
    const p = await create();
    await db.prospect.update({ where: { id: p.id }, data: { status: "qualified" } });
    await assert.rejects(changeStatus(db, p.id, "ready_to_contact", null), /sourced collision\/body evidence/);
  });
  test("manual Yes with valid stored evidence can qualify and become Ready", async () => {
    const p = await create(); await add(p.id);
    await changeStatus(db, p.id, "qualified", null); await changeStatus(db, p.id, "ready_to_contact", null);
    assert.equal((await row(p.id)).status, "ready_to_contact");
  });
  test("contradictory stored evidence blocks a manual Yes without converting it to No", async () => {
    const p = await create(); await add(p.id); await add(p.id, "We do not offer collision repair.");
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /contradictory collision\/body evidence/);
    assert.equal((await row(p.id)).signals.find(s => s.key === "collision_repair_services")?.value, "yes");
  });
  test("Unknown plus valid evidence still requires an explicit human Yes", async () => {
    const p = await create({ signal_collision_repair_services: "unknown" }); await add(p.id);
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /Unverified/);
    await updateProspect(db, p.id, { ...formValuesOf(await row(p.id)), signal_collision_repair_services: "yes" });
    await changeStatus(db, p.id, "qualified", null);
  });
  test("No stays disqualified even with positive evidence", async () => {
    const p = await create({ signal_collision_repair_services: "no" }); await add(p.id);
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /Disqualified/);
    assert.equal((await row(p.id)).signals.find(s => s.key === "collision_repair_services")?.value, "no");
  });
  test("off-site evidence and mechanical evidence cannot manufacture collision fit", async () => {
    const p = await create(); await add(p.id, "We offer collision repair.", "https://other-business.example.com/services");
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /attributed to this business/);
    const q = await create({ businessName: "Second Auto" });
    await addEvidence(db, q.id, { signalKey: "general_repair_services", sourceUrl: `${WEBSITE}/services`, excerpt: "Brakes and oil changes." });
    await assert.rejects(changeStatus(db, q.id, "qualified", null), /sourced collision\/body evidence/);
  });
  test("a listing identifies a manual prospect that has no website", async () => {
    const p = await create({ website: "", signal_digital_inspections: "unknown", signal_no_online_booking: "unknown" });
    await add(p.id, "Smith Auto: We offer collision repair.", "https://listing.example.com/smith-auto");
    await changeStatus(db, p.id, "qualified", null);
  });
  test("editing identity cannot leave Qualified or Ready with evidence from a different website", async () => {
    const p = await create(); await add(p.id); await changeStatus(db, p.id, "qualified", null);
    for (const status of ["qualified", "ready_to_contact"]) {
      if (status === "ready_to_contact") await changeStatus(db, p.id, status, null);
      await assert.rejects(updateProspect(db, p.id, { ...formValuesOf(await row(p.id)), website: "https://changed.example.com" }), /sourced collision\/body evidence/);
      assert.equal((await row(p.id)).website, `${WEBSITE}/`);
    }
  });
  test("evidence mutations cannot remove the last support or introduce a contradiction while Ready", async () => {
    const p = await create(); const first = await add(p.id); await changeStatus(db, p.id, "qualified", null); await changeStatus(db, p.id, "ready_to_contact", null);
    await assert.rejects(deleteEvidence(db, p.id, first.id), /keep the supporting evidence/);
    await assert.rejects(add(p.id, "We do not offer collision repair."), /contradictory collision\/body evidence/);
    await add(p.id, "We provide auto body repair."); await deleteEvidence(db, p.id, first.id);
    assert.equal((await row(p.id)).evidence.length, 1);
    await changeStatus(db, p.id, "qualified", null); await changeStatus(db, p.id, "new", null);
    await deleteEvidence(db, p.id, (await row(p.id)).evidence[0]!.id);
    assert.equal((await row(p.id)).status, "new");
  });
  test("linked completed research disagreement still blocks qualification despite manual evidence", async () => {
    const p = await create(); await add(p.id);
    const c = await db.discoveryCandidate.create({ data: { provider: "manual", businessName: p.businessName!, nameKey: "smith auto", status: "approved", prospectId: p.id, categoryVerdict: "in_target", categorySource: "manual" } });
    await db.candidateResearch.create({ data: { candidateId: c.id, version: "r12", trigger: "admin", status: "completed", warnings: ['Research found "collision_repair_services" = no, but a person recorded yes; the person\'s value was kept.'] } });
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /contradictory collision\/body research/);
    await db.prospect.update({ where: { id: p.id }, data: { status: "qualified" } });
    await assert.rejects(changeStatus(db, p.id, "ready_to_contact", null), /contradictory collision\/body research/);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).categorySource, "manual");
  });
  test("internal manual test prospects obey the same evidence requirement", async () => {
    const p = await createInternalTestProspect(db, readyForm({ confirmInternalTest: "yes" }));
    await assert.rejects(changeStatus(db, p.id, "qualified", null), /sourced collision\/body evidence/);
    await add(p.id); await changeStatus(db, p.id, "qualified", null);
  });
  test("manual candidate approval cannot bypass evidence; valid evidence survives transfer", async () => {
    const c = await addManualCandidate(db, { businessName: "Smith Auto", website: WEBSITE });
    await updateCandidate(db, c.id, readyForm({ signal_independent_shop: "unknown", signal_general_repair_services: "unknown", signal_digital_inspections: "unknown", signal_no_online_booking: "unknown" }));
    await setCandidateCategory(db, c.id, "in_target", "Human category decision; evidence is still required.");
    await changeCandidateStatus(db, c.id, "needs_review", "Human verification pending.");
    await assert.rejects(approveCandidate(db, c.id), /collision_repair_services|Collision\/body fit needs/);
    await addCandidateEvidence(db, c.id, { signalKey: "collision_repair_services", sourceUrl: `${WEBSITE}/services`, excerpt: "We offer collision repair." });
    const { prospect } = await approveCandidate(db, c.id);
    await changeStatus(db, prospect.id, "qualified", null);
    await changeStatus(db, prospect.id, "ready_to_contact", null);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).categorySource, "manual");
  });
  test("qualification racing removal of its last evidence cannot commit an unsupported Qualified record", async () => {
    const p = await create(); const evidence = await add(p.id);
    const results = await Promise.allSettled([changeStatus(db, p.id, "qualified", null), deleteEvidence(db, p.id, evidence.id)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const current = await row(p.id);
    if (current.status === "qualified") assert.equal(current.evidence.length, 1);
    else { assert.equal(current.status, "new"); assert.equal(current.evidence.length, 0); }
  });
});
