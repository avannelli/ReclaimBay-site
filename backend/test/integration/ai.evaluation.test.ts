import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { COLLISION_FIT_KIND, COLLISION_FIT_PROMPT_VERSION } from "../../src/ai/collisionFitJudge.js";
import { evaluateCohort } from "../../src/ai/evaluation.js";
import { AiEvalError, adjudicateLabel, blindLabel, createCohort, planCohort } from "../../src/ai/goldSet.js";
import type { AiProvider, CompletionRequest } from "../../src/ai/provider.js";
import { runAiShadow } from "../../src/ai/shadow.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { fixtureWeb, page } from "../fixtures/researchSite.js";
import { TEST_DATABASE_URL, freshDb, skipReason, truncate } from "./helpers.js";

/*
 * Blind gold-set evaluation against a disposable PostgreSQL: cohorts, blind
 * labels, adjudication, the evaluation joins, and the blinded admin pages.
 * Fixture websites and a fake provider only: no network, no real AI.
 */

const SECRET = "integration-test-secret-0123456789";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const QUOTE = "We provide collision repair and auto body repair for all makes.";
const WARN_SPECIALTY = "Dealership or specialty collision/body services require human verification before qualification.";

type Kind = "verify" | "specialty" | "auto_approved" | "auto_rejected" | "person" | "approved_by_person" | "ineligible";

describe("blind gold-set evaluation (local PostgreSQL)", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  const originalFetch = globalThis.fetch;
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }), db, false);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => {
    await truncate(db);
    globalThis.fetch = (async () => {
      throw new Error("Real network forbidden.");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  /** The page's own content: from its heading to the shared footer, without the admin shell (styles, navigation). */
  const content = (html: string) => html.slice(html.indexOf("<h1"), html.indexOf('class="foot"'));
  const post = (url: string, data: Record<string, string>) => app.inject({ method: "POST", url, headers: { ...FORM, cookie }, payload: new URLSearchParams(data).toString() });

  let n = 0;
  async function candidate(kind: Kind) {
    const i = ++n;
    const host = `shop${i}.example.com`;
    const status = kind === "auto_approved" || kind === "approved_by_person" ? "approved" : kind === "auto_rejected" ? "rejected" : "researched";
    const decisionReason = kind === "auto_approved" ? "Automatically approved (approval@a2): target category confirmed." : kind === "auto_rejected" ? "Automatically rejected (rejection@r2): Outside the target category." : kind === "approved_by_person" ? "Approved by a person." : null;
    const c = await db.discoveryCandidate.create({
      data: { businessName: `Harbor Collision ${i}`, website: `https://${host}/`, nameKey: `harbor ${i}`, provider: "fixture", externalId: `ev-${i}`, city: "Ventura", state: "CA", status, decisionReason, websiteVerifiedAt: kind === "ineligible" ? null : new Date() },
    });
    const run = await db.candidateResearch.create({
      data: { candidateId: c.id, version: "r12", trigger: "cli", status: "completed", outcome: "website_verified", finishedAt: new Date(), warnings: kind === "specialty" ? [WARN_SPECIALTY] : ["The provider's phone is not on the website.", 'Research found "collision_repair_services" = yes, but a person recorded no; the person\'s value was kept.'] },
    });
    const source = await db.researchSource.create({ data: { researchId: run.id, kind: "website", url: `https://${host}/services`, ok: true, httpStatus: 200 } });
    await db.researchFact.create({ data: { researchId: run.id, field: "collision_repair_services", value: "yes", state: "verified", sourceId: source.id, excerpt: QUOTE } });
    if (kind === "person") {
      await db.candidateSignal.create({ data: { candidateId: c.id, key: "collision_repair_services", value: "no", origin: "manual" } });
      await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "collision_repair_services", sourceUrl: `https://${host}/about`, excerpt: "PERSON-ONLY-EVIDENCE: this is a towing company.", origin: "manual" } });
    }
    if (kind === "auto_approved") await db.candidateSignal.create({ data: { candidateId: c.id, key: "collision_repair_services", value: "yes", origin: "research" } });
    return { ...c, host, runId: run.id };
  }
  const aiRow = (candidateId: string, over: Record<string, unknown> = {}) => ({
    kind: COLLISION_FIT_KIND, subjectType: "candidate", subjectId: candidateId, inputHash: "a".repeat(64), mode: "shadow", model: "claude-opus-5-5", promptVersion: COLLISION_FIT_PROMPT_VERSION,
    status: "valid", decision: "not_collision", confidence: 0.87, evidence: [{ sourceUrl: "https://x.example.com/s", quote: "SECRET-AI-QUOTE we do not repair cars" }], reasons: ["SECRET-AI-REASON the site sells tires"], concerns: ["SECRET-AI-CONCERN"], nextAction: "record_collision_no", ruleDecision: "primary", agreement: "disagree", inputTokens: 1000, outputTokens: 100, costMicroUsd: 6000, latencyMs: 1500,
    ...over,
  });
  /** Everything evaluation and labeling must never change. */
  async function pipelineSnapshot() {
    return JSON.stringify({
      candidates: await db.discoveryCandidate.findMany({ orderBy: { id: "asc" }, include: { signals: true, evidence: true, notes: true, research: { include: { facts: true, sources: true } } } }),
      prospects: await db.prospect.findMany({ include: { signals: true, evidence: true, statusChanges: true } }),
      outreach: await db.outreach.count(),
      suppression: await db.emailSuppression.count(),
      switch: await db.outreachControlChange.count(),
      decisions: await db.aiDecision.findMany({ orderBy: { id: "asc" } }),
    });
  }

  // ---------- cohorts ----------

  test("a cohort is a stratified, reproducible sample chosen without any AI output", async () => {
    for (let i = 0; i < 4; i++) await candidate("verify");
    for (let i = 0; i < 2; i++) await candidate("specialty");
    for (let i = 0; i < 3; i++) await candidate("auto_approved");
    await candidate("auto_rejected");
    await candidate("person");
    await candidate("approved_by_person");
    await candidate("ineligible");
    const quotas = { verify: 3, specialty_or_uncertain: 2, auto_approved: 2, auto_rejected: 5, person_decided: 1 };
    const plan = await planCohort(db, { seed: "s1", quotas });
    assert.deepEqual(plan.strata, {
      verify: { quota: 3, available: 4, chosen: 3 },
      specialty_or_uncertain: { quota: 2, available: 2, chosen: 2 },
      auto_approved: { quota: 2, available: 3, chosen: 2 },
      auto_rejected: { quota: 5, available: 1, chosen: 1 },
      person_decided: { quota: 1, available: 1, chosen: 1 },
    });
    assert.deepEqual((await planCohort(db, { seed: "s1", quotas })).picks, plan.picks, "the same seed and data choose the same cases");
    // AI output never influences the sample.
    for (const c of await db.discoveryCandidate.findMany()) await db.aiDecision.create({ data: aiRow(c.id) });
    assert.deepEqual((await planCohort(db, { seed: "s1", quotas })).picks, plan.picks);
    const other = await planCohort(db, { seed: "another seed", quotas });
    assert.notDeepEqual(other.picks.filter((p) => p.stratum === "verify").map((p) => p.candidateId), plan.picks.filter((p) => p.stratum === "verify").map((p) => p.candidateId), "a different seed draws differently");

    const cohort = await createCohort(db, { name: "Gold set 1", seed: "s1", quotas });
    assert.equal(cohort.samplingVersion, "stratified@s1");
    const cases = await db.aiEvalCase.findMany({ where: { cohortId: cohort.id }, orderBy: { position: "asc" } });
    assert.equal(cases.length, 9);
    assert.deepEqual(cases.map((c) => c.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(new Set(cases.map((c) => c.candidateId)), new Set(plan.picks.map((p) => p.candidateId)));
    await assert.rejects(createCohort(db, { name: "Gold set 1", seed: "s2" }), (e: unknown) => e instanceof AiEvalError && e.kind === "conflict");
    await assert.rejects(db.aiEvalCase.create({ data: { cohortId: cohort.id, candidateId: cases[0]!.candidateId, stratum: "verify", position: 99 } }), "a candidate appears once per cohort");
  });

  test("an explicit list (a manual or imported cohort) is accepted only for candidates that exist", async () => {
    const a = await candidate("verify");
    const b = await candidate("auto_approved");
    const cohort = await createCohort(db, { name: "Manual", seed: "m", candidateIds: [a.id, b.id, a.id] });
    assert.equal(cohort.samplingVersion, "manual");
    assert.equal(cohort._count.cases, 2);
    await assert.rejects(createCohort(db, { name: "Bad", seed: "m", candidateIds: [a.id, "00000000-0000-4000-8000-000000000000"] }), /don't exist/);
  });

  // ---------- labels ----------

  test("blind labels: one per case, append-only adjudication with a reason, enforced by the database", async () => {
    const c = await candidate("verify");
    const cohort = await createCohort(db, { name: "L", seed: "s", candidateIds: [c.id] });
    const kase = await db.aiEvalCase.findFirstOrThrow({ where: { cohortId: cohort.id } });
    await assert.rejects(blindLabel(db, kase.id, { label: "approve" }), /Choose one of the answers/);
    const [x, y] = await Promise.allSettled([blindLabel(db, kase.id, { label: "collision_primary" }), blindLabel(db, kase.id, { label: "not_collision" })]);
    assert.equal([x, y].filter((r) => r.status === "fulfilled").length, 1, "two submissions at once: exactly one blind label");
    await assert.rejects(blindLabel(db, kase.id, { label: "not_collision" }), (e: unknown) => e instanceof AiEvalError && e.kind === "conflict");
    await assert.rejects(adjudicateLabel(db, kase.id, { label: "not_collision" }), /needs a reason/);
    const adj = await adjudicateLabel(db, kase.id, { label: "not_collision", note: "The services page lists towing only.", labeledBy: "Alex" });
    assert.deepEqual([adj.revision, adj.source, adj.labeledBy], [2, "adjudicated", "Alex"]);
    const labels = await db.aiLabel.findMany({ where: { caseId: kase.id }, orderBy: { revision: "asc" } });
    assert.deepEqual(labels.map((l) => [l.revision, l.source]), [[1, "blind"], [2, "adjudicated"]], "history kept");
    // The database refuses anything that isn't a blind first label or a reasoned adjudication.
    await assert.rejects(db.aiLabel.create({ data: { caseId: kase.id, candidateId: c.id, revision: 3, source: "blind", label: "not_collision" } }));
    await assert.rejects(db.aiLabel.create({ data: { caseId: kase.id, candidateId: c.id, revision: 3, source: "adjudicated", label: "not_collision" } }), "no reason");
    await assert.rejects(db.aiLabel.create({ data: { caseId: kase.id, candidateId: c.id, revision: 3, source: "adjudicated", label: "approve", note: "x" } }), "not a label");
    await assert.rejects(db.aiLabel.create({ data: { caseId: kase.id, candidateId: c.id, revision: 2, source: "adjudicated", label: "not_collision", note: "dup" } }), "no duplicate revision");
  });

  // ---------- evaluation ----------

  test("evaluation scores AI and rules on the same labeled cases, keeps failed AI answers, and never mixes models or prompts", async () => {
    const cs = [await candidate("verify"), await candidate("verify"), await candidate("auto_approved"), await candidate("auto_rejected"), await candidate("verify")];
    const cohort = await createCohort(db, { name: "E", seed: "s", candidateIds: cs.map((c) => c.id) });
    const cases = await db.aiEvalCase.findMany({ where: { cohortId: cohort.id } });
    const caseOf = (id: string) => cases.find((k) => k.candidateId === id)!.id;
    await blindLabel(db, caseOf(cs[0]!.id), { label: "collision_primary" });
    await blindLabel(db, caseOf(cs[1]!.id), { label: "not_collision" });
    await adjudicateLabel(db, caseOf(cs[1]!.id), { label: "collision_primary", note: "On review." });
    await blindLabel(db, caseOf(cs[2]!.id), { label: "collision_primary" });
    await blindLabel(db, caseOf(cs[3]!.id), { label: "insufficient_evidence" });
    // cs[4] stays unlabeled: outside the population.
    // Opus p1: right, wrong, invalid, a provider error; Sonnet p1 and Opus p2: answers that must not mix in.
    await db.aiDecision.create({ data: aiRow(cs[0]!.id, { decision: "collision_primary", ruleDecision: "unknown" }) });
    await db.aiDecision.create({ data: aiRow(cs[1]!.id, { decision: "collision_primary", confidence: 0.6, ruleDecision: "negative" }) });
    await db.aiDecision.create({ data: aiRow(cs[2]!.id, { status: "invalid", decision: "collision_primary", ruleDecision: "primary", validationErrors: ["evidence 1: the quote is not word for word in the supplied excerpts for its source URL."] }) });
    await db.aiDecision.create({ data: aiRow(cs[3]!.id, { status: "error", decision: null, confidence: null, ruleDecision: "primary", error: "timeout: The provider did not answer in time." }) });
    await db.aiDecision.create({ data: aiRow(cs[4]!.id, { decision: "collision_primary" }) });
    await db.aiDecision.create({ data: aiRow(cs[0]!.id, { model: "claude-sonnet-5-5", decision: "not_collision" }) });
    await db.aiDecision.create({ data: aiRow(cs[1]!.id, { promptVersion: "collision-fit@p2", decision: "insufficient_evidence" }) });

    const before = await pipelineSnapshot();
    const ev = (await evaluateCohort(db, cohort.id))!;
    assert.deepEqual(ev.version, { model: "claude-opus-5-5", promptVersion: COLLISION_FIT_PROMPT_VERSION });
    assert.deepEqual(ev.versions.map((v) => [v.model, v.promptVersion, v.decisions]), [["claude-opus-5-5", COLLISION_FIT_PROMPT_VERSION, 5], ["claude-opus-5-5", "collision-fit@p2", 1], ["claude-sonnet-5-5", COLLISION_FIT_PROMPT_VERSION, 1]]);
    const m = ev.metrics;
    assert.deepEqual([m.cases, m.population], [5, 4]);
    assert.deepEqual([m.aiVsHuman.population, m.rulesVsHuman.population], [4, 4], "the same four cases for the AI and the rules");
    assert.deepEqual(m.aiOutcomes, { valid: 2, abstained: 0, invalid: 1, error: 1, missing: 0 });
    assert.deepEqual(m.humanLabels, { definite: 3, cantTell: 1 });
    assert.equal(m.aiVsHuman.confusion.collision_primary.collision_primary, 1);
    assert.equal(m.aiVsHuman.confusion.not_collision.collision_primary, 1, "scored against the blind label, not the adjudication");
    assert.equal(m.aiVsHuman.confusion.collision_primary.no_answer, 1, "the invalid answer stays in, as no usable answer");
    assert.equal(m.aiVsHuman.confusion.insufficient_evidence.no_answer, 1, "the provider error stays in");
    assert.deepEqual(m.aiVsHuman.primary.recall, { num: 1, den: 2, rate: null }, "the invalid answer is a miss for recall");
    assert.equal(m.rulesVsHuman.confusion.collision_primary.collision_primary, 1, "the rules' verdict on the invalid case still counts");
    assert.deepEqual(m.adjudicated, { cases: 1, changedFromBlind: 1 });
    assert.equal(m.aiVsHuman.agreement.rate, null, "four labels: unavailable");
    assert.deepEqual(m.byStratum.map((s) => [s.stratum, s.cases, s.labeled]), [["manual", 5, 4]], "an explicit-list cohort has one stratum");
    assert.deepEqual(ev.disagreements.map((d) => [d.candidateId, d.gold, d.aiDecision]), [[cs[1]!.id, "not_collision", "collision_primary"]]);

    // Another model or prompt: its own decisions only; a case it never judged is "no usable answer", not borrowed from another version.
    const sonnet = (await evaluateCohort(db, cohort.id, { model: "claude-sonnet-5-5" }))!;
    assert.deepEqual(sonnet.version, { model: "claude-sonnet-5-5", promptVersion: COLLISION_FIT_PROMPT_VERSION });
    assert.deepEqual(sonnet.metrics.aiOutcomes, { valid: 1, abstained: 0, invalid: 0, error: 0, missing: 3 });
    assert.equal(sonnet.metrics.aiVsHuman.confusion.collision_primary.not_collision, 1);
    assert.equal(sonnet.metrics.aiVsHuman.population, 4);
    assert.equal(sonnet.metrics.rulesVsHuman.population, 4, "same population; the rules have no verdict where this version never read the site");
    const p2 = (await evaluateCohort(db, cohort.id, { promptVersion: "collision-fit@p2" }))!;
    assert.deepEqual([p2.version?.promptVersion, p2.metrics.aiVsHuman.abstention.num, p2.metrics.aiOutcomes.missing], ["collision-fit@p2", 1, 3]);
    assert.equal(await pipelineSnapshot(), before, "evaluation changes nothing");
  });

  test("a cohort-mode shadow run judges exactly the cohort, whatever the rules decided", async () => {
    const cs = [await candidate("auto_approved"), await candidate("auto_rejected"), await candidate("verify")];
    await candidate("verify"); // not in the cohort
    const cohort = await createCohort(db, { name: "Run", seed: "s", candidateIds: cs.map((c) => c.id) });
    const routes = Object.assign({}, ...cs.map((c) => ({ [`https://${c.host}/robots.txt`]: { body: "User-agent: *\nAllow: /", contentType: "text/plain" }, [`https://${c.host}/`]: { body: page("Harbor", `<p>${QUOTE}</p>`) } })));
    const calls: CompletionRequest[] = [];
    const provider: AiProvider = { name: "fake", model: "claude-opus-5-5", async complete(req) { calls.push(req); return { text: '{"decision":"insufficient_evidence","confidence":0.5,"evidence":[],"reasons":[],"concerns":[],"recommendedNextAction":"human_verification"}', model: "claude-opus-5-5", inputTokens: 10, outputTokens: 10 }; } };
    const before = await db.discoveryCandidate.findMany({ orderBy: { id: "asc" }, include: { signals: true } });
    const r = await runAiShadow(db, { enabled: true, provider, dailyBudgetUsd: 5, limit: 10, mode: "cohort", cohortId: cohort.id, acquireLock: async () => ({ release: async () => undefined }), makeFetcher: fixtureWeb(routes).makeFetcher });
    assert.equal(r.calls, 3);
    const order = (await db.aiEvalCase.findMany({ where: { cohortId: cohort.id }, orderBy: { position: "asc" } })).map((k) => k.candidateId);
    assert.deepEqual((await db.aiDecision.findMany({ orderBy: { createdAt: "asc" } })).map((d) => d.subjectId), order, "in labeling order");
    assert.deepEqual(await db.discoveryCandidate.findMany({ orderBy: { id: "asc" }, include: { signals: true } }), before);
  });

  // ---------- the admin pages: blind until labeled ----------

  test("the blind labeling page shows the evidence and nothing of the AI, the rules, or a person's decision", async () => {
    const c = await candidate("person");
    await db.aiDecision.create({ data: aiRow(c.id) });
    const cohort = await createCohort(db, { name: "Blind", seed: "s", candidateIds: [c.id] });
    const kase = await db.aiEvalCase.findFirstOrThrow({ where: { cohortId: cohort.id } });
    const next = await get(`/admin/ai/cohorts/${cohort.id}/next`);
    assert.equal(next.statusCode, 303);
    assert.equal(next.headers.location, `/admin/ai/label/${kase.id}`);
    const res = await get(`/admin/ai/label/${kase.id}`);
    assert.equal(res.statusCode, 200);
    const body = content(res.body);
    // The evidence a verifier needs.
    assert.ok(body.includes(c.businessName));
    assert.ok(body.includes(`${c.host}/services`));
    assert.ok(body.includes(QUOTE));
    assert.ok(body.includes("The provider&#39;s phone is not on the website.") || body.includes("The provider's phone is not on the website."));
    assert.match(body, /name="label" value="collision_primary"/);
    // Nothing of the AI: verdict, confidence, reasoning, recommended action, model, prompt.
    for (const s of ["SECRET-AI-QUOTE", "SECRET-AI-REASON", "SECRET-AI-CONCERN", "87%", "0.87", "claude-opus-5-5", COLLISION_FIT_PROMPT_VERSION, "record_collision_no", "record collision no", "AI decision", "Not collision", "AI SHADOW"]) {
      assert.ok(!body.includes(s), `the blind page must not show "${s}"`);
    }
    // Nothing of the rules' or a person's decision either.
    for (const s of ["PERSON-ONLY-EVIDENCE", "but a person recorded", "verified", "Researched", "person_decided", "A person recorded collision/body fit", "Meets criteria"]) {
      assert.ok(!body.includes(s), `the blind page must not show "${s}"`);
    }
  });

  test("AI output stays hidden on the candidate page, the shadow list, and the case review until the blind label is saved", async () => {
    const c = await candidate("verify");
    await db.aiDecision.create({ data: aiRow(c.id) });
    const cohort = await createCohort(db, { name: "Hidden", seed: "s", candidateIds: [c.id] });
    const kase = await db.aiEvalCase.findFirstOrThrow({ where: { cohortId: cohort.id } });

    const cand = (await get(`/admin/discovery/candidates/${c.id}`)).body;
    assert.match(cand, /AI shadow verdict hidden/);
    assert.ok(!cand.includes("SECRET-AI-REASON") && !cand.includes("87%"));
    const list = (await get("/admin/ai")).body;
    assert.match(list, /Hidden: blind gold-set label pending/);
    assert.ok(!list.includes("SECRET-AI"));
    assert.match(list, /SHADOW ONLY/);
    const early = await get(`/admin/ai/cases/${kase.id}`);
    assert.equal(early.statusCode, 303, "no review before the blind label");
    assert.equal(early.headers.location, `/admin/ai/label/${kase.id}`);

    const saved = await post(`/admin/ai/label/${kase.id}`, { label: "collision_primary", note: "Services page." });
    assert.equal(saved.statusCode, 303);
    assert.equal((await post(`/admin/ai/label/${kase.id}`, { label: "not_collision" })).statusCode, 409, "a second blind label is refused");

    assert.match((await get(`/admin/discovery/candidates/${c.id}`)).body, /SECRET-AI-REASON/);
    const review = (await get(`/admin/ai/cases/${kase.id}`)).body;
    assert.match(review, /SECRET-AI-QUOTE/);
    assert.match(review, /Adjudicate \(after review\)/);
    assert.equal((await post(`/admin/ai/label/${kase.id}/adjudicate`, { label: "collision_primary" })).statusCode, 400, "an adjudication needs a reason");
    assert.equal((await post(`/admin/ai/label/${kase.id}/adjudicate`, { label: "collision_primary", note: "Confirmed." })).statusCode, 303);
    const relabeled = (await get(`/admin/ai/label/${kase.id}`)).body;
    assert.match(relabeled, /Your blind label/);
    assert.doesNotMatch(relabeled, /Save blind label/, "the blind label can't be resubmitted");
  });

  test("the evaluation and disagreement pages: honest when empty, complete after labeling, never changing state", async () => {
    const cs = [await candidate("verify"), await candidate("verify")];
    const cohort = await createCohort(db, { name: "Pages", seed: "s", candidateIds: cs.map((c) => c.id) });
    const empty = content((await get(`/admin/ai/cohorts/${cohort.id}`)).body);
    assert.match(empty, /SHADOW ONLY/);
    assert.match(empty, /Not enough labeled cases yet\./);
    assert.match(empty, /No AI decisions for this gold set yet/);
    assert.doesNotMatch(empty, /0%/, "unknown is never shown as 0%");

    await db.aiDecision.create({ data: aiRow(cs[0]!.id, { decision: "not_collision" }) });
    await db.aiDecision.create({ data: aiRow(cs[1]!.id, { decision: "collision_primary" }) });
    const cases = await db.aiEvalCase.findMany({ where: { cohortId: cohort.id } });
    for (const k of cases) await post(`/admin/ai/label/${k.id}`, { label: "collision_primary" });
    const before = await pipelineSnapshot();
    const page1 = (await get(`/admin/ai/cohorts/${cohort.id}`)).body;
    assert.match(page1, /Gold-set cases labeled<\/dt><dd>2 \/ 2/);
    assert.match(page1, /<code>claude-opus-5-5<\/code>/);
    assert.ok(page1.includes(`<code>${COLLISION_FIT_PROMPT_VERSION}</code>`));
    assert.match(page1, /<code>collision_fit<\/code>/);
    assert.match(page1, /stratified@s1|<code>manual<\/code>/);
    assert.match(page1, /Unavailable \(1 of 2; needs 20\)/, "agreement with 2 labels is unavailable");
    assert.match(page1, /Confidence calibration/);
    assert.match(page1, /Evaluation population<\/dt><dd>2 labeled cases\. The AI and the rules are scored on exactly these/);
    assert.match(page1, /Evaluation by stratum/);
    assert.match(page1, /Gold-set results reflect the intentionally stratified evaluation sample/);
    assert.match(page1, /<th scope="row">Chosen explicitly<\/th><td class="num">2<\/td><td class="num">2<\/td>/);
    assert.match(page1, /No usable answer/);
    assert.match(page1, /AI vs human \(blind gold labels\)/);
    assert.match(page1, /Rules vs human \(same gold labels, same cases\)/);
    const dis = (await get(`/admin/ai/cohorts/${cohort.id}/disagreements`)).body;
    assert.match(dis, /SECRET-AI-QUOTE/);
    assert.match(dis, /SECRET-AI-REASON/);
    assert.match(dis, /Blind human label<\/dt><dd>Performs collision or auto body repair/);
    assert.match(dis, /Rules on the same pages<\/dt><dd>primary/);
    assert.equal((dis.match(/Review and adjudicate/g) ?? []).length, 1);
    assert.equal(await pipelineSnapshot(), before, "pages change nothing");
  });

  test("a gold set is created from the admin, refused on a duplicate name, and shown with its progress", async () => {
    await candidate("verify");
    const res = await post("/admin/ai/cohorts", { name: "Admin set", seed: "seed-1" });
    assert.equal(res.statusCode, 303);
    const page1 = (await get("/admin/ai")).body;
    assert.match(page1, /Admin set/);
    assert.match(page1, /<td>0 \/ 1<\/td>/);
    assert.equal((await post("/admin/ai/cohorts", { name: "Admin set", seed: "seed-2" })).statusCode, 409);
    assert.equal((await post("/admin/ai/cohorts", { name: "", seed: "x" })).statusCode, 400);
  });
});
