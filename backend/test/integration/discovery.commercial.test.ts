import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { applyDiscoveryAutomation, applyDiscoveryBatch, discoveryAutomationPreview, executable } from "../../src/discovery/automation.js";
import { approveCandidate, getCandidateDetail, reviewQueue, runAutoApproval } from "../../src/discovery/service.js";
import { discoveryAutomationPage } from "../../src/admin/discoveryAutomationViews.js";
import { candidateProtection, protectionIndex } from "../../src/discovery/protection.js";
import { assessAcquisition } from "../../src/discovery/acquisition.js";
import { automationInclude } from "../../src/discovery/automationPolicy.js";
import { commercialCandidate } from "../../src/discovery/commercial.js";
import { COMMERCIAL_QUOTES_PER_RUN } from "../../src/policies/reclaimbay/commercial.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import { runAutoResearch, enqueueResearch, processResearch } from "../../src/research/service.js";
import { fixtureWeb, independentShop } from "../fixtures/researchSite.js";
import { freshDb, skipReason, truncate, TEST_DATABASE_URL } from "./helpers.js";

const DEFAULT_TEXT = "We are family-owned. Our car repair services include engine repair and brake repair.";
const DEFAULT_EVIDENCE = "Our car repair services include engine repair and brake repair.";
const OVERRIDE = "Owner confirmed passenger-car repair is most of its work; the trailer page is a side line.";

/** A candidate whose latest run is a current-rules read of its own verified location. */
async function makeCandidate(db: Db, seq: number, extra: Record<string, unknown> = {}, text = DEFAULT_TEXT, opts: { evidence?: string; ownership?: string } = {}) {
  const c = await db.discoveryCandidate.create({ data: { businessName: "Neighborhood Service", nameKey: "neighborhood service", provider: "manual",
    city: "Ventura", state: "CA", streetAddress: `${seq} Main St`, website: `https://commercial${seq}.example.com/`, status: "researched",
    categoryVerdict: "in_target", categorySource: "website", websiteVerifiedAt: new Date(), ...extra } });
  const run = await db.candidateResearch.create({ data: { candidateId: c.id, version: RESEARCH_VERSION, status: "completed", outcome: "website_verified", trigger: "cli", subjectWebsite: c.website, warnings: [] } });
  const source = await db.researchSource.create({ data: { researchId: run.id, kind: "website", url: c.website!, ok: true } });
  for (const [field, value, excerpt] of [["location_identity", "verified_location", null], ["ownership_class", opts.ownership ?? "independent", null], ["site_locations", "1", null],
    ["page_location", "own_location", null], ["commercial_quote", "observed", text], ["email", `service@commercial${seq}.example.com`, null]] as const)
    await db.researchFact.create({ data: { researchId: run.id, field, value, excerpt, state: "verified", sourceId: source.id } });
  await db.candidateSignal.create({ data: { candidateId: c.id, key: "automotive_repair_services", value: "yes", origin: "research" } });
  const evidence = await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "automotive_repair_services", sourceUrl: source.url,
    excerpt: opts.evidence ?? (text.includes("trailer") ? "Our trailer brake replacement services." : DEFAULT_EVIDENCE), origin: "research", researchId: run.id } });
  return { c, run, source, evidence };
}

describe("commercial Discovery integration and creation boundaries", { skip: skipReason }, () => {
  let db: Db, sequence = 0;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); });
  after(async () => { await db?.$disconnect(); });
  const candidate = (extra: Record<string, unknown> = {}, text = DEFAULT_TEXT, opts: { evidence?: string; ownership?: string } = {}) => makeCandidate(db, ++sequence, extra, text, opts);
  const plan = async (id: string) => (await discoveryAutomationPreview(db)).rows.find(r => r.id === id)!;
  const intact = async () => Promise.all(["Prospect", "ProspectNote", "ProspectSignal", "ProspectEvidence", "Outreach", "OutreachEvent", "OutreachCampaign", "OutreachCampaignMessage", "OutreachReply", "Invitation", "EmailSuppression", "EmailedUnsubscribeReview", "OutreachControlChange"].map(t => db.$queryRawUnsafe(`SELECT row_to_json(t)::text FROM "${t}" t ORDER BY row_to_json(t)::text`)));
  /** Everything automation can do on its own: an Admin batch of every executable row, then the scheduled worker. */
  const runAllAutomation = async () => {
    const preview = await discoveryAutomationPreview(db);
    const batch = preview.rows.filter(r => executable(r.assessment) && r.assessment.action !== "research").map(r => ({ id: r.id, token: r.token }));
    if (batch.length) await applyDiscoveryBatch(db, batch);
    await runAutoResearch(db, { enabled: true, databaseUrl: TEST_DATABASE_URL, limit: 25 });
  };

  test("technical fit, commercial fit and eligibility remain distinct; no creator runs", async () => {
    const { c } = await candidate(); const r = await plan(c.id);
    assert.equal(r.assessment.acquisition!.technicalQualification, "meets_criteria");
    assert.equal(r.assessment.acquisition!.commercial.disposition, "fit");
    assert.equal(r.assessment.acquisition!.commercial.confidence, "high");
    assert.equal(r.assessment.acquisition!.eligibleForAutonomousProspecting, false, "missing stored recipient remains a separate gate");
    assert.equal(r.assessment.acquisition!.prospectCreationEnabled, false);
    const before = await intact();
    assert.equal((await applyDiscoveryAutomation(db, c.id, { allowResearch: true })).applied, false);
    await runAutoApproval(db, { apply: true });
    await runAutoResearch(db, { enabled: true, databaseUrl: TEST_DATABASE_URL, limit: 1 });
    assert.deepEqual(await intact(), before);
    await assert.rejects(approveCandidate(db, c.id, { automatic: true }), /person must approve/);
  });
  test("all future candidate gates can pass while creation still stays explicitly disabled", async () => {
    const { c, source } = await candidate();
    const email = (await db.researchFact.findFirstOrThrow({ where: { researchId: source.researchId, field: "email" } })).value!;
    await db.discoveryCandidate.update({ where: { id: c.id }, data: { email, emailSourceUrl: source.url } });
    const a = (await plan(c.id)).assessment.acquisition!;
    assert.equal(a.eligibleForAutonomousProspecting, true); assert.equal(a.requiresHumanApproval, true); assert.equal(a.prospectCreationEnabled, false);
    assert.equal(await db.prospect.count(), 0); assert.equal(await db.outreach.count(), 0);
  });
  test("a commercial exclusion is sourced and explainable, but held for a person: batches and scheduled automation never reject it", async () => {
    const { c, evidence, run } = await candidate({ businessName: "Harbor Trailer Fabrication" }, "We only repair trailers and install hitches with welding.");
    const r = await plan(c.id);
    assert.equal(r.assessment.action, "human"); assert.equal(executable(r.assessment), false);
    assert.equal(r.assessment.acquisition!.commercial.disposition, "exclude");
    assert.ok(r.assessment.acquisition!.commercial.findings[0]!.evidence[0]!.factId);
    const before = await intact(); const original = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal((await applyDiscoveryBatch(db, [{ id: c.id, token: r.token }]))[0]!.applied, false);
    await runAllAutomation();
    await runAutoApproval(db, { apply: true });
    assert.deepEqual(await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } }), original);
    assert.equal(await db.candidateNote.count({ where: { candidateId: c.id } }), 0);
    assert.deepEqual(await db.candidateEvidence.findUniqueOrThrow({ where: { id: evidence.id } }), evidence);
    assert.deepEqual(await db.candidateResearch.findUniqueOrThrow({ where: { id: run.id } }), run);
    assert.deepEqual(await intact(), before);
  });
  test("ICP matrix: dealer, manufacturer, chain and tire retail are held for a person; specialty, collision, hybrid and mechanical shops are Ready", async () => {
    const held = {
      dealer: await candidate({}, "We are a dealership service center.", { ownership: "dealership" }),
      dealerQuoteOnly: await candidate({}, "We are a dealership.", { evidence: "Names brakes: Brake repair for all makes." }),
      manufacturer: await candidate({}, "Factory-trained manufacturer service.", { ownership: "manufacturer" }),
      chain: await candidate({}, "Proud to be part of a franchise network.", { ownership: "chain" }),
      nationalTire: await candidate({}, "We are a nationwide tire retail chain."),
      regionalTire: await candidate({}, "Family tire stores with 3 locations.", { ownership: "regional" }),
    };
    const ready = {
      specialty: await candidate({ businessName: "Harbor Transmission" }, "We are family-owned. We specialize in transmission repair.", { evidence: "Names transmission/drivetrain: We specialize in transmission repair and transmission rebuilds." }),
      passengerOnlySpecialty: await candidate({ businessName: "Harbor Transmission" }, "We only repair cars and light trucks, no RVs or motorcycles.", { evidence: "Names transmission/drivetrain: We specialize in transmission repair and transmission rebuilds." }),
      collision: await candidate({ businessName: "Harbor Collision Center" }, "We are family-owned. Free estimates on all collision repairs. We only paint with factory-matched colors.", { evidence: "Names collision/body: We provide collision repair and auto body work." }),
      hybrid: await candidate({}, DEFAULT_TEXT, { evidence: "We provide collision repair, brake repair and engine repair." }),
      mechanical: await candidate(),
    };
    for (const [name, { c }] of Object.entries(held)) {
      const r = await plan(c.id);
      assert.equal(r.assessment.action, "human", `${name}: ${r.assessment.code} ${r.assessment.reason}`);
      assert.equal(executable(r.assessment), false, name);
      assert.notEqual(r.assessment.acquisition!.commercial.disposition, "fit", name);
    }
    for (const [name, { c }] of Object.entries(ready)) {
      const r = await plan(c.id);
      assert.equal(r.assessment.action, "ready", `${name}: ${r.assessment.code} ${r.assessment.reason}`);
      assert.equal(r.assessment.acquisition!.commercial.disposition, "fit", name);
    }
    const before = await intact();
    await runAllAutomation();
    await runAutoApproval(db, { apply: true });
    assert.equal(await db.discoveryCandidate.count({ where: { status: { not: "researched" } } }), 0, "nothing was rejected or approved automatically");
    assert.deepEqual(await intact(), before);
  });
  test("a person approves a commercial exclusion only with a recorded reason; the override is append-only on candidate and prospect", async () => {
    const { c } = await candidate({}, "We operate a tire retail chain with multiple stores.");
    assert.equal((await plan(c.id)).assessment.acquisition!.commercial.disposition, "exclude");
    await assert.rejects(approveCandidate(db, c.id), /commercial override reason/);
    await assert.rejects(approveCandidate(db, c.id, { commercialOverrideReason: "   " }), /commercial override reason/);
    await assert.rejects(approveCandidate(db, c.id, { commercialOverrideReason: "too short" }), /10 to 500 characters/);
    assert.equal(await db.prospect.count(), 0);
    const notesBefore = await db.candidateNote.findMany({ where: { candidateId: c.id } });
    const { prospect } = await approveCandidate(db, c.id, { commercialOverrideReason: `  ${OVERRIDE}  ` });
    assert.equal(await db.prospect.count(), 1); assert.equal(await db.outreach.count(), 0);
    const candidateNotes = await db.candidateNote.findMany({ where: { candidateId: c.id }, orderBy: { id: "asc" } });
    assert.deepEqual(candidateNotes.slice(0, notesBefore.length), notesBefore, "earlier notes untouched");
    const override = candidateNotes.map(n => JSON.parse(n.body) as Record<string, unknown>).find(n => n.type === "commercial_override")!;
    assert.equal(override.reason, OVERRIDE); assert.equal(override.action, "human_override"); assert.equal(override.disposition, "exclude");
    assert.equal(override.rules, "reclaimbay.commercial@v1"); assert.deepEqual(override.codes, ["commercial.multi_store_tire_retail"]);
    const prospectNotes = (await db.prospectNote.findMany({ where: { prospectId: prospect.id } })).map(n => n.body);
    assert.ok(prospectNotes.some(n => n.includes('"type":"commercial_override"') && n.includes(OVERRIDE)));
    assert.ok(prospectNotes.some(n => n.includes('"action":"human_override"') && n.includes('"references":')));
  });
  test("a commercial override never lifts duplicate, existing-account or evidence requirements", async () => {
    const excluded = "We only repair trailers.";
    const dup = await candidate({}, excluded);
    await db.discoveryCandidate.create({ data: { businessName: "Neighbor", nameKey: "neighbor", provider: "manual", possibleDuplicateCandidateId: dup.c.id, duplicateHold: true, status: "needs_review" } });
    await assert.rejects(approveCandidate(db, dup.c.id, { commercialOverrideReason: OVERRIDE }), /Unresolved possible/);
    const account = await candidate({ website: "https://brand.example.com/ventura" }, excluded);
    await db.prospect.create({ data: { referralCode: "existing-account", businessName: "Brand Other Location", website: "https://brand.example.com/simi", city: "Simi Valley", state: "CA" } });
    await assert.rejects(approveCandidate(db, account.c.id, { commercialOverrideReason: OVERRIDE }), /already has a Prospect\/account/);
    const unsourced = await candidate({}, excluded);
    await db.candidateEvidence.delete({ where: { id: unsourced.evidence.id } });
    await assert.rejects(approveCandidate(db, unsourced.c.id, { commercialOverrideReason: OVERRIDE }));
    assert.equal(await db.prospect.count(), 1, "only the pre-existing account Prospect");
    for (const { c } of [dup, account, unsourced]) assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "researched");
  });
  test("a successful explicit human approval remains the sole candidate creator and retains its assessment", async () => {
    const { c } = await candidate();
    const approved = await approveCandidate(db, c.id);
    assert.equal(await db.prospect.count(), 1); assert.equal(await db.outreach.count(), 0);
    const notes = await db.prospectNote.findMany({ where: { prospectId: approved.prospect.id } });
    assert.ok(notes.some(n => n.body.includes('"action":"human_approve"') && n.body.includes('"references":')));
    assert.ok(!notes.some(n => n.body.includes('"type":"commercial_override"')), "no override when none was needed");
  });
  test("inbound duplicate ambiguity blocks Ready, future eligibility and human creation", async () => {
    const { c } = await candidate();
    await db.discoveryCandidate.create({ data: { businessName: "Neighbor", nameKey: "neighbor", provider: "manual", possibleDuplicateCandidateId: c.id, duplicateHold: true, status: "needs_review" } });
    const r = await plan(c.id); assert.equal(r.assessment.action, "human"); assert.equal(r.assessment.acquisition!.gates.account.pass, false);
    await assert.rejects(approveCandidate(db, c.id), /Unresolved possible/);
  });
  test("legitimate same-brand locations cannot become independent accounts twice", async () => {
    const { c: a } = await candidate({ website: "https://brand.example.com/ventura" });
    const { c: b } = await candidate({ website: "https://brand.example.com/simi", city: "Simi Valley" });
    assert.equal((await plan(a.id)).assessment.code, "account_review"); assert.equal((await plan(b.id)).assessment.code, "account_review");
    await approveCandidate(db, a.id);
    await assert.rejects(approveCandidate(db, b.id), /already has a Prospect\/account/);
    assert.equal(await db.prospect.count(), 1);
    assert.equal((await plan(b.id)).assessment.acquisition!.gates.account.pass, false);
  });
  test("concurrent human approvals of two locations create at most one account", async () => {
    const { c: a } = await candidate({ website: "https://brand.example.com/ventura" });
    const { c: b } = await candidate({ website: "https://brand.example.com/simi", city: "Simi Valley" });
    const results = await Promise.allSettled([approveCandidate(db, a.id), approveCandidate(db, b.id)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(await db.prospect.count(), 1);
  });
  for (const status of ["draft", "queued", "sent", "replied"] as const) test(`outreach ${status} protects even a commercially excluded candidate`, async () => {
    const { c } = await candidate({}, "We only repair trailers.");
    const p = await db.prospect.create({ data: { referralCode: "protected-" + status, businessName: c.businessName, website: c.website, city: c.city, state: "CA" } });
    await db.outreach.create({ data: { prospectId: p.id, kind: "initial", template: "fixture", subject: "Preserve", body: "Preserve", evidence: [], generatedAt: new Date(), recipientEmail: "office@example.com", recipientSourceUrl: c.website!, status } });
    const before = await intact(); const original = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal((await plan(c.id)).assessment.action, "protected"); assert.equal((await applyDiscoveryAutomation(db, c.id, { allowResearch: true })).applied, false);
    await assert.rejects(approveCandidate(db, c.id, { commercialOverrideReason: OVERRIDE }), /existing prospect matches|already has a Prospect/);
    assert.deepEqual(await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } }), original);
    assert.deepEqual(await intact(), before);
  });
  test("a protected Prospect without outreach still cannot be processed", async () => {
    const { c } = await candidate({}, "We only repair trailers.");
    await db.prospect.create({ data: { referralCode: "quiet-protected", businessName: c.businessName, website: c.website, city: c.city, state: "CA" } });
    assert.equal((await applyDiscoveryAutomation(db, c.id)).applied, false);
  });
  test("failed source or other-location evidence cannot establish commercial exclusion", async () => {
    for (const mode of ["failed", "other_location"] as const) {
      const { c, source } = await candidate({}, "We only repair trailers.");
      if (mode === "failed") await db.researchSource.update({ where: { id: source.id }, data: { ok: false } });
      else await db.researchFact.updateMany({ where: { researchId: source.researchId, field: "page_location" }, data: { value: "other_location" } });
      const r = await plan(c.id);
      assert.notEqual(r.assessment.action, "reject"); assert.notEqual(r.assessment.acquisition!.commercial.disposition, "exclude");
    }
  });
  test("earlier stronger normal repair contradicts a newer scope exclusion", async () => {
    const { c, run, evidence } = await candidate();
    await db.candidateResearch.update({ where: { id: run.id }, data: { queuedAt: new Date("2020-01-01") } });
    const newer = await db.candidateResearch.create({ data: { candidateId: c.id, version: RESEARCH_VERSION, status: "completed", outcome: "website_verified", trigger: "cli", subjectWebsite: c.website, warnings: [] } });
    const source = await db.researchSource.create({ data: { researchId: newer.id, kind: "website", url: c.website!, ok: true } });
    for (const [field, value, excerpt] of [["location_identity", "verified_location", null], ["page_location", "own_location", null], ["commercial_quote", "observed", "We only repair trailers."]] as const)
      await db.researchFact.create({ data: { researchId: newer.id, sourceId: source.id, field, value, excerpt, state: "verified" } });
    const row = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: automationInclude });
    const r = commercialCandidate(row); assert.equal(r.disposition, "review"); assert.ok(r.findings.some(f => f.code === "commercial.historical_conflict"));
    assert.notEqual((await plan(c.id)).assessment.action, "reject");
    assert.deepEqual(await db.candidateEvidence.findUniqueOrThrow({ where: { id: evidence.id } }), evidence);
  });
  test("scheduled fixture research retains commercial quotes but creates no Prospect or outreach", async () => {
    const c = await db.discoveryCandidate.create({ data: { businessName: "Saviers Road Auto Repair", nameKey: "saviers road auto repair", provider: "manual", website: "https://saviersauto.example.com/", providerPhone: "8055550101", streetAddress: "5577 Saviers Rd" } });
    const web = fixtureWeb(independentShop());
    const queued = await enqueueResearch(db, [c.id], "scheduled");
    await processResearch(db, queued.queued[0]!.researchId, { makeFetcher: web.makeFetcher });
    const facts = await db.researchFact.findMany({ where: { research: { candidateId: c.id } } });
    const quotes = facts.filter(f => f.field === "commercial_quote").map(f => f.excerpt);
    assert.ok(quotes.some(q => /Family owned and operated/.test(q ?? "")), "the ownership claim is kept with its source");
    assert.ok(quotes.length <= COMMERCIAL_QUOTES_PER_RUN); assert.equal(new Set(quotes).size, quotes.length, "each quote kept once per run");
    assert.ok(facts.filter(f => f.field === "commercial_quote").every(f => f.sourceId), "every quote points at its source");
    // R16.1: "© 2025 Saviers Road Auto Repair" is not a second location.
    assert.equal(facts.find(f => f.field === "site_locations")?.value, "1");
    assert.equal(facts.find(f => f.field === "ownership_class")?.value, "independent");
    assert.equal(await db.prospect.count(), 0); assert.equal(await db.outreach.count(), 0);
  });
  test("CLI compatibility apply and preview have no candidate-to-Prospect path", async () => {
    const { c } = await candidate();
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL, RESEARCH_AUTORUN_ENABLED: "0", OUTREACH_SENDING_ENABLED: "0" };
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/scripts/autoApprove.ts", "--apply", "--candidate", c.id], { cwd: root, env, stdio: "pipe" });
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/scripts/discoveryAutomation.ts"], { cwd: root, env, stdio: "pipe" });
    assert.equal(await db.prospect.count(), 0); assert.equal(await db.outreach.count(), 0);
  });
  test("preview, detail and Ready queue share the same policy; stale preview holds", async () => {
    const { c, run, source } = await candidate(); const before = await plan(c.id);
    assert.deepEqual((await getCandidateDetail(db, c.id))!.acquisition.commercial, before.assessment.acquisition!.commercial);
    assert.ok((await reviewQueue(db, {}, "ready")).items.some(i => i.candidate.id === c.id));
    assert.match(discoveryAutomationPage(await discoveryAutomationPreview(db), false), /Commercial: fit/);
    await db.researchFact.create({ data: { researchId: run.id, field: "commercial_quote", value: "observed", state: "verified", sourceId: source.id,
      excerpt: "We only repair trailers." } });
    const row = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: automationInclude });
    const protection = candidateProtection(row, await protectionIndex(db));
    assert.equal(assessAcquisition(row, protection).prospectCreationEnabled, false);
    await assert.rejects(applyDiscoveryAutomation(db, c.id, { token: before.token }), /changed/);
  });
});

describe("commercial override in the admin (HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  let db: Db, app: FastifyInstance, cookie = "", sequence = 1000;
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }), db, false);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => { await app?.close(); await db?.$disconnect(); });
  const post = (url: string, data: Record<string, string>) => app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: new URLSearchParams(data).toString() });

  test("the candidate page offers a reasoned override; approving without a reason is refused, with one creates the Prospect", async () => {
    const { c } = await makeCandidate(db, ++sequence, {}, "We only repair trailers.", { evidence: "Names brakes: Brake repair for cars." });
    const page = (await app.inject({ method: "GET", url: `/admin/discovery/candidates/${c.id}`, headers: { cookie } })).body;
    assert.match(page, /Commercial fit: exclude/); assert.match(page, /name="commercialOverrideReason"/);
    const refused = await post(`/admin/discovery/candidates/${c.id}/approve`, {});
    assert.equal(refused.statusCode, 400); assert.match(refused.body, /commercial override reason/);
    assert.equal(await db.prospect.count(), 0);
    const approved = await post(`/admin/discovery/candidates/${c.id}/approve`, { commercialOverrideReason: OVERRIDE });
    assert.equal(approved.statusCode, 303, approved.body); assert.match(String(approved.headers.location), /^\/admin\/prospects\//);
    assert.equal(await db.prospect.count(), 1); assert.equal(await db.outreach.count(), 0);
    assert.ok((await db.candidateNote.findMany({ where: { candidateId: c.id } })).some(n => n.body.includes(OVERRIDE)));
  });
  test("a commercially fit candidate shows no override form", async () => {
    const { c } = await makeCandidate(db, ++sequence);
    const page = (await app.inject({ method: "GET", url: `/admin/discovery/candidates/${c.id}`, headers: { cookie } })).body;
    assert.match(page, /Commercial fit: fit/); assert.doesNotMatch(page, /name="commercialOverrideReason"/);
  });
});
