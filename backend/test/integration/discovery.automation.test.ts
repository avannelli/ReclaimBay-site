import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { applyDiscoveryAutomation, applyDiscoveryBatch, discoveryAutomationPreview } from "../../src/discovery/automation.js";
import { AUDITED_CATEGORY_CORRECTIONS } from "../../src/discovery/categoryReassessment.js";
import { approveCandidate, changeCandidateStatus, deleteCandidateEvidence, updateCandidate, reviewQueue, reviewResearchWarnings, addCandidateNote, backfillCategoryCheck, setCandidateCategory, applyResearchFindings } from "../../src/discovery/service.js";
import { WARNING_REVIEW_PREFIX, unreviewedWarnings } from "../../src/discovery/warningReview.js";
import { normalizeName } from "../../src/discovery/normalize.js";
import { autoResearchSelection, enqueueResearch, processResearch, runAutoResearch } from "../../src/research/service.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import { researchFetcher } from "../../src/research/fetcher.js";
import { fixtureWeb, independentShop, page } from "../fixtures/researchSite.js";
import { freshDb, readyForm, skipReason, truncate, TEST_DATABASE_URL } from "./helpers.js";

describe("Discovery automation boundaries", { skip: skipReason }, () => {
  let db: Db, sequence = 0;
  const originalFetch = globalThis.fetch;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); globalThis.fetch = (async () => { throw new Error("External network/email calls are forbidden in Discovery automation tests."); }) as typeof fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });
  after(async () => db?.$disconnect());
  const candidate = (extra: Record<string, unknown> = {}) => db.discoveryCandidate.create({ data: {
    businessName: "Saviers Road Auto Repair", nameKey: normalizeName("Saviers Road Auto Repair"), provider: "manual",
    website: `https://shop${++sequence}.example.com/`, city: "Oxnard", state: "CA", categoryVerdict: "in_target", ...extra,
  } });
  const preview = async (id: string, recovery = false) => (await discoveryAutomationPreview(db, { recovery })).rows.find(r => r.id === id)!;
  const historical = async (extra: Record<string, unknown> = {}, excerpt = "Our automotive repair services include brake repair and engine repair.", runId?: string) => {
    const c = await candidate({ status: "researched", websiteVerifiedAt: new Date(), categorySource: "website", ...extra });
    const run = await db.candidateResearch.create({ data: { ...(runId ? { id: runId } : {}), candidateId: c.id, version: "r11", status: "completed", outcome: "website_verified", trigger: "cli", warnings: [], subjectWebsite: c.website } });
    await db.researchSource.create({ data: { researchId: run.id, kind: "website", url: c.website!, ok: true } });
    await db.candidateSignal.create({ data: { candidateId: c.id, key: "general_repair_services", value: "yes", origin: "research" } });
    const evidence = await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "general_repair_services", sourceUrl: c.website!, excerpt, origin: "research", researchId: run.id } });
    return { c, run, evidence };
  };
  const downstream = async () => {
    const tables = ["Prospect", "ProspectEvidence", "ProspectSignal", "ProspectNote", "ProspectStatusChange", "AnalyticsSession", "ProductEvent", "Outreach", "OutreachEvent", "OutreachReply", "OutreachCampaign", "OutreachCampaignMessage", "Invitation", "EmailSuppression", "EmailedUnsubscribeReview", "EmailedUnsubscribeCandidate", "OutreachControlChange"];
    return Promise.all(tables.map(t => db.$queryRawUnsafe(`SELECT row_to_json(t)::text FROM "${t}" t ORDER BY row_to_json(t)::text`)));
  };

  test("re-evaluates sourced historical excerpts, preserves originals, stops at Ready to approve, and is idempotent", async () => {
    const { c, evidence } = await historical();
    const before = await downstream();
    const plan = await preview(c.id);
    assert.equal(plan.assessment.action, "qualify");
    const applied = await applyDiscoveryAutomation(db, c.id, { token: plan.token });
    assert.equal(applied.applied, true);
    assert.equal((await preview(c.id)).assessment.action, "ready");
    assert.deepEqual(await db.candidateEvidence.findUnique({ where: { id: evidence.id } }), evidence);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "researched");
    const count = await db.candidateEvidence.count();
    assert.equal((await applyDiscoveryAutomation(db, c.id)).applied, false);
    assert.equal(await db.candidateEvidence.count(), count);
    assert.deepEqual(await downstream(), before, "zero prospect, message, queue, reply, campaign, invitation or opt-out side effects");
    await assert.rejects(approveCandidate(db, c.id, { automatic: true }), /person must approve/);
  });

  test("old labels and general-repair Yes alone cannot qualify; missing source, specialty and identity warnings need evidence", async () => {
    const weak = await historical({}, "Brakes, maintenance, our location and our friendly staff.");
    assert.equal((await preview(weak.c.id)).assessment.action, "research");
    const unsourced = await historical();
    await db.researchSource.deleteMany({ where: { researchId: unsourced.run.id } });
    assert.notEqual((await preview(unsourced.c.id)).assessment.action, "qualify");
    const fleet = await historical({ businessName: "Fleet Auto Repair" });
    assert.notEqual((await preview(fleet.c.id)).assessment.action, "qualify");
    const conflict = await historical();
    await db.candidateResearch.update({ where: { id: conflict.run.id }, data: { warnings: ["The website gives a different business address."] } });
    assert.notEqual((await preview(conflict.c.id)).assessment.action, "qualify");
  });

  test("missing websites, blocked and mismatched sites are actionable exceptions; corrected websites can be researched", async () => {
    const missing = await candidate({ website: null });
    assert.equal((await preview(missing.id)).assessment.code, "missing_website");
    for (const outcome of ["access_blocked", "website_mismatch", "website_unconfirmed"]) {
      const c = await candidate();
      await db.candidateResearch.create({ data: { candidateId: c.id, version: "r11", trigger: "cli", status: "completed", outcome, subjectWebsite: c.website } });
      assert.equal((await preview(c.id)).assessment.action, "human");
      if (outcome !== "access_blocked") {
        await db.discoveryCandidate.update({ where: { id: c.id }, data: { website: "https://corrected.example.com/" } });
        assert.equal((await preview(c.id)).assessment.action, "research");
      }
    }
  });

  test("exhaustion requires an explicit one-time recovery preview, retains attempts, and observes cooldown", async () => {
    const c = await candidate();
    for (let n = 0; n < 3; n++) await db.candidateResearch.create({ data: { candidateId: c.id, version: "r12", trigger: "scheduled", status: "failed", outcome: "website_unreachable", finishedAt: new Date(Date.now() - 48 * 3600_000) } });
    assert.equal((await preview(c.id)).assessment.code, "retry_exhausted");
    const plan = await preview(c.id, true);
    assert.equal(plan.assessment.researchKind, "recovery");
    await applyDiscoveryBatch(db, [{ id: c.id, token: plan.token }], { recovery: true });
    assert.equal(await db.candidateResearch.count(), 4);
    const recovery = await db.candidateResearch.findFirstOrThrow({ where: { trigger: "recovery" } });
    await db.candidateResearch.update({ where: { id: recovery.id }, data: { status: "failed", outcome: "website_unreachable", finishedAt: new Date(Date.now() - 48 * 3600_000) } });
    assert.equal((await preview(c.id, true)).assessment.action, "human");
  });

  test("only the audited stale exclusion is corrected, with its earlier reason retained", async () => {
    const audited = AUDITED_CATEGORY_CORRECTIONS[0]!;
    const c = await candidate({ id: audited.id, businessName: audited.name, categoryVerdict: "wrong_category", categorySource: "name", categoryRules: "automotive@c1", categoryReason: audited.reason, providerCategory: "automotive_repair", categoryTier: "core" });
    assert.equal((await preview(c.id)).assessment.action, "category");
    await applyDiscoveryAutomation(db, c.id);
    const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(after.categoryVerdict, "unclear"); assert.equal(after.status, "discovered");
    assert.ok((await db.candidateNote.findFirstOrThrow()).body.includes(audited.reason));
    const unrelated = await candidate({ categoryVerdict: "wrong_category", categorySource: "name", categoryRules: "automotive@c1" });
    assert.equal((await applyDiscoveryAutomation(db, unrelated.id)).applied, false);
  });

  test("a confident duplicate is linked without changing prospect/outreach history; ambiguous and human-resolved flags are preserved", async () => {
    const canonical = await db.prospect.create({ data: { referralCode: "canonical", businessName: "Saviers Road Auto Repair", website: "https://canonical.example.com/", city: "Oxnard", state: "CA" } });
    const msg = await db.outreach.create({ data: { prospectId: canonical.id, kind: "initial", template: "fixture", subject: "Preserve", body: "Preserve", evidence: [], generatedAt: new Date(), recipientEmail: "office@canonical.example.com", recipientSourceUrl: canonical.website!, status: "sent", sentAt: new Date() } });
    await db.outreachReply.create({ data: { outreachId: msg.id, receivedAt: new Date(), summary: "Preserve reply" } });
    await db.outreach.create({ data: { prospectId: canonical.id, kind: "initial", template: "fixture", subject: "Preserve draft", body: "Preserve draft", evidence: [], generatedAt: new Date(), recipientEmail: "draft@canonical.example.com", recipientSourceUrl: canonical.website!, status: "draft" } });
    await db.invitation.create({ data: { prospectId: canonical.id, outreachId: msg.id, tokenHash: "b".repeat(64) } });
    await db.emailedUnsubscribeReview.create({ data: { mailboxAccount: "fixture@example.com", gmailMessageId: "fixture-review", senderEmail: msg.recipientEmail, reason: "multiple_candidates", candidates: { create: { outreachId: msg.id, prospectId: canonical.id, recipientEmail: msg.recipientEmail } } } });
    await db.emailSuppression.create({ data: { email: msg.recipientEmail, reason: "unsubscribed", outreachId: msg.id } });
    const campaign = await db.outreachCampaign.create({ data: { name: "Preserve campaign", attributionCampaign: "fixture", messages: { create: { outreachId: msg.id, messageHash: "a".repeat(64) } } } });
    const original = await candidate({ businessName: "Other business" });
    const duplicate = await candidate({ website: canonical.website, status: "needs_review", duplicateHold: true, possibleDuplicateCandidateId: original.id });
    const before = await downstream();
    const plan = await preview(duplicate.id);
    assert.equal(plan.assessment.action, "link_duplicate");
    await applyDiscoveryAutomation(db, duplicate.id, { token: plan.token });
    const after = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: duplicate.id } });
    assert.equal(after.status, "duplicate"); assert.equal(after.possibleDuplicateProspectId, canonical.id);
    assert.equal(after.possibleDuplicateCandidateId, original.id);
    assert.deepEqual(await downstream(), before); assert.ok(campaign.id);
    const ambiguous = await candidate({ businessName: "Unrelated Garage", status: "needs_review", duplicateHold: true, possibleDuplicateCandidateId: original.id });
    assert.equal((await preview(ambiguous.id)).assessment.action, "protected", "the retained candidate flag reaches canonical outreach through an indirect link");
    await assert.rejects(approveCandidate(db, ambiguous.id), /Resolve the possible duplicate/);
    const unresolved = await candidate({ website: canonical.website, status: "needs_review", duplicateHold: true, duplicateDecision: "unresolved", possibleDuplicateCandidateId: original.id });
    assert.notEqual((await preview(unresolved.id)).assessment.action, "link_duplicate");
    const protectedCandidate = await candidate({ email: msg.recipientEmail });
    assert.equal((await preview(protectedCandidate.id)).assessment.action, "protected");
    assert.equal((await enqueueResearch(db, [protectedCandidate.id], "admin")).queued.length, 0);
    assert.deepEqual(await downstream(), before);
    await changeCandidateStatus(db, duplicate.id, "discovered", "Recheck identity");
    const reopened = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: duplicate.id } });
    assert.equal(reopened.possibleDuplicateProspectId, canonical.id);
    assert.equal((await preview(duplicate.id)).assessment.action, "protected");
    assert.deepEqual(await downstream(), before);
  });

  test("stale previews and concurrent batches cannot repeat a decision", async () => {
    const { c } = await historical(); const plan = await preview(c.id);
    await db.discoveryCandidate.update({ where: { id: c.id }, data: { status: "needs_review" } });
    await assert.rejects(applyDiscoveryAutomation(db, c.id, { token: plan.token }), /changed/);
    const other = await historical(); const p = await preview(other.c.id);
    const results = await Promise.allSettled([1, 2].map(() => applyDiscoveryAutomation(db, other.c.id, { token: p.token })));
    assert.equal(results.filter(r => r.status === "fulfilled" && r.value.applied).length, 1);
    assert.equal(await db.candidateSignal.count({ where: { candidateId: other.c.id, key: "automotive_repair_services" } }), 1);
  });

  test("research never creates prospects, retains evidence and more than five runs, including weaker blocked results", async () => {
    const c = await candidate({ website: "https://saviersauto.example.com/", streetAddress: "5577 Saviers Rd", postalCode: "93033", providerPhone: "8055550101" });
    const web = fixtureWeb(independentShop());
    const run = async (makeFetcher = web.makeFetcher) => { const q = await enqueueResearch(db, [c.id], "admin"); assert.equal(q.queued.length, 1); return processResearch(db, q.queued[0]!.researchId, { makeFetcher }); };
    await run();
    const evidence = await db.candidateEvidence.findMany({ where: { candidateId: c.id } });
    assert.ok(evidence.length); assert.equal(await db.prospect.count(), 0);
    for (let n = 0; n < 5; n++) await run();
    await run(fixtureWeb({ "https://saviersauto.example.com/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /" } }).makeFetcher);
    assert.equal(await db.candidateResearch.count({ where: { candidateId: c.id } }), 7);
    assert.deepEqual(await db.candidateEvidence.findMany({ where: { id: { in: evidence.map(e => e.id) } }, orderBy: { id: "asc" } }), evidence.sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(await db.prospect.count(), 0); assert.equal(await db.outreach.count(), 0);
    assert.equal((await preview(c.id)).assessment.code, "blocked");
    assert.equal(RESEARCH_VERSION, "r15");
  });

  test("a negative rerun preserves stronger signals, both sources, and blocks manual approval", async () => {
    const c = await candidate({ website: "https://saviersauto.example.com/", streetAddress: "5577 Saviers Rd", postalCode: "93033", providerPhone: "8055550101" });
    const run = async (routes: ReturnType<typeof independentShop>) => {
      const q = await enqueueResearch(db, [c.id], "admin");
      return processResearch(db, q.queued[0]!.researchId, { makeFetcher: fixtureWeb(routes).makeFetcher });
    };
    await run(independentShop());
    const signal = await db.candidateSignal.findUniqueOrThrow({ where: { candidateId_key: { candidateId: c.id, key: "automotive_repair_services" } } });
    const oldEvidence = await db.candidateEvidence.findMany();
    const routes = independentShop();
    routes["https://saviersauto.example.com/services"]!.body = page("Services", "<p>We do not perform automotive repairs at this location.</p>");
    await run(routes);
    assert.deepEqual(await db.candidateSignal.findUniqueOrThrow({ where: { id: signal.id } }), signal);
    assert.equal(await db.candidateEvidence.count({ where: { id: { in: oldEvidence.map(e => e.id) } } }), oldEvidence.length);
    assert.ok(await db.candidateEvidence.count() > oldEvidence.length);
    assert.equal((await preview(c.id)).assessment.action, "human");
    await assert.rejects(approveCandidate(db, c.id), /contradictory/);
    assert.equal(await db.prospect.count(), 0);
  });

  test("historical contradictory excerpts and human No cannot be relabeled as positive fit", async () => {
    const { c, run } = await historical();
    await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "general_repair_services", sourceUrl: c.website!, excerpt: "We do not perform automotive repairs at this location.", origin: "research", researchId: run.id } });
    assert.equal((await preview(c.id)).assessment.code, "conflicting_evidence");
    assert.equal((await applyDiscoveryAutomation(db, c.id)).applied, false);
    const manual = await historical();
    await db.candidateSignal.create({ data: { candidateId: manual.c.id, key: "automotive_repair_services", value: "no", origin: "manual" } });
    assert.notEqual((await preview(manual.c.id)).assessment.action, "qualify");
    assert.notEqual((await preview(manual.c.id)).assessment.action, "reject");
  });

  test("relationship changes invalidate previews and protected records refuse destructive edits", async () => {
    const { c, evidence } = await historical();
    const plan = await preview(c.id);
    const p = await db.prospect.create({ data: { referralCode: "late-prospect", businessName: c.businessName, website: c.website, city: c.city, state: c.state } });
    const before = await downstream();
    await assert.rejects(applyDiscoveryAutomation(db, c.id, { token: plan.token }), /changed/);
    await assert.rejects(deleteCandidateEvidence(db, c.id, evidence.id), /linked to a prospect/);
    await assert.rejects(changeCandidateStatus(db, c.id, "rejected", "Not repair"), /linked to a prospect/);
    await assert.rejects(updateCandidate(db, c.id, readyForm({ businessName: c.businessName })), /linked to a prospect/);
    assert.deepEqual(await downstream(), before);
    assert.ok(p.id);
  });

  test("research becoming outreach-connected while fetching cannot store its completion", async () => {
    const c = await candidate({ website: "https://saviersauto.example.com/", providerPhone: "8055550101" });
    const q = await enqueueResearch(db, [c.id], "admin");
    const web = fixtureWeb(independentShop());
    let inserted = false;
    const fetcher = researchFetcher({ get: async (url, options) => {
      if (!inserted) { inserted = true; await db.prospect.create({ data: { referralCode: "during-fetch", businessName: c.businessName, website: c.website, city: c.city, state: c.state } }); }
      return web.get(url, options);
    }, sleep: async () => undefined });
    await processResearch(db, q.queued[0]!.researchId, { makeFetcher: () => fetcher });
    assert.equal(await db.candidateEvidence.count(), 0);
    assert.equal(await db.researchSource.count(), 0);
    assert.equal((await db.candidateResearch.findUniqueOrThrow({ where: { id: q.queued[0]!.researchId } })).outcome, "superseded");
    assert.equal(await db.outreach.count(), 0);
  });

  test("stale queued research and human holds cannot be processed by a scheduled selection", async () => {
    const c = await candidate();
    const q = await enqueueResearch(db, [c.id], "scheduled");
    await changeCandidateStatus(db, c.id, "needs_review", "Check identity");
    const web = fixtureWeb({});
    await processResearch(db, q.queued[0]!.researchId, { makeFetcher: web.makeFetcher });
    assert.equal(web.calls.length, 0);
    assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "needs_review");
    assert.equal((await enqueueResearch(db, [c.id], "scheduled")).queued.length, 0);
  });

  test("policy refresh is uncapped by the displayed queue and queues only one current-version run", async () => {
    for (let i = 0; i < 205; i++) await candidate({ businessName: `Garage ${i}`, website: null });
    const { c } = await historical({}, "Our location and staff.");
    assert.equal((await reviewQueue(db, {})).items.length, 200);
    assert.ok((await autoResearchSelection(db, 25)).fresh.includes(c.id));
    const plan = await preview(c.id);
    const results = await Promise.all([1, 2].map(() => applyDiscoveryBatch(db, [{ id: c.id, token: plan.token }])));
    assert.equal(results.flat().filter(r => r.applied).length, 1);
    assert.equal(await db.candidateResearch.count({ where: { candidateId: c.id, version: RESEARCH_VERSION } }), 1);
  });

  test("duplicate cycles and conflicting canonical targets are held without merging or deleting", async () => {
    const p = await db.prospect.create({ data: { referralCode: "cycle", businessName: "Saviers Road Auto Repair", website: "https://canonical.example.com/", city: "Oxnard", state: "CA" } });
    const a = await candidate({ website: p.website, status: "needs_review", duplicateHold: true });
    const b = await candidate({ businessName: "Different Business", possibleDuplicateCandidateId: a.id });
    await db.discoveryCandidate.update({ where: { id: a.id }, data: { possibleDuplicateCandidateId: b.id } });
    assert.notEqual((await preview(a.id)).assessment.action, "link_duplicate");
    const before = await downstream();
    assert.equal((await applyDiscoveryAutomation(db, a.id)).applied, false);
    assert.deepEqual(await downstream(), before);
    assert.equal(await db.discoveryCandidate.count(), 2);
  });

  test("a disabled worker preserves the complete acquisition and outreach state", async () => {
    await historical();
    const before = await downstream();
    const revision = await db.discoveryCandidate.findMany();
    assert.equal((await runAutoResearch(db, { enabled: false, databaseUrl: TEST_DATABASE_URL, limit: 25 })).outcome, "disabled");
    assert.deepEqual(await db.discoveryCandidate.findMany(), revision);
    assert.deepEqual(await downstream(), before);
  });

  test("a sourced human warning review preserves the original run and permits safe historical re-evaluation", async () => {
    const { c, run } = await historical();
    const warnings = ["The website gives a different business address."];
    await db.candidateResearch.update({ where: { id: run.id }, data: { warnings } });
    assert.equal((await preview(c.id)).assessment.action, "research");
    await assert.rejects(reviewResearchWarnings(db, c.id, { researchId: "stale", sourceUrl: c.website!, reason: "Verified the correct location." }), /Research changed/);
    await assert.rejects(addCandidateNote(db, c.id, WARNING_REVIEW_PREFIX + "{}"), /review form/);
    await reviewResearchWarnings(db, c.id, { researchId: run.id, sourceUrl: c.website!, reason: "The owner confirms this address identifies the same repair shop." });
    assert.deepEqual((await db.candidateResearch.findUniqueOrThrow({ where: { id: run.id } })).warnings, warnings);
    assert.equal((await preview(c.id)).assessment.action, "qualify");
    const oldToken = (await preview(c.id)).token;
    await db.candidateResearch.update({ where: { id: run.id }, data: { warnings: [...warnings, "Business identity remains unclear."] } });
    await assert.rejects(applyDiscoveryAutomation(db, c.id, { token: oldToken }), /changed/);
    assert.notEqual((await preview(c.id)).assessment.action, "qualify");
  });

  test("admin previews are read-only; authenticated sourced qualification applies once with same-origin protection", async () => {
    const { c } = await historical();
    const app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: "discovery-regression-secret-0123456789", TRUST_PROXY_HOPS: "0" }), db, false);
    try {
      const plan = await preview(c.id);
      const headers = { "content-type": "application/x-www-form-urlencoded" };
      const payload = new URLSearchParams({ [`candidate_${c.id}`]: plan.token }).toString();
      await app.inject({ method: "POST", url: "/admin/discovery/automation", headers, payload });
      assert.equal((await preview(c.id)).token, plan.token, "unauthenticated request cannot apply");
      const login = await app.inject({ method: "POST", url: "/admin/login", headers, payload: new URLSearchParams({ secret: "discovery-regression-secret-0123456789" }).toString() });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const before = await downstream();
      const page = await app.inject({ method: "GET", url: "/admin/discovery/automation", headers: { cookie } });
      assert.equal(page.statusCode, 200);
      assert.ok(page.body.includes(`candidate_${c.id}`));
      assert.ok(page.body.includes(c.website!));
      assert.equal((await preview(c.id)).token, plan.token);
      const crossOrigin = await app.inject({ method: "POST", url: "/admin/discovery/automation", headers: { ...headers, cookie, origin: "https://untrusted.example.com" }, payload });
      assert.equal(crossOrigin.statusCode, 403);
      assert.equal((await preview(c.id)).token, plan.token);
      const applied = await app.inject({ method: "POST", url: "/admin/discovery/automation", headers: { ...headers, cookie }, payload });
      assert.equal(applied.statusCode, 200);
      assert.equal((await preview(c.id)).assessment.action, "ready");
      const repeated = await app.inject({ method: "POST", url: "/admin/discovery/automation", headers: { ...headers, cookie }, payload });
      assert.equal(repeated.statusCode, 200);
      assert.match(repeated.body, /0 actions applied; 1 skipped/);
      assert.deepEqual(await downstream(), before);
    } finally { await app.close(); }
  });

  test("legacy category and provider research paths preserve indirect prospect identities", async () => {
    const c = await candidate({ categorySource: "name", categoryRules: "automotive@c1", categoryReason: "Historical name classification." });
    await db.prospect.create({ data: { referralCode: "legacy-path", businessName: c.businessName, website: c.website, city: c.city, state: c.state } });
    const before = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    const downstreamBefore = await downstream();
    const result = await backfillCategoryCheck(db, { apply: true });
    assert.equal(result.skipped.protected, 1);
    await assert.rejects(setCandidateCategory(db, c.id, "wrong_category", "Replace category"), /linked to a prospect/);
    await assert.rejects(applyResearchFindings(db, c.id, { signals: {}, evidence: [] }, "fixture"), /linked to a prospect/);
    assert.deepEqual(await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } }), before);
    assert.deepEqual(await downstream(), downstreamBefore);
  });

  test("a negated dealership note does not override sourced repair fit, while a confirmed dealership stays held", async () => {
    const { c, run } = await historical();
    await db.researchFact.create({ data: { researchId: run.id, field: "business_type", value: "independent", state: "verified", note: "No chain, franchise or dealership indication found." } });
    assert.equal((await preview(c.id)).assessment.action, "qualify");
    await db.researchFact.updateMany({ where: { researchId: run.id, field: "business_type" }, data: { value: "dealership", note: "Verified dealership service department." } });
    assert.notEqual((await preview(c.id)).assessment.action, "qualify");
  });

  test("a newer blocked completion wins a queued-time tie and cannot reuse older fit for qualification", async () => {
    const { c, run } = await historical({}, "Our automotive repair services include brake repair and engine repair.", "00000000-0000-4000-8000-000000000001");
    await db.candidateResearch.update({ where: { id: run.id }, data: { finishedAt: new Date(Date.now() - 3600_000) } });
    await db.candidateResearch.create({ data: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", candidateId: c.id, version: RESEARCH_VERSION, trigger: "cli", status: "completed", outcome: "access_blocked", subjectWebsite: c.website, queuedAt: run.queuedAt, finishedAt: new Date() } });
    assert.equal((await preview(c.id)).assessment.code, "blocked");
    assert.equal((await applyDiscoveryAutomation(db, c.id)).applied, false);
  });

  test("identity edits invalidate website verification and prior warning reviews", async () => {
    const { c, run } = await historical();
    await db.candidateResearch.update({ where: { id: run.id }, data: { warnings: ["The website gives a different business address."] } });
    await reviewResearchWarnings(db, c.id, { researchId: run.id, sourceUrl: c.website!, reason: "Verified the original business at this address." });
    assert.equal((await preview(c.id)).assessment.action, "qualify");
    await updateCandidate(db, c.id, readyForm({ businessName: "A Different Repair Business", website: c.website!, city: c.city!, state: c.state!, phone: "", phoneSourceUrl: "", signal_independent_shop: "unknown", signal_general_repair_services: "yes", signal_collision_repair_services: "unknown", signal_digital_inspections: "unknown", signal_no_online_booking: "unknown" }));
    const edited = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(edited.websiteVerifiedAt, null);
    assert.deepEqual(unreviewedWarnings(await db.candidateResearch.findUniqueOrThrow({ where: { id: run.id } }), await db.candidateNote.findMany({ where: { candidateId: c.id } }), edited), ["The website gives a different business address."]);
    assert.notEqual((await preview(c.id)).assessment.action, "qualify");
  });

  test("overlapping mixed batches and a second fresh pass create only one set of qualification and research work", async () => {
    const a = await historical({ businessName: "First Garage" });
    const b = await historical({ businessName: "Second Garage" });
    const fresh = await candidate({ businessName: "Third Garage" });
    const ids = [a.c.id, b.c.id, fresh.id];
    const selected = (await discoveryAutomationPreview(db)).rows.filter(r => ids.includes(r.id)).map(r => ({ id: r.id, token: r.token }));
    const before = await downstream();
    const raced = await Promise.all([applyDiscoveryBatch(db, selected), applyDiscoveryBatch(db, [...selected].reverse())]).catch(error => {
      assert.fail(JSON.stringify({ code: error.code, metaKeys: Object.keys(error.meta ?? {}), sqlState: error.meta?.code, adapterCode: error.meta?.driverAdapterError?.cause?.originalCode, adapterKind: error.meta?.driverAdapterError?.cause?.kind }));
    });
    assert.equal(raced.flat().filter(r => r.applied).length, 3);
    assert.equal(await db.candidateSignal.count({ where: { key: "automotive_repair_services" } }), 2);
    assert.equal(await db.candidateResearch.count({ where: { candidateId: fresh.id } }), 1);
    const counts = [await db.candidateEvidence.count(), await db.candidateNote.count(), await db.candidateResearch.count()];
    const again = (await discoveryAutomationPreview(db)).rows.filter(r => ids.includes(r.id)).map(r => ({ id: r.id, token: r.token }));
    assert.equal((await applyDiscoveryBatch(db, again)).filter(r => r.applied).length, 0);
    assert.deepEqual([await db.candidateEvidence.count(), await db.candidateNote.count(), await db.candidateResearch.count()], counts);
    assert.deepEqual(await downstream(), before);
  });

  test("a partial batch skips a stale row and completes an independent safe row", async () => {
    const stale = await historical({ businessName: "Stale Garage" });
    const safe = await historical({ businessName: "Safe Garage" });
    const selected = (await discoveryAutomationPreview(db)).rows.map(r => ({ id: r.id, token: r.token }));
    await changeCandidateStatus(db, stale.c.id, "needs_review", "Verify source");
    const result = await applyDiscoveryBatch(db, selected);
    assert.equal(result.find(r => r.id === stale.c.id)?.applied, false);
    assert.equal(result.find(r => r.id === safe.c.id)?.applied, true);
    assert.equal((await preview(stale.c.id)).assessment.code, "human_hold");
    assert.equal((await preview(safe.c.id)).assessment.action, "ready");
    assert.equal(await db.prospect.count(), 0);
    assert.equal(await db.outreach.count(), 0);
  });

  test("machine-written historical service labels cannot turn maintenance-only quotes into primary repair fit", async () => {
    const { c } = await historical({}, "Names general repair, brakes: Our services include oil changes for cars and trucks.");
    assert.equal((await preview(c.id)).assessment.action, "research");
    assert.equal((await applyDiscoveryAutomation(db, c.id)).applied, false);
    assert.equal(await db.candidateSignal.count({ where: { candidateId: c.id, key: "automotive_repair_services" } }), 0);
    assert.equal(await db.prospect.count(), 0);
  });
});
