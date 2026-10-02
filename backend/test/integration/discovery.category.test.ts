import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import {
  addManualCandidate,
  backfillCategoryCheck,
  changeCandidateStatus,
  ingestBusinesses,
  listCandidates,
  setCandidateCategory,
  updateCandidate,
} from "../../src/discovery/service.js";
import type { DiscoveredBusiness } from "../../src/discovery/types.js";
import { autoResearchIds, enqueueResearch, processResearch, researchIdle } from "../../src/research/service.js";
import { fixtureWeb, independentShop, page } from "../fixtures/researchSite.js";
import { TEST_DATABASE_URL, WEBSITE, freshDb, readyForm, skipReason, truncate } from "./helpers.js";

/*
 * Category Validation v1: the category check is an annotation, separate from
 * status, qualification, and the score. These tests run the real service and
 * admin against a disposable database and fixture websites (no network).
 */

const TODAY = new Date("2026-10-01T12:00:00Z");
const POPS_SITE = "https://pops.example.com/";
let seq = 0;
const business = (over: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness => ({
  externalId: `08f2a1b2-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  businessName: "Saviers Road Auto Repair",
  website: "https://saviersauto.example.com/",
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

/** The Pops One Stop Repair Shop case: a shoe and vacuum repair business listed as automotive repair. */
const popsWeb = () =>
  fixtureWeb({
    [`${POPS_SITE}robots.txt`]: { status: 404 },
    [POPS_SITE]: {
      body: page(
        "POPS ONE STOP REPAIR SHOP | HOME",
        "<h1>Pops One Stop Repair Shop</h1><p>SHOE REPAIR BOOT REPAIR VACUUM REPAIR LAMP REPAIR SHARPENING SERVICE</p><p>Pop's Camarillo 805 388 - 0700</p>",
      ),
    },
  });
const POPS = { businessName: "Pops One Stop Repair Shop", website: POPS_SITE, phone: "+18053880700", streetAddress: "2131 Pickwick Dr", city: "Camarillo" };

describe("category check (service)", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  const ingest = async (over: Partial<DiscoveredBusiness> = {}) => {
    const b = business(over);
    const counters = await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [b]);
    return { b, counters, c: await db.discoveryCandidate.findFirst({ where: { externalId: b.externalId } }) };
  };

  test("a wrong-category record is stored, not dropped, and a re-import still skips it as a duplicate", async () => {
    const { b, counters, c } = await ingest({ businessName: "Able Auto Glass", website: "https://ventura-autoglass.example.com/" });
    assert.equal(counters.created, 1);
    assert.ok(c, "stored for auditability");
    assert.deepEqual([c!.categoryVerdict, c!.categorySource, c!.categoryRules, c!.status], ["wrong_category", "name", "automotive@c1", "discovered"]);
    assert.match(c!.categoryReason!, /auto glass/);
    const again = await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [b]);
    assert.deepEqual([again.created, again.duplicates], [0, 1], "the duplicate index is unchanged");
    assert.equal(await db.discoveryCandidate.count(), 1);
  });

  test("every new candidate is checked: provider, name, and hand-added", async () => {
    const plain = (await ingest({ businessName: "Bill Hahn's Automotive" })).c!;
    assert.deepEqual([plain.categoryVerdict, plain.categorySource], ["in_target", "provider"]);
    const mixed = (await ingest({ businessName: "German Tech Auto Repair and Sales", website: "https://germantech.example.com/" })).c!;
    assert.equal(mixed.categoryVerdict, "unclear");
    const manual = await addManualCandidate(db, { businessName: "Sun City Glass Tinting", city: "Ventura", state: "CA" });
    assert.deepEqual([manual.categoryVerdict, manual.categorySource], ["wrong_category", "name"]);
  });

  test("renaming re-runs the name check, but never over a person's decision", async () => {
    const c = (await ingest({ businessName: "Able Auto Glass", website: "https://ableglass.example.com/" })).c!;
    await updateCandidate(db, c.id, { businessName: "Able Auto Repair", city: "Oxnard", state: "CA" });
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).categoryVerdict, "in_target");
    await setCandidateCategory(db, c.id, "wrong_category", "Checked by phone: glass only.");
    await updateCandidate(db, c.id, { businessName: "Able Auto Service", city: "Oxnard", state: "CA" });
    const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.deepEqual([after.categoryVerdict, after.categorySource], ["wrong_category", "manual"]);
  });

  test("automatic research selection skips wrong category; an explicit request still works; unclear stays eligible", async () => {
    const wrong = (await ingest({ businessName: "Wrap Labs", website: "https://wraplabs.example.com/" })).c!;
    const unclear = (await ingest({ businessName: "Auto Body & Repair", website: "https://abr.example.com/" })).c!;
    const fine = (await ingest({ businessName: "Bill Hahn's Automotive", website: "https://billhahn.example.com/" })).c!;
    const list = await listCandidates(db, {});
    const ids = autoResearchIds(list.rows, 10);
    assert.ok(!ids.includes(wrong.id));
    assert.ok(ids.includes(unclear.id) && ids.includes(fine.id));
    const explicit = await enqueueResearch(db, [wrong.id], "admin");
    assert.equal(explicit.queued.length, 1, "a person can still research it");
  });

  test("research records the website's verdict, with its source, and can't overwrite a person's decision", async () => {
    const c = (await ingest({ ...POPS })).c!;
    assert.equal(c.categoryVerdict, "in_target", "the name alone looks fine");
    const [q] = (await enqueueResearch(db, [c.id], "admin")).queued;
    const run = (await processResearch(db, q!.researchId, { makeFetcher: popsWeb().makeFetcher, today: TODAY }))!;
    assert.equal(run.version, "r11");
    const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.deepEqual([after.categoryVerdict, after.categorySource, after.categorySourceUrl], ["wrong_category", "website", POPS_SITE]);
    assert.match(after.categoryReason!, /^Website describes shoe repair, boot repair, vacuum repair, lamp repair and sharpening; no automotive services or vocabulary/);
    const fact = await db.researchFact.findFirst({ where: { researchId: run.id, field: "business_category" } });
    assert.equal(fact?.value, "Wrong category");

    // A person decides otherwise; research keeps that and says so.
    await setCandidateCategory(db, c.id, "in_target", "Owner confirmed they also repair cars.");
    const [q2] = (await enqueueResearch(db, [c.id], "admin")).queued;
    const run2 = (await processResearch(db, q2!.researchId, { makeFetcher: popsWeb().makeFetcher, today: TODAY }))!;
    const kept = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.deepEqual([kept.categoryVerdict, kept.categorySource], ["in_target", "manual"]);
    assert.ok((run2.warnings as string[]).some((w) => /a person set the category; the person's decision was kept/.test(w)));
  });

  test("the list: a category filter, and wrong category is never ranked, qualified, or banded", async () => {
    const wrong = (await ingest({ businessName: "Caliber Collision", website: "https://caliber.example.com/" })).c!;
    const fine = (await ingest({ businessName: "Bill Hahn's Automotive", website: "https://billhahn.example.com/" })).c!;
    const only = await listCandidates(db, { category: "wrong_category" });
    assert.deepEqual(only.rows.map((r) => r.candidate.id), [wrong.id]);
    const ranked = await listCandidates(db, { sort: "score" });
    assert.deepEqual(ranked.rows.map((r) => r.candidate.id), [fine.id]);
    assert.equal(ranked.notRanked, 1);
    const unverified = await listCandidates(db, { qualification: "unverified" });
    assert.ok(!unverified.rows.some((r) => r.candidate.id === wrong.id));
    const all = await listCandidates(db, {});
    assert.equal(all.rows.find((r) => r.candidate.id === wrong.id)!.outsideTarget, true);
  });

  test("the backfill: a dry run writes nothing, apply is repeatable, and people's and websites' decisions are kept", async () => {
    const glass = (await ingest({ businessName: "Able Auto Glass", website: "https://ableglass.example.com/" })).c!;
    const plain = (await ingest({ businessName: "Bill Hahn's Automotive", website: "https://billhahn.example.com/" })).c!;
    const person = (await ingest({ businessName: "Wrap Labs", website: "https://wraplabs.example.com/" })).c!;
    await setCandidateCategory(db, person.id, "in_target", "They also repair cars.");
    const site = (await ingest({ businessName: "Mario's Auto Body", website: "https://marios.example.com/" })).c!;
    await db.discoveryCandidate.update({ where: { id: site.id }, data: { categoryVerdict: "in_target", categorySource: "website", categoryReason: "The website names general repair services." } });
    // Simulate candidates stored before the category check existed.
    await db.discoveryCandidate.updateMany({ where: { id: { in: [glass.id, plain.id] } }, data: { categoryVerdict: null, categorySource: null, categoryReason: null, categoryRules: null, categoryCheckedAt: null } });
    const statusesBefore = await db.discoveryCandidate.findMany({ select: { id: true, status: true }, orderBy: { id: "asc" } });

    const dry = await backfillCategoryCheck(db, { apply: false });
    assert.equal(dry.changes.length, 2);
    assert.deepEqual([dry.skipped.manual, dry.skipped.website], [1, 1]);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: glass.id } })).categoryVerdict, null, "a dry run writes nothing");

    const applied = await backfillCategoryCheck(db, { apply: true });
    assert.equal(applied.changes.length, 2);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: glass.id } })).categoryVerdict, "wrong_category");
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: plain.id } })).categoryVerdict, "in_target");
    assert.deepEqual(applied.verdicts, { in_target: 3, wrong_category: 1, unclear: 0 });

    const again = await backfillCategoryCheck(db, { apply: true });
    assert.equal(again.changes.length, 0, "a second run rewrites nothing");
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: person.id } })).categorySource, "manual");
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: site.id } })).categorySource, "website");
    assert.deepEqual(await db.discoveryCandidate.findMany({ select: { id: true, status: true }, orderBy: { id: "asc" } }), statusesBefore, "no status changes");
    assert.equal(await db.prospect.count(), 0);
    assert.equal(await db.candidateResearch.count(), 0);
  });

  test("rejecting still needs a reason, and the category check never changes a status", async () => {
    const c = (await ingest({ businessName: "Streamline Garage Doors", website: "https://streamline.example.com/" })).c!;
    assert.equal(c.status, "discovered", "wrong category is not a rejection");
    await assert.rejects(changeCandidateStatus(db, c.id, "rejected", ""), /requires a reason/);
    await changeCandidateStatus(db, c.id, "rejected", "Garage doors, not auto repair.");
    const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.deepEqual([after.status, after.categoryVerdict], ["rejected", "wrong_category"]);
    await assert.rejects(setCandidateCategory(db, c.id, "in_target", ""), /needs a reason/);
  });
});

describe("category check (admin HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  const web = fixtureWeb({ ...independentShop("billhahn.example.com"), ...{ [`${POPS_SITE}robots.txt`]: { status: 404 } } });

  before(async () => {
    db = await freshDb();
    app = await buildApp(
      loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }),
      db,
      false,
      { research: { makeFetcher: web.makeFetcher, today: TODAY, sleep: async () => undefined } },
    );
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: form({ secret: SECRET }) });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => {
    await researchIdle();
    await truncate(db);
  });
  after(async () => {
    await researchIdle();
    await app?.close();
    await db?.$disconnect();
  });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, data: Record<string, string>, auth = true) =>
    app.inject({ method: "POST", url, headers: { ...FORM, ...(auth ? { cookie } : {}) }, payload: form(data) });
  const idFrom = (location: unknown) => /candidates\/([0-9a-f-]{36})/.exec(String(location))![1]!;

  /** A hand-added candidate researched through the forms, ready for approval except for its category. */
  async function readyCandidate(businessName: string) {
    const add = await post("/admin/discovery/candidates", { businessName, website: WEBSITE, city: "Springfield", state: "IL" });
    assert.equal(add.statusCode, 303, add.body);
    const id = idFrom(add.headers.location);
    assert.equal((await post(`/admin/discovery/candidates/${id}`, readyForm({ businessName, signal_no_online_booking: "unknown", signal_digital_inspections: "unknown" }))).statusCode, 303);
    assert.equal((await post(`/admin/discovery/candidates/${id}/status`, { status: "researching" })).statusCode, 303);
    for (const signalKey of ["independent_shop", "general_repair_services"]) {
      await post(`/admin/discovery/candidates/${id}/evidence`, { signalKey, sourceUrl: `${WEBSITE}/about`, excerpt: `Public page supports ${signalKey}.` });
    }
    assert.equal((await post(`/admin/discovery/candidates/${id}/status`, { status: "researched" })).statusCode, 303);
    return id;
  }

  test("the detail page separates the category check from qualification, and doesn't score a wrong-category business", async () => {
    const id = await readyCandidate("Able Auto Glass");
    const html = (await get(`/admin/discovery/candidates/${id}`)).body;
    assert.match(html, /Category check/);
    assert.match(html, /✕ Wrong category/);
    assert.match(html, /The name indicates auto glass/);
    assert.match(html, /not qualification/);
    assert.match(html, /Not scored: outside the target category/);
    assert.match(html, /Not assessed/);
    assert.match(html, /<b>Automated<\/b>/);
    assert.doesNotMatch(html, /class="rv-score">\d+<\/b>/, "no raw score is shown");

    const fine = await readyCandidate("Smith Auto Repair");
    const ok = (await get(`/admin/discovery/candidates/${fine}`)).body;
    assert.match(ok, /✓ In target category/);
    assert.match(ok, /class="rv-score">\d+<\/b>/);
    assert.doesNotMatch(ok, /Not scored: outside the target category/);
  });

  test("approval is blocked for wrong category, and works after a deliberate override", async () => {
    const id = await readyCandidate("Able Auto Glass");
    const refused = await post(`/admin/discovery/candidates/${id}/approve`, {});
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /outside the target category/);
    assert.equal(await db.prospect.count(), 0);

    const noReason = await post(`/admin/discovery/candidates/${id}/category`, { categoryVerdict: "in_target", categoryReason: "" });
    assert.equal(noReason.statusCode, 400);
    assert.match(noReason.body, /A category decision needs a reason/);
    const override = await post(`/admin/discovery/candidates/${id}/category`, { categoryVerdict: "in_target", categoryReason: "Confirmed by phone: full mechanical repair." });
    assert.equal(override.statusCode, 303);
    const c = await db.discoveryCandidate.findUniqueOrThrow({ where: { id }, include: { notes: true } });
    assert.deepEqual([c.categoryVerdict, c.categorySource, c.categoryRules, c.status], ["in_target", "manual", null, "researched"]);
    assert.ok(c.notes.some((n) => /set by a person to In target category/.test(n.body)));
    assert.match((await get(`/admin/discovery/candidates/${id}`)).body, /A person&#39;s decision|A person's decision/);

    const approved = await post(`/admin/discovery/candidates/${id}/approve`, {});
    assert.equal(approved.statusCode, 303, approved.body);
    assert.equal(await db.prospect.count(), 1);
  });

  test("the override route needs a session", async () => {
    const id = await readyCandidate("Able Auto Glass");
    const res = await post(`/admin/discovery/candidates/${id}/category`, { categoryVerdict: "in_target", categoryReason: "x" }, false);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, "/admin/login");
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id } })).categorySource, "name");
  });

  test("the list: category filter, 'not ranked' note, and bulk research skips wrong category", async () => {
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [
      business({ businessName: "Wrap Labs", website: "https://wraplabs.example.com/" }),
      business({ businessName: "Bill Hahn's Automotive", website: "https://billhahn.example.com/" }),
    ]);
    const filtered = (await get("/admin/discovery?category=wrong_category")).body;
    assert.match(filtered, /Wrap Labs/);
    assert.doesNotMatch(filtered, /Bill Hahn/);
    const byScore = (await get("/admin/discovery?sort=score")).body;
    assert.match(byScore, /1 outside the target category not ranked/);
    assert.doesNotMatch(byScore, /Wrap Labs/);

    const bulk = await post("/admin/discovery/research", {});
    assert.equal(bulk.statusCode, 303);
    await researchIdle();
    const runs = await db.candidateResearch.findMany({ include: { candidate: { select: { businessName: true } } } });
    assert.deepEqual(runs.map((r) => r.candidate.businessName), ["Bill Hahn's Automotive"]);
  });
});
