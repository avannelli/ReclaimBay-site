import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { applyDiscoveryBatch, discoveryAutomationPreview } from "../../src/discovery/automation.js";
import { autonomousCandidates } from "../../src/discovery/autonomous.js";
import { CONTACT_RULES } from "../../src/research/analyze.js";
import { autoResearchSelection, enqueueResearch, processResearch } from "../../src/research/service.js";
import { fixtureWeb, independentShop, page, type Fixture } from "../fixtures/researchSite.js";
import { freshDb, skipReason, truncate } from "./helpers.js";

/* Contact rules c2: a free/ISP mailbox published as the business's contact, end to end through research, readiness and the autonomous gate. */

const ORIGIN = "https://saviersauto.example.com";
const MAILBOX = "saviersroadauto@gmail.com";
const DAY = 24 * 60 * 60 * 1000;
/** The independent shop, its contact page showing a business-named Gmail mailbox, or no email at all. */
const site = (contact: "mailbox" | "none"): Record<string, Fixture> => ({
  ...independentShop(),
  [`${ORIGIN}/contact-us`]: { body: page("Contact", contact === "mailbox" ? `<h1>Contact</h1><p>Email us: <a href="mailto:${MAILBOX}">${MAILBOX}</a></p>` : "<h1>Contact</h1><p>Call us to book.</p>") },
});
const unreachable: Record<string, Fixture> = { [`${ORIGIN}/robots.txt`]: { error: "ECONNREFUSED" }, [`${ORIGIN}/`]: { error: "ECONNREFUSED" } };

describe("contact rules c2", { skip: skipReason }, () => {
  let db: Db;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); });
  after(async () => { await db?.$disconnect(); });

  const candidate = () => db.discoveryCandidate.create({ data: { businessName: "Saviers Road Auto Repair", nameKey: "saviers road auto repair", provider: "manual", city: "Oxnard", state: "CA",
    website: `${ORIGIN}/`, providerPhone: "8055550101", streetAddress: "5577 Saviers Rd" } });
  const research = async (id: string, routes: Record<string, Fixture>, trigger: "scheduled" | "admin" = "scheduled") => {
    const q = await enqueueResearch(db, [id], trigger);
    assert.equal(q.queued.length, 1, JSON.stringify(q.skipped));
    return processResearch(db, q.queued[0]!.researchId, { makeFetcher: fixtureWeb(routes).makeFetcher });
  };
  const plan = async (id: string, now = new Date()) => (await discoveryAutomationPreview(db, { now })).rows.find((r) => r.id === id)!;
  /** A Ready candidate whose current r16 read predates c2: no email on the site, and its run carries no contact-rules fact. */
  const readyBeforeC2 = async () => {
    const c = await candidate();
    const run = await research(c.id, site("none"));
    await db.researchFact.deleteMany({ where: { researchId: run!.id, field: "contact_rules" } });
    return { c, run: run! };
  };

  test("a fresh read records the published business mailbox: Ready, contact gate passed, autonomous-eligible", async () => {
    const c = await candidate();
    const run = await research(c.id, site("mailbox"));
    const stored = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.deepEqual([stored.email, stored.emailSourceUrl], [MAILBOX, `${ORIGIN}/contact-us`]);
    const facts = await db.researchFact.findMany({ where: { researchId: run!.id, field: { in: ["email", "contact_rules"] } }, include: { source: true } });
    const email = facts.find((f) => f.field === "email")!;
    assert.deepEqual([email.state, email.value, email.source?.url], ["verified", MAILBOX, `${ORIGIN}/contact-us`]);
    assert.equal(facts.find((f) => f.field === "contact_rules")!.value, CONTACT_RULES);
    const p = await plan(c.id);
    assert.deepEqual([p.assessment.action, p.assessment.code], ["ready", "qualified"], p.assessment.reason);
    assert.equal(p.assessment.acquisition!.gates.contact.pass, true);
    assert.deepEqual(await autonomousCandidates(db, new Date()), [c.id]);
  });

  test("a Ready candidate read before c2 gets exactly one contact re-read; a failed one is hidden and spends no retry budget", async () => {
    const { c, run } = await readyBeforeC2();
    const runBefore = await db.candidateResearch.findUniqueOrThrow({ where: { id: run.id }, include: { facts: true, sources: true } });
    const evidenceBefore = await db.candidateEvidence.findMany({ where: { candidateId: c.id }, orderBy: { id: "asc" } });
    const p = await plan(c.id);
    assert.deepEqual([p.assessment.action, p.assessment.code, p.assessment.researchKind], ["research", "contact_refresh", "contact"]);
    assert.ok((await autoResearchSelection(db, 10)).fresh.includes(c.id), "the worker picks it as new work, not a retry");

    const [applied] = await applyDiscoveryBatch(db, [{ id: c.id, token: p.token }]);
    assert.equal(applied!.applied, true);
    const queued = await db.candidateResearch.findFirstOrThrow({ where: { candidateId: c.id, status: "queued" } });
    assert.equal(queued.trigger, "contact");
    assert.equal((await plan(c.id)).assessment.action, "wait");

    await processResearch(db, queued.id, { makeFetcher: fixtureWeb(unreachable).makeFetcher });
    const failed = await db.candidateResearch.findUniqueOrThrow({ where: { id: queued.id } });
    assert.deepEqual([failed.status, failed.outcome], ["failed", "website_unreachable"]);
    for (const now of [new Date(), new Date(Date.now() + 2 * DAY)]) {
      const after = await plan(c.id, now);
      assert.deepEqual([after.assessment.action, after.assessment.code], ["ready", "qualified"], "the run before the failed re-read still decides; no retry, no cooldown, no second re-read");
      assert.ok(!(await autoResearchSelection(db, 10, now)).fresh.includes(c.id));
      assert.ok(!(await autoResearchSelection(db, 10, now)).retries.includes(c.id));
    }
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "researched");
    assert.deepEqual(await db.candidateResearch.findUniqueOrThrow({ where: { id: run.id }, include: { facts: true, sources: true } }), runBefore, "the earlier run is untouched");
    assert.deepEqual(await db.candidateEvidence.findMany({ where: { candidateId: c.id }, orderBy: { id: "asc" } }), evidenceBefore);
  });

  test("a successful contact re-read records the mailbox, keeps earlier evidence, and makes the candidate autonomous-eligible once", async () => {
    const { c, run } = await readyBeforeC2();
    const runBefore = await db.candidateResearch.findUniqueOrThrow({ where: { id: run.id }, include: { facts: true, sources: true } });
    const evidenceBefore = await db.candidateEvidence.findMany({ where: { candidateId: c.id } });
    assert.deepEqual(await autonomousCandidates(db, new Date()), [], "no verified contact yet");
    const p = await plan(c.id);
    await applyDiscoveryBatch(db, [{ id: c.id, token: p.token }]);
    const queued = await db.candidateResearch.findFirstOrThrow({ where: { candidateId: c.id, status: "queued" } });
    await processResearch(db, queued.id, { makeFetcher: fixtureWeb(site("mailbox")).makeFetcher });

    const stored = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.deepEqual([stored.status, stored.email, stored.emailSourceUrl], ["researched", MAILBOX, `${ORIGIN}/contact-us`]);
    assert.deepEqual(await db.candidateResearch.findUniqueOrThrow({ where: { id: run.id }, include: { facts: true, sources: true } }), runBefore, "history is appended, never rewritten");
    const evidenceAfter = await db.candidateEvidence.findMany({ where: { candidateId: c.id } });
    for (const e of evidenceBefore) assert.ok(evidenceAfter.some((x) => x.id === e.id), "earlier evidence is kept");
    const after = await plan(c.id);
    assert.deepEqual([after.assessment.action, after.assessment.code], ["ready", "qualified"], after.assessment.reason);
    assert.equal(after.assessment.acquisition!.gates.contact.pass, true);
    assert.deepEqual(await autonomousCandidates(db, new Date()), [c.id]);
    assert.equal(await db.candidateResearch.count({ where: { candidateId: c.id } }), 2, "one original run and one contact re-read");
  });

  test("protection still applies: a suppressed mailbox makes the candidate a protected identity, never eligible or re-read", async () => {
    const c = await candidate();
    await research(c.id, site("mailbox"));
    await db.emailSuppression.create({ data: { email: MAILBOX, reason: "unsubscribed" } });
    const p = await plan(c.id);
    assert.equal(p.protection.protected, true);
    assert.notEqual(p.assessment.action, "ready");
    assert.deepEqual(await autonomousCandidates(db, new Date()), []);
    assert.deepEqual((await enqueueResearch(db, [c.id], "scheduled")).queued, []);
  });
});
