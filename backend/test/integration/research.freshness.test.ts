import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { addCandidateEvidence, changeCandidateStatus, setCandidateCategory, updateCandidate } from "../../src/discovery/service.js";
import { researchFetcher } from "../../src/research/fetcher.js";
import { enqueueResearch, failStaleResearch, processResearch } from "../../src/research/service.js";
import { fixtureWeb, independentShop } from "../fixtures/researchSite.js";
import { freshDb, readyForm, skipReason, truncate } from "./helpers.js";

const SITE = "https://saviersauto.example.com/";
const OTHER = "https://changed.example.com/";
const TODAY = new Date("2026-10-01T12:00:00Z");

/** A deterministic barrier inside the real browser-independent researcher. */
function pausedWebsite(website = SITE, fail = false) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = fixtureWeb(independentShop(new URL(website).hostname));
  let held = false;
  const makeFetcher = () => researchFetcher({
    sleep: async () => undefined,
    get: async (url, options) => {
      if (url === website && !held) {
        held = true;
        enter();
        await gate;
        if (fail) throw new URIError("Synthetic parser interruption");
      }
      return fixture.get(url, options);
    },
  });
  return { entered, release, makeFetcher };
}

describe("research freshness: obsolete workers cannot mutate newer state", { skip: skipReason }, () => {
  let db: Db;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  const candidate = () => db.discoveryCandidate.create({ data: {
    provider: "fixture", businessName: "Saviers Road Auto Repair", website: SITE,
    nameKey: "saviers road auto repair", streetAddress: "5577 Saviers Rd",
    city: "Oxnard", state: "CA", country: "US", providerPhone: "+18055550101",
  } });
  const full = (id: string) => db.discoveryCandidate.findUniqueOrThrow({ where: { id }, include: { signals: true, evidence: true } });
  const run = (id: string) => db.candidateResearch.findUniqueOrThrow({ where: { id } });
  const editWebsite = (id: string, website: string) => updateCandidate(db, id, readyForm({
    businessName: "Saviers Road Auto Repair", website, city: "Oxnard", state: "CA", phone: "", phoneSourceUrl: "",
  }));
  async function start(fail = false) {
    const c = await candidate();
    const [q] = (await enqueueResearch(db, [c.id], "admin")).queued;
    const web = pausedWebsite(SITE, fail);
    const pending = processResearch(db, q!.researchId, { makeFetcher: web.makeFetcher, today: TODAY, autoApprove: false });
    await web.entered;
    return { c, id: q!.researchId, pending, release: web.release };
  }
  async function assertNoResults(id: string) {
    assert.equal(await db.researchSource.count({ where: { researchId: id } }), 0);
    assert.equal(await db.researchFact.count({ where: { researchId: id } }), 0);
    assert.equal(await db.candidateEvidence.count({ where: { researchId: id } }), 0);
  }
  async function recover(id: string) {
    await db.candidateResearch.update({ where: { id }, data: { heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
    return failStaleResearch(db);
  }

  test("website A completion cannot verify B or attach A's sources/facts/evidence", async () => {
    const work = await start();
    try {
      await editWebsite(work.c.id, OTHER);
      const before = await full(work.c.id);
      work.release();
      assert.equal(await work.pending, null, "obsolete completion is not a current-run failure");
      assert.deepEqual(await full(work.c.id), before, "the newer candidate is completely untouched");
      const obsolete = await run(work.id);
      assert.equal(obsolete.subjectWebsite, SITE, "history identifies the website actually researched");
      assert.equal(obsolete.outcome, "superseded");
      assert.equal(obsolete.status, "failed");
      assert.equal(before.websiteVerifiedAt, null);
      await assertNoResults(work.id);
    } finally { work.release(); await work.pending; }
  });

  test("A to B to A still invalidates the old worker, regardless of timestamp equality", async () => {
    const work = await start();
    try {
      await editWebsite(work.c.id, OTHER);
      await editWebsite(work.c.id, SITE);
      await db.discoveryCandidate.update({ where: { id: work.c.id }, data: { updatedAt: work.c.updatedAt } });
      const before = await full(work.c.id);
      work.release();
      assert.equal(await work.pending, null);
      assert.deepEqual(await full(work.c.id), before);
      await assertNoResults(work.id);
    } finally { work.release(); await work.pending; }
  });

  for (const fail of [true, false]) test(`new human hold wins over research ${fail ? "failure" : "success"}`, async () => {
    const work = await start(fail);
    try {
      await changeCandidateStatus(db, work.c.id, "needs_review", "Synthetic human hold");
      const before = await full(work.c.id);
      work.release();
      assert.equal(await work.pending, null);
      assert.deepEqual(await full(work.c.id), before);
      assert.equal((await run(work.id)).outcome, "superseded");
      await assertNoResults(work.id);
    } finally { work.release(); await work.pending; }
  });

  test("rejecting during research cannot be reversed by the worker", async () => {
    const work = await start();
    try {
      await changeCandidateStatus(db, work.c.id, "rejected", "Human rejection");
      const before = await full(work.c.id);
      work.release();
      assert.equal(await work.pending, null);
      assert.deepEqual(await full(work.c.id), before);
      await assertNoResults(work.id);
    } finally { work.release(); await work.pending; }
  });

  test("manual evidence and category edits invalidate work even without a status/website change", async () => {
    for (const kind of ["evidence", "category"] as const) {
      const work = await start();
      try {
        if (kind === "evidence") await addCandidateEvidence(db, work.c.id, {
          signalKey: "independent_shop", sourceUrl: SITE, excerpt: "Family owned and operated.",
        });
        else await setCandidateCategory(db, work.c.id, "wrong_category", "A person checked the business");
        const before = await full(work.c.id);
        work.release();
        assert.equal(await work.pending, null);
        assert.deepEqual(await full(work.c.id), before);
        await assertNoResults(work.id);
      } finally { work.release(); await work.pending; }
    }
  });

  for (const fail of [false, true]) test(`recovery cannot be resurrected or rewritten by late ${fail ? "failure" : "success"}`, async () => {
    const work = await start(fail);
    try {
      assert.equal(await recover(work.id), 1);
      const recovered = await run(work.id);
      const before = await full(work.c.id);
      assert.equal(recovered.status, "failed");
      assert.equal(before.status, "discovered");
      work.release();
      assert.equal(await work.pending, null);
      assert.deepEqual(await run(work.id), recovered);
      assert.deepEqual(await full(work.c.id), before);
      await assertNoResults(work.id);
    } finally { work.release(); await work.pending; }
  });

  test("a replacement run owns B; the old worker cannot mutate that running or completed run", async () => {
    const old = await start();
    const web = pausedWebsite(OTHER);
    let replacement: ReturnType<typeof processResearch> | undefined;
    try {
      assert.equal(await recover(old.id), 1);
      await editWebsite(old.c.id, OTHER);
      const [q] = (await enqueueResearch(db, [old.c.id], "admin")).queued;
      replacement = processResearch(db, q!.researchId, { makeFetcher: web.makeFetcher, today: TODAY, autoApprove: false });
      await web.entered;
      const before = await full(old.c.id);
      const newRun = await run(q!.researchId);
      old.release();
      assert.equal(await old.pending, null);
      assert.deepEqual(await full(old.c.id), before);
      assert.deepEqual(await run(q!.researchId), newRun);
      web.release();
      assert.equal((await replacement)?.status, "completed");
      assert.equal((await run(old.id)).status, "failed");
      assert.equal((await run(q!.researchId)).subjectWebsite, OTHER);
      const evidence = (await full(old.c.id)).evidence;
      assert.ok(evidence.length > 0);
      assert.ok(evidence.every((e) => e.researchId === q!.researchId && new URL(e.sourceUrl).hostname === new URL(OTHER).hostname));
      await assertNoResults(old.id);
    } finally { old.release(); web.release(); await old.pending; await replacement; }
  });

  test("current success and failure still commit and report genuine failures", async () => {
    const c = await candidate();
    const [q] = (await enqueueResearch(db, [c.id], "admin")).queued;
    const web = fixtureWeb(independentShop());
    const success = await processResearch(db, q!.researchId, { makeFetcher: web.makeFetcher, today: TODAY, autoApprove: false });
    assert.equal(success?.status, "completed");
    assert.equal(success?.subjectWebsite, SITE);
    assert.equal((await full(c.id)).status, "researched");
    assert.ok((await full(c.id)).websiteVerifiedAt);
    assert.equal((await full(c.id)).evidence.length, 9);
    const failed = await start(true);
    failed.release();
    const failure = await failed.pending;
    assert.equal(failure?.status, "failed");
    assert.match(failure?.error ?? "", /Research error: Synthetic parser interruption/);
    assert.equal(failure?.outcome, null);
    assert.equal((await full(failed.c.id)).status, "discovered");
  });

  test("claiming newer work invalidates an older running worker even before recovery", async () => {
    const old = await start();
    const web = pausedWebsite();
    let replacement: ReturnType<typeof processResearch> | undefined;
    try {
      const newer = await db.candidateResearch.create({ data: {
        candidateId: old.c.id, version: "r14", trigger: "admin",
      } });
      replacement = processResearch(db, newer.id, { makeFetcher: web.makeFetcher, today: TODAY, autoApprove: false });
      await web.entered;
      const before = await full(old.c.id);
      const newerRun = await run(newer.id);
      old.release();
      assert.equal(await old.pending, null);
      assert.equal((await run(old.id)).outcome, "superseded");
      assert.deepEqual(await full(old.c.id), before);
      assert.deepEqual(await run(newer.id), newerRun);
      await assertNoResults(old.id);
      web.release();
      assert.equal((await replacement)?.status, "completed");
    } finally { old.release(); web.release(); await old.pending; await replacement; }
  });

  test("completion waits for an uncommitted candidate edit and then rejects its obsolete snapshot", async () => {
    const work = await start();
    let entered!: () => void;
    let release!: () => void;
    const editing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    const pending = work.pending.then((result) => { finished = true; return result; });
    const edit = db.$transaction(async (tx) => {
      await tx.discoveryCandidate.update({ where: { id: work.c.id }, data: {
        researchRevision: { increment: 1 }, website: OTHER, websiteVerifiedAt: null,
      } });
      entered();
      await gate;
    });
    try {
      await editing;
      work.release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(finished, false, "the candidate row lock spans check and commit");
      release();
      await edit;
      assert.equal(await pending, null);
      assert.equal((await full(work.c.id)).website, OTHER);
      await assertNoResults(work.id);
    } finally { release(); work.release(); await edit; await pending; }
  });

  test("12 concurrent claimers and repeated processing commit exactly once (8 rounds)", async () => {
    for (let round = 0; round < 8; round++) {
      const c = await candidate();
      const [q] = (await enqueueResearch(db, [c.id], "admin")).queued;
      const web = fixtureWeb(independentShop());
      const deps = { makeFetcher: web.makeFetcher, today: TODAY, autoApprove: false };
      const results = await Promise.all(Array.from({ length: 12 }, () => processResearch(db, q!.researchId, deps)));
      assert.equal(results.filter((r) => r?.status === "completed").length, 1);
      const sources = await db.researchSource.count({ where: { researchId: q!.researchId } });
      const facts = await db.researchFact.count({ where: { researchId: q!.researchId } });
      assert.ok(sources > 0 && facts > 0);
      const snapshot = await full(c.id);
      assert.equal(snapshot.evidence.length, 9);
      assert.equal(await processResearch(db, q!.researchId, deps), null);
      assert.equal(await db.researchSource.count({ where: { researchId: q!.researchId } }), sources);
      assert.equal(await db.researchFact.count({ where: { researchId: q!.researchId } }), facts);
      assert.deepEqual(await full(c.id), snapshot);
    }
  });

  test("concurrent recovery transitions once and preserves a newer human researching state", async () => {
    const work = await start();
    try {
      await changeCandidateStatus(db, work.c.id, "needs_review", null);
      await changeCandidateStatus(db, work.c.id, "researching", null);
      const before = await full(work.c.id);
      await db.candidateResearch.update({ where: { id: work.id }, data: { heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
      const recovered = await Promise.all(Array.from({ length: 4 }, () => failStaleResearch(db)));
      assert.equal(recovered.reduce((a, b) => a + b, 0), 1);
      assert.deepEqual(await full(work.c.id), before);
      work.release();
      assert.equal(await work.pending, null);
      assert.deepEqual(await full(work.c.id), before);
    } finally { work.release(); await work.pending; }
  });

  test("pre-migration running research without an ownership snapshot is failed conservatively", async () => {
    const c = await candidate();
    await db.discoveryCandidate.update({ where: { id: c.id }, data: { status: "researching" } });
    const old = await db.candidateResearch.create({ data: { candidateId: c.id, version: "r14", trigger: "admin", status: "running", heartbeatAt: new Date(0) } });
    const before = await full(c.id);
    assert.equal(await failStaleResearch(db), 1);
    assert.deepEqual(await full(c.id), before);
    assert.equal((await run(old.id)).status, "failed");
  });
});
