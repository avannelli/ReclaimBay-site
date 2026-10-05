import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { scoreCandidate } from "../../src/discovery/approval.js";
import { bboxOf, type Boundary, type Polygon } from "../../src/discovery/boundaries.js";
import { createOvertureImporter, type OvertureRow } from "../../src/discovery/overture.js";
import { discoveryProviders } from "../../src/discovery/providers.js";
import {
  applyResearchFindings,
  approveCandidate,
  changeCandidateStatus,
  listCandidates,
  processDiscoveryRun,
  processQueuedRuns,
  queueDiscoveryRun,
  runDiscovery,
} from "../../src/discovery/service.js";
import { STALE_IMPORT_MS, runImport } from "../../src/discovery/staging.js";
import type { DiscoveryProvider } from "../../src/discovery/types.js";
import { ProspectError, changeStatus } from "../../src/prospects.js";
import { TEST_DATABASE_URL, freshDb, skipReason, truncate } from "./helpers.js";

/*
 * The Overture importer end to end, with the network replaced: Overture-shaped
 * rows (synthetic, example.com) and a square stand-in for the county
 * boundary. Everything after the source is the real code: staging, the
 * Overture staged provider, normalization, dedupe, candidates, approval.
 */

const RELEASE = "2026-09-23.1";
const COUNTY = { region: "US-CA", county: "Ventura County" };
const RUN = { provider: "overture", region: "Ventura County, CA", businessType: "Independent automotive repair" };
const SQUARE: Polygon = [[[-119.5, 34.0], [-118.6, 34.0], [-118.6, 34.9], [-119.5, 34.9], [-119.5, 34.0]]];
const BOUNDARY: Boundary = { name: "Ventura County", state: "CA", geoid: "06111", bbox: bboxOf([SQUARE]), polygons: [SQUARE] };
const AUTO = ["travel_and_transportation", "vehicle_service", "automotive_service"];
const CATALOG = {
  latest: RELEASE,
  links: [
    { rel: "child", href: "https://stac.overturemaps.org/2026-08-19.0/catalog.json" },
    { rel: "child", href: `https://stac.overturemaps.org/${RELEASE}/catalog.json` },
  ],
};

const gers = (n: number) => `08f2a1b2-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ov = (n: number, over: Partial<OvertureRow> = {}): OvertureRow => ({
  id: gers(n),
  name: "Saviers Road Auto Repair",
  taxonomy: { primary: "auto_body_shop", hierarchy: [...AUTO, "auto_body_shop"], alternates: null },
  confidence: 0.92,
  operating_status: "open",
  websites: ["http://www.saviersauto.example.com/"],
  phones: ["+18055550101"],
  brand: null,
  addresses: [{ freeform: "5577 Saviers Rd", locality: "Oxnard", postcode: "93033", region: "CA", country: "US" }],
  sources: [{ dataset: "meta", license: "CDLA-Permissive-2.0" }, { dataset: "Overture", license: "CDLA-Permissive-2.0" }],
  lon: -119.1773,
  lat: 34.1468,
  ...over,
});

/** Synthetic Overture rows covering the multi-location and dedupe cases. */
const ROWS: OvertureRow[] = [
  ov(1),
  // The same shop again under another GERS ID, about 5 m away: a confident duplicate.
  ov(2, { name: "Saviers Road Auto Repair Inc", lon: -119.17735, lat: 34.14683 }),
  // Another location of the same business on the same website: kept and related.
  ov(3, { addresses: [{ freeform: "10 Main St", locality: "Ventura", postcode: "93001", region: "CA", country: "US" }], lon: -119.2945, lat: 34.2805, phones: ["+18055550133"] }),
  // A different shop sharing A's phone, far away: flagged for review.
  ov(4, {
    name: "Mesa Brake Pros",
    taxonomy: { primary: "auto_body_shop", hierarchy: [...AUTO, "auto_body_shop"] },
    websites: ["https://mesabrake.example.com"],
    addresses: [{ freeform: "12 Mesa Rd", locality: "Moorpark", postcode: "93021", region: "CA", country: "US" }],
    lon: -118.882,
    lat: 34.2856,
    sources: [{ dataset: "Foursquare", license: "Apache-2.0" }],
  }),
  // Adjacent tier.
  ov(5, {
    name: "Harbor Quick Lube",
    taxonomy: { primary: "oil_change_station", hierarchy: [...AUTO, "oil_change_station"] },
    websites: ["https://harborlube.example.com"],
    phones: ["+18055550155"],
    lon: -119.25,
    lat: 34.19,
  }),
  // Discovery filters: low confidence, closed.
  ov(6, { name: "Maybe Motors", websites: null, phones: null, confidence: 0.21, lon: -119.0, lat: 34.27 }),
  ov(7, { name: "Old Grove Garage", websites: null, phones: null, operating_status: "permanently_closed", lon: -119.24, lat: 34.45 }),
  // Never staged: outside the county, not repair, malformed.
  ov(8, { name: "Malibu Auto", lon: -118.2, lat: 34.03 }),
  ov(9, { name: "Sparkle Car Wash", taxonomy: { primary: "car_wash", hierarchy: [...AUTO, "car_wash"] }, lon: -119.1, lat: 34.2 }),
  ov(10, { name: null }),
];

function overtureImporter(rows: OvertureRow[] | (() => AsyncIterable<OvertureRow[]>) = ROWS) {
  return createOvertureImporter({
    source: {
      query: typeof rows === "function" ? rows : async function* () {
        for (let i = 0; i < rows.length; i += 4) yield rows.slice(i, i + 4);
      },
    },
    boundary: async () => BOUNDARY,
    fetchJson: async () => CATALOG,
  });
}

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ProspectError, `expected ProspectError, got ${String(err)}`);
    assert.match(err.messages.join(" | "), pattern);
    return true;
  });
}

describe("Overture provider through the staging pipeline", { skip: skipReason }, () => {
  let db: Db;
  let providers: Map<string, DiscoveryProvider>;
  before(async () => {
    db = await freshDb();
    providers = discoveryProviders({ enableFixtureDiscovery: false }, db);
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  const byGers = (n: number) => db.discoveryCandidate.findFirst({ where: { provider: "overture", externalId: gers(n) } });

  async function importAndRun(tiers = "core") {
    const imp = await runImport(db, overtureImporter(), "latest", COUNTY);
    assert.equal(imp.status, "completed");
    const queued = await runDiscovery(db, providers, { ...RUN, tiers });
    assert.equal(queued.status, "queued", "Overture runs are background runs, never inside a request");
    return (await processDiscoveryRun(db, providers, queued.id))!;
  }

  describe("import", () => {
    test("the Overture provider is registered in every environment; its importer only loads into staging", async () => {
      assert.ok(providers.has("overture"));
      assert.ok(!providers.has("fixture"), "fixtures stay off when not enabled");
      assert.equal(providers.get("overture")!.mode, "background");
    });

    test("'latest' is resolved and recorded; only repair places inside the county are staged, with stats", async () => {
      const r = await runImport(db, overtureImporter(), "latest", COUNTY);
      assert.deepEqual([r.status, r.release, r.scope, r.recordCount], ["completed", RELEASE, "US-CA/ventura", 7]);
      const imp = await db.providerImport.findUniqueOrThrow({ where: { id: r.importId } });
      assert.deepEqual([imp.provider, imp.release, imp.scope, imp.area, imp.status], ["overture", RELEASE, "US-CA/ventura", "Ventura County, CA", "completed"]);
      const stats = imp.stats as Record<string, number | string>;
      assert.equal(stats.read, 10);
      assert.equal(stats.staged, 7);
      assert.equal(stats.outside_area, 1);
      assert.equal(stats.excluded_automotive, 1);
      assert.equal(stats.malformed, 1);
      const a = await db.providerPlace.findFirstOrThrow({ where: { importId: r.importId, externalId: gers(1) } });
      assert.equal(a.county, "Ventura County");
      assert.equal(a.phone, "+18055550101");
      assert.equal(a.sources, "meta (CDLA-Permissive-2.0)");
      assert.equal(await db.discoveryCandidate.count(), 0, "importing creates no candidates");
      assert.equal(await db.prospect.count(), 0);
    });

    test("an unavailable release is refused before anything is written", async () => {
      await assert.rejects(runImport(db, overtureImporter(), "2026-06-17.0", COUNTY), /not available/);
      await assert.rejects(runImport(db, overtureImporter(), "latest", { region: "US-CA" }), /one county at a time/);
      assert.equal(await db.providerImport.count(), 0);
    });

    test("rerunning the same release is a no-op; --force imports again; retention keeps two", async () => {
      const first = await runImport(db, overtureImporter(), "latest", COUNTY);
      const again = await runImport(db, overtureImporter(), RELEASE, COUNTY);
      assert.equal(again.status, "unchanged");
      assert.equal(again.importId, first.importId);
      assert.equal(await db.providerImport.count(), 1);
      await runImport(db, overtureImporter(), RELEASE, COUNTY, { force: true });
      await runImport(db, overtureImporter(), RELEASE, COUNTY, { force: true });
      assert.equal(await db.providerImport.count(), 3);
      assert.equal(await db.providerPlace.count({ where: { importId: first.importId } }), 0, "the oldest import's rows are pruned");
      assert.equal(await db.providerPlace.count(), 14);
    });

    test("a source that fails part-way leaves a failed import with a redacted error, and its rows are never read", async () => {
      const failing = overtureImporter(async function* () {
        yield ROWS.slice(0, 4);
        throw new Error("IO Error: connection reset reading s3://overturemaps-us-west-2/release/x/part-1.parquet");
      });
      const r = await runImport(db, failing, "latest", COUNTY);
      assert.equal(r.status, "failed");
      assert.doesNotMatch(r.error!, /s3:\/\//);
      assert.match(r.error!, /\[url\]/);
      assert.equal(await db.providerPlace.count({ where: { importId: r.importId } }), 0, "a failed import's rows are pruned at once");
      const queued = await queueDiscoveryRun(db, providers, RUN);
      const run = (await processDiscoveryRun(db, providers, queued.id))!;
      assert.equal(run.status, "failed");
      assert.match(run.error!, /No completed Overture Maps Places import for Ventura County, CA/);
    });

    test("an import interrupted mid-way (its process died) is marked failed and cleaned up by the next one", async () => {
      const dead = await db.providerImport.create({
        data: { provider: "overture", release: RELEASE, scope: "US-CA/ventura", area: "Ventura County, CA", startedAt: new Date(Date.now() - STALE_IMPORT_MS - 60_000) },
      });
      await db.providerPlace.create({ data: { importId: dead.id, externalId: gers(99), businessName: "Half Imported" } });
      const r = await runImport(db, overtureImporter(), "latest", COUNTY);
      assert.equal(r.status, "completed");
      const after = await db.providerImport.findUniqueOrThrow({ where: { id: dead.id } });
      assert.equal(after.status, "failed");
      assert.match(after.error!, /Interrupted/);
      assert.equal(await db.providerPlace.count({ where: { importId: dead.id } }), 0);
    });

    test("an empty result completes with nothing staged, and a run over it finds nothing", async () => {
      const r = await runImport(db, overtureImporter([]), "latest", COUNTY);
      assert.deepEqual([r.status, r.recordCount], ["completed", 0]);
      const queued = await queueDiscoveryRun(db, providers, RUN);
      const run = (await processDiscoveryRun(db, providers, queued.id))!;
      assert.deepEqual([run.status, run.found, run.created], ["completed", 0, 0]);
    });
  });

  describe("runs and candidates", () => {
    test("a core run: duplicates skipped, other locations kept and linked, a shared phone flagged, filters applied", async () => {
      const run = await importAndRun();
      assert.equal(run.status, "completed");
      assert.deepEqual([run.found, run.created, run.duplicates, run.flagged, run.invalid], [4, 3, 1, 1, 0]);
      assert.equal(run.providerRelease, RELEASE);
      assert.ok(run.importId, "the run records the import it read");

      const pair = [await byGers(1), await byGers(2)].filter((c) => c !== null);
      assert.equal(pair.length, 1, "the same shop under two GERS IDs is stored once");
      const other = (await byGers(3))!;
      const linked = [pair[0]!, other].filter((c) => c.relatedCandidateId);
      assert.equal(linked.length, 1, "the two locations are linked as related");
      assert.match(linked[0]!.relationReason!, /same website, different location/);
      const flagged = await db.discoveryCandidate.findMany({ where: { status: "needs_review" } });
      assert.equal(flagged.length, 1);
      assert.match(flagged[0]!.duplicateReason!, /same phone number/);

      for (const n of [5, 6, 7, 8, 9]) assert.equal(await byGers(n), null, `GERS ${n} is not a core candidate`);
      assert.equal(await db.prospect.count(), 0, "discovery never creates a prospect");
      assert.equal(await db.candidateSignal.count(), 0);
    });

    test("GERS ID, release, location, category, and sources are preserved on the candidate", async () => {
      await importAndRun();
      const c = (await byGers(4))!;
      assert.equal(c.provider, "overture");
      assert.equal(c.externalId, gers(4));
      assert.equal(c.providerRelease, RELEASE);
      assert.equal(c.streetAddress, "12 Mesa Rd");
      assert.equal(c.city, "Moorpark");
      assert.equal(c.state, "CA");
      assert.equal(c.latitude, 34.2856);
      assert.equal(c.longitude, -118.882);
      assert.equal(c.providerCategory, "auto_body_shop");
      assert.equal(c.categoryTier, "core");
      assert.equal(c.providerStatus, "open");
      assert.equal(c.providerConfidence, 0.92);
      assert.equal(c.providerSources, "Foursquare (Apache-2.0)");
      assert.equal(c.sourceUrl, null, "Overture has no per-place page");
      assert.equal(c.query, "Independent automotive repair in Ventura County, CA");
    });

    test("the provider phone is kept only as the unverified provider phone", async () => {
      await importAndRun();
      const c = (await db.discoveryCandidate.findFirst({ where: { providerPhone: "+18055550133" } }))!;
      assert.equal(c.phone, null);
      assert.equal(c.phoneSourceUrl, null);
      assert.equal(c.phoneKey, "8055550133", "used only to find duplicates");
      const result = scoreCandidate({ ...c, signals: [] });
      assert.equal(result.breakdown.find((s) => s.key === "public_business_contact")!.state, "unknown");
    });

    test("approval never copies the provider phone, so the prospect can't become Ready to contact on it", async () => {
      await importAndRun();
      const c = (await byGers(3))!;
      await changeCandidateStatus(db, c.id, "researching", null);
      await applyResearchFindings(
        db,
        c.id,
        {
          signals: { independent_shop: "yes", general_repair_services: "yes", collision_repair_services: "yes" },
          evidence: [
            { signalKey: "independent_shop", sourceUrl: "http://www.saviersauto.example.com/about", excerpt: "Family owned since 1988." },
            { signalKey: "general_repair_services", sourceUrl: "http://www.saviersauto.example.com/services", excerpt: "Brakes, suspension, A/C." },
        { signalKey: "collision_repair_services", sourceUrl: "http://www.saviersauto.example.com/services", excerpt: "We offer collision repair." },
          ],
        },
        "fixture-research",
      );
      const { prospect } = await approveCandidate(db, c.id);
      assert.equal(prospect.phone, null);
      assert.equal(prospect.phoneSourceUrl, null);
      await changeStatus(db, prospect.id, "qualified", null);
      await rejects(changeStatus(db, prospect.id, "ready_to_contact", null), /requires a public business phone or email/);
      const note = await db.prospectNote.findFirstOrThrow({ where: { prospectId: prospect.id } });
      assert.match(note.body, /Provider: overture\./);
      assert.match(note.body, new RegExp(`Provider ID: ${gers(3)}\\.`));
      assert.match(note.body, /Release: 2026-09-23\.1\./);
    });

    test("core + adjacent adds the oil change station; the tier is a filter, never qualification", async () => {
      const run = await importAndRun("core,adjacent");
      assert.deepEqual([run.found, run.created], [5, 4]);
      const lube = (await byGers(5))!;
      assert.equal(lube.categoryTier, "adjacent");
      const listed = await listCandidates(db, { tier: "adjacent" });
      assert.deepEqual(listed.rows.map((r) => r.candidate.externalId), [gers(5)]);
      assert.equal(listed.rows[0]!.result.qualification, "unverified");
    });

    test("rerunning discovery over the same release creates nothing new", async () => {
      await importAndRun();
      const again = await runDiscovery(db, providers, RUN);
      const run = (await processDiscoveryRun(db, providers, again.id))!;
      assert.deepEqual([run.found, run.created, run.duplicates], [4, 0, 4]);
      assert.equal(await db.discoveryCandidate.count(), 3);
    });

    test("a re-import of the same release, processed again, still creates nothing new", async () => {
      await importAndRun();
      await runImport(db, overtureImporter(), RELEASE, COUNTY, { force: true });
      const again = await runDiscovery(db, providers, RUN);
      const run = (await processDiscoveryRun(db, providers, again.id))!;
      assert.equal(run.created, 0);
      assert.equal(await db.discoveryCandidate.count(), 3);
    });

    test("a run whose worker died is reclaimed and finishes without duplicates", async () => {
      await runImport(db, overtureImporter(), "latest", COUNTY);
      const queued = await queueDiscoveryRun(db, providers, RUN);
      await db.discoveryRun.update({ where: { id: queued.id }, data: { status: "running", heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
      const { reclaimed, processed } = await processQueuedRuns(db, providers);
      assert.equal(reclaimed, 1);
      assert.equal(processed[0]!.status, "completed");
      assert.equal(await db.discoveryCandidate.count(), 3);
    });

    test("geography is controlled: another county or a whole state has no import to read", async () => {
      await runImport(db, overtureImporter(), "latest", COUNTY);
      for (const region of ["Los Angeles County, CA", "CA"]) {
        const queued = await queueDiscoveryRun(db, providers, { ...RUN, region });
        const run = (await processDiscoveryRun(db, providers, queued.id))!;
        assert.equal(run.status, "failed", region);
        assert.match(run.error!, /No completed Overture Maps Places import/);
      }
      assert.equal(await db.discoveryCandidate.count(), 0);
    });

    test("a city filter narrows the run within the county", async () => {
      await runImport(db, overtureImporter(), "latest", COUNTY);
      const queued = await queueDiscoveryRun(db, providers, { ...RUN, city: "Moorpark" });
      const run = (await processDiscoveryRun(db, providers, queued.id))!;
      assert.deepEqual([run.found, run.created], [1, 1]);
      assert.ok(await byGers(4));
    });
  });
});

describe("Overture in the admin (HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";

  before(async () => {
    db = await freshDb();
    app = await buildApp(
      loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }),
      db,
      false,
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
  const post = (url: string, data: Record<string, string>) =>
    app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: new URLSearchParams(data).toString() });

  async function settled(runId: string) {
    for (let i = 0; i < 100; i++) {
      const run = await db.discoveryRun.findUniqueOrThrow({ where: { id: runId } });
      if (run.status === "completed" || run.status === "failed") return run;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("background run did not finish");
  }

  test("imports, runs, and Overture candidates are visible with their provenance", async () => {
    await runImport(db, overtureImporter(), "latest", COUNTY);
    await runImport(db, overtureImporter(), "latest", COUNTY, { force: true });
    await runImport(db, overtureImporter(), "latest", COUNTY, { force: true });
    let page = (await get("/admin/discovery")).body;
    assert.equal((page.match(/rows pruned/g) ?? []).length, 1, "the import beyond retention says its rows are gone");
    assert.match(page, /Provider imports/);
    assert.match(page, /Ventura County, CA/);
    assert.match(page, /release 2026-09-23\.1/);
    assert.match(page, /Overture Maps Places/);
    assert.match(page, /10 read · 1 outside the area · 1 excluded automotive categories · 1 malformed/);
    assert.match(page, /<option value="overture">Overture Maps Places/);

    const res = await post("/admin/discovery/runs", { ...RUN, city: "", tiers: "core" });
    assert.equal(res.statusCode, 303, res.body);
    const runId = /run=([0-9a-f-]{36})/.exec(String(res.headers.location))![1]!;
    assert.match((await get(String(res.headers.location))).body, /Discovery run queued/);
    const run = await settled(runId);
    assert.equal(run.status, "completed");

    page = (await get("/admin/discovery")).body;
    assert.match(page, /import: Ventura County, CA/);
    const c = await db.discoveryCandidate.findFirstOrThrow({ where: { externalId: gers(4) } });
    const detail = (await get(`/admin/discovery/candidates/${c.id}`)).body;
    assert.match(detail, /Overture Maps Places/);
    assert.match(detail, /GERS ID/);
    assert.match(detail, new RegExp(gers(4)));
    assert.match(detail, /Upstream sources/);
    assert.match(detail, /Foursquare \(Apache-2\.0\)/);
    assert.match(detail, /Data: Overture Maps Foundation, overturemaps\.org/);
    assert.match(detail, /Provider phone/);
    assert.match(detail, /Unverified/);
    assert.doesNotMatch(detail, /Verified business contact/);
    assert.match(detail, /Reported by overture, unverified/);
  });
});
