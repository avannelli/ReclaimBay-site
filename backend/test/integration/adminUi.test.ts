import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { createProspect } from "../../src/prospects.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";

const SECRET = "integration-test-secret-0123456789";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

describe("admin UI structure (HTTP)", { skip: skipReason }, () => {
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
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: form({ secret: SECRET }) });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, data: Record<string, string>) =>
    app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: form(data) });

  async function seed() {
    const p = await createProspect(db, readyForm({ businessName: "Structure Auto", website: "https://structure.example.com" }));
    const cand = await post("/admin/discovery/candidates", { businessName: "Candidate Garage", city: "Ojai", state: "CA" });
    const candId = /candidates\/([0-9a-f-]{36})/.exec(String(cand.headers.location))![1]!;
    return { prospectId: p.id, candId };
  }

  test("every signed-in page has one h1 (the page title), a skip link, one main landmark, and the current nav item", async () => {
    const { prospectId, candId } = await seed();
    const pages: [string, string, string][] = [
      ["/admin", "Funnel", "Funnel"],
      ["/admin/prospects", "Prospects", "Prospects"],
      ["/admin/prospects/new", "Add prospect", "Prospects"],
      [`/admin/prospects/${prospectId}`, "Structure Auto", "Prospects"],
      [`/admin/prospects/${prospectId}/edit`, "Edit Structure Auto", "Prospects"],
      ["/admin/discovery", "Discovery", "Discovery"],
      ["/admin/discovery/candidates/new", "Add candidate", "Discovery"],
      [`/admin/discovery/candidates/${candId}`, "Candidate Garage", "Discovery"],
      [`/admin/discovery/candidates/${candId}/edit`, "Research Candidate Garage", "Discovery"],
    ];
    for (const [url, h1, nav] of pages) {
      const res = await get(url);
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.body.match(/<h1[ >]/g)?.length, 1, `${url}: exactly one h1`);
      assert.match(res.body, new RegExp(`<h1>${h1}</h1>`), `${url}: h1 is the page title`);
      assert.match(res.body, /<a class="skip" href="#main">/, url);
      assert.equal(res.body.match(/<main /g)?.length, 1, url);
      assert.match(res.body, new RegExp(`<a href="[^"]+" aria-current="page">${nav}</a>`), `${url}: ${nav} is current`);
      assert.match(res.body, /<nav class="nav" aria-label="Admin sections">/, url);
      assert.match(res.body, /<form method="post" action="\/admin\/logout"><button/, url);
    }
  });

  test("the nav has Funnel, Prospects, and Discovery, and sign out", async () => {
    const body = (await get("/admin")).body;
    for (const [href, label] of [["/admin", "Funnel"], ["/admin/prospects", "Prospects"], ["/admin/discovery", "Discovery"]]) {
      assert.match(body, new RegExp(`<a href="${href}"[^>]*>${label}</a>`));
    }
    assert.match(body, />Sign out</);
  });

  test("the admin ships no scripts, inline handlers, or external resources", async () => {
    const { prospectId, candId } = await seed();
    for (const url of ["/admin", "/admin/prospects", `/admin/prospects/${prospectId}`, "/admin/discovery", `/admin/discovery/candidates/${candId}`, "/admin/prospects/new"]) {
      const res = await get(url);
      assert.doesNotMatch(res.body, /<script|javascript:|\son[a-z]+\s*=|<link |<img |@import/i, url);
      assert.doesNotMatch(res.body, /https?:\/\/(?!reclaimbay\.com|structure\.example\.com|directory\.example\.com)[a-z0-9.-]+\/[^"\s]*\.(js|css|woff2?|png)/i, url);
      assert.match(String(res.headers["content-security-policy"]), /default-src 'none'; style-src 'unsafe-inline'/, url);
    }
  });

  test("tables have captions and column headers, and stack into labelled cards on small screens", async () => {
    await seed();
    const body = (await get("/admin/prospects")).body;
    assert.match(body, /<caption class="sr-only">Prospects<\/caption>/);
    assert.match(body, /<th scope="col">Prospect<\/th>/);
    assert.match(body, /<table class="tbl cards">/);
    assert.match(body, /data-label="Opportunity score"/);
    assert.match(body, /data-label="Qualification"/);
  });

  test("the list makes qualification and score visibly different things", async () => {
    await seed();
    const body = (await get("/admin/prospects")).body;
    assert.match(body, /Qualification<br><span[^>]*>required criteria<\/span>/);
    assert.match(body, /Opportunity score<br><span[^>]*>research ranking<\/span>/);
    assert.match(body, /Opportunity score<\/b> is a research ranking, not a verdict/);
  });

  describe("forms show errors next to fields and keep what was typed", () => {
    test("create: summary links to fields, inline errors appear, values and choices survive", async () => {
      const res = await post("/admin/prospects", {
        ...readyForm({ businessName: "Keep Me", phoneSourceUrl: "", email: "nope", emailSourceUrl: "https://x.example.com", signal_no_online_booking: "no" }),
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /<div class="errbox" role="alert"/);
      assert.match(res.body, /<a href="#f-phoneSourceUrl">Phone needs the public URL where it is listed\.<\/a>/);
      assert.match(res.body, /<a href="#f-email">Email must be an email address\.<\/a>/);
      assert.match(res.body, /id="f-phoneSourceUrl"[^>]*aria-invalid="true"/);
      assert.match(res.body, /class="ferr" id="e-phoneSourceUrl">Phone needs the public URL/);
      assert.match(res.body, /value="Keep Me"/);
      assert.match(res.body, /value="nope"/);
      assert.match(res.body, /name="signal_independent_shop" value="yes" checked/);
      assert.equal(await db.prospect.count(), 0);
    });

    test("a signal consistency error appears on that signal's row", async () => {
      const res = await post("/admin/prospects", readyForm({ website: "", signal_no_online_booking: "no" }));
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /id="f-signal_no_online_booking"[\s\S]*?class="ferr">No online booking: can only be observed on a website/);
    });

    test("the signal checklist separates required criteria from opportunity signals, with Unknown first-class", async () => {
      const body = (await get("/admin/prospects/new")).body;
      assert.match(body, /Required qualification criteria/);
      assert.match(body, /Opportunity signals/);
      assert.equal(body.match(/<span class="kind req">Required criterion<\/span>/g)?.length, 2);
      assert.equal(body.match(/<span class="kind">Opportunity signal<\/span>/g)?.length, 7);
      assert.equal(body.match(/<span>Unknown<\/span>/g)?.length, 9, "every signal offers Unknown");
      assert.match(body, /<summary>View rules<\/summary>/);
      assert.match(body, /\+25/);
    });

    test("the six workflow steps are present on create and edit alike", async () => {
      const { prospectId } = await seed();
      for (const url of ["/admin/prospects/new", `/admin/prospects/${prospectId}/edit`]) {
        const body = (await get(url)).body;
        for (const step of ["Business", "Location", "Public business contact", "Required qualification criteria", "Opportunity signals", "Review and save"]) {
          assert.match(body, new RegExp(`</span>${step}</legend>`), `${url}: ${step}`);
        }
        assert.match(body, /Only record contact information publicly published by the business itself\./, url);
      }
    });

    test("editing a Qualified or Ready to contact prospect explains the status gate", async () => {
      const p = await createProspect(db, readyForm({ businessName: "Gated Auto", website: "https://gated.example.com" }));
      await post(`/admin/prospects/${p.id}/status`, { status: "qualified" });
      assert.match((await get(`/admin/prospects/${p.id}/edit`)).body, /This prospect is <b>Qualified<\/b>\. A save is refused if/);
      await post(`/admin/prospects/${p.id}/status`, { status: "ready_to_contact" });
      const body = (await get(`/admin/prospects/${p.id}/edit`)).body;
      assert.match(body, /This prospect is <b>Ready to contact<\/b>/);
      assert.match(body, /remove the public phone or email together with its source URL/);
      const fresh = await createProspect(db, readyForm({ businessName: "Fresh Auto", website: "https://fresh.example.com" }));
      assert.doesNotMatch((await get(`/admin/prospects/${fresh.id}/edit`)).body, /A save is refused if/);
    });

    test("evidence, note, and status errors appear beside their own form", async () => {
      const p = await createProspect(db, readyForm({ businessName: "Errors Auto", website: "https://errors.example.com" }));
      const ev = await post(`/admin/prospects/${p.id}/evidence`, { signalKey: "", sourceUrl: "nope", excerpt: "z".repeat(400) });
      assert.equal(ev.statusCode, 400);
      assert.match(ev.body, /class="ferr">Choose the signal this evidence supports\./);
      assert.match(ev.body, /id="f-sourceUrl"[^>]*aria-invalid="true"/);
      assert.match(ev.body, /class="ferr">Excerpt is 400 characters/);
      const note = await post(`/admin/prospects/${p.id}/notes`, { body: "  " });
      assert.match(note.body, /class="ferr">Note can&#39;t be empty/);
      const st = await post(`/admin/prospects/${p.id}/status`, { status: "contacted" });
      assert.equal(st.statusCode, 400);
      assert.match(st.body, /class="ferr">Can&#39;t move from New to Contacted/);
    });
  });

  describe("prospect detail: research workspace", () => {
    test("sections follow the workflow, and only valid next statuses are offered", async () => {
      const p = await createProspect(db, readyForm({ businessName: "Flow Auto", website: "https://flow.example.com" }));
      const body = (await get(`/admin/prospects/${p.id}`)).body;
      const order = ["business", "activity", "score", "status", "evidence", "notes"].map((id) => body.indexOf(`id="${id}-h"`));
      assert.ok(order.every((i) => i > 0), "every section is present");
      assert.deepEqual([...order].sort((a, b) => a - b), order, "sections appear in workflow order");
      assert.match(body, /<a class="btn btn-secondary" href="#status">Change status<\/a>/);
      assert.match(body, /<a class="btn" href="\/admin\/prospects\/[0-9a-f-]+\/edit">Edit<\/a>/);
      const options = /<select id="f-status"[\s\S]*?<\/select>/.exec(body)![0];
      assert.deepEqual([...options.matchAll(/value="([a-z_]+)"/g)].map((m) => m[1]), ["qualified", "not_a_fit", "do_not_contact", "archived"]);
      assert.match(body, /<ol class="steps" aria-label="Pipeline progress">/);
      assert.match(body, /<li class="now" aria-current="step">New/);
    });

    test("the Qualification and Opportunity cards are separate and say what they are", async () => {
      const p = await createProspect(db, readyForm({ businessName: "Cards Auto", website: "https://cards.example.com" }));
      const body = (await get(`/admin/prospects/${p.id}`)).body;
      assert.match(body, /v-label">Qualification<\/div>/);
      assert.match(body, /Required criteria: Independent shop and Offers general repair/);
      assert.match(body, /v-label">Opportunity score<\/div>/);
      assert.match(body, /Opportunity score · ranking only, not a verdict/);
      assert.match(body, /A high score does not mean the business is qualified\./);
    });

    test("empty states are explicit for evidence and notes", async () => {
      const p = await createProspect(db, { businessName: "Bare Auto" });
      const body = (await get(`/admin/prospects/${p.id}`)).body;
      assert.match(body, /No evidence recorded yet\./);
      assert.match(body, /No research notes yet\./);
    });

    test("a do-not-contact prospect shows no status form", async () => {
      const p = await createProspect(db, { businessName: "Closed Auto" });
      await post(`/admin/prospects/${p.id}/status`, { status: "do_not_contact", reason: "Asked not to be contacted" });
      const body = (await get(`/admin/prospects/${p.id}`)).body;
      assert.doesNotMatch(body, /action="\/admin\/prospects\/[^"]+\/status"/);
      assert.match(body, /The status is permanent and can&#39;t be changed here\.|can't be changed here/);
    });
  });

  describe("empty and filtered states", () => {
    test("no prospects, no candidates, no runs, no activity", async () => {
      assert.match((await get("/admin/prospects")).body, /No prospects yet\.[\s\S]*Add your first prospect to begin building the research pipeline\./);
      const discovery = (await get("/admin/discovery")).body;
      assert.match(discovery, /No candidates to review\./);
      assert.match(discovery, /No discovery runs yet\./);
      assert.match((await get("/admin")).body, /No prospect activity yet\./);
    });

    test("filters with no matches say so and offer a way out", async () => {
      await seed();
      const prospects = (await get("/admin/prospects?q=zzzzzz")).body;
      assert.match(prospects, /No prospects match these filters\./);
      assert.match(prospects, /Try clearing a filter or changing your search\./);
      assert.match(prospects, /href="\/admin\/prospects">Clear filters/);
      const discovery = (await get("/admin/discovery?q=zzzzzz")).body;
      assert.match(discovery, /No candidates match these filters\./);
    });

    test("status chips show counts and mark the active filter", async () => {
      await seed();
      const body = (await get("/admin/prospects?status=new")).body;
      assert.match(body, /<a class="chip" href="\/admin\/prospects\?status=new" aria-current="true">New <span class="n">1<\/span><\/a>/);
      assert.match(body, /<a class="chip" href="\/admin\/prospects">All <span class="n">1<\/span><\/a>/);
    });

    test("the funnel points at what needs attention", async () => {
      await seed();
      await db.discoveryCandidate.updateMany({ data: { status: "needs_review" } });
      const body = (await get("/admin")).body;
      assert.match(body, /<a class="attn-item" href="\/admin\/discovery\?status=needs_review"><b>1<\/b><span>candidate needs review<\/span>/);
      assert.match(body, /<a class="attn-item" href="\/admin\/prospects\?status=new"><b>1<\/b><span>new prospect to research<\/span>/);
    });

    test("sample-only activity is labelled, not counted as real", async () => {
      const p = await createProspect(db, readyForm({ businessName: "Sample Auto", website: "https://sample.example.com" }));
      const session = await db.analyticsSession.create({ data: { anonymousSessionId: randomUUID(), prospectId: p.id } });
      await db.productEvent.create({ data: { sessionId: session.id, prospectId: p.id, eventType: "scan_completed", isSample: true } });
      const body = (await get("/admin")).body;
      assert.match(body, /Sample activity only/);
      assert.match(body, /\+1 sample/);
      assert.match(body, /data-label="Real scans"><span class="muted">0<\/span>/);
    });
  });

  describe("discovery pages", () => {
    test("runs are openable, and a run's candidates can be listed", async () => {
      await post("/admin/discovery/runs", { provider: "fixture", region: "Ventura County, CA" });
      const run = await db.discoveryRun.findFirstOrThrow();
      const page = (await get("/admin/discovery")).body;
      assert.match(page, new RegExp(`href="/admin/discovery\\?run=${run.id}">Open candidates</a>`));
      const filtered = (await get(`/admin/discovery?run=${run.id}`)).body;
      assert.match(filtered, /Showing candidates from one discovery run/);
      assert.match(filtered, /Conejo Valley Auto Care/);
      const other = (await get(`/admin/discovery?run=${randomUUID()}`)).body;
      assert.match(other, /No candidates match these filters\./);
      assert.match((await get("/admin/discovery?run=not-a-uuid")).body, /Conejo Valley Auto Care/, "an invalid run id is ignored");
    });

    test("needs-review candidates are visibly distinct and labelled Review", async () => {
      await post("/admin/discovery/runs", { provider: "fixture", region: "Ventura County, CA" });
      const body = (await get("/admin/discovery")).body;
      assert.match(body, /<tr class="attn">/);
      assert.match(body, /class="st cs-needs_review">Needs review/);
      assert.match(body, /<a class="chip attn"/);
      assert.match(body, />Review<\/a>/);
    });

    test("candidate detail is organized by the research questions, and says it is not a prospect", async () => {
      await post("/admin/discovery/runs", { provider: "fixture", region: "Ventura County, CA" });
      const c = await db.discoveryCandidate.findFirstOrThrow({ where: { externalId: "fx-1001" } });
      const body = (await get(`/admin/discovery/candidates/${c.id}`)).body;
      const order = ["duplicates", "know", "dont-know", "evidence", "state", "approval", "notes"].map((id) => body.indexOf(`id="${id}-h"`));
      assert.ok(order.every((i) => i > 0), "every section is present");
      assert.deepEqual([...order].sort((a, b) => a - b), order, "sections appear in order");
      assert.match(body, /Candidate, not a prospect/);
      assert.match(body, /class="st cs-discovered">Discovered/);
      assert.match(body, /<span class="obs obs-unknown">Unknown<\/span>/);
      assert.match(body, /No duplicate flags/);
    });

    test("approval copy states what approval does and does not do", async () => {
      const add = await post("/admin/discovery/candidates", { businessName: "Approve Me", website: "https://approve.example.com", city: "Ojai", state: "CA" });
      const id = /candidates\/([0-9a-f-]{36})/.exec(String(add.headers.location))![1]!;
      await post(`/admin/discovery/candidates/${id}`, readyForm({ businessName: "Approve Me", website: "https://approve.example.com", city: "Ojai", state: "CA", signal_digital_inspections: "unknown", signal_no_online_booking: "unknown" }));
      await post(`/admin/discovery/candidates/${id}/status`, { status: "researching" });
      for (const signalKey of ["independent_shop", "general_repair_services"]) {
        await post(`/admin/discovery/candidates/${id}/evidence`, { signalKey, sourceUrl: "https://approve.example.com/a", excerpt: "Public page." });
      }
      await post(`/admin/discovery/candidates/${id}/status`, { status: "researched" });
      const body = (await get(`/admin/discovery/candidates/${id}`)).body;
      assert.match(body, /Approve candidate → create prospect/);
      assert.match(body, /Approval adds this business to the prospect pipeline\. It does not automatically qualify the business or mark it ready to contact\./);
    });
  });
});
