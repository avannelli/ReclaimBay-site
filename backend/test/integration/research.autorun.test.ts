import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { ingestBusinesses } from "../../src/discovery/service.js";
import type { DiscoveredBusiness } from "../../src/discovery/types.js";
import { PoliteFetcher } from "../../src/research/fetcher.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import {
  STALE_RESEARCH_MS,
  acquireWorkerLock,
  autoResearchSelection,
  automaticResearchStatus,
  enqueueResearch,
  failStaleResearch,
  runAutoResearch,
} from "../../src/research/service.js";
import { fixtureWeb, independentShop, page, type Fixture } from "../fixtures/researchSite.js";
import { TEST_DATABASE_URL, assertSeparateSessions, freshDb, skipReason, truncate } from "./helpers.js";

/*
 * The automatic research worker (discovery:research --auto) against a real,
 * disposable PostgreSQL: row locks, the advisory lock, stale-run release,
 * selection, and the automatic decision after research. Fixture websites
 * only: nothing touches the network, and nothing is ever sent.
 */

const TODAY = new Date("2026-10-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const CLEAN_HOST = "saviersauto.example.com";
const MIDAS_HOST = "midasoxnard.example.com";
let seq = 0;
const business = (over: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness => {
  const n = ++seq;
  return {
    externalId: `ab000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    businessName: `Test Garage ${n}`,
    website: `https://garage${n}.example.com/`,
    streetAddress: `${100 + n} Test St`,
    city: "Oxnard",
    state: "CA",
    postalCode: "93033",
    country: "US",
    phone: `+1805555${String(1000 + n).slice(-4)}`,
    category: "automotive_repair",
    categoryTier: "core",
    ...over,
  };
};
const clean = (): Partial<DiscoveredBusiness> => ({ businessName: "Saviers Road Auto Repair", website: `https://${CLEAN_HOST}/`, phone: "+18055550101", streetAddress: "5577 Saviers Rd" });
const midas = (): Partial<DiscoveredBusiness> => ({ businessName: "Midas (Oxnard Blvd)", website: `https://${MIDAS_HOST}/`, phone: "+18055550202", streetAddress: "100 Oxnard Blvd" });

/** Both fixture sites; any other website answers 404 everywhere (unreachable). */
const web = () => {
  const routes: Record<string, Fixture> = { ...independentShop(CLEAN_HOST), ...independentShop(MIDAS_HOST, "(805) 555-0202") };
  routes[`https://${MIDAS_HOST}/`] = {
    body: page(
      "Midas Oxnard | Brakes, Oil Changes and Auto Repair",
      `<h1>Midas Oxnard</h1><p>Our 6 service bays are open Monday to Friday.</p><p>Call <a href="tel:+18055550202">(805) 555-0202</a> · 100 Oxnard Blvd, Oxnard, CA 93033</p><footer>© 2025 Midas</footer>`,
    ),
  };
  return fixtureWeb(routes);
};

describe("automatic research worker (real PostgreSQL)", { skip: skipReason }, () => {
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
  /** A past run in the candidate's history. */
  const pastRun = (candidateId: string, status: "completed" | "failed", outcome: string | null, endedHoursAgo: number) =>
    db.candidateResearch.create({
      data: {
        candidateId,
        version: RESEARCH_VERSION,
        trigger: "scheduled",
        status,
        outcome,
        queuedAt: new Date(Date.now() - endedHoursAgo * HOUR - 60_000),
        finishedAt: new Date(Date.now() - endedHoursAgo * HOUR),
      },
    });
  const deps = () => ({ makeFetcher: web().makeFetcher, today: TODAY, sleep: async () => undefined });
  const auto = (over: Partial<Parameters<typeof runAutoResearch>[1]> = {}) =>
    runAutoResearch(db, { enabled: true, databaseUrl: TEST_DATABASE_URL, limit: 10, deps: deps(), ...over });

  // ---------- G1: atomic queueing ----------

  test("concurrent queue attempts for one candidate create exactly one run", async () => {
    const c = await candidate();
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueResearch(db, [c.id], "scheduled")));
    assert.equal(results.flatMap((r) => r.queued).length, 1, "exactly one attempt queued it");
    assert.equal(results.flatMap((r) => r.skipped).filter((s) => s.reason === "research already queued or running").length, 4);
    assert.equal(await db.candidateResearch.count({ where: { candidateId: c.id } }), 1);
  });

  test("queueing still refuses approved, rejected, and duplicate candidates", async () => {
    for (const status of ["approved", "rejected", "duplicate"] as const) {
      const c = await candidate();
      await db.discoveryCandidate.update({ where: { id: c.id }, data: { status } });
      const r = await enqueueResearch(db, [c.id], "scheduled");
      assert.deepEqual(r.skipped, [{ candidateId: c.id, reason: `candidate is ${status}` }]);
    }
    assert.equal(await db.candidateResearch.count(), 0);
  });

  // ---------- the worker lock ----------

  describe("the worker lock (needs separate PostgreSQL sessions)", () => {
    // Fail fast, with the reason, on a database that can't run these tests (e.g. Prisma's emulator).
    before(async () => assertSeparateSessions());

    test("two automatic workers at once: exactly one gets the lock; the other exits cleanly", async () => {
      const first = await acquireWorkerLock(TEST_DATABASE_URL);
      assert.ok(first, "the first worker takes the lock");
      try {
        const competing = await acquireWorkerLock(TEST_DATABASE_URL);
        // Released before the assertion: a lock left open here would keep this file's process alive.
        await competing?.release();
        assert.equal(competing, null, "a second worker can't");
        await candidate();
        const second = await auto();
        assert.equal(second.outcome, "locked");
        assert.equal(await db.candidateResearch.count(), 0, "the locked-out worker queued nothing");
      } finally {
        await first.release();
      }
      const again = await acquireWorkerLock(TEST_DATABASE_URL);
      assert.ok(again, "released: the next worker gets it");
      await again.release();
    });

    test("two workers racing for the lock: one runs, one reports locked", async () => {
      await candidate(clean());
      // Slow websites, so the winner is still working when the other asks for the lock.
      const w = web();
      const slow = { ...deps(), makeFetcher: () => new PoliteFetcher({ get: async (u, o) => (await new Promise((r) => setTimeout(r, 200)), w.get(u, o)), sleep: async () => undefined }) };
      const [a, b] = await Promise.all([auto({ deps: slow }), auto({ deps: slow })]);
      assert.deepEqual([a.outcome, b.outcome].sort(), ["done", "locked"]);
      assert.equal(await db.candidateResearch.count(), 1, "the candidate was researched once");
    });
  });

  // ---------- G2: stale runs release their candidate ----------

  const strand = async (c: { id: string }) => {
    const [q] = (await enqueueResearch(db, [c.id], "scheduled")).queued;
    const old = new Date(Date.now() - STALE_RESEARCH_MS - 60_000);
    await db.candidateResearch.update({ where: { id: q!.researchId }, data: { status: "running", startedAt: old, heartbeatAt: old } });
    await db.discoveryCandidate.update({ where: { id: c.id }, data: { status: "researching" } });
    return q!.researchId;
  };

  test("a stale run is marked failed and its candidate returns to Discovered; the run stays in the history", async () => {
    const c = await candidate();
    const runId = await strand(c);
    assert.equal(await failStaleResearch(db), 1);
    const run = await db.candidateResearch.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(run.status, "failed");
    assert.match(run.error!, /^Interrupted/);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "discovered");
  });

  test("a candidate that moved on, or has another run queued, is left alone", async () => {
    const moved = await candidate();
    await strand(moved);
    await db.discoveryCandidate.update({ where: { id: moved.id }, data: { status: "needs_review" } });
    const busy = await candidate();
    const staleId = await strand(busy);
    // A newer run for the same candidate is waiting (made directly: enqueue refuses while one is running).
    await db.candidateResearch.create({ data: { candidateId: busy.id, version: RESEARCH_VERSION, trigger: "admin" } });

    assert.equal(await failStaleResearch(db), 2);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: moved.id } })).status, "needs_review");
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: busy.id } })).status, "researching");
    assert.equal((await db.candidateResearch.findUniqueOrThrow({ where: { id: staleId } })).status, "failed");
  });

  test("the worker releases stranded candidates before it selects", async () => {
    const c = await candidate();
    await strand(c);
    const r = await auto({ limit: 1 });
    assert.equal(r.reclaimed, 1);
    // Just interrupted: not retried for 24 hours.
    assert.equal(r.queuedRetries, 0);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "discovered");
  });

  // ---------- G3: selection and retries ----------

  test("selection: never-researched first, then eligible retries; everything else excluded", async () => {
    const fresh = await candidate();
    const retry = await candidate();
    await pastRun(retry.id, "failed", "website_unreachable", 25);
    const interrupted = await candidate();
    await pastRun(interrupted.id, "failed", null, 30);

    // Excluded:
    const recent = await candidate();
    await pastRun(recent.id, "failed", "website_unreachable", 2);
    const exhausted = await candidate();
    for (const h of [100, 75, 50]) await pastRun(exhausted.id, "failed", "website_unreachable", h);
    const noWebsite = await candidate();
    await pastRun(noWebsite.id, "completed", "no_website", 48);
    const blocked = await candidate();
    await pastRun(blocked.id, "completed", "access_blocked", 48);
    const reviewDone = await candidate();
    await pastRun(reviewDone.id, "completed", "website_unconfirmed", 48);
    await db.discoveryCandidate.update({ where: { id: reviewDone.id }, data: { status: "researched" } });
    const held = await candidate();
    await db.discoveryCandidate.update({ where: { id: held.id }, data: { status: "needs_review" } });
    const heldFailed = await candidate();
    await pastRun(heldFailed.id, "failed", null, 48);
    await db.discoveryCandidate.update({ where: { id: heldFailed.id }, data: { status: "needs_review" } });
    const outside = await candidate();
    await db.discoveryCandidate.update({ where: { id: outside.id }, data: { categoryVerdict: "wrong_category" } });
    for (const status of ["approved", "rejected", "duplicate"] as const) {
      const c = await candidate();
      await db.discoveryCandidate.update({ where: { id: c.id }, data: { status } });
      const failed = await candidate();
      await pastRun(failed.id, "failed", null, 48);
      await db.discoveryCandidate.update({ where: { id: failed.id }, data: { status } });
    }

    const s = await autoResearchSelection(db, 25);
    assert.deepEqual(s.fresh, [fresh.id]);
    assert.deepEqual(s.retries, [interrupted.id, retry.id], "oldest attempt first");
  });

  test("a retry is queued as scheduled and researched again; after the third attempt it is never retried", async () => {
    const c = await candidate({ website: "https://gone.example.com/" });
    await pastRun(c.id, "failed", "website_unreachable", 50);
    await pastRun(c.id, "failed", "website_unreachable", 25);
    const r = await auto();
    assert.equal(r.queuedRetries, 1);
    assert.equal(r.failed, 1, "unreachable again");
    const runs = await db.candidateResearch.findMany({ where: { candidateId: c.id }, orderBy: { queuedAt: "desc" } });
    assert.equal(runs.length, 3);
    assert.equal(runs[0]!.trigger, "scheduled");
    assert.equal(runs[0]!.outcome, "website_unreachable");
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "discovered");
    // Even long after, three attempts were made: a person decides.
    const later = await autoResearchSelection(db, 25, new Date(Date.now() + 72 * HOUR));
    assert.deepEqual(later.retries, []);
  });

  // ---------- the run itself ----------

  test("disarmed: nothing is selected, queued, or researched", async () => {
    await candidate(clean());
    const r = await auto({ enabled: false });
    assert.equal(r.outcome, "disabled");
    assert.equal(await db.candidateResearch.count(), 0);
  });

  test("nothing to do: exits cleanly, and releases the lock", async () => {
    const r = await auto();
    assert.equal(r.outcome, "done");
    assert.equal(r.queuedFresh + r.queuedRetries + r.completed + r.failed + r.reclaimed, 0);
    const lock = await acquireWorkerLock(TEST_DATABASE_URL);
    assert.ok(lock, "the lock was released");
    await lock.release();
  });

  test("research is followed by the automatic decision: approval@a1 and rejection@r1; nothing is sent", async () => {
    const shop = await candidate(clean());
    const chain = await candidate(midas());
    const dead = await candidate({ website: "https://gone.example.com/" });
    const r = await auto();
    assert.equal(r.outcome, "done");
    assert.deepEqual(
      { fresh: r.queuedFresh, completed: r.completed, failed: r.failed, approved: r.approved, rejected: r.rejected, review: r.review },
      { fresh: 3, completed: 2, failed: 1, approved: 1, rejected: 1, review: 0 },
    );
    const status = async (id: string) => (await db.discoveryCandidate.findUniqueOrThrow({ where: { id } })).status;
    assert.equal(await status(shop.id), "approved");
    assert.equal(await status(chain.id), "rejected");
    assert.equal(await status(dead.id), "discovered", "a failed run returns its candidate");
    assert.equal(await db.prospect.count(), 1);
    assert.equal(await db.outreach.count(), 0, "automatic research never starts outreach");
    assert.equal(await db.candidateResearch.count({ where: { trigger: "scheduled" } }), 3);
    // Run again at once: nothing new, nothing retried yet.
    const again = await auto();
    assert.equal(again.queuedFresh + again.queuedRetries + again.completed, 0);
  });

  test("at most --limit candidates per run", async () => {
    for (let i = 0; i < 3; i++) await candidate();
    const r = await auto({ limit: 2 });
    assert.equal(r.outcome, "limit");
    assert.equal(r.queuedFresh, 2);
    assert.equal(r.completed + r.failed, 2);
    assert.equal(await db.candidateResearch.count(), 2, "the third waits for the next run");
  });

  test("a stop (SIGTERM) finishes the candidate in progress and starts no other", async () => {
    await candidate(clean());
    await candidate(midas());
    let checks = 0;
    const r = await auto({ shouldStop: () => checks++ > 0 });
    assert.equal(r.outcome, "signal");
    assert.equal(r.completed + r.failed, 1);
    assert.equal(await db.candidateResearch.count({ where: { status: { in: ["completed", "failed"] } } }), 1);
    assert.equal(await db.candidateResearch.count({ where: { status: "queued" } }), 1, "the other stays queued for the next run");
    assert.equal(await db.candidateResearch.count({ where: { status: "running" } }), 0);
    assert.equal(await db.discoveryCandidate.count({ where: { status: "researching" } }), 0);
  });

  test("the time budget: no new candidate once it is spent", async () => {
    await candidate(clean());
    await candidate(midas());
    let t = 0;
    // Each clock reading advances 6 minutes: the second candidate would start after 10 minutes.
    const r = await auto({ clock: () => (t += 6 * 60 * 1000) });
    assert.equal(r.outcome, "budget");
    assert.equal(r.completed + r.failed, 1);
  });

  // ---------- the Discovery page status ----------

  test("automatic research status: last run, the last 24 hours, and what is waiting", async () => {
    const before = await automaticResearchStatus(db);
    assert.deepEqual(before, { lastRunAt: null, researched24h: 0, failed24h: 0, waitingFresh: 0, waitingRetries: 0, stale: false }, "nothing waiting: no warning");

    await candidate(clean());
    await candidate({ website: "https://gone.example.com/" });
    const retry = await candidate();
    await pastRun(retry.id, "failed", null, 30);
    const waiting = await automaticResearchStatus(db);
    assert.equal(waiting.waitingFresh, 2);
    assert.equal(waiting.waitingRetries, 1);
    assert.ok(waiting.lastRunAt, "the past run was scheduled");
    assert.equal(waiting.stale, true, "waiting, and no automatic run in the last hour");

    await auto();
    const done = await automaticResearchStatus(db);
    assert.ok(done.lastRunAt && Date.now() - done.lastRunAt.getTime() < HOUR);
    assert.equal(done.researched24h, 1);
    assert.equal(done.failed24h, 2, "the unreachable site, and the retry (unreachable again); the 30-hour-old failure is outside 24 hours");
    assert.equal(done.waitingFresh + done.waitingRetries, 0);
    assert.equal(done.stale, false);
  });
});

describe("automatic research status (admin HTTP)", { skip: skipReason }, () => {
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
  const discovery = async () => (await app.inject({ method: "GET", url: "/admin/discovery", headers: { cookie } })).body;

  test("the Discovery page shows the status line, with the automation summary kept; amber when the worker isn't running", async () => {
    const quiet = await discovery();
    assert.match(quiet, /<section aria-label="What the automation decided"/, "the existing summary stays");
    assert.match(quiet, /<b>Automatic research:<\/b> last run never · 0 researched, 0 failed in the last 24 hours · waiting: 0 new, 0 to retry/);
    assert.doesNotMatch(quiet, /hasn't run in the last hour/);

    const b = business();
    await ingestBusinesses(db, { runId: null, provider: "overture", query: null }, [b]);
    const stale = await discovery();
    assert.match(stale, /<section aria-label="Automatic research" class="callout warn"/);
    assert.match(stale, /waiting: 1 new, 0 to retry/);
    assert.match(stale, /Candidates are waiting, but automatic research hasn't run in the last hour/);
  });
});
