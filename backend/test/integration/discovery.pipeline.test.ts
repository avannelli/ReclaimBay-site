import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { scoreCandidate } from "../../src/discovery/approval.js";
import { FIXTURE_STAGED_PLACES, discoveryProviders, fixtureImporter } from "../../src/discovery/providers.js";
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
import { createStagedProvider, runImport } from "../../src/discovery/staging.js";
import type { DiscoveryProvider, ProviderImporter, ResearchFindings } from "../../src/discovery/types.js";
import { ProspectError, changeStatus } from "../../src/prospects.js";
import { TEST_DATABASE_URL, freshDb, skipReason, truncate } from "./helpers.js";

const CA = { region: "US-CA" };
const RELEASE = "2026-09-23.0";
const STAGED = { provider: "fixture-staged", region: "Ventura County, CA", businessType: "Independent automotive repair" };
const CA_ROWS = FIXTURE_STAGED_PLACES.filter((p) => p.state === "CA").length;

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ProspectError, `expected ProspectError, got ${String(err)}`);
    assert.match(err.messages.join(" | "), pattern);
    return true;
  });
}

/** An importer that yields one batch of fixture rows, then fails as a broken download would. */
const failingImporter: ProviderImporter = {
  provider: "fixture-staged",
  label: "Failing importer",
  async *fetch(release, scope) {
    for await (const batch of fixtureImporter.fetch(release, scope)) {
      yield batch;
      throw new Error("connection reset fetching https://example.com/secret-path");
    }
  },
};

describe("discovery pipeline: release -> staging -> background run -> candidates", { skip: skipReason }, () => {
  let db: Db;
  let providers: Map<string, DiscoveryProvider>;
  before(async () => {
    db = await freshDb();
    providers = discoveryProviders({ enableFixtureDiscovery: true }, db);
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  const staged = (externalId: string) =>
    db.discoveryCandidate.findFirst({ where: { provider: "fixture-staged", externalId }, include: { signals: true, evidence: true } });

  async function importAndRun(tiers = "core") {
    const imp = await runImport(db, fixtureImporter, RELEASE, CA);
    assert.equal(imp.status, "completed");
    const queued = await runDiscovery(db, providers, { ...STAGED, tiers });
    assert.equal(queued.status, "queued", "a background provider never runs inside the call");
    const run = await processDiscoveryRun(db, providers, queued.id);
    assert.ok(run);
    return run;
  }

  describe("staging import", () => {
    test("loads a release in batches into minimized staging rows and records it", async () => {
      const batches: number[] = [];
      const r = await runImport(db, fixtureImporter, RELEASE, CA, { onBatch: (n) => batches.push(n) });
      assert.deepEqual([r.status, r.recordCount, r.skipped, r.error], ["completed", CA_ROWS, 0, null]);
      assert.ok(batches.length > 1, "imported in batches");
      const imp = await db.providerImport.findUniqueOrThrow({ where: { id: r.importId } });
      assert.deepEqual([imp.provider, imp.release, imp.scope, imp.status, imp.recordCount], ["fixture-staged", RELEASE, "US-CA", "completed", CA_ROWS]);
      assert.ok(imp.finishedAt);
      const row = await db.providerPlace.findFirstOrThrow({ where: { importId: r.importId, externalId: "st-101" } });
      assert.equal(row.categoryTier, "core");
      assert.equal(row.county, "Ventura County");
      assert.equal(row.phone, "(805) 555-1101");
      assert.equal(await db.discoveryCandidate.count(), 0, "importing creates no candidates");
      assert.equal(await db.prospect.count(), 0);
    });

    test("refuses a malformed scope or an empty release", async () => {
      await assert.rejects(runImport(db, fixtureImporter, RELEASE, { region: "California" }), /Scope must look like US-CA/);
      await assert.rejects(runImport(db, fixtureImporter, "  ", CA), /Release is required/);
      assert.equal(await db.providerImport.count(), 0);
    });

    test("rows without an ID or name are skipped, and a repeated ID is stored once", async () => {
      const importer: ProviderImporter = {
        provider: "fixture-staged",
        label: "x",
        async *fetch() {
          yield [
            { externalId: "a", businessName: "A Auto" },
            { externalId: "a", businessName: "A Auto again" },
            { externalId: "", businessName: "No ID" },
            { externalId: "b", businessName: "   " },
          ];
        },
      };
      const r = await runImport(db, importer, RELEASE, CA);
      assert.deepEqual([r.recordCount, r.skipped], [1, 3]);
    });

    test("a failed import is recorded as failed, its error is redacted, and its rows are never used or kept", async () => {
      const bad = await runImport(db, failingImporter, "2026-10-01.0", CA);
      assert.equal(bad.status, "failed");
      assert.ok(bad.recordCount > 0, "the first batch was written before the failure");
      assert.doesNotMatch(bad.error!, /secret-path/);
      assert.match(bad.error!, /\[url\]/);
      assert.equal((await db.providerImport.findUniqueOrThrow({ where: { id: bad.importId } })).status, "failed");

      // No completed import yet: a run fails clearly instead of reading partial data.
      const queued = await queueDiscoveryRun(db, providers, STAGED);
      const failed = await processDiscoveryRun(db, providers, queued.id);
      assert.equal(failed!.status, "failed");
      assert.match(failed!.error!, /No completed Fixture, staged release \(background\) import for Ventura County, CA/);
      assert.equal(await db.discoveryCandidate.count(), 0);

      // The next good import prunes the failed one's rows.
      await runImport(db, fixtureImporter, RELEASE, CA);
      assert.equal(await db.providerPlace.count({ where: { importId: bad.importId } }), 0);
    });

    test("only the newest two completed imports keep their rows", async () => {
      const ids = [];
      for (const release of ["2026-07-22.0", "2026-08-20.0", "2026-09-23.0"]) {
        ids.push((await runImport(db, fixtureImporter, release, CA)).importId);
      }
      const counts = await Promise.all(ids.map((importId) => db.providerPlace.count({ where: { importId } })));
      assert.deepEqual(counts, [0, CA_ROWS, CA_ROWS]);
      assert.equal(await db.providerImport.count(), 3, "the import record itself is kept as history");
    });
  });

  describe("background discovery runs", () => {
    test("a core-tier run: duplicates skipped, other locations kept and linked, shared phone flagged", async () => {
      const run = await importAndRun();
      assert.equal(run.status, "completed");
      assert.deepEqual([run.found, run.created, run.duplicates, run.flagged, run.invalid], [7, 6, 1, 1, 0]);
      assert.equal(run.providerRelease, RELEASE);
      assert.deepEqual(run.tiers, ["core"]);
      assert.ok(run.startedAt && run.heartbeatAt && run.finishedAt);

      // Leon's: the Thousand Oaks shop appears twice (one is skipped), the Oxnard location is kept.
      const to = [await staged("st-101"), await staged("st-103")].filter((c) => c !== null);
      assert.equal(to.length, 1, "the Thousand Oaks duplicate is skipped, whichever came first");
      const oxnard = (await staged("st-102"))!;
      assert.ok(oxnard);
      const pair = [to[0]!, oxnard];
      const links = pair.filter((c) => c.relatedCandidateId && pair.some((o) => o.id === c.relatedCandidateId));
      assert.equal(links.length, 1, "the two locations are linked as related");
      assert.match(links[0]!.relationReason!, /same website, different location/);
      for (const c of pair) {
        assert.equal(c.possibleDuplicateCandidateId, null, "another location is not a duplicate");
        assert.notEqual(c.status, "needs_review");
      }

      // Locator-domain shops: kept, no website, no relation between them.
      for (const id of ["st-301", "st-302"]) {
        const c = (await staged(id))!;
        assert.equal(c.website, null);
        assert.equal(c.domainKey, null);
        assert.equal(c.relatedCandidateId, null);
        assert.equal(c.possibleDuplicateCandidateId, null);
      }

      // Same phone, different name, far apart: both kept, one flagged for a person.
      const phones = [(await staged("st-401"))!, (await staged("st-402"))!];
      const flagged = phones.filter((c) => c.status === "needs_review");
      assert.equal(flagged.length, 1);
      assert.match(flagged[0]!.duplicateReason!, /candidate: same phone number/);

      // Excluded by discovery filters, not by qualification.
      for (const id of ["st-201", "st-501", "st-601", "st-602", "st-701", "st-801"]) assert.equal(await staged(id), null, id);
      assert.equal(await db.prospect.count(), 0, "discovery never creates a prospect");
      assert.equal(await db.candidateSignal.count(), 0);
    });

    test("core + adjacent adds the chain and the tire shop; the chain's locations are related, not duplicates", async () => {
      const run = await importAndRun("core,adjacent");
      assert.deepEqual([run.found, run.created, run.duplicates, run.flagged], [11, 10, 1, 1]);
      assert.deepEqual(run.tiers, ["core", "adjacent"]);
      const chain = await db.discoveryCandidate.findMany({ where: { externalId: { in: ["st-201", "st-202", "st-203"] } } });
      assert.equal(chain.length, 3);
      assert.equal(chain.filter((c) => c.relatedCandidateId).length, 2);
      assert.ok(chain.every((c) => c.status === "discovered" && c.providerBrand === "QuickLube" && c.categoryTier === "adjacent"));
      assert.equal((await staged("st-501"))!.categoryTier, "adjacent");
    });

    test("provenance and location are stored; the provider phone stays unverified", async () => {
      await importAndRun();
      const c = (await staged("st-102"))!;
      assert.equal(c.streetAddress, "300 S Oxnard Blvd");
      assert.equal(c.latitude, 34.1975);
      assert.equal(c.longitude, -119.1771);
      assert.equal(c.providerRelease, RELEASE);
      assert.equal(c.providerCategory, "transmission_repair");
      assert.equal(c.categoryTier, "core");
      assert.equal(c.providerConfidence, 0.92);
      assert.equal(c.providerStatus, "open");
      assert.ok(c.providerRetrievedAt);
      assert.equal(c.query, "Independent automotive repair in Ventura County, CA");
      assert.equal(c.providerPhone, "(805) 555-1102");
      assert.equal(c.phone, null);
      assert.equal(c.phoneSourceUrl, null);
      assert.equal(c.phoneKey, "8055551102", "used only to find duplicates");
      assert.equal(scoreCandidate(c).breakdown.find((s) => s.key === "public_business_contact")!.state, "unknown");
    });

    test("the category tier is a list filter only; it is not a qualification input", async () => {
      await importAndRun("core,adjacent");
      const adjacent = await listCandidates(db, { tier: "adjacent" });
      assert.deepEqual(adjacent.rows.map((r) => r.candidate.externalId).sort(), ["st-201", "st-202", "st-203", "st-501"]);
      assert.equal((await listCandidates(db, { tier: "core" })).total, 6);
      assert.equal((await listCandidates(db, { tier: "bogus" })).total, 10, "an unknown tier is ignored");
      for (const r of adjacent.rows) assert.equal(r.result.qualification, "unverified", "tier never decides qualification");
      assert.equal((await listCandidates(db, { q: "555-1102" })).total, 1, "search covers the provider phone");
    });

    test("a run is claimed once: a second worker gets nothing, and a finished run isn't reprocessed", async () => {
      await runImport(db, fixtureImporter, RELEASE, CA);
      const queued = await queueDiscoveryRun(db, providers, STAGED);
      const [a, b] = await Promise.all([processDiscoveryRun(db, providers, queued.id), processDiscoveryRun(db, providers, queued.id)]);
      assert.equal([a, b].filter((r) => r !== null).length, 1);
      assert.equal(await processDiscoveryRun(db, providers, queued.id), null);
      assert.equal(await db.discoveryCandidate.count(), 6);
    });

    test("re-running the same release creates nothing new", async () => {
      await importAndRun();
      const again = await runDiscovery(db, providers, STAGED);
      const run = (await processDiscoveryRun(db, providers, again.id))!;
      assert.deepEqual([run.found, run.created, run.duplicates], [7, 0, 7]);
      assert.equal(await db.discoveryCandidate.count(), 6);
    });

    test("a run interrupted mid-way is reclaimed and finishes without duplicating what it already stored", async () => {
      await runImport(db, fixtureImporter, RELEASE, CA);
      const real = providers.get("fixture-staged")!;
      // A worker that dies after the first batch (batch size 3 so the run spans several batches).
      const small = createStagedProvider(db, { name: "fixture-staged", label: "x", batchSize: 3 });
      const dying: DiscoveryProvider = {
        ...small,
        async *discoverBatches(target) {
          for await (const batch of small.discoverBatches!(target)) {
            yield batch;
            throw new Error("worker killed");
          }
        },
      };
      const queued = await queueDiscoveryRun(db, providers, STAGED);
      const died = (await processDiscoveryRun(db, new Map([["fixture-staged", dying]]), queued.id))!;
      assert.equal(died.status, "failed");
      const partial = await db.discoveryCandidate.count();
      assert.ok(partial > 0 && partial < 6, `partial progress was saved (${partial})`);

      // A worker that stopped heartbeating: reclaimed and processed by the scheduler.
      await db.discoveryRun.update({ where: { id: queued.id }, data: { status: "running", heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
      const fresh = await queueDiscoveryRun(db, providers, STAGED);
      await db.discoveryRun.update({ where: { id: fresh.id }, data: { status: "running", heartbeatAt: new Date() } });
      const { reclaimed, processed } = await processQueuedRuns(db, new Map([["fixture-staged", real]]));
      assert.equal(reclaimed, 1, "only the stale run is reclaimed; a live one is left alone");
      assert.deepEqual(processed.map((r) => [r.id, r.status]), [[queued.id, "completed"]]);
      assert.equal(await db.discoveryCandidate.count(), 6, "no duplicates after resuming");
      assert.equal((await db.discoveryRun.findUniqueOrThrow({ where: { id: fresh.id } })).status, "running");
    });

    test("a provider that isn't available fails the run with a clear error", async () => {
      const queued = await queueDiscoveryRun(db, providers, STAGED);
      const run = (await processDiscoveryRun(db, new Map(), queued.id))!;
      assert.equal(run.status, "failed");
      assert.match(run.error!, /not available for background runs/);
    });
  });

  describe("provider phone vs. contact rules", () => {
    const findings = (over: Partial<ResearchFindings> = {}): ResearchFindings => ({
      signals: { independent_shop: "yes", general_repair_services: "yes" },
      evidence: [
        { signalKey: "independent_shop", sourceUrl: "https://mesabrake.example.com/about", excerpt: "Family owned since 1988." },
        { signalKey: "general_repair_services", sourceUrl: "https://mesabrake.example.com/services", excerpt: "Brakes, suspension, A/C." },
      ],
      ...over,
    });

    test("a provider phone never makes a prospect Ready to contact, even after approval", async () => {
      await importAndRun();
      const c = (await staged("st-401"))!;
      await changeCandidateStatus(db, c.id, "researching", null);
      await applyResearchFindings(db, c.id, findings(), "fixture-research");
      const { prospect } = await approveCandidate(db, c.id);
      assert.equal(prospect.status, "new");
      assert.equal(prospect.phone, null, "the provider phone is not carried over as verified contact");
      assert.equal(prospect.phoneSourceUrl, null);
      await changeStatus(db, prospect.id, "qualified", null);
      await rejects(changeStatus(db, prospect.id, "ready_to_contact", null), /requires a public business phone or email/);
      const note = await db.prospectNote.findFirstOrThrow({ where: { prospectId: prospect.id } });
      assert.match(note.body, new RegExp(`Release: ${RELEASE.replace(/\./g, "\\.")}`));
    });

    test("research can verify the phone only from the business's own website", async () => {
      await importAndRun();
      const c = (await staged("st-401"))!;
      await changeCandidateStatus(db, c.id, "researching", null);
      await rejects(
        applyResearchFindings(db, c.id, findings({ contact: { phone: "(805) 555-4401", phoneSourceUrl: "https://directory.example.com/mesa" } }), "r"),
        /Research can only verify a phone found on the business's own website/,
      );
      assert.equal((await staged("st-401"))!.phone, null, "nothing stored after a refusal");

      const done = await applyResearchFindings(
        db,
        c.id,
        findings({ contact: { phone: "(805) 555-4401", phoneSourceUrl: "https://www.mesabrake.example.com/contact" } }),
        "r",
      );
      assert.equal(done.phone, "(805) 555-4401");
      assert.equal(done.phoneSourceUrl, "https://www.mesabrake.example.com/contact");
      assert.equal(scoreCandidate((await staged("st-401"))!).breakdown.find((s) => s.key === "public_business_contact")!.state, "yes");
      const { prospect } = await approveCandidate(db, c.id);
      await changeStatus(db, prospect.id, "qualified", null);
      await changeStatus(db, prospect.id, "ready_to_contact", null);
    });

    test("a candidate with no website can't have contact verified by research", async () => {
      await importAndRun();
      const c = (await staged("st-301"))!;
      await changeCandidateStatus(db, c.id, "researching", null);
      await rejects(
        applyResearchFindings(db, c.id, findings({ contact: { phone: "(805) 555-3301", phoneSourceUrl: "https://locations.partsprogram.example.com/gallardo" } }), "r"),
        /own website \(none is stored\)/,
      );
    });
  });
});

describe("discovery pipeline (admin HTTP)", { skip: skipReason }, () => {
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

  test("a staged run is queued by the request and processed in the background", async () => {
    await runImport(db, fixtureImporter, RELEASE, CA);
    const res = await post("/admin/discovery/runs", { ...STAGED, city: "", tiers: "core" });
    assert.equal(res.statusCode, 303, res.body);
    const runId = /run=([0-9a-f-]{36})/.exec(String(res.headers.location))![1]!;
    const page = (await get(String(res.headers.location))).body;
    assert.match(page, /Discovery run queued\. It runs in the background/);
    const run = await settled(runId);
    assert.equal(run.status, "completed");
    assert.equal(run.created, 6);
    const overview = (await get("/admin/discovery")).body;
    assert.match(overview, /release 2026-09-23\.0/);
    assert.match(overview, /Core repair categories/);
  });

  test("the candidate page separates the unverified provider phone and shows provenance, tier, and the related location", async () => {
    await runImport(db, fixtureImporter, RELEASE, CA);
    const res = await post("/admin/discovery/runs", { ...STAGED, city: "", tiers: "core" });
    await settled(/run=([0-9a-f-]{36})/.exec(String(res.headers.location))![1]!);
    const linked = await db.discoveryCandidate.findFirstOrThrow({ where: { relatedCandidateId: { not: null } } });
    const page = (await get(`/admin/discovery/candidates/${linked.id}`)).body;
    assert.match(page, /Provider phone/);
    assert.match(page, /Unverified/);
    assert.doesNotMatch(page, /Verified business contact/);
    assert.match(page, /Release/);
    assert.match(page, /transmission_repair/);
    assert.match(page, /Core repair category/);
    assert.match(page, /Other location of the same business or chain/);

    const list = (await get("/admin/discovery?tier=core")).body;
    assert.match(list, /Other location shares this website/);
    const edit = (await get(`/admin/discovery/candidates/${linked.id}/edit`)).body;
    assert.match(edit, /\(unverified\)\. Enter it as the business phone only after you find it on the business&#39;s own website|\(unverified\)\. Enter it as the business phone only after you find it on the business's own website/);
  });

  test("an unknown tier value falls back to core", async () => {
    await runImport(db, fixtureImporter, RELEASE, CA);
    const res = await post("/admin/discovery/runs", { ...STAGED, city: "", tiers: "everything" });
    const run = await settled(/run=([0-9a-f-]{36})/.exec(String(res.headers.location))![1]!);
    assert.deepEqual(run.tiers, ["core"]);
  });
});
