import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import type { ProviderImporter, StagedPlace } from "../../src/discovery/types.js";
import { changeControl, readControl, recordPriorScreening, replenishmentStatus, runReplenishment, type ReplenishmentDeps } from "../../src/replenishment/service.js";
import { independentShop, type Fixture } from "../fixtures/researchSite.js";
import { freshDb, skipReason, truncate } from "./helpers.js";

/*
 * Supply replenishment against a real, disposable PostgreSQL: the controls, sourcing, durable budgets,
 * prescreening through the real research transport (fixture websites, no network), intake through the
 * existing Discovery pipeline, idempotency and the fail-closed paths. Nothing is ever sent.
 */

const RELEASE = "2026-10-21.0";
const TEST_AREAS = [
  { key: "oxnard", label: "Oxnard", state: "CA", county: "Ventura County", cities: ["oxnard"], zips: ["93033"] },
  { key: "camarillo", label: "Camarillo", state: "CA", county: "Ventura County", cities: ["camarillo"], zips: ["93010"] },
];

/** An independent shop's fixture site under another name, street, phone and (optionally) email. */
function shopSite(host: string, name: string, street: string, phone: string, email: string | null = `service@${host}`) {
  const base = independentShop(host, phone);
  const out: Record<string, Fixture> = {};
  for (const [url, f] of Object.entries(base)) {
    let body = (f as Fixture).body?.replaceAll("Saviers Road Auto Repair", name).replaceAll("5577 Saviers Rd", street);
    if (url.endsWith("/contact-us")) body = email ? body?.replaceAll(`service@${host}`, email) : "<!doctype html><html><head><title>Contact</title></head><body><h1>Contact</h1><p>Call us.</p></body></html>";
    out[url] = { ...(f as Fixture), body };
  }
  return out;
}

const place = (n: number, over: Partial<StagedPlace> = {}): StagedPlace => ({
  externalId: `ov-${n}`, businessName: `Shop ${n} Auto Repair`, website: `https://shop${n}.example.com/`, phone: `(805) 555-01${String(n).padStart(2, "0")}`,
  streetAddress: `${100 + n} Main St`, city: "Oxnard", county: "Ventura County", state: "CA", postalCode: "93033", country: "US",
  latitude: 34.1 + n / 100, longitude: -119.1 - n / 100, category: "automotive_repair", categoryTier: "core", brand: null, confidence: 0.95,
  operatingStatus: "open", sourceUrl: null, sources: "meta (CDLA-Permissive-2.0)", ...over,
});

function world(places: StagedPlace[], sites: Record<string, Fixture>, opts: { failSource?: boolean } = {}) {
  const calls: string[] = [];
  const importer: ProviderImporter = {
    provider: "overture", label: "Overture Maps Places",
    resolveRelease: async () => RELEASE,
    checkScope: (s) => (s.county ? null : "county required"),
    async *fetch(_release, scope) {
      if (opts.failSource) throw new Error("provider read failed at s3://overturemaps-us-west-2/release/x");
      yield places.filter((p) => p.county === scope.county);
    },
  };
  const transportFetch = async (url: string) => {
    calls.push(url);
    const f = sites[url];
    if (!f) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(f.body ?? "", { status: f.status ?? 200, headers: { "content-type": f.contentType ?? "text/html; charset=utf-8" } });
  };
  const deps: ReplenishmentDeps = { importer, screen: { transportFetch, sleep: async () => undefined } };
  return { deps, calls };
}

const shops = () => {
  const places = [place(1), place(2), place(3), place(4, { businessName: "Midas Oxnard" }), place(5, { city: "Camarillo", postalCode: "93010" })];
  const sites = {
    ...shopSite("shop1.example.com", "Shop 1 Auto Repair", "101 Main St", "(805) 555-0101"),
    ...shopSite("shop2.example.com", "Shop 2 Auto Repair", "102 Main St", "(805) 555-0102"),
    // Shop 3 publishes no email: kept out (requirePublishedEmail).
    ...shopSite("shop3.example.com", "Shop 3 Auto Repair", "103 Main St", "(805) 555-0103", null),
    ...shopSite("shop5.example.com", "Shop 5 Auto Repair", "105 Main St", "(805) 555-0105"),
  };
  return { places, sites };
};

async function enable(db: Db, config: unknown = { areas: TEST_AREAS, lowSupply: 5, limits: { cooldownMinutes: 15 } }) {
  await changeControl(db, "configure", "test areas", config);
  await changeControl(db, "enable", "test enable");
}

async function counts(db: Db) {
  return {
    batches: await db.replenishmentBatch.count(), entries: await db.screeningEntry.count(), candidates: await db.discoveryCandidate.count(),
    runs: await db.discoveryRun.count(), prospects: await db.prospect.count(), outreach: await db.outreach.count(), controls: await db.replenishmentControlChange.count(),
  };
}

describe("supply replenishment (real PostgreSQL)", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
  });
  after(async () => db?.$disconnect());

  test("off by default: unarmed, or armed without the control, does nothing and reads nothing", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    assert.equal((await runReplenishment(db, { armed: false, deps: w.deps })).outcome, "disabled");
    assert.equal((await runReplenishment(db, { armed: true, deps: w.deps })).outcome, "disabled");
    assert.equal((await readControl(db)).enabled, false);
    assert.deepEqual(await counts(db), { batches: 0, entries: 0, candidates: 0, runs: 0, prospects: 0, outreach: 0, controls: 0 });
    assert.equal(w.calls.length, 0);
  });

  test("one batch sources the area, prescreens within budget and adds only accepted businesses to Discovery", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    await enable(db);
    const r = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(r.outcome, "completed", JSON.stringify(r));
    assert.equal(r.area, "oxnard");
    assert.deepEqual(r.supply, { eligible: 0, pendingResearch: 0, total: 0 });
    // Midas is never sourced; Camarillo is another area; three are screened.
    assert.equal(r.source?.selected, 3);
    assert.equal(r.source?.skipped.unsuitable_segment, 1);
    assert.equal(r.source?.skipped.outside_area, 1);
    assert.deepEqual([r.screened, r.accepted, r.rejected, r.errors, r.ingested], [3, 2, 1, 0, 2]);
    assert.deepEqual(r.rejections, { no_published_email: 1 });
    const batch = await db.replenishmentBatch.findUniqueOrThrow({ where: { id: r.batchId! } });
    assert.equal(batch.status, "completed");
    assert.equal(batch.reservedFetches, 0);
    assert.equal(batch.reservedBytes, 0);
    assert.equal(batch.fetches, w.calls.length);
    assert.ok(batch.runId);
    const candidates = await db.discoveryCandidate.findMany({ where: { runId: batch.runId! }, orderBy: { externalId: "asc" } });
    assert.deepEqual(candidates.map((c) => [c.provider, c.externalId, c.email, c.status]), [["overture", "ov-1", null, "discovered"], ["overture", "ov-2", null, "discovered"]]);
    const entries = await db.screeningEntry.findMany({ orderBy: { externalId: "asc" } });
    assert.deepEqual(entries.map((e) => [e.externalId, e.status, !!e.candidateId]), [["ov-1", "ingested", true], ["ov-2", "ingested", true], ["ov-3", "rejected", false]]);
    assert.equal(entries[0]!.publishedEmail, "service@shop1.example.com");
    // Nothing beyond supply: no prospect, message or sending control.
    assert.equal(await db.prospect.count(), 0);
    assert.equal(await db.outreach.count(), 0);
    assert.equal(await db.outreachControlChange.count(), 0);
  });

  test("idempotent: a cooldown, then pending research counts as supply, and no record is ever screened twice", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    await enable(db);
    const first = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(first.outcome, "completed");
    assert.equal((await runReplenishment(db, { armed: true, deps: w.deps })).outcome, "cooldown");
    await db.replenishmentBatch.updateMany({ data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    const second = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.deepEqual(second.supply, { eligible: 0, pendingResearch: 2, total: 2 });
    // The Oxnard records are all screened; the rotation moves to Camarillo.
    assert.equal(second.area, "camarillo");
    assert.equal(second.outcome, "completed");
    assert.equal(second.ingested, 1);
    const ids = (await db.screeningEntry.findMany({ select: { externalId: true } })).map((e) => e.externalId).sort();
    assert.deepEqual(ids, ["ov-1", "ov-2", "ov-3", "ov-5"]);
    // Supply at the threshold stops it.
    await changeControl(db, "configure", "lower threshold", { areas: TEST_AREAS, lowSupply: 3, limits: { cooldownMinutes: 15 } });
    await db.replenishmentBatch.updateMany({ data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    assert.equal((await runReplenishment(db, { armed: true, deps: w.deps })).outcome, "not_needed");
  });

  test("an area with nothing left is recorded exhausted and skipped by the rotation", async () => {
    const w = world([place(5, { city: "Camarillo", postalCode: "93010" })], shopSite("shop5.example.com", "Shop 5 Auto Repair", "105 Main St", "(805) 555-0105"));
    await enable(db);
    const r = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.area, "oxnard");
    // Only the provider was read: the next run moves on at once, without the cooldown.
    const next = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(next.area, "camarillo");
    assert.equal(next.ingested, 1);
  });

  test("a dry run sources and screens but writes nothing, even with the control off", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    await changeControl(db, "configure", "test areas", { areas: TEST_AREAS });
    const before = await counts(db);
    const r = await runReplenishment(db, { armed: false, dryRun: true, deps: w.deps });
    assert.equal(r.outcome, "completed", JSON.stringify(r));
    assert.equal(r.dryRun, true);
    assert.equal(r.accepted, 2);
    assert.deepEqual(r.wouldAdd?.map((a) => [a.businessName, a.domain, a.emailDomain]), [["Shop 1 Auto Repair", "shop1.example.com", "shop1.example.com"], ["Shop 2 Auto Repair", "shop2.example.com", "shop2.example.com"]]);
    assert.ok(r.fetches > 0);
    assert.deepEqual(await counts(db), before);
    assert.equal(await db.replenishmentControl.count(), 1);
  });

  test("budgets: once the batch budget is reserved, the rest of the batch is never screened", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    await enable(db, { areas: TEST_AREAS, lowSupply: 5, limits: { cooldownMinutes: 15, fetches: 20, perBusinessFetches: 15, concurrency: 1 } });
    const r = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(r.outcome, "completed", JSON.stringify(r));
    assert.equal(r.screened, 2);
    assert.equal(r.skippedBudget, 1);
    const batch = await db.replenishmentBatch.findUniqueOrThrow({ where: { id: r.batchId! } });
    assert.ok(batch.fetches <= 20);
    assert.equal(batch.reservedFetches, 0);
    assert.equal(await db.screeningEntry.count({ where: { status: "budget" } }), 1);
  });

  test("a published email that is suppressed keeps the business out", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    await db.emailSuppression.create({ data: { email: "service@shop2.example.com", reason: "unsubscribed" } });
    await enable(db);
    const r = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(r.ingested, 1);
    assert.equal(r.rejections.suppressed_or_existing_email, 1);
  });

  test("out of time: screening resumes on the next run without screening anything twice", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    await enable(db, { areas: TEST_AREAS, lowSupply: 5, limits: { cooldownMinutes: 15, concurrency: 1 } });
    const first = await runReplenishment(db, { armed: true, deadline: Date.now() + 30_000, deps: w.deps });
    assert.equal(first.outcome, "screening");
    assert.equal(first.screened, 0);
    // A business interrupted mid-screen keeps its reservation charged and is not retried.
    const stuck = await db.screeningEntry.findFirstOrThrow({ where: { status: "pending" }, orderBy: { createdAt: "asc" } });
    await db.screeningEntry.update({ where: { id: stuck.id }, data: { status: "screening" } });
    await db.replenishmentBatch.update({ where: { id: first.batchId! }, data: { reservedFetches: { increment: 25 }, reservedBytes: { increment: 8_000_000 } } });
    const second = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(second.outcome, "completed", JSON.stringify(second));
    assert.equal(second.batchId, first.batchId);
    const batch = await db.replenishmentBatch.findUniqueOrThrow({ where: { id: first.batchId! } });
    assert.equal(batch.screened, 3);
    assert.equal(batch.errors, 1);
    assert.equal(batch.reservedFetches, 0);
    assert.ok(batch.fetches >= 25, "the interrupted reservation stays charged");
    assert.equal((await db.screeningEntry.findUniqueOrThrow({ where: { id: stuck.id } })).status, "error");
  });

  test("fail-closed: an unexpected error pauses replenishment, with its reason, until a person resumes it", async () => {
    const { places, sites } = shops();
    await enable(db);
    const r = await runReplenishment(db, { armed: true, deps: world(places, sites, { failSource: true }).deps });
    assert.equal(r.outcome, "failed");
    assert.doesNotMatch(r.reason ?? "", /s3:\/\//);
    const control = await readControl(db);
    assert.equal(control.paused, true);
    assert.match(control.pauseReason ?? "", /Automatic pause/);
    assert.equal(await db.replenishmentControlChange.count({ where: { action: "auto_pause" } }), 1);
    assert.equal((await runReplenishment(db, { armed: true, deps: world(places, sites).deps })).outcome, "paused");
    await changeControl(db, "resume", "reviewed the provider error");
    assert.equal((await runReplenishment(db, { armed: true, deps: world(places, sites).deps })).outcome, "completed");
  });

  test("fail-closed: an interrupted intake is never retried automatically", async () => {
    await enable(db);
    await db.replenishmentBatch.create({ data: { status: "intake", area: "oxnard", provider: "overture", release: RELEASE, trigger: {}, limits: {} } });
    const { places, sites } = shops();
    const r = await runReplenishment(db, { armed: true, deps: world(places, sites).deps });
    assert.equal(r.outcome, "failed");
    assert.match(r.reason ?? "", /interrupted during intake/);
    assert.equal((await readControl(db)).paused, true);
    assert.equal(await db.discoveryCandidate.count(), 0);
  });

  test("switched off after screening: intake waits, then completes once switched back on", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    await enable(db, { areas: TEST_AREAS, lowSupply: 5, limits: { cooldownMinutes: 15, concurrency: 1 } });
    // A concurrent Discovery run defers intake (never two runs at once).
    await db.discoveryRun.create({ data: { provider: "fixture", region: "Ventura County, CA", businessType: "Automotive repair", tiers: ["core"], status: "running" } });
    const r = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(r.outcome, "deferred");
    assert.equal((await db.replenishmentBatch.findUniqueOrThrow({ where: { id: r.batchId! } })).status, "ready");
    await db.discoveryRun.updateMany({ data: { status: "completed" } });
    const resumed = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(resumed.outcome, "completed");
    assert.equal(resumed.ingested, 2);
  });

  test("a recorded prior prescreen is never screened again, and never counts toward the cooldown", async () => {
    const { places, sites } = shops();
    const w = world(places, sites);
    // One area, so the rotation has to come back to the area the prior screening covered.
    await enable(db, { areas: [TEST_AREAS[0]], lowSupply: 5, limits: { cooldownMinutes: 15 } });
    const prior = { label: "targeted-outreach-03", area: "oxnard", release: RELEASE, entries: [{ business: places[0]!, status: "rejected" as const, reasons: ["unsuitable_ownership"] }] };
    assert.deepEqual((await recordPriorScreening(db, prior, "TO03 decisions")).recorded, 1);
    assert.equal((await recordPriorScreening(db, prior, "repeat")).alreadyPresent, 1);
    await assert.rejects(recordPriorScreening(db, prior, " "), /reason/);
    const r = await runReplenishment(db, { armed: true, deps: w.deps });
    assert.equal(r.outcome, "completed", JSON.stringify(r));
    assert.equal(r.source?.skipped.already_screened, 1);
    assert.equal(r.screened, 2);
    assert.ok(!w.calls.some((u) => u.includes("shop1.example.com")), "the recorded business is not fetched");
    assert.equal(await db.screeningEntry.count({ where: { externalId: "ov-1", status: "rejected" } }), 1);
  });

  test("every control change is audited, and an invalid configuration is refused before it is stored", async () => {
    await changeControl(db, "enable", "start");
    await changeControl(db, "pause", "holiday");
    await changeControl(db, "resume", "back");
    await changeControl(db, "disable", "stop");
    await assert.rejects(changeControl(db, "configure", "bad", { limits: { businesses: 1_000 } }), /businesses/);
    await assert.rejects(changeControl(db, "enable", "  "), /reason/);
    const changes = await db.replenishmentControlChange.findMany({ orderBy: { createdAt: "asc" } });
    assert.deepEqual(changes.map((c) => [c.action, c.enabled, c.paused]), [["enable", true, false], ["pause", true, true], ["resume", true, false], ["disable", false, false]]);
    const status = await replenishmentStatus(db);
    assert.equal(status.control.enabled, false);
    assert.equal(status.changes.length, 4);
  });
});
