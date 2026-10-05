import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { discoveryProviders } from "../../src/discovery/providers.js";
import {
  addCandidateEvidence,
  addManualCandidate,
  approveCandidate,
  changeCandidateStatus,
  queuePosition,
  resolveDuplicate,
  reviewQueue,
  runDiscovery,
  updateCandidate,
} from "../../src/discovery/service.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";

/*
 * The Discovery work queue: candidates in the right group, counts, views, one
 * primary action per state, and the queue -> candidate -> next flow. Candidates
 * are seeded through the service, so the 10-a-minute run route isn't involved.
 */

const SECRET = "integration-test-secret-0123456789";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const ENV = { DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" };

describe("discovery work queue", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";

  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig(ENV), db, false);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: form({ secret: SECRET }) });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, data: Record<string, string>) => app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: form(data) });

  let phones = 0;
  /** A hand-added candidate, researched through the service with the given answers and evidence. */
  async function researched(name: string, answers: { fit: string; repair: string }, opts: { website?: string; researched?: boolean } = {}) {
    const website = opts.website ?? `https://${name.toLowerCase().replace(/[^a-z]/g, "")}.example.com`;
    const c = await addManualCandidate(db, { businessName: name, website, city: "Ventura", state: "CA" });
    // A phone of its own, so no two seeded businesses look like duplicates.
    const phone = { phone: `(805) 555-${String(1000 + ++phones)}`, phoneSourceUrl: website ? `${website}/contact` : "" };
    await updateCandidate(db, c.id, readyForm({
      ...(website ? phone : { phone: "", phoneSourceUrl: "" }),
      businessName: name, website, city: "Ventura", state: "CA",
      signal_independent_shop: "yes", signal_collision_repair_services: answers.fit, signal_general_repair_services: answers.repair,
      signal_digital_inspections: "unknown", signal_no_online_booking: "unknown",
    }));
    if (name !== "Able Auto Glass") await db.discoveryCandidate.update({where:{id:c.id},data:{categoryVerdict:"in_target",categorySource:"manual",categoryReason:"Fixture collision/body classification."}});
    if (opts.researched === false) return c.id;
    await changeCandidateStatus(db, c.id, "researching", null);
    for (const [key, value] of [["independent_shop", "yes"], ["collision_repair_services", answers.fit], ["general_repair_services", answers.repair]] as const) {
      if (value !== "unknown") await addCandidateEvidence(db, c.id, { signalKey: key, sourceUrl: `${website}/about`, excerpt: `Public page about ${key}.` });
    }
    await changeCandidateStatus(db, c.id, "researched", null);
    return c.id;
  }

  /** One candidate in every state the queue distinguishes. */
  async function seedEveryState() {
    await runDiscovery(db, discoveryProviders(loadConfig(ENV), db), { provider: "fixture", region: "Ventura County, CA", city: "", businessType: "Independent automotive repair" });
    const dup = await db.discoveryCandidate.findFirstOrThrow({ where: { externalId: "fx-2002" } });
    const notResearched = { id: await researched("Smith Auto Repair", { fit: "unknown", repair: "unknown" }, { researched: false }) };
    const ready = await researched("Bender Auto Repair", { fit: "yes", repair: "yes" });
    const verify = await researched("Conejo Auto Repair", { fit: "unknown", repair: "yes" });
    const noFit = await researched("Quick Auto Repair", { fit: "no", repair: "yes" });
    const wrongCategory = await researched("Able Auto Glass", { fit: "yes", repair: "yes" });
    const approved = await researched("Approved Auto Repair", { fit: "yes", repair: "yes" });
    await approveCandidate(db, approved);
    const rejected = await researched("Rejected Auto Repair", { fit: "yes", repair: "yes" });
    await changeCandidateStatus(db, rejected, "rejected", "A dealership.");
    return { dup: dup.id, notResearched: notResearched.id, ready, verify, noFit, wrongCategory, approved, rejected };
  }

  /** The queue row of a candidate, or null when it isn't on the page. */
  const rowOf = (html: string, id: string) => {
    const at = html.indexOf(`id="c-${id}"`);
    if (at === -1) return null;
    const start = html.lastIndexOf(`<li class="q-row`, at);
    return html.slice(start, html.indexOf("</li>", at));
  };

  test("every candidate lands in its group with one primary action that fits its state", async () => {
    const ids = await seedEveryState();
    const q = await reviewQueue(db, {}, "all");
    const step = (id: string) => q.items.find((i) => i.candidate.id === id)!.step;
    assert.deepEqual([step(ids.dup).lane, step(ids.dup).action], ["decision", "review_duplicate"], "a possible duplicate needs a decision");
    assert.deepEqual([step(ids.noFit).lane, step(ids.noFit).action], ["decision", "disregard"], "a criterion observed as No: disregard");
    assert.deepEqual([step(ids.wrongCategory).lane, step(ids.wrongCategory).kind], ["decision", "outside_target"]);
    assert.deepEqual([step(ids.ready).lane, step(ids.ready).action], ["ready", "approve"], "qualified and researched: approve");
    assert.deepEqual([step(ids.verify).lane, step(ids.verify).action, step(ids.verify).criterion], ["verify", "verify", "collision_repair_services"]);
    assert.deepEqual([step(ids.notResearched).lane, step(ids.notResearched).action], ["research", "run_research"], "never researched: run research");
    assert.deepEqual([step(ids.approved).lane, step(ids.approved).kind], ["handled", "approved"]);
    assert.deepEqual([step(ids.rejected).lane, step(ids.rejected).kind], ["handled", "disregarded"]);

    // The order: decisions, then approvals, then verification, then research, then handled.
    const lanes = q.items.map((i) => i.step.lane);
    assert.deepEqual([...new Set(lanes)], ["decision", "ready", "verify", "research", "handled"]);

    // Counts add up, and match what the page shows.
    assert.equal(q.counts.all, q.items.length);
    assert.equal(q.counts.decision + q.counts.ready + q.counts.verify + q.counts.research + q.counts.handled, q.counts.all);
    assert.equal(q.counts.active, q.counts.all - q.counts.handled);
    assert.deepEqual([q.counts.ready, q.counts.verify, q.counts.duplicates, q.counts.completed, q.counts.disregarded], [1, 1, 1, 1, 1]);
    const page = (await get("/admin/discovery")).body;
    assert.match(page, new RegExp(`<b>${q.counts.active} businesses need your attention</b>`));
    assert.match(page, new RegExp(`<span class="q-tile-n">${q.counts.decision}</span><span class="q-tile-l"><span aria-hidden="true">⚠</span> Needs decision`));
    assert.match(page, /<span class="q-tile-n">1<\/span><span class="q-tile-l"><span aria-hidden="true">✓<\/span> Ready to approve/);

    // Each row's primary action.
    assert.match(rowOf(page, ids.dup)!, /href="\/admin\/discovery\/candidates\/[0-9a-f-]+#dup-h">Review duplicate/);
    assert.match(rowOf(page, ids.ready)!, /<form method="post" action="\/admin\/discovery\/candidates\/[0-9a-f-]+\/approve" class="inline-form"><input type="hidden" name="from" value="queue"><button type="submit" class="btn-go">✓ Approve as prospect/);
    assert.match(rowOf(page, ids.verify)!, /href="\/admin\/discovery\/candidates\/[0-9a-f-]+\/edit#sig-collision_repair_services">Verify qualification/);
    assert.match(rowOf(page, ids.noFit)!, /href="\/admin\/discovery\/candidates\/[0-9a-f-]+\?act=disregard#dec-h">Disregard…/);
    assert.match(rowOf(page, ids.noFit)!, /Verified collision\/body repair is No\./, "says why");
    assert.match(rowOf(page, ids.notResearched)!, /action="\/admin\/discovery\/candidates\/[0-9a-f-]+\/research"[\s\S]*?▶ Run research/);
    assert.match(rowOf(page, ids.notResearched)!, /\? <\/span>|Not checked yet/, "unknown before research is quiet, not a warning");
    for (const id of [ids.ready, ids.verify, ids.dup]) assert.match(rowOf(page, id)!, /Opportunity \d+\/100 <span class="muted">\(ranking only\)<\/span>/);
    assert.match(page, /Opportunity score — ranking only, not a verdict\./);
    // Handled items are there, but secondary and collapsed.
    assert.match(page, /<details class="disc q-handled" id="handled"><summary><h2 id="handled-h">Handled<\/h2>/);
    assert.match(rowOf(page, ids.approved)!, /Approved by a person/);
    // One h1; groups are h2; rows are h3.
    assert.equal(page.match(/<h1[ >]/g)?.length, 1);
    assert.match(page, /<h1>Discovery<\/h1>/);
  });

  test("the quick views filter the queue, mark the active one, and keep the search", async () => {
    const ids = await seedEveryState();
    const names = async (url: string) => (await get(url)).body;
    const decision = await names("/admin/discovery?view=decision");
    assert.match(decision, /<a class="chip" href="\/admin\/discovery\?view=decision" aria-current="true">Needs decision/);
    assert.ok(rowOf(decision, ids.dup) && rowOf(decision, ids.noFit) && rowOf(decision, ids.wrongCategory));
    assert.equal(rowOf(decision, ids.ready), null);
    assert.equal(rowOf(decision, ids.notResearched), null);

    const dups = await names("/admin/discovery?view=duplicates");
    assert.ok(rowOf(dups, ids.dup));
    assert.equal(rowOf(dups, ids.noFit), null);
    assert.ok(rowOf(await names("/admin/discovery?view=ready"), ids.ready));
    assert.ok(rowOf(await names("/admin/discovery?view=verify"), ids.verify));
    assert.ok(rowOf(await names("/admin/discovery?view=research"), ids.notResearched));
    assert.ok(rowOf(await names("/admin/discovery?view=completed"), ids.approved));
    const disregarded = await names("/admin/discovery?view=disregarded");
    assert.ok(rowOf(disregarded, ids.rejected));
    assert.equal(rowOf(disregarded, ids.approved), null);

    // A search narrows every view, and switching views keeps it.
    const searched = await names("/admin/discovery?view=decision&q=quick");
    assert.ok(rowOf(searched, ids.noFit));
    assert.equal(rowOf(searched, ids.dup), null);
    assert.match(searched, /href="\/admin\/discovery\?view=ready&amp;q=quick"|href="\/admin\/discovery\?view=ready&q=quick"/);
    // An unknown view falls back to the whole queue.
    assert.match(await names("/admin/discovery?view=bogus"), /<a class="chip" href="\/admin\/discovery" aria-current="true">All/);
    // An empty view says so and offers the way back.
    await truncate(db);
    const empty = await names("/admin/discovery?view=ready");
    assert.match(empty, /No candidates to review\./);
  });

  test("a resolved 'not a duplicate' leaves the duplicate work; an unresolved one stays", async () => {
    const ids = await seedEveryState();
    await resolveDuplicate(db, ids.dup, "unresolved");
    assert.ok(rowOf((await get("/admin/discovery?view=duplicates")).body, ids.dup), "left unresolved: still waiting");
    await resolveDuplicate(db, ids.dup, "not_duplicate");
    const q = await reviewQueue(db, {}, "all");
    assert.equal(q.counts.duplicates, 0);
    assert.notEqual(q.items.find((i) => i.candidate.id === ids.dup)!.step.kind, "duplicate");
    assert.equal(rowOf((await get("/admin/discovery?view=duplicates")).body, ids.dup), null);
  });

  test("approving from the queue returns to the queue with a confirmation, and the item moves to Completed", async () => {
    const ids = await seedEveryState();
    const res = await post(`/admin/discovery/candidates/${ids.ready}/approve`, { from: "queue", view: "ready" });
    assert.equal(res.statusCode, 303);
    assert.equal(String(res.headers.location), `/admin/discovery?done=approved&c=${ids.ready}&view=ready`);
    const page = (await get(String(res.headers.location))).body;
    assert.match(page, /Bender Auto Repair was approved and added to your prospect pipeline as New\. <a href="\/admin\/prospects\/[0-9a-f-]+">Open prospect<\/a>/);
    assert.match(page, /Nothing in “Ready to approve”\./, "the ready view is now empty");
    assert.ok(rowOf((await get("/admin/discovery?view=completed")).body, ids.ready));

    // From the candidate page, approval still opens the new prospect, as before.
    const other = await researched("Second Auto Repair", { fit: "yes", repair: "yes" });
    assert.match(String((await post(`/admin/discovery/candidates/${other}/approve`, {})).headers.location), /^\/admin\/prospects\/[0-9a-f-]+\?done=created$/);
  });

  test("approving something that isn't approvable from the queue explains why, on the queue", async () => {
    const ids = await seedEveryState();
    const res = await post(`/admin/discovery/candidates/${ids.notResearched}/approve`, { from: "queue" });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /<h1>Discovery<\/h1>/);
    assert.match(res.body, /Only Researched or Needs review candidates can be approved/);
  });

  test("Run research from the queue returns to the queue; a candidate that can't be researched is refused there", async () => {
    const noSite = await researched("No Site Auto Repair", { fit: "unknown", repair: "unknown" }, { website: "", researched: false });
    const res = await post(`/admin/discovery/candidates/${noSite}/research`, { from: "queue", view: "research" });
    assert.equal(res.statusCode, 303);
    assert.equal(String(res.headers.location), `/admin/discovery?done=research_one&c=${noSite}&view=research`);
    assert.match((await get(String(res.headers.location))).body, /Research queued for No Site Auto Repair\./);

    const closed = await researched("Closed Auto Repair", { fit: "yes", repair: "yes" });
    await changeCandidateStatus(db, closed, "rejected", "Not a fit.");
    const refused = await post(`/admin/discovery/candidates/${closed}/research`, { from: "queue" });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.body, /<h1>Discovery<\/h1>/);
    assert.match(refused.body, /Research can&#39;t start: candidate is rejected\./);
  });

  test("Disregard… from the queue opens the candidate with the reason form open and prefilled", async () => {
    const ids = await seedEveryState();
    const page = (await get(`/admin/discovery/candidates/${ids.noFit}?act=disregard`)).body;
    assert.match(page, /<details class="rv-disregard" open>/);
    assert.match(page, /name="reason" value="Does not qualify: Verified collision\/body repair is No\."/);
    assert.doesNotMatch((await get(`/admin/discovery/candidates/${ids.noFit}`)).body, /<details class="rv-disregard" open>/, "closed unless asked for");
  });

  test("the candidate page shows its place in the queue, with Previous and Next", async () => {
    const ids = await seedEveryState();
    const q = await reviewQueue(db, {}, "all");
    const active = q.items.filter((i) => i.step.lane !== "handled");
    const second = active[1]!.candidate;
    const page = (await get(`/admin/discovery/candidates/${second.id}`)).body;
    assert.match(page, /<nav class="rv-nav" aria-label="Review queue">/);
    assert.match(page, /<a class="rv-back" href="\/admin\/discovery">← Review queue<\/a>/);
    assert.match(page, new RegExp(`2 of ${active.length} needing attention`));
    assert.match(page, new RegExp(`href="/admin/discovery/candidates/${active[0]!.candidate.id}" rel="prev"`));
    assert.match(page, new RegExp(`href="/admin/discovery/candidates/${active[2]!.candidate.id}" rel="next"`));

    // A handled candidate isn't in the queue: Next is the first item still needing attention.
    const handled = (await get(`/admin/discovery/candidates/${ids.approved}`)).body;
    assert.match(handled, new RegExp(`${active.length} items need attention`));
    assert.match(handled, new RegExp(`href="/admin/discovery/candidates/${active[0]!.candidate.id}" rel="next"`));
    assert.doesNotMatch(handled, /rel="prev"/);

    // After a decision, the confirmation offers the next item.
    const res = await post(`/admin/discovery/candidates/${ids.dup}/duplicate`, { decision: "not_duplicate" });
    const decided = (await get(String(res.headers.location))).body;
    assert.match(decided, /Duplicate resolved: [\s\S]*?rel="next">Next: [^<]+ →<\/a> · <a href="\/admin\/discovery">Back to review queue<\/a>/);
  });

  test("Previous and Next use the whole queue, not the 200 shown", async () => {
    // 250 candidates in one lane: "Queue Shop 001" is newest, so it is first and
    // shop N is at position N. Shop 240 starts disregarded, out of the queue.
    const base = Date.UTC(2026, 0, 1);
    const n = (i: number) => `Queue Shop ${String(i).padStart(3, "0")}`;
    await db.discoveryCandidate.createMany({
      data: Array.from({ length: 250 }, (_, k) => ({
        businessName: n(k + 1),
        nameKey: n(k + 1).toLowerCase(),
        provider: "manual",
        discoveredAt: new Date(base - k * 60_000),
        ...(k + 1 === 240 ? { status: "rejected" as const, decisionReason: "Not a fit.", decidedAt: new Date(base) } : {}),
      })),
    });
    const ids = new Map((await db.discoveryCandidate.findMany({ select: { id: true, businessName: true } })).map((c) => [c.businessName, c.id]));
    const id = (i: number) => ids.get(n(i))!;

    const q = await reviewQueue(db, {}, "all");
    assert.equal(q.items.length, 200, "the queue still shows at most 200");
    assert.equal(q.total, 250);
    assert.equal(q.counts.active, 249);

    // Past the display limit: its true place and neighbours, not the start of the queue.
    assert.deepEqual(await queuePosition(db, id(230)), {
      remaining: 248,
      index: 230,
      total: 249,
      previous: { id: id(229), businessName: n(229) },
      next: { id: id(231), businessName: n(231) },
    });
    const page = (await get(`/admin/discovery/candidates/${id(230)}`)).body;
    assert.match(page, /230 of 249 needing attention/);
    assert.match(page, new RegExp(`href="/admin/discovery/candidates/${id(229)}" rel="prev">← Previous</a>`));
    assert.match(page, new RegExp(`href="/admin/discovery/candidates/${id(231)}" rel="next">Next →<span class="sr-only">: ${n(231)}</span></a>`));
    assert.doesNotMatch(page, new RegExp(`href="/admin/discovery/candidates/${id(1)}"`), "doesn't jump back to the first item");

    // The last item: Previous only (shop 250 follows the disregarded shop 240).
    const last = await queuePosition(db, id(250));
    assert.equal(last.index, 249);
    assert.equal(last.previous?.id, id(249));
    assert.equal(last.next, null);
    assert.doesNotMatch((await get(`/admin/discovery/candidates/${id(250)}`)).body, /rel="next"/);

    // A decision that returns a deep candidate to the queue: Next is its true neighbour.
    const res = await post(`/admin/discovery/candidates/${id(240)}/status`, { status: "discovered", intent: "reopen" });
    assert.equal(res.statusCode, 303);
    const decided = (await get(String(res.headers.location))).body;
    assert.match(decided, new RegExp(`${n(240)} was reopened for review\\. <a class="[^"]*" href="/admin/discovery/candidates/${id(241)}" rel="next">Next: ${n(241)} →</a>`));
    assert.match(decided, /240 of 250 needing attention/);
    assert.match(decided, new RegExp(`href="/admin/discovery/candidates/${id(239)}" rel="prev"`));
  });

  test("the funnel's attention counts come from the same queue", async () => {
    await seedEveryState();
    const q = await reviewQueue(db, {}, "all");
    const funnel = (await get("/admin")).body;
    assert.match(funnel, new RegExp(`href="/admin/discovery\\?view=decision"><b>${q.counts.decision}</b><span>candidates need your decision</span>`));
    assert.match(funnel, /href="\/admin\/discovery\?view=ready"><b>1<\/b><span>candidate ready to approve<\/span>/);
  });
});
