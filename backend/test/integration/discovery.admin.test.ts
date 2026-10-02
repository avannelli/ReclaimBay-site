import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { discoveryProviders } from "../../src/discovery/providers.js";
import { runDiscovery } from "../../src/discovery/service.js";
import { TEST_DATABASE_URL, WEBSITE, freshDb, readyForm, skipReason, truncate } from "./helpers.js";

const SECRET = "integration-test-secret-0123456789";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const ENV = { DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" };

async function signIn(app: FastifyInstance) {
  const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: form({ secret: SECRET }) });
  assert.equal(login.statusCode, 303);
  return String(login.headers["set-cookie"]).split(";")[0]!;
}

describe("discovery admin (HTTP)", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";

  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig(ENV), db, false);
    cookie = await signIn(app);
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const get = (url: string, auth = true) => app.inject({ method: "GET", url, headers: auth ? { cookie } : {} });
  const post = (url: string, data: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...FORM, cookie, ...headers }, payload: form(data) });
  const idFrom = (location: unknown, prefix: string) => new RegExp(`${prefix}/([0-9a-f-]{36})`).exec(String(location))![1]!;

  const runVentura = () => post("/admin/discovery/runs", { provider: "fixture", region: "Ventura County, CA", city: "", businessType: "Independent automotive repair" });
  /**
   * The same fixture run through the service, for tests about what happens after
   * discovery: the HTTP route allows 10 runs a minute, and this file shares it.
   */
  const seedVentura = () =>
    runDiscovery(db, discoveryProviders(loadConfig(ENV), db), { provider: "fixture", region: "Ventura County, CA", city: "", businessType: "Independent automotive repair" });
  const candidateId = async (externalId: string) => (await db.discoveryCandidate.findFirstOrThrow({ where: { externalId } })).id;

  /** A manual candidate researched through the forms, ready for approval. */
  async function readyCandidate(over: Record<string, string> = {}) {
    const add = await post("/admin/discovery/candidates", { businessName: "Smith Auto", website: WEBSITE, city: "Springfield", state: "IL", ...over });
    assert.equal(add.statusCode, 303, add.body);
    const id = idFrom(add.headers.location, "candidates");
    const edit = await post(`/admin/discovery/candidates/${id}`, readyForm({ businessName: "Smith Auto", signal_no_online_booking: "unknown", signal_digital_inspections: "unknown", ...over }));
    assert.equal(edit.statusCode, 303, edit.body);
    assert.equal((await post(`/admin/discovery/candidates/${id}/status`, { status: "researching" })).statusCode, 303);
    for (const signalKey of ["independent_shop", "general_repair_services"]) {
      const ev = await post(`/admin/discovery/candidates/${id}/evidence`, { signalKey, sourceUrl: `${WEBSITE}/about`, excerpt: `Public page supports ${signalKey}.` });
      assert.equal(ev.statusCode, 303, ev.body);
    }
    const done = await post(`/admin/discovery/candidates/${id}/status`, { status: "researched" });
    assert.equal(done.statusCode, 303, done.body);
    return id;
  }

  describe("access control", () => {
    const getUrls = ["/admin/discovery", "/admin/discovery/candidates/new", `/admin/discovery/candidates/${randomUUID()}`, `/admin/discovery/candidates/${randomUUID()}/edit`];

    test("every discovery page requires a session", async () => {
      for (const url of getUrls) {
        const res = await get(url, false);
        assert.equal(res.statusCode, 303, url);
        assert.equal(res.headers.location, "/admin/login");
      }
    });

    test("every discovery POST requires a session and creates nothing without one", async () => {
      await runVentura(); // with a session, to have a candidate to poke at
      const id = await candidateId("fx-1001");
      const before = { candidates: await db.discoveryCandidate.count(), prospects: await db.prospect.count() };
      const posts: [string, Record<string, string>][] = [
        ["/admin/discovery/runs", { provider: "fixture", region: "Ventura County, CA" }],
        ["/admin/discovery/candidates", { businessName: "Sneaky" }],
        [`/admin/discovery/candidates/${id}`, readyForm()],
        [`/admin/discovery/candidates/${id}/status`, { status: "rejected", reason: "x" }],
        [`/admin/discovery/candidates/${id}/notes`, { body: "x" }],
        [`/admin/discovery/candidates/${id}/evidence`, { signalKey: "independent_shop", sourceUrl: WEBSITE, excerpt: "x" }],
        [`/admin/discovery/candidates/${id}/approve`, {}],
      ];
      for (const [url, data] of posts) {
        const res = await app.inject({ method: "POST", url, headers: FORM, payload: form(data) });
        assert.equal(res.statusCode, 303, url);
        assert.equal(res.headers.location, "/admin/login", url);
      }
      assert.equal(await db.discoveryCandidate.count(), before.candidates);
      assert.equal(await db.prospect.count(), before.prospects);
      assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id } })).status, "discovered");
    });

    test("cross-origin POSTs are refused, including approval and runs", async () => {
      const id = await readyCandidate();
      for (const url of ["/admin/discovery/runs", "/admin/discovery/candidates", `/admin/discovery/candidates/${id}/approve`]) {
        const res = await post(url, { provider: "fixture", region: "Ventura County, CA", businessName: "x" }, { origin: "https://evil.example" });
        assert.equal(res.statusCode, 403, url);
      }
      const opaque = await post(`/admin/discovery/candidates/${id}/approve`, {}, { origin: "null" });
      assert.equal(opaque.statusCode, 403);
      assert.equal(await db.prospect.count(), 0);
      assert.equal(await db.discoveryRun.count(), 0);
    });

    test("discovery pages carry the admin security headers", async () => {
      for (const url of ["/admin/discovery", "/admin/discovery/candidates/new"]) {
        const res = await get(url);
        assert.equal(res.statusCode, 200, url);
        assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
        assert.equal(res.headers["cache-control"], "no-store");
        assert.equal(res.headers["referrer-policy"], "same-origin");
        assert.match(String(res.headers["x-robots-tag"]), /noindex/);
      }
    });

    test("malformed ids are 404, not errors", async () => {
      assert.equal((await get("/admin/discovery/candidates/not-a-uuid")).statusCode, 404);
      assert.equal((await get(`/admin/discovery/candidates/${randomUUID()}`)).statusCode, 404);
      assert.equal((await post(`/admin/discovery/candidates/${randomUUID()}/approve`, {})).statusCode, 404);
    });
  });

  describe("production configuration", () => {
    test("no fake provider is offered in production (only Overture), and fake-provider runs are refused", async () => {
      const prod = await buildApp(loadConfig({ ...ENV, NODE_ENV: "production" }), db, false);
      try {
        const prodCookie = await signIn(prod);
        const page = await prod.inject({ method: "GET", url: "/admin/discovery", headers: { cookie: prodCookie } });
        assert.equal(page.statusCode, 200);
        assert.match(page.body, /<option value="overture">Overture Maps Places/, "the real provider is offered");
        assert.doesNotMatch(page.body, /value="fixture"|value="fixture-staged"/, "no fake provider in production");
        assert.match(page.body, /Add candidate/, "manual entry still works");
        const run = await prod.inject({ method: "POST", url: "/admin/discovery/runs", headers: { ...FORM, cookie: prodCookie }, payload: form({ provider: "fixture", region: "Ventura County, CA" }) });
        assert.equal(run.statusCode, 400);
        assert.match(run.body, /available discovery provider/);
        assert.equal(await db.discoveryCandidate.count(), 0);
      } finally {
        await prod.close();
      }
    });

    test("ENABLE_FIXTURE_DISCOVERY=1 opts in explicitly", async () => {
      const opted = await buildApp(loadConfig({ ...ENV, NODE_ENV: "production", ENABLE_FIXTURE_DISCOVERY: "1" }), db, false);
      try {
        const res = await opted.inject({ method: "GET", url: "/admin/discovery", headers: { cookie: await signIn(opted) } });
        assert.match(res.body, /value="fixture"/);
      } finally {
        await opted.close();
      }
    });
  });

  describe("running discovery", () => {
    test("a run redirects with a summary, lists candidates, and never creates prospects", async () => {
      const res = await runVentura();
      assert.equal(res.statusCode, 303);
      const page = await get(String(res.headers.location));
      assert.match(page.body, /Discovery finished: 6 new candidate\(s\), 1 duplicate\(s\) skipped, 1 flagged for review\./);
      for (const name of ["Conejo Valley Auto Care", "Oak Park Import Repair", "Harbor Street Garage", "Camarillo Brake"]) {
        assert.match(page.body, new RegExp(name));
      }
      assert.match(page.body, /Possible duplicate/);
      assert.match(page.body, /candidate: same name and city/);
      assert.equal(await db.prospect.count(), 0);
    });

    test("an empty region is refused with the form kept", async () => {
      const res = await post("/admin/discovery/runs", { provider: "fixture", region: " ", city: "Ojai", businessType: "Garages" });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /Region is required/);
      assert.match(res.body, /value="Ojai"/);
    });

    test("filters work from the URL", async () => {
      await runVentura();
      const flagged = (await get("/admin/discovery?flagged=1")).body;
      assert.match(flagged, /Harbor Street Garage/);
      assert.doesNotMatch(flagged, /Oak Park Import Repair/);
      const byStatus = (await get("/admin/discovery?status=needs_review")).body;
      assert.match(byStatus, /Harbor Street Garage/);
      assert.doesNotMatch(byStatus, /Conejo Valley/);
      assert.match((await get("/admin/discovery?q=simi")).body, /Simi Valley Motor Works/);
      assert.match((await get("/admin/discovery?qualification=meets_criteria")).body, /No candidates match/);
    });
  });

  describe("candidate detail: what we know, don't know, and where from", () => {
    test("shows the sections, the sources, and keeps qualification and score separate", async () => {
      await runVentura();
      const id = await candidateId("fx-1001");
      const page = (await get(`/admin/discovery/candidates/${id}`)).body;
      assert.match(page, /What we know/);
      assert.match(page, /What we don&#39;t know|What we don't know/);
      assert.match(page, /Where each fact came from/);
      assert.match(page, /class="vd vd-warn lg"><span aria-hidden="true">⚠<\/span>Needs verification/);
      assert.match(page, /Opportunity score · ranking only, not a verdict/);
      assert.match(page, /directory\.example\.com\/listing\/fx-1001/);
      assert.match(page, /8 of 9 signals are unknown/, "only 'has a website' is known; the provider phone is unverified");
      assert.match(page, /Provider phone/);
      assert.match(page, /Unverified/);
      assert.match(page, /Can&#39;t approve yet/);
      assert.match(page, /It hasn&#39;t been researched yet\./, "the blocker in plain words");
      assert.doesNotMatch(page, /Approve as prospect|Approve anyway/);
    });

    test("recorded facts show their evidence and source; unsourced ones are flagged", async () => {
      const add = await post("/admin/discovery/candidates", { businessName: "Smith Auto", website: WEBSITE, city: "Springfield", state: "IL" });
      const id = idFrom(add.headers.location, "candidates");
      await post(`/admin/discovery/candidates/${id}`, readyForm({ signal_no_online_booking: "unknown", signal_digital_inspections: "unknown" }));
      let page = (await get(`/admin/discovery/candidates/${id}`)).body;
      assert.match(page, /No evidence yet/);
      await post(`/admin/discovery/candidates/${id}/evidence`, { signalKey: "independent_shop", sourceUrl: `${WEBSITE}/about`, excerpt: "Family owned since 1984." });
      page = (await get(`/admin/discovery/candidates/${id}`)).body;
      assert.match(page, /Family owned since 1984\./);
      assert.match(page, /smithauto\.example\.com\/about/);
      // Both required criteria are recorded "yes", so the existing rules say Meets criteria;
      // the signal that still lacks evidence stays flagged, and approval stays blocked.
      assert.match(page, /class="vd vd-pos lg"><span aria-hidden="true">✓<\/span>Qualified/);
      assert.match(page, /No evidence yet/);
      assert.match(page, /Can&#39;t approve yet/);
    });

    test("a possible duplicate explains itself, compares the two, and links to the match", async () => {
      await runVentura();
      const page = (await get(`/admin/discovery/candidates/${await candidateId("fx-2002")}`)).body;
      assert.match(page, /Possible duplicate/);
      assert.match(page, /Why it was flagged<\/span><b>Same name in the same city<\/b>/);
      assert.match(page, /matched only on: candidate: same name and city/, "the detection record stays in the details");
      assert.match(page, /<table class="cmp">/);
      assert.match(page, new RegExp(`href="/admin/discovery/candidates/${await candidateId("fx-2001")}"`));
    });

    test("while a duplicate is unresolved, the decision is the duplicate question, not approval", async () => {
      await seedVentura();
      const page = (await get(`/admin/discovery/candidates/${await candidateId("fx-2002")}`)).body;
      assert.match(page, /Resolve the possible duplicate first/);
      assert.doesNotMatch(page, /Approve as prospect|Approve anyway/);
      for (const decision of ["not_duplicate", "duplicate", "unresolved"]) assert.match(page, new RegExp(`name="decision" value="${decision}"`));
    });

    test("user and provider text is escaped everywhere", async () => {
      const bad = `<script>alert(1)</script>"'`;
      const add = await post("/admin/discovery/candidates", { businessName: bad, city: "<img src=x onerror=alert(1)>" });
      const id = idFrom(add.headers.location, "candidates");
      await post(`/admin/discovery/candidates/${id}/notes`, { body: "<b onmouseover=alert(1)>hi</b>" });
      for (const url of [`/admin/discovery/candidates/${id}`, "/admin/discovery", `/admin/discovery/candidates/${id}/edit`]) {
        const body = (await get(url)).body;
        assert.doesNotMatch(body, /<script>alert|<img src=x|<b onmouseover/, url);
      }
      assert.match((await get(`/admin/discovery/candidates/${id}`)).body, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
    });
  });

  describe("resolving a possible duplicate", () => {
    /** The flagged fixture candidate and the record it was matched with. */
    const flagged = async () => {
      await seedVentura();
      const c = await db.discoveryCandidate.findFirstOrThrow({ where: { externalId: "fx-2002" } });
      assert.equal(c.status, "needs_review");
      assert.equal(c.duplicateHold, true, "the hold is the duplicate check's");
      const match = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.possibleDuplicateCandidateId! } });
      return { c, match };
    };
    const decide = (id: string, decision: string) => post(`/admin/discovery/candidates/${id}/duplicate`, { decision });

    test("Not a duplicate records the decision, keeps the flag, lifts the hold, and confirms with a way back to the queue", async () => {
      const { c, match } = await flagged();
      const res = await decide(c.id, "not_duplicate");
      assert.equal(res.statusCode, 303);
      assert.match(String(res.headers.location), /\?done=not_duplicate$/);
      const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: { notes: true } });
      assert.equal(after.duplicateDecision, "not_duplicate");
      assert.ok(after.duplicateDecidedAt);
      assert.equal(after.possibleDuplicateCandidateId, match.id, "the detection record is kept");
      assert.equal(after.duplicateReason, c.duplicateReason);
      assert.equal(after.status, "discovered", "no evidence yet, so it goes back to be researched");
      assert.ok(after.notes.some((n) => n.body.startsWith(`Not a duplicate of ${match.businessName}: a person checked the possible match (same name in the same city)`)));

      const page = (await get(String(res.headers.location))).body;
      assert.match(page, /Duplicate resolved: .+ is not a duplicate of /);
      assert.match(page, /<a href="\/admin\/discovery">Back to review queue<\/a>/);
      assert.match(page, /✓<\/span>Not a duplicate/);
      assert.doesNotMatch(page, /Resolve the possible duplicate first/);
      assert.doesNotMatch((await get("/admin/discovery?flagged=1")).body, new RegExp(`/admin/discovery/candidates/${c.id}"`), "no longer waiting on a person");
      assert.equal(await db.prospect.count(), 0, "a decision never creates a prospect");
    });

    test("Not a duplicate never lifts a Needs review hold a person set", async () => {
      const { c } = await flagged();
      // A person takes the candidate out of the duplicate check's hold, then puts it on hold themselves.
      assert.equal((await post(`/admin/discovery/candidates/${c.id}/status`, { status: "researching" })).statusCode, 303);
      assert.equal((await post(`/admin/discovery/candidates/${c.id}/status`, { status: "needs_review", intent: "keep" })).statusCode, 303);
      assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).duplicateHold, false);

      const res = await decide(c.id, "not_duplicate");
      assert.match(String(res.headers.location), /\?done=not_duplicate_held$/);
      const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: { notes: true } });
      assert.equal(after.status, "needs_review", "the person's hold stays");
      assert.equal(after.duplicateDecision, "not_duplicate", "the duplicate question is still answered");
      assert.ok(after.notes.some((n) => /It stays in Needs review, where a person put it\.$/.test(n.body)));
      const page = (await get(String(res.headers.location))).body;
      assert.match(page, /It stays in Needs review because a person also put it on hold\./);
      assert.doesNotMatch(page, /Resolve the possible duplicate first/);
    });

    test("Not a duplicate returns an evidence-backed candidate to Researched", async () => {
      const { c } = await flagged();
      await post(`/admin/discovery/candidates/${c.id}/evidence`, { signalKey: "independent_shop", sourceUrl: "https://harbor.example.com/about", excerpt: "Family owned." });
      await decide(c.id, "not_duplicate");
      const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(after.status, "researched");
      assert.ok(after.researchedAt);
    });

    test("Mark duplicate closes it with the match as the reason; it can't be approved, and can be reopened", async () => {
      const { c, match } = await flagged();
      const res = await decide(c.id, "duplicate");
      assert.equal(res.statusCode, 303);
      const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(after.status, "duplicate");
      assert.equal(after.decisionReason, `Duplicate of ${match.businessName} (same name in the same city).`);
      const page = (await get(String(res.headers.location))).body;
      assert.match(page, /Marked as a duplicate: .+ is the same business as /);
      assert.match(page, /↔<\/span>Duplicate/);
      assert.equal((await post(`/admin/discovery/candidates/${c.id}/approve`, {})).statusCode, 400);

      const reopen = await post(`/admin/discovery/candidates/${c.id}/status`, { status: "discovered", intent: "reopen" });
      assert.match(String(reopen.headers.location), /\?done=reopened$/);
      const reopened = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(reopened.status, "discovered");
      assert.match((await get(`/admin/discovery/candidates/${c.id}`)).body, /Possible duplicate/, "the flag is still there to decide again");
    });

    test("Leave unresolved records that a person looked, and keeps the warning and the hold", async () => {
      const { c } = await flagged();
      await decide(c.id, "unresolved");
      const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(after.duplicateDecision, "unresolved");
      assert.equal(after.status, "needs_review");
      const page = (await get(`/admin/discovery/candidates/${c.id}?done=unresolved`)).body;
      assert.match(page, /Left unresolved: .+ keeps its possible-duplicate warning/);
      assert.match(page, /Resolve the possible duplicate first/);
      assert.doesNotMatch(page, /value="unresolved"/, "already left unresolved: only the two real answers remain");
      assert.match((await get("/admin/discovery?flagged=1")).body, new RegExp(`/admin/discovery/candidates/${c.id}"`));
    });

    test("refused: no flag, an unknown answer, or an approved candidate", async () => {
      const { c } = await flagged();
      const clean = await candidateId("fx-1001");
      const none = await decide(clean, "not_duplicate");
      assert.equal(none.statusCode, 400);
      assert.match(none.body, /no possible-duplicate flag to resolve/);
      assert.equal((await decide(c.id, "maybe")).statusCode, 400);
      assert.equal((await decide(randomUUID(), "not_duplicate")).statusCode, 404);

      const id = await readyCandidate();
      await db.discoveryCandidate.update({ where: { id }, data: { possibleDuplicateCandidateId: c.id, duplicateReason: "candidate: same phone number" } });
      assert.equal((await post(`/admin/discovery/candidates/${id}/approve`, {})).statusCode, 303);
      const frozen = await decide(id, "duplicate");
      assert.equal(frozen.statusCode, 409, "an approved candidate is frozen, as for every other change to it");
      assert.match(frozen.body, /This candidate is approved and is now a prospect/);
    });

    test("Keep for review and Disregard are explicit decisions with confirmations", async () => {
      const id = await readyCandidate();
      const keep = await post(`/admin/discovery/candidates/${id}/status`, { status: "needs_review", intent: "keep" });
      assert.match(String(keep.headers.location), /\?done=kept$/);
      assert.match((await get(String(keep.headers.location))).body, /is kept for review\./);

      const noReason = await post(`/admin/discovery/candidates/${id}/status`, { status: "rejected", intent: "disregard", reason: "" });
      assert.equal(noReason.statusCode, 400);
      assert.match(noReason.body, /<details class="rv-disregard" open>/, "the reason form stays open with the error");
      const gone = await post(`/admin/discovery/candidates/${id}/status`, { status: "rejected", intent: "disregard", reason: "A dealership." });
      assert.match(String(gone.headers.location), /\?done=disregarded$/);
      const page = (await get(String(gone.headers.location))).body;
      assert.match(page, /was disregarded\./);
      assert.match(page, /✕<\/span>Disregarded/);
      assert.match(page, /A dealership\./);
    });
  });

  describe("human approval", () => {
    test("manual add -> research forms -> approve creates a New prospect with provenance and evidence", async () => {
      const id = await readyCandidate();
      const detail = (await get(`/admin/discovery/candidates/${id}`)).body;
      assert.match(detail, /✓ Approve as prospect/);
      assert.match(detail, /does not automatically qualify the business or mark it ready to contact/);

      const res = await post(`/admin/discovery/candidates/${id}/approve`, {});
      assert.equal(res.statusCode, 303);
      const prospectId = idFrom(res.headers.location, "prospects");
      assert.match(String(res.headers.location), /done=created$/);

      const prospect = await db.prospect.findUniqueOrThrow({ where: { id: prospectId }, include: { evidence: true, notes: true, signals: true } });
      assert.equal(prospect.status, "new");
      assert.equal(prospect.evidence.length, 2);
      assert.equal(prospect.signals.length, 2);
      assert.match(prospect.notes[0]!.body, /Approved by a human from a discovery candidate\. Provider: manual/);

      const page = (await get(String(res.headers.location))).body;
      assert.match(page, /Prospect created\./);
      assert.match(page, /Approved by a human from a discovery candidate/);
      assert.match(page, /class="st q-meets_criteria q-big">Meets criteria/);
      assert.match(page, /<span class="st st-new">New<\/span>/);

      const after = (await get(`/admin/discovery/candidates/${id}`)).body;
      assert.match(after, /class="st cs-approved">Approved/);
      assert.match(after, new RegExp(`href="/admin/prospects/${prospectId}"`));
      assert.doesNotMatch(after, /Edit research|Add evidence/);
      assert.equal((await get(`/admin/discovery/candidates/${id}/edit`)).statusCode, 303, "approved candidates can't be edited");
    });

    test("approval is refused while research is incomplete, and creates nothing", async () => {
      await runVentura();
      const id = await candidateId("fx-1001");
      const res = await post(`/admin/discovery/candidates/${id}/approve`, {});
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /Only Researched or Needs review candidates can be approved/);
      assert.equal(await db.prospect.count(), 0);
    });

    test("rejected and duplicate candidates can't be approved", async () => {
      await runVentura();
      const id = await candidateId("fx-1002");
      assert.equal((await post(`/admin/discovery/candidates/${id}/status`, { status: "rejected", reason: "" })).statusCode, 400, "reason required");
      assert.equal((await post(`/admin/discovery/candidates/${id}/status`, { status: "rejected", reason: "Import specialist" })).statusCode, 303);
      assert.match((await get(`/admin/discovery/candidates/${id}`)).body, /Decision: Import specialist/);
      assert.equal((await post(`/admin/discovery/candidates/${id}/approve`, {})).statusCode, 400);
      assert.equal(await db.prospect.count(), 0);
    });

    test("approving twice doesn't create a second prospect", async () => {
      const id = await readyCandidate();
      assert.equal((await post(`/admin/discovery/candidates/${id}/approve`, {})).statusCode, 303);
      const again = await post(`/admin/discovery/candidates/${id}/approve`, {});
      assert.equal(again.statusCode, 409);
      assert.match(again.body, /Already approved/);
      assert.equal(await db.prospect.count(), 1);
    });

    test("status can't be set to approved through the status form", async () => {
      const id = await readyCandidate();
      const res = await post(`/admin/discovery/candidates/${id}/status`, { status: "approved" });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /Use Approve/);
      assert.equal(await db.prospect.count(), 0);
    });

    test("existing prospect pages still work and link to Discovery", async () => {
      const list = await get("/admin/prospects");
      assert.equal(list.statusCode, 200);
      assert.match(list.body, /href="\/admin\/discovery"/);
      assert.match((await get("/admin/prospects/new")).body, /name="signal_independent_shop"/);
    });
  });
});
