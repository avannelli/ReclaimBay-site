import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { TEST_DATABASE_URL, WEBSITE, freshDb, readyForm, skipReason, truncate } from "./helpers.js";

const SECRET = "integration-test-secret-0123456789";
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("admin prospect workflow (HTTP)", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";

  before(async () => {
    db = await freshDb();
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      ALLOWED_ORIGIN: "https://reclaimbay.com",
      ADMIN_SECRET: SECRET,
      TRUST_PROXY_HOPS: "0",
    });
    app = await buildApp(config, db, false);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: form({ secret: SECRET }) });
    assert.equal(login.statusCode, 303);
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const get = (url: string, auth = true) => app.inject({ method: "GET", url, headers: auth ? { cookie } : {} });
  const post = (url: string, data: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...FORM, cookie, ...headers }, payload: form(data) });
  const createViaHttp = async (data = readyForm()) => {
    const res = await post("/admin/prospects", data);
    assert.equal(res.statusCode, 303, res.body);
    const id = /\/admin\/prospects\/([0-9a-f-]{36})/.exec(String(res.headers.location))![1]!;
    return id;
  };

  test("every prospect route requires a session", async () => {
    for (const url of ["/admin/prospects", "/admin/prospects/new", `/admin/prospects/${randomUUID()}`]) {
      const res = await get(url, false);
      assert.equal(res.statusCode, 303, url);
      assert.equal(res.headers.location, "/admin/login");
    }
    const res = await app.inject({ method: "POST", url: "/admin/prospects", headers: FORM, payload: form(readyForm()) });
    assert.equal(res.statusCode, 303);
    assert.equal(await db.prospect.count(), 0, "nothing created without a session");
  });

  test("admin pages use a referrer policy that lets the browser send the real Origin on their own POSTs", async () => {
    // "no-referrer" makes browsers send `Origin: null` on form POSTs, which
    // the origin check rejects (the production login 403).
    for (const url of ["/admin/login", "/admin", "/admin/prospects"]) {
      assert.equal((await get(url)).headers["referrer-policy"], "same-origin", url);
    }
  });

  test("login accepts the backend's own origin, whatever domain it is served on", async () => {
    for (const host of ["reclaimbay-production.up.railway.app", "api.reclaimbay.com"]) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { ...FORM, host, origin: `https://${host}` },
        payload: form({ secret: SECRET }),
      });
      assert.equal(res.statusCode, 303, host);
    }
  });

  test("login refuses an opaque or foreign Origin, including the frontend's", async () => {
    for (const origin of ["null", "https://evil.example", "https://reclaimbay.com"]) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { ...FORM, host: "reclaimbay-production.up.railway.app", origin },
        payload: form({ secret: SECRET }),
      });
      assert.equal(res.statusCode, 403, origin);
      assert.equal(res.headers["set-cookie"], undefined, `${origin}: no session issued`);
    }
  });

  test("cross-origin posts are refused", async () => {
    const res = await post("/admin/prospects", readyForm(), { origin: "https://evil.example" });
    assert.equal(res.statusCode, 403);
    assert.equal(await db.prospect.count(), 0);
  });

  test("create -> detail shows the score breakdown, with the admin security headers", async () => {
    const id = await createViaHttp();
    const res = await get(`/admin/prospects/${id}?done=created`);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(res.body, /Prospect created\./);
    assert.match(res.body, /Score breakdown/);
    assert.match(res.body, /Opportunity score/);
    assert.match(res.body, />70<\/span><span class="muted">\/100/);
    assert.match(res.body, /class="st q-meets_criteria q-big">Meets criteria/);
    assert.match(res.body, /Independent shop/);
    assert.match(res.body, /found at <a class="url" href="https:\/\/smithauto\.example\.com\/contact"/);
  });

  test("a disqualified prospect keeps its score, and the page shows both separately", async () => {
    const id = await createViaHttp(readyForm({ businessName: "Midas Downtown", signal_independent_shop: "no", signal_multiple_bays_or_staff: "yes" }));
    const detail = (await get(`/admin/prospects/${id}`)).body;
    assert.match(detail, /class="st q-disqualified q-big">Disqualified/);
    assert.match(detail, /Independent shop observed as “no”/);
    assert.match(detail, />60<\/span><span class="muted">\/100<\/span> <span class="pill band-high">High/);
    const list = (await get("/admin/prospects?qualification=disqualified")).body;
    assert.match(list, /Midas Downtown/);
    assert.match(list, /q-disqualified[\s\S]*band-high/);
    const refused = await post(`/admin/prospects/${id}/status`, { status: "qualified" });
    assert.equal(refused.statusCode, 400, "a high score can't qualify a disqualified shop");
  });

  test("user input is escaped everywhere it is shown", async () => {
    const id = await createViaHttp(readyForm({ businessName: `<script>alert(1)</script>"'` }));
    await post(`/admin/prospects/${id}/notes`, { body: "<img src=x onerror=alert(1)>" });
    for (const url of [`/admin/prospects/${id}`, "/admin/prospects", "/admin"]) {
      const res = await get(url);
      assert.doesNotMatch(res.body, /<script>alert|<img src=x/, url);
    }
    assert.match((await get(`/admin/prospects/${id}`)).body, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
  });

  test("an invalid create re-renders the form with errors and the entered values", async () => {
    const res = await post("/admin/prospects", readyForm({ businessName: "Keep Me", phoneSourceUrl: "" }));
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Not saved/);
    assert.match(res.body, /public URL where it is listed/);
    assert.match(res.body, /value="Keep Me"/);
  });

  test("edit form is prefilled, and saving recomputes the score", async () => {
    const id = await createViaHttp();
    const edit = await get(`/admin/prospects/${id}/edit`);
    assert.equal(edit.statusCode, 200);
    assert.match(edit.body, /name="signal_independent_shop" value="yes" checked/);
    assert.match(edit.body, /name="signal_has_website" value="yes" disabled/);

    const save = await post(`/admin/prospects/${id}`, readyForm({ signal_multiple_bays_or_staff: "yes" }));
    assert.equal(save.statusCode, 303);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id } })).score, 85);
  });

  test("status changes go through the rules and show on the page", async () => {
    const id = await createViaHttp();
    const skip = await post(`/admin/prospects/${id}/status`, { status: "contacted", reason: "" });
    assert.equal(skip.statusCode, 400);
    assert.match(skip.body, /Can&#39;t move from New to Contacted/);

    assert.equal((await post(`/admin/prospects/${id}/status`, { status: "qualified" })).statusCode, 303);
    assert.equal((await post(`/admin/prospects/${id}/status`, { status: "do_not_contact", reason: "Asked by email" })).statusCode, 303);

    const page = await get(`/admin/prospects/${id}`);
    assert.match(page.body, /can.t be changed here/);
    assert.doesNotMatch(page.body, /action="\/admin\/prospects\/[^"]+\/status"/, "no status form once do-not-contact");
    assert.match(page.body, /Asked by email/);

    const reopen = await post(`/admin/prospects/${id}/status`, { status: "new", reason: "try again" });
    assert.equal(reopen.statusCode, 400);
  });

  test("evidence and notes can be added; evidence removed", async () => {
    const id = await createViaHttp();
    const ev = await post(`/admin/prospects/${id}/evidence`, {
      signalKey: "digital_inspections",
      sourceUrl: `${WEBSITE}/services`,
      excerpt: "Every visit includes a digital inspection with photos.",
    });
    assert.equal(ev.statusCode, 303);
    const tooLong = await post(`/admin/prospects/${id}/evidence`, { signalKey: "digital_inspections", sourceUrl: WEBSITE, excerpt: "z".repeat(300) });
    assert.equal(tooLong.statusCode, 400);

    assert.equal((await post(`/admin/prospects/${id}/notes`, { body: "Prefers email." })).statusCode, 303);
    const page = await get(`/admin/prospects/${id}`);
    assert.match(page.body, /digital inspection with photos/);
    assert.match(page.body, /Prefers email\./);

    const evidence = await db.prospectEvidence.findFirstOrThrow({ where: { prospectId: id } });
    assert.equal((await post(`/admin/prospects/${id}/evidence/${evidence.id}/delete`, {})).statusCode, 303);
    assert.equal(await db.prospectEvidence.count(), 0);
  });

  test("list filters and unknown ids", async () => {
    await createViaHttp();
    await createViaHttp({ businessName: "Valley Motors", city: "Fresno", state: "CA" });
    const all = await get("/admin/prospects");
    assert.match(all.body, /Smith Auto/);
    assert.match(all.body, /Valley Motors/);
    const ca = await get("/admin/prospects?state=CA");
    assert.doesNotMatch(ca.body, /Smith Auto/);
    assert.match(ca.body, /Valley Motors/);
    assert.equal((await get(`/admin/prospects/${randomUUID()}`)).statusCode, 404);
    assert.equal((await get("/admin/prospects/not-a-uuid")).statusCode, 404);
  });

  test("Milestone 1 still works: referral events attribute to the prospect and appear in admin", async () => {
    const id = await createViaHttp();
    const { referralCode } = await db.prospect.findUniqueOrThrow({ where: { id } });
    const sessionId = randomUUID();
    const events = [
      { sessionId, ref: referralCode, event: "landing_view", campaign: "launch-v1", isSample: false, exportType: null },
      { sessionId, event: "scan_completed", isSample: false },
      { sessionId, event: "report_exported", isSample: false, exportType: "pdf" },
    ];
    for (const payload of events) {
      const res = await app.inject({ method: "POST", url: "/api/events", headers: { origin: "https://reclaimbay.com" }, payload });
      assert.equal(res.statusCode, 204);
    }
    const extra = await app.inject({ method: "POST", url: "/api/events", payload: { sessionId, event: "scan_completed", total: 5 } });
    assert.equal(extra.statusCode, 400, "allowlist still rejects extra fields");

    assert.equal(await db.productEvent.count({ where: { prospectId: id } }), 3);
    const funnel = await get("/admin");
    assert.match(funnel.body, new RegExp(`href="/admin/prospects/${id}"`));
    assert.match(funnel.body, /class="pill">High/);
    const detail = await get(`/admin/prospects/${id}`);
    assert.match(detail.body, /<dt>Real scans<\/dt><dd>1<\/dd>/);
    assert.match(detail.body, /<dt>Exports<\/dt><dd>1<\/dd>/);
    assert.equal((await get("/health", false)).statusCode, 200);
  });
});
