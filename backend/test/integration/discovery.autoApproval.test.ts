import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { AUTO_APPROVED_PREFIX, AUTO_REJECTED_PREFIX, REOPENED_PREFIX } from "../../src/discovery/autoApproval.js";
import {
  approveCandidate,
  autoApproveCandidate,
  changeCandidateStatus,
  ingestBusinesses,
  runAutoApproval,
  setCandidateCategory,
} from "../../src/discovery/service.js";
import type { DiscoveredBusiness } from "../../src/discovery/types.js";
import { previewOutreachDraft } from "../../src/outreach/service.js";
import { createProspect } from "../../src/prospects.js";
import { enqueueResearch, processResearch } from "../../src/research/service.js";
import { fixtureWeb, independentShop, page, type Fixture } from "../fixtures/researchSite.js";
import { OPTS } from "./outreachHelpers.js";
import { TEST_DATABASE_URL, freshDb, skipReason, truncate } from "./helpers.js";

/*
 * Automatic approval (approval@a2) through the real service, research, and
 * admin, against a disposable database and fixture websites (no network).
 */

const TODAY = new Date("2026-10-01T12:00:00Z");
const HOST = "saviersauto.example.com";
const SITE = `https://${HOST}/`;
let seq = 0;
const business = (over: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness => ({
  externalId: `aa000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  businessName: "Saviers Road Auto Repair",
  website: SITE,
  streetAddress: "5577 Saviers Rd",
  city: "Oxnard",
  state: "CA",
  postalCode: "93033",
  country: "US",
  phone: "+18055550101",
  category: "automotive_repair",
  categoryTier: "core",
  ...over,
});

/** The clean shop, but its site no longer says it is family owned: independence unknown. */
const noIndependence = () => {
  const routes = independentShop(HOST);
  routes[`https://${HOST}/services`]!.body = routes[`https://${HOST}/services`]!.body!.replace("<li>We provide collision repair.</li>", "");
  routes[SITE] = {
    body: page(
      "Saviers Road Auto Repair | Oxnard Auto Repair",
      `<h1>Saviers Road Auto Repair</h1><p>Our 6 service bays are open Monday to Friday.</p><p>Call (805) 555-0101 · 5577 Saviers Rd, Oxnard, CA 93033</p><footer>© 2025 Saviers Road Auto Repair</footer>`,
    ),
  };
  return fixtureWeb(routes);
};

describe("automatic approval (service)", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  const candidate = async (over: Partial<DiscoveredBusiness> = {}) => {
    const b = business(over);
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [b]);
    return db.discoveryCandidate.findFirstOrThrow({ where: { externalId: b.externalId } });
  };
  /** Research with the automatic-approval step on (the default). */
  const research = async (id: string, web = fixtureWeb(independentShop(HOST))) => {
    const [q] = (await enqueueResearch(db, [id], "admin")).queued;
    return processResearch(db, q!.researchId, { makeFetcher: web.makeFetcher, today: TODAY });
  };
  const full = (id: string) => db.discoveryCandidate.findUniqueOrThrow({ where: { id }, include: { notes: true } });

  test("a verified, independent, in-target general repair shop becomes a prospect after research, with the reason recorded", async () => {
    const c = await candidate();
    await research(c.id);
    const after = await full(c.id);
    assert.equal(after.status, "approved");
    assert.ok(after.prospectId);
    assert.ok(after.decisionReason!.startsWith(`${AUTO_APPROVED_PREFIX} (approval@a2): target category confirmed`));
    assert.ok(after.notes.some((n) => n.body.startsWith(AUTO_APPROVED_PREFIX)));

    const prospect = await db.prospect.findUniqueOrThrow({ where: { id: after.prospectId! }, include: { notes: true, signals: true, evidence: true } });
    assert.equal(prospect.status, "new", "approval doesn't qualify or contact anyone");
    assert.equal(prospect.phone, "(805) 555-0101");
    assert.ok(prospect.notes.some((n) => /^Approved automatically \(approval@a2\) from a discovery candidate\./.test(n.body)));
    assert.ok(prospect.notes.some((n) => n.body.startsWith(AUTO_APPROVED_PREFIX)));
    const cand = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: { signals: true, evidence: true } });
    assert.equal(prospect.signals.length, cand.signals.length, "signals copied exactly as a person's approval would");
    assert.equal(prospect.evidence.length, cand.evidence.length);
  });

  test("independence unknown: held for review, no prospect", async () => {
    const c = await candidate();
    await research(c.id, noIndependence());
    const after = await full(c.id);
    assert.equal(after.status, "researched");
    assert.equal(await db.prospect.count(), 0);
    const r = (await autoApproveCandidate(db, c.id))!;
    assert.equal(r.assessment.decision, "review");
    assert.ok(r.assessment.reasons.includes("Verified collision\/body repair is unknown, not yes."));
  });

  test("a person's 'unclear' category holds it, and research doesn't override it", async () => {
    const unclear = await candidate();
    await setCandidateCategory(db, unclear.id, "unclear", "Not sure they do mechanical work.");
    await research(unclear.id);
    assert.equal((await full(unclear.id)).status, "researched");
    assert.equal((await full(unclear.id)).categorySource, "manual");
    assert.equal(await db.prospect.count(), 0);
  });

  test("a person's 'wrong category' blocks it, and research doesn't override it", async () => {
    const wrong = await candidate();
    await setCandidateCategory(db, wrong.id, "wrong_category", "Glass only, per a phone call.");
    await research(wrong.id);
    const r = (await autoApproveCandidate(db, wrong.id))!;
    assert.equal(r.assessment.decision, "blocked");
    assert.equal(await db.prospect.count(), 0);
  });

  test("a website that isn't the business's own is never approved", async () => {
    const c = await candidate();
    const other = fixtureWeb({ [`${SITE}robots.txt`]: { status: 404 }, [SITE]: { body: page("Sparkle Car Wash", "<h1>Sparkle Car Wash</h1><p>(805) 555-7777</p>") } });
    await research(c.id, other);
    const after = await full(c.id);
    assert.notEqual(after.status, "approved");
    assert.equal(after.websiteVerifiedAt, null);
    assert.equal(await db.prospect.count(), 0);
  });

  test("a person's Needs review is never overridden by later automation", async () => {
    const c = await candidate();
    await research(c.id, noIndependence());
    await changeCandidateStatus(db, c.id, "needs_review", null);
    await research(c.id); // the site now says family owned; everything else is clean
    const after = await full(c.id);
    assert.equal(after.status, "needs_review", "a person asked for a look");
    assert.equal(await db.prospect.count(), 0);
    // A person can still approve it, as before.
    await approveCandidate(db, c.id);
    const approved = await full(c.id);
    assert.equal(approved.status, "approved");
    assert.equal(approved.decisionReason, null, "a person's approval records no automatic reason");
  });

  test("manual approval of a held candidate works exactly as before", async () => {
    const c = await candidate();
    await research(c.id, noIndependence());
    const { prospect } = await approveCandidate(db, c.id);
    const notes = await db.prospectNote.findMany({ where: { prospectId: prospect.id } });
    assert.ok(notes.some((n) => /^Approved by a human from a discovery candidate\./.test(n.body)));
    assert.ok(!notes.some((n) => n.body.startsWith(AUTO_APPROVED_PREFIX)));
  });

  test("manual rejection works and blocks automation", async () => {
    const c = await candidate();
    await research(c.id, noIndependence());
    await assert.rejects(changeCandidateStatus(db, c.id, "rejected", ""), /requires a reason/);
    await changeCandidateStatus(db, c.id, "rejected", "Not a fit.");
    const r = (await autoApproveCandidate(db, c.id))!;
    assert.equal(r.assessment.decision, "blocked");
    assert.equal(await db.prospect.count(), 0);
  });

  test("repeating automation is idempotent: one prospect, ever", async () => {
    const c = await candidate();
    await research(c.id, noIndependence()); // held
    await research(c.id); // now clean: approved by the research trigger
    assert.equal(await db.prospect.count(), 1);
    const again = await runAutoApproval(db, { apply: true, candidateIds: [c.id] });
    assert.equal(again[0]!.assessment.decision, "approved");
    assert.equal(again[0]!.prospectId, undefined);
    assert.equal((await autoApproveCandidate(db, c.id))!.assessment.decision, "approved");
    await assert.rejects(approveCandidate(db, c.id, { automatic: true }), /Already approved/);
    assert.equal(await db.prospect.count(), 1);
  });

  test("the batch: a dry run changes nothing; apply approves only eligible candidates", async () => {
    const clean = await candidate();
    // A different business, never researched: not something the rule approves.
    const held = await candidate({ businessName: "Elsewhere Garage", website: "https://elsewhere.example.com/", phone: "+18055559999", streetAddress: "1 Other St", city: "Ventura" });
    await research(clean.id, fixtureWeb(independentShop(HOST)));
    await db.discoveryCandidate.update({ where: { id: clean.id }, data: { status: "researched", prospectId: null, approvedAt: null, decisionReason: null } });
    await db.prospect.deleteMany({}); // as if researched before automatic approval existed
    const dry = await runAutoApproval(db, { apply: false });
    assert.deepEqual(dry.map((r) => [r.businessName, r.assessment.decision]).sort(), [["Saviers Road Auto Repair", "approve"]]);
    assert.equal(await db.prospect.count(), 0, "a dry run changes nothing");
    assert.equal((await full(held.id)).status, "discovered");
    const applied = await runAutoApproval(db, { apply: true });
    assert.equal(applied.filter((r) => r.prospectId).length, 1);
    assert.equal(await db.prospect.count(), 1);
  });

  test("the approval re-checks the rule in its own transaction: a change in between stops it", async () => {
    const c = await candidate();
    await research(c.id, noIndependence());
    await assert.rejects(approveCandidate(db, c.id, { automatic: true }), /Verified collision\/body repair is unknown/);
    assert.equal(await db.prospect.count(), 0);
  });
});

/** A Midas franchise location: its own site, verified by name, phone, and address, under the chain's brand. */
const MIDAS_HOST = "midasoxnard.example.com";
const MIDAS_SITE = `https://${MIDAS_HOST}/`;
const midasBusiness = (): Partial<DiscoveredBusiness> => ({ businessName: "Midas (Oxnard Blvd)", website: MIDAS_SITE, phone: "+18055550202", streetAddress: "100 Oxnard Blvd" });
const midasSite = () => {
  const routes: Record<string, Fixture> = independentShop(MIDAS_HOST, "(805) 555-0202");
  routes[`https://${MIDAS_HOST}/services`]!.body = routes[`https://${MIDAS_HOST}/services`]!.body!.replace("We provide collision repair.", "We do not offer collision repair.");
  routes[MIDAS_SITE] = {
    body: page(
      "Midas Oxnard | Brakes, Oil Changes and Auto Repair",
      `<h1>Midas Oxnard</h1><p>Our 6 service bays are open Monday to Friday.</p><p>Call <a href="tel:+18055550202">(805) 555-0202</a> · 100 Oxnard Blvd, Oxnard, CA 93033</p><footer>© 2025 Midas</footer>`,
    ),
  };
  return fixtureWeb(routes);
};
/** The clean shop without a contact page: no email anywhere on its site. */
const noEmail = () => {
  const routes: Record<string, Fixture> = independentShop(HOST);
  delete routes[`https://${HOST}/contact-us`];
  return fixtureWeb(routes);
};

describe("automatic rejection and the re-decision pass (service)", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  const candidate = async (over: Partial<DiscoveredBusiness> = {}) => {
    const b = business(over);
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [b]);
    return db.discoveryCandidate.findFirstOrThrow({ where: { externalId: b.externalId } });
  };
  /** Research; `decide: false` is research as it ran before automatic rejection existed (approval only off too). */
  const research = async (id: string, web: ReturnType<typeof fixtureWeb>, decide = true) => {
    const [q] = (await enqueueResearch(db, [id], "admin")).queued;
    return processResearch(db, q!.researchId, { makeFetcher: web.makeFetcher, today: TODAY, autoApprove: decide });
  };
  const full = (id: string) => db.discoveryCandidate.findUniqueOrThrow({ where: { id }, include: { notes: true } });
  const autoNotes = (notes: { body: string }[]) => notes.filter((n) => n.body.startsWith(AUTO_REJECTED_PREFIX));

  test("a franchise location: research records the chain brand with its source, and it is rejected automatically; no prospect", async () => {
    const c = await candidate(midasBusiness());
    await research(c.id, midasSite());
    const after = await full(c.id);
    assert.equal(after.status, "rejected");
    assert.match(after.decisionReason!, /^Automatically rejected \(rejection@r2\): Verified collision\/body repair is No:/);
    assert.equal(autoNotes(after.notes).length, 1, "the reason is recorded once, as a note");
    assert.equal(await db.prospect.count(), 0);
    const evidence = await db.candidateEvidence.findFirstOrThrow({ where: { candidateId: c.id, signalKey: "independent_shop" } });
    assert.equal(evidence.origin, "research", "the rejection rests on research's own sourced evidence");
  });

  test("approved with an email on the business's own site: a prospect that outreach can prepare a first message for", async () => {
    const c = await candidate();
    await research(c.id, fixtureWeb(independentShop(HOST)));
    const after = await full(c.id);
    assert.equal(after.status, "approved");
    const prospect = await db.prospect.findUniqueOrThrow({ where: { id: after.prospectId! } });
    assert.equal(prospect.email, `service@${HOST}`);
    assert.equal(prospect.emailSourceUrl, `https://${HOST}/contact-us`);
    const preview = await previewOutreachDraft(db, prospect.id, OPTS);
    assert.deepEqual(preview.errors, [], "outreach eligibility: nothing stops a first draft");
    assert.ok(preview.message);
  });

  test("approved with no email on the site: a prospect, but not eligible for outreach", async () => {
    const c = await candidate();
    await research(c.id, noEmail());
    const after = await full(c.id);
    assert.equal(after.status, "approved");
    const prospect = await db.prospect.findUniqueOrThrow({ where: { id: after.prospectId! } });
    assert.equal(prospect.email, null);
    assert.match((await previewOutreachDraft(db, prospect.id, OPTS)).errors.join(" "), /public business email/);
  });

  test("a business that is already a prospect: the automatic decision never creates a second prospect, and doesn't reject it either", async () => {
    // (A confident duplicate is never stored as a candidate at all; this one became a prospect after it was discovered.)
    const c = await candidate();
    await createProspect(db, { businessName: "Saviers Road Auto Repair", website: SITE, city: "Oxnard", state: "CA", phone: "(805) 555-0101", phoneSourceUrl: `${SITE}contact-us` });
    await research(c.id, fixtureWeb(independentShop(HOST)));
    const after = await full(c.id);
    assert.equal(after.status, "researched", "held for a person to mark it a duplicate");
    assert.equal(await db.prospect.count(), 1, "no second prospect");
    const r = (await runAutoApproval(db, { apply: true, candidateIds: [c.id] }))[0]!;
    assert.equal(r.assessment.decision, "review");
    assert.match(r.assessment.reasons.join(" "), /An existing prospect matches this candidate/);
    assert.equal(await db.prospect.count(), 1);
  });

  test("the re-decision pass rejects a chain researched before automatic rejection existed, once; repeating changes nothing", async () => {
    const c = await candidate(midasBusiness());
    await research(c.id, midasSite(), false);
    assert.equal((await full(c.id)).status, "researched", "as research left it before rejection@r2");

    const dry = await runAutoApproval(db, { apply: false });
    assert.deepEqual(dry.map((r) => [r.businessName, r.assessment.decision]), [["Midas (Oxnard Blvd)", "reject"]]);
    assert.equal((await full(c.id)).status, "researched", "a dry run changes nothing");

    const first = await runAutoApproval(db, { apply: true });
    assert.equal(first[0]!.rejected, true);
    const rejected = await full(c.id);
    assert.equal(rejected.status, "rejected");

    // Again: nothing to decide (it is no longer Researched), so nothing changes.
    const second = await runAutoApproval(db, { apply: true });
    assert.deepEqual(second, []);
    const again = await runAutoApproval(db, { apply: true, candidateIds: [c.id] });
    assert.equal(again[0]!.rejected, undefined);
    const same = await full(c.id);
    assert.equal(same.decidedAt!.getTime(), rejected.decidedAt!.getTime());
    assert.equal(autoNotes(same.notes).length, 1, "no duplicate history");
    assert.equal(await db.prospect.count(), 0);
  });

  test("a person's hold survives repeated automation, and so does a person's reopening", async () => {
    // A hold: research shows a chain, but a person asked for a look first.
    const held = await candidate(midasBusiness());
    await research(held.id, midasSite(), false);
    await changeCandidateStatus(db, held.id, "needs_review", null);
    await runAutoApproval(db, { apply: true, candidateIds: [held.id] });
    await runAutoApproval(db, { apply: true, candidateIds: [held.id] });
    assert.equal((await full(held.id)).status, "needs_review");

    // A reopening: rejected automatically, reopened by a person, researched again: only a person rejects it now.
    await db.discoveryCandidate.delete({ where: { id: held.id } });
    const c = await candidate(midasBusiness());
    await research(c.id, midasSite());
    assert.equal((await full(c.id)).status, "rejected");
    await changeCandidateStatus(db, c.id, "discovered", null);
    const reopened = await full(c.id);
    assert.ok(reopened.notes.some((n) => n.body.startsWith(REOPENED_PREFIX) && n.body.includes("Automatically rejected")));
    await research(c.id, midasSite());
    await runAutoApproval(db, { apply: true, candidateIds: [c.id] });
    const after = await full(c.id);
    assert.equal(after.status, "researched", "held for a person, not rejected again");
    const r = (await runAutoApproval(db, { apply: false, candidateIds: [c.id] }))[0]!;
    assert.notEqual(r.assessment.decision, "reject");
  });
});

describe("automatic approval (admin HTTP)", { skip: skipReason }, () => {
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

  const make = async (web: ReturnType<typeof fixtureWeb>) => {
    const b = business();
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [b]);
    const c = await db.discoveryCandidate.findFirstOrThrow({ where: { externalId: b.externalId } });
    const [q] = (await enqueueResearch(db, [c.id], "admin")).queued;
    await processResearch(db, q!.researchId, { makeFetcher: web.makeFetcher, today: TODAY });
    return c.id;
  };

  test("an administrator sees who approved a prospect and why", async () => {
    const auto = await make(fixtureWeb(independentShop(HOST)));
    const autoPage = (await get(`/admin/discovery/candidates/${auto}`)).body;
    assert.match(autoPage, /✓<\/span>Approved automatically/);
    assert.match(autoPage, /Automatically approved \(approval@a2\): target category confirmed/);
    const list = (await get("/admin/discovery")).body;
    assert.match(list, /Approved automatically/);
    const c = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: auto } });
    const prospectPage = (await get(`/admin/prospects/${c.prospectId}`)).body;
    assert.match(prospectPage, /Approved automatically \(approval@a2\) from a discovery candidate/);
  });

  test("the Discovery summary shows what the automation decided; a rejection says why", async () => {
    await make(fixtureWeb(independentShop(HOST)));
    const b = business(midasBusiness());
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [b]);
    const chain = await db.discoveryCandidate.findFirstOrThrow({ where: { externalId: b.externalId } });
    const [q] = (await enqueueResearch(db, [chain.id], "admin")).queued;
    await processResearch(db, q!.researchId, { makeFetcher: midasSite().makeFetcher, today: TODAY });

    const list = (await get("/admin/discovery")).body;
    assert.match(list, /<section aria-label="What the automation decided"/);
    assert.match(list, /<dt>Auto-approved<\/dt><dd>1<\/dd>/);
    assert.match(list, /<dt>Rejected <span style="font-weight:400">\(1 automatically\)<\/span><\/dt><dd>1<\/dd>/);
    assert.match(list, /<dt>Review <span style="font-weight:400">a person decides<\/span><\/dt><dd>0<\/dd>/);
    const rejected = (await get("/admin/discovery?view=disregarded")).body;
    assert.match(rejected, /Automatically rejected \(rejection@r2\): Verified collision\/body repair is No/);
  });

  test("an administrator sees why a candidate is held, and can still approve it", async () => {
    const held = await make(noIndependence());
    const heldPage = (await get(`/admin/discovery/candidates/${held}`)).body;
    assert.match(heldPage, /Automatic approval \(approval@a2\): Held for human review/);
    assert.match(heldPage, /Verified collision\/body repair is unknown, not yes\./);
    assert.match(heldPage, /Needs verification/);
    assert.match(heldPage, /Approve anyway/, "a person can still approve it");
  });
});
