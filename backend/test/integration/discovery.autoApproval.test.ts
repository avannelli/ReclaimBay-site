import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { AUTO_APPROVED_PREFIX } from "../../src/discovery/autoApproval.js";
import {
  approveCandidate,
  autoApproveCandidate,
  changeCandidateStatus,
  ingestBusinesses,
  runAutoApproval,
  setCandidateCategory,
} from "../../src/discovery/service.js";
import type { DiscoveredBusiness } from "../../src/discovery/types.js";
import { enqueueResearch, processResearch } from "../../src/research/service.js";
import { fixtureWeb, independentShop, page } from "../fixtures/researchSite.js";
import { TEST_DATABASE_URL, freshDb, skipReason, truncate } from "./helpers.js";

/*
 * Automatic approval (approval@a1) through the real service, research, and
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
    assert.ok(after.decisionReason!.startsWith(`${AUTO_APPROVED_PREFIX} (approval@a1): target category confirmed`));
    assert.ok(after.notes.some((n) => n.body.startsWith(AUTO_APPROVED_PREFIX)));

    const prospect = await db.prospect.findUniqueOrThrow({ where: { id: after.prospectId! }, include: { notes: true, signals: true, evidence: true } });
    assert.equal(prospect.status, "new", "approval doesn't qualify or contact anyone");
    assert.equal(prospect.phone, "(805) 555-0101");
    assert.ok(prospect.notes.some((n) => /^Approved automatically \(approval@a1\) from a discovery candidate\./.test(n.body)));
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
    assert.ok(r.assessment.reasons.includes("Independent shop is unknown, not yes."));
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
    await assert.rejects(approveCandidate(db, c.id, { automatic: true }), /Independent shop is unknown/);
    assert.equal(await db.prospect.count(), 0);
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
    assert.match(autoPage, /✓ Approved automatically/);
    assert.match(autoPage, /Automatically approved \(approval@a1\): target category confirmed/);
    const list = (await get("/admin/discovery")).body;
    assert.match(list, /Approved automatically/);
    const c = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: auto } });
    const prospectPage = (await get(`/admin/prospects/${c.prospectId}`)).body;
    assert.match(prospectPage, /Approved automatically \(approval@a1\) from a discovery candidate/);
  });

  test("an administrator sees why a candidate is held, and can still approve it", async () => {
    const held = await make(noIndependence());
    const heldPage = (await get(`/admin/discovery/candidates/${held}`)).body;
    assert.match(heldPage, /Automatic approval \(approval@a1\): Held for human review/);
    assert.match(heldPage, /Independent shop is unknown, not yes\./);
    assert.match(heldPage, /Approve and create prospect/, "a person can still approve it");
  });
});
