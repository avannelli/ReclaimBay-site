import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { scoreCandidate } from "../../src/discovery/approval.js";
import { approveCandidate, changeCandidateStatus, ingestBusinesses, updateCandidate } from "../../src/discovery/service.js";
import type { DiscoveredBusiness } from "../../src/discovery/types.js";
import { changeStatus } from "../../src/prospects.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import {
  RESEARCH_HISTORY,
  enqueueResearch,
  failStaleResearch,
  processQueuedResearch,
  processResearch,
  researchIdle,
} from "../../src/research/service.js";
import { scoreProspect } from "../../src/scoring.js";
import { fixtureWeb, independentShop, page } from "../fixtures/researchSite.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";

const TODAY = new Date("2026-10-01T12:00:00Z");
const SITE = "https://saviersauto.example.com/";

const business = (over: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness => ({
  externalId: "08f2a1b2-0000-4000-8000-000000000001",
  businessName: "Saviers Road Auto Repair",
  website: SITE,
  streetAddress: "5577 Saviers Rd",
  city: "Oxnard",
  state: "CA",
  postalCode: "93033",
  country: "US",
  latitude: 34.1468,
  longitude: -119.1773,
  phone: "+18055550101",
  category: "automotive_repair",
  categoryTier: "core",
  confidence: 0.92,
  operatingStatus: "open",
  release: "2026-09-23.1",
  ...over,
});

describe("automated research (service)", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  async function candidate(over: Partial<DiscoveredBusiness> = {}) {
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [business(over)]);
    return db.discoveryCandidate.findFirstOrThrow({ where: { externalId: over.externalId ?? business().externalId } });
  }
  const full = (id: string) => db.discoveryCandidate.findUniqueOrThrow({ where: { id }, include: { signals: true, evidence: true, notes: true } });

  async function research(id: string, web = fixtureWeb(independentShop())) {
    const q = await enqueueResearch(db, [id], "admin");
    assert.equal(q.queued.length, 1, JSON.stringify(q.skipped));
    // These tests are about research itself; automatic approval has its own tests (discovery.autoApproval.test.ts).
    return processResearch(db, q.queued[0]!.researchId, { makeFetcher: web.makeFetcher, today: TODAY, autoApprove: false });
  }

  test("a successful run verifies the website and contact, records evidence-backed signals, and leaves approval to a person", async () => {
    const c = await candidate();
    assert.equal(c.websiteVerifiedAt, null, "a provider website starts unverified");
    assert.equal(c.phone, null, "a provider phone is never contact on its own");

    const run = (await research(c.id))!;
    assert.deepEqual([run.status, run.outcome, run.version], ["completed", "website_verified", RESEARCH_VERSION]);
    assert.equal(run.pagesFetched, 4);

    const after = await full(c.id);
    assert.equal(after.status, "researched", "evidence-backed, so Researched");
    assert.ok(after.researchedAt);
    assert.ok(after.websiteVerifiedAt);
    assert.equal(after.phone, "(805) 555-0101");
    assert.equal(after.phoneSourceUrl, SITE, "the verified phone cites the business's own page");
    assert.equal(after.email, "service@saviersauto.example.com");
    assert.equal(after.prospectId, null);
    assert.equal(await db.prospect.count(), 0, "research never creates a prospect");

    const signals = Object.fromEntries(after.signals.map((s) => [s.key, `${s.value}/${s.origin}`]));
    assert.deepEqual(signals, {
      independent_shop: "yes/research",
      general_repair_services: "yes/research",
      collision_repair_services: "yes/research",
      digital_inspections: "yes/research",
      no_online_booking: "yes/research",
      website_not_https: "no/research",
      website_no_recent_date: "no/research",
      multiple_bays_or_staff: "yes/research",
    });
    assert.equal(after.evidence.length, 8, "one evidence item per signal");
    assert.ok(after.evidence.every((e) => e.origin === "research" && e.researchId === run.id && e.sourceUrl.startsWith("https://saviersauto.example.com/")));
    assert.ok(after.notes.some((n) => new RegExp(`Automated research \\(${RESEARCH_VERSION}\\): website verified`).test(n.body)));

    // Sources and facts are stored for audit, without page bodies.
    const sources = await db.researchSource.findMany({ where: { researchId: run.id } });
    assert.ok(sources.some((s) => s.kind === "robots" && s.ok));
    assert.equal(sources.filter((s) => s.kind === "website" && s.ok).length, 4);
    const facts = await db.researchFact.findMany({ where: { researchId: run.id }, include: { source: true } });
    const phoneFact = facts.find((f) => f.field === "phone")!;
    assert.equal(phoneFact.state, "verified");
    assert.equal(phoneFact.source?.url, SITE);
    assert.equal(facts.find((f) => f.field === "provider_phone")!.state, "verified");
  });

  test("the existing qualification and score consume the researched facts, unchanged", async () => {
    const c = await candidate();
    await research(c.id);
    const after = await full(c.id);
    const result = scoreCandidate(after);
    assert.equal(result.qualification, "meets_criteria");
    // The same numbers scoring.ts gives for the same facts, computed directly.
    const direct = scoreProspect({
      signals: Object.fromEntries(after.signals.map((s) => [s.key, s.value])),
      website: after.website,
      phone: after.phone,
      phoneSourceUrl: after.phoneSourceUrl,
      email: after.email,
      emailSourceUrl: after.emailSourceUrl,
    });
    assert.deepEqual(result, direct);
    // has_website 5 + contact 10 + independent 25 + general 20 + DVI 10 + no booking 5 + 3+ bays 15
    assert.equal(result.score, 90);
  });

  test("approval stays a human step and carries only verified contact", async () => {
    const c = await candidate();
    await research(c.id);
    const { prospect } = await approveCandidate(db, c.id);
    assert.equal(prospect.status, "new");
    assert.equal(prospect.phone, "(805) 555-0101");
    assert.equal(prospect.phoneSourceUrl, SITE);
    await changeStatus(db, prospect.id, "qualified", null);
    await changeStatus(db, prospect.id, "ready_to_contact", null);
  });

  test("re-running replaces the previous research signals and evidence instead of adding to them", async () => {
    const c = await candidate();
    await research(c.id);
    const first = await full(c.id);
    await research(c.id);
    const second = await full(c.id);
    assert.equal(second.signals.length, first.signals.length);
    assert.equal(second.evidence.length, first.evidence.length, "no duplicated evidence");
    assert.equal(await db.candidateResearch.count({ where: { candidateId: c.id } }), 2, "each run is history");
    for (let i = 0; i < RESEARCH_HISTORY + 2; i++) await research(c.id);
    assert.equal(await db.candidateResearch.count({ where: { candidateId: c.id } }), RESEARCH_HISTORY, "old runs are pruned");
    assert.equal((await full(c.id)).evidence.length, first.evidence.length);
  });

  test("a signal a person recorded is never changed by research; the disagreement is reported", async () => {
    const c = await candidate();
    await updateCandidate(db, c.id, readyForm({
      businessName: "Saviers Road Auto Repair",
      website: SITE,
      city: "Oxnard",
      state: "CA",
      postalCode: "93033",
      phone: "",
      phoneSourceUrl: "",
      signal_independent_shop: "no",
      signal_general_repair_services: "unknown",
      signal_no_online_booking: "unknown",
      signal_digital_inspections: "unknown",
    }));
    const run = (await research(c.id))!;
    const after = await full(c.id);
    const ind = after.signals.find((s) => s.key === "independent_shop")!;
    assert.deepEqual([ind.value, ind.origin], ["no", "manual"]);
    assert.ok((run.warnings as string[]).some((w) => /independent_shop.*person recorded no/.test(w)));
    assert.ok(!after.evidence.some((e) => e.signalKey === "independent_shop" && e.origin === "research"));
  });

  test("a stored phone is never overwritten; a different number on the website is reported", async () => {
    const c = await candidate();
    await db.discoveryCandidate.update({ where: { id: c.id }, data: { phone: "(805) 555-0999", phoneSourceUrl: "https://saviersauto.example.com/old" } });
    const run = (await research(c.id))!;
    const after = await full(c.id);
    assert.equal(after.phone, "(805) 555-0999");
    assert.ok((run.warnings as string[]).some((w) => /stored phone \(805\) 555-0999 was kept/.test(w)));
  });

  test("no website: nothing is fetched, nothing is verified, and the candidate returns to Discovered", async () => {
    const c = await candidate({ website: null });
    const web = fixtureWeb({});
    const run = (await research(c.id, web))!;
    assert.deepEqual([run.status, run.outcome], ["completed", "no_website"]);
    assert.equal(web.calls.length, 0);
    const after = await full(c.id);
    assert.equal(after.status, "discovered");
    assert.equal(after.phone, null, "the provider phone stays unverified");
    assert.equal(after.providerPhone, "+18055550101");
    assert.equal(after.signals.length, 0);
    const facts = await db.researchFact.findMany({ where: { researchId: run.id } });
    assert.equal(facts.find((f) => f.field === "provider_phone")!.state, "unverified");
    assert.equal(facts.find((f) => f.field === "website")!.state, "not_found");
  });

  test("a provider website that belongs to another business is never verified", async () => {
    const c = await candidate();
    const web = fixtureWeb({ [`${SITE}robots.txt`]: { status: 404 }, [SITE]: { body: page("Sparkle Car Wash", "<h1>Sparkle Car Wash</h1><p>(805) 555-7777</p>") } });
    const run = (await research(c.id, web))!;
    assert.equal(run.outcome, "website_mismatch");
    const after = await full(c.id);
    assert.equal(after.websiteVerifiedAt, null);
    assert.equal(after.phone, null);
    assert.equal(after.signals.length, 0);
    assert.equal(after.website, SITE, "provider data is not deleted; a person decides");
  });

  test("conflicting phones: the website's number becomes contact, the disagreement is recorded", async () => {
    const c = await candidate();
    const run = (await research(c.id, fixtureWeb(independentShop("saviersauto.example.com", "(805) 555-0202"))))!;
    const after = await full(c.id);
    assert.equal(after.phone, "(805) 555-0202");
    assert.ok((run.warnings as string[]).some((w) => /provider's phone is not on the website/.test(w)));
    const facts = await db.researchFact.findMany({ where: { researchId: run.id } });
    assert.equal(facts.find((f) => f.field === "provider_phone")!.state, "uncertain");
  });

  test("a failed run is recorded, keeps the previous research, and the candidate returns to its status", async () => {
    const c = await candidate();
    await research(c.id);
    const before = await full(c.id);
    const down = fixtureWeb({ [`${SITE}robots.txt`]: { status: 404 }, [SITE]: { error: "timeout" } });
    const run = (await research(c.id, down))!;
    assert.deepEqual([run.status, run.outcome], ["failed", "website_unreachable"]);
    assert.match(run.error!, /could not be read/);
    assert.equal(down.calls.filter((u) => u === SITE).length, 2, "one retry for a timeout, then stop");
    const after = await full(c.id);
    assert.equal(after.status, "researched");
    assert.equal(after.signals.length, before.signals.length, "a failure doesn't erase earlier research");
    assert.equal(after.evidence.length, before.evidence.length);
  });

  test("a first run that fails returns the candidate to Discovered", async () => {
    const c = await candidate();
    const run = (await research(c.id, fixtureWeb({ [`${SITE}robots.txt`]: { status: 404 }, [SITE]: { error: "dns" } })))!;
    assert.equal(run.status, "failed");
    assert.equal((await full(c.id)).status, "discovered");
  });

  test("one queued run per candidate; approved, rejected, and duplicate candidates are not researched", async () => {
    const c = await candidate();
    const first = await enqueueResearch(db, [c.id], "admin");
    const again = await enqueueResearch(db, [c.id], "admin");
    assert.equal(first.queued.length, 1);
    assert.deepEqual(again.skipped, [{ candidateId: c.id, reason: "research already queued or running" }]);
    const r = await candidate({ externalId: "08f2a1b2-0000-4000-8000-000000000002", businessName: "Rejected Motors", website: "https://rejected.example.com/", phone: null, streetAddress: "1 Elsewhere Rd", latitude: 34.3, longitude: -119.0 });
    await changeCandidateStatus(db, r.id, "rejected", "Not a fit");
    const q = await enqueueResearch(db, [r.id], "admin");
    assert.deepEqual(q.skipped, [{ candidateId: r.id, reason: "candidate is rejected" }]);
  });

  test("a candidate under review stays under review after research", async () => {
    const c = await candidate();
    await changeCandidateStatus(db, c.id, "needs_review", null);
    await research(c.id);
    assert.equal((await full(c.id)).status, "needs_review");
  });

  test("an interrupted run is marked failed and is not retried automatically", async () => {
    const c = await candidate();
    const q = await enqueueResearch(db, [c.id], "admin");
    await db.candidateResearch.update({ where: { id: q.queued[0]!.researchId }, data: { status: "running", heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
    assert.equal(await failStaleResearch(db), 1);
    const run = await db.candidateResearch.findUniqueOrThrow({ where: { id: q.queued[0]!.researchId } });
    assert.equal(run.status, "failed");
    assert.match(run.error!, /Interrupted/);
    assert.equal(await processResearch(db, run.id, {}), null, "a failed run is never picked up again");
  });

  test("a batch is processed one candidate at a time, oldest first, within its limit", async () => {
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      const c = await candidate({
        externalId: `08f2a1b2-0000-4000-8000-00000000010${i}`,
        businessName: `Shop Number ${["One", "Two", "Three"][i - 1]}`,
        website: null,
        phone: null,
        streetAddress: `${i} Main St`,
        latitude: 34 + i / 10,
        longitude: -119,
      });
      ids.push(c.id);
    }
    await enqueueResearch(db, ids, "batch");
    const pauses: number[] = [];
    const r1 = await processQueuedResearch(db, { limit: 2, sleep: async (ms) => void pauses.push(ms), makeFetcher: fixtureWeb({}).makeFetcher });
    assert.equal(r1.processed.length, 2);
    assert.equal(pauses.length, 1, "a pause between candidates");
    assert.equal(await db.candidateResearch.count({ where: { status: "queued" } }), 1);
    const r2 = await processQueuedResearch(db, { makeFetcher: fixtureWeb({}).makeFetcher });
    assert.equal(r2.processed.length, 1);
  });

  test("editing the website clears its verification", async () => {
    const c = await candidate();
    await research(c.id);
    assert.ok((await full(c.id)).websiteVerifiedAt);
    await changeCandidateStatus(db, c.id, "researching", null);
    await updateCandidate(db, c.id, readyForm({ businessName: "Saviers Road Auto Repair", website: "https://another.example.com", city: "Oxnard", state: "CA", phone: "", phoneSourceUrl: "" }));
    assert.equal((await full(c.id)).websiteVerifiedAt, null);
  });
});

describe("automated research in the admin (HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  const web = fixtureWeb(independentShop());

  before(async () => {
    db = await freshDb();
    app = await buildApp(
      loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }),
      db,
      false,
      // Research in the admin, without the automatic-approval step (tested in discovery.autoApproval.test.ts).
      { research: { makeFetcher: web.makeFetcher, today: TODAY, sleep: async () => undefined, autoApprove: false } },
    );
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, data: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: new URLSearchParams(data).toString() });

  /** Waits for the background worker without querying alongside it. */
  const settled = (_candidateId?: string) => researchIdle();

  test("Run research queues it, the page shows verified, unverified, and uncertain facts with their sources", async () => {
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [business()]);
    const c = await db.discoveryCandidate.findFirstOrThrow();
    let page = (await get(`/admin/discovery/candidates/${c.id}`)).body;
    assert.match(page, /Automated research/);
    assert.match(page, /Not researched yet/);
    assert.match(page, />Run research</);

    const res = await post(`/admin/discovery/candidates/${c.id}/research`);
    assert.equal(res.statusCode, 303);
    assert.match(String(res.headers.location), /done=research/);
    await settled(c.id);

    page = (await get(`/admin/discovery/candidates/${c.id}`)).body;
    assert.match(page, /Website verified/);
    assert.match(page, new RegExp(`rules ${RESEARCH_VERSION} · 4 pages read`));
    assert.match(page, /Verified \(\d+\)/);
    assert.match(page, /class="obs obs-yes">Verified</);
    assert.match(page, /Provider-reported · unverified \(\d+\)/);
    assert.match(page, /Uncertain \(\d+\)/);
    assert.match(page, /source: <a[^>]*href="https:\/\/saviersauto\.example\.com\//);
    assert.match(page, /robots\.txt read/);
    assert.match(page, /Research history/);
    assert.match(page, /Set by research/);
    assert.match(page, /Automated research<\/span>/, "research evidence is labelled");
    assert.match(page, />Run research again</);
    // The candidate page's qualification result (Stage 1 wording; the rule is unchanged).
    assert.match(page, /✓<\/span>Qualified/);
    assert.doesNotMatch(page, /Approved by a human/);
    assert.equal(await db.prospect.count(), 0);
  });

  test("a second click while research is queued is refused", async () => {
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [business()]);
    const c = await db.discoveryCandidate.findFirstOrThrow();
    await db.candidateResearch.create({ data: { candidateId: c.id, version: "r1", trigger: "admin" } });
    const res = await post(`/admin/discovery/candidates/${c.id}/research`);
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /already queued or running/);
  });

  test("the batch action researches up to 10 not-yet-researched candidates from the current view", async () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      business({ externalId: `ext-${i}`, businessName: `Batch Garage ${String.fromCharCode(65 + i)}`, website: null, phone: null, streetAddress: `${i + 1} Batch St`, latitude: 34 + i / 100, longitude: -119 }),
    );
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, list);
    await db.discoveryCandidate.updateMany({ where: { externalId: { in: list.map(b => b.externalId!) } }, data: { categoryVerdict: "in_target", categorySource: "manual", categoryReason: "Fixture categories verified; service evidence remains unverified." } });
    const res = await post("/admin/discovery/research", { tier: "core" });
    assert.equal(res.statusCode, 303);
    assert.match(String(res.headers.location), /done=research_batch/);
    await settled();
    assert.equal(await db.candidateResearch.count(), 10);
    const overview = (await get("/admin/discovery?done=research_batch")).body;
    assert.match(overview, /Research queued for up to 10/);
    assert.match(overview, /10 completed/);
    assert.match(overview, /No website known, so research found too little to go on\./);
    // The next batch takes the remaining two.
    await post("/admin/discovery/research", { tier: "core" });
    await settled();
    assert.equal(await db.candidateResearch.count(), 12);
    const none = await post("/admin/discovery/research", { tier: "core" });
    assert.match(String(none.headers.location), /done=research_none/);
  });
});
