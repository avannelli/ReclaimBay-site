import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
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
      assert.match(page, /class="st q-unverified q-big">Unverified/);
      assert.match(page, /Opportunity score · ranking only, not a verdict/);
      assert.match(page, /directory\.example\.com\/listing\/fx-1001/);
      assert.match(page, /8 of 9 signals are unknown/, "only 'has a website' is known; the provider phone is unverified");
      assert.match(page, /Provider phone/);
      assert.match(page, /Unverified/);
      assert.match(page, /Not ready to approve yet/);
      assert.doesNotMatch(page, /Approve and create prospect/);
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
      assert.match(page, /class="st q-meets_criteria q-big"/);
      assert.match(page, /No evidence yet/);
      assert.match(page, /Not ready to approve yet/);
    });

    test("a possible duplicate explains itself and links to the match", async () => {
      await runVentura();
      const page = (await get(`/admin/discovery/candidates/${await candidateId("fx-2002")}`)).body;
      assert.match(page, /Possible duplicate/);
      assert.match(page, /Matched only on: candidate: same name and city/);
      assert.match(page, new RegExp(`href="/admin/discovery/candidates/${await candidateId("fx-2001")}"`));
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

  describe("human approval", () => {
    test("manual add -> research forms -> approve creates a New prospect with provenance and evidence", async () => {
      const id = await readyCandidate();
      const detail = (await get(`/admin/discovery/candidates/${id}`)).body;
      assert.match(detail, /Approve and create prospect/);
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
