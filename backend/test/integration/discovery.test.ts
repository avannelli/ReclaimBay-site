import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { scoreCandidate } from "../../src/discovery/approval.js";
import { discoveryProviders, FIXTURE_BUSINESSES } from "../../src/discovery/providers.js";
import * as svc from "../../src/discovery/service.js";
import type { DiscoveryProvider, ResearchFindings, ResearchProvider, ResearchSubject } from "../../src/discovery/types.js";
import { ProspectError, changeStatus, createProspect } from "../../src/prospects.js";
import { WEBSITE, freshDb, readyForm, skipReason, truncate } from "./helpers.js";

const {
  addCandidateEvidence,
  addCandidateNote,
  addManualCandidate,
  applyResearchFindings,
  approveCandidate,
  changeCandidateStatus,
  deleteCandidateEvidence,
  listCandidates,
  runDiscovery,
  updateCandidate,
} = svc;

const fixtureOnly = discoveryProviders({ enableFixtureDiscovery: true });
const VENTURA = { provider: "fixture", region: "Ventura County, CA", businessType: "Independent automotive repair" };

async function rejects(p: Promise<unknown>, pattern: RegExp, kind: ProspectError["kind"] = "invalid") {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ProspectError, `expected ProspectError, got ${String(err)}`);
    assert.equal(err.kind, kind);
    assert.match(err.messages.join(" | "), pattern);
    return true;
  });
}

/** A research provider as a real one would be: findings only, no database access. */
class FixtureResearch implements ResearchProvider {
  readonly name = "fixture-research";
  constructor(private readonly findings: ResearchFindings) {}
  async research(_subject: ResearchSubject) {
    return this.findings;
  }
}

describe("discovery service", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  const candidateByExternalId = (externalId: string) =>
    db.discoveryCandidate.findFirstOrThrow({ where: { provider: "fixture", externalId }, include: { signals: true, evidence: true } });

  /** Full edit form for a candidate (names match the prospect form). */
  const form = (over: Record<string, string> = {}) =>
    readyForm({
      businessName: "Smith Auto",
      signal_no_online_booking: "unknown",
      signal_digital_inspections: "unknown",
      ...over,
    });

  /** A manual candidate taken all the way to Researched with sourced signals. */
  async function researchedCandidate(over: Record<string, string> = {}) {
    const c = await addManualCandidate(db, { businessName: "Smith Auto", website: WEBSITE, city: "Springfield", state: "IL", ...over });
    await updateCandidate(db, c.id, form({ ...over }));
    await changeCandidateStatus(db, c.id, "researching", null);
    const stored = await db.candidateSignal.findMany({ where: { candidateId: c.id } });
    for (const s of stored) {
      await addCandidateEvidence(db, c.id, { signalKey: s.key, sourceUrl: `${WEBSITE}/about`, excerpt: `Public page supports ${s.key}.` });
    }
    await changeCandidateStatus(db, c.id, "researched", null);
    return c;
  }

  describe("discovery runs", () => {
    test("a run stores candidates with provenance and cleaned, normalized data", async () => {
      const run = await runDiscovery(db, fixtureOnly, VENTURA);
      assert.equal(run.status, "completed");
      assert.deepEqual([run.found, run.created, run.duplicates, run.flagged, run.invalid], [7, 6, 1, 1, 0]);
      assert.equal(await db.discoveryCandidate.count(), 6);

      const c = await candidateByExternalId("fx-1001");
      assert.equal(c.businessName, "Conejo Valley Auto Care");
      assert.equal(c.domainKey, "conejoauto.example.com");
      assert.equal(c.nameKey, "conejo valley auto care");
      assert.equal(c.locationKey, "thousand oaks|CA");
      assert.equal(c.phoneKey, "8055550101");
      assert.equal(c.phoneSourceUrl, "https://directory.example.com/listing/fx-1001", "the listing is the phone's public source");
      assert.equal(c.provider, "fixture");
      assert.equal(c.sourceUrl, "https://directory.example.com/listing/fx-1001");
      assert.equal(c.query, "Independent automotive repair in Ventura County, CA");
      assert.equal(c.runId, run.id);
      assert.ok(c.discoveredAt);
      assert.equal(c.status, "discovered");
      assert.equal(c.prospectId, null);
    });

    test("discovery never creates a Prospect, and candidates start unresearched with no signals", async () => {
      await runDiscovery(db, fixtureOnly, VENTURA);
      assert.equal(await db.prospect.count(), 0);
      assert.equal(await db.candidateSignal.count(), 0);
      assert.equal(await db.candidateEvidence.count(), 0);
    });

    test("untrustworthy provider data is cleaned: social pages aren't websites; unsourced phones are dropped", async () => {
      await runDiscovery(db, fixtureOnly, VENTURA);
      const brake = await candidateByExternalId("fx-3001");
      assert.equal(brake.website, null);
      assert.equal(brake.domainKey, null);
      assert.equal(brake.phone, null);
      assert.equal(brake.phoneSourceUrl, null);
      assert.equal(scoreCandidate(brake).breakdown.find((s) => s.key === "has_website")!.state, "unknown");
    });

    test("re-running the same discovery creates nothing new", async () => {
      await runDiscovery(db, fixtureOnly, VENTURA);
      const second = await runDiscovery(db, fixtureOnly, VENTURA);
      assert.deepEqual([second.found, second.created, second.duplicates], [7, 0, 7]);
      assert.equal(await db.discoveryCandidate.count(), 6);
      assert.equal(await db.discoveryRun.count(), 2);
    });

    test("CONFIDENT duplicates are skipped: same provider ID, or same website domain under a new ID", async () => {
      await runDiscovery(db, fixtureOnly, VENTURA);
      assert.equal(await db.discoveryCandidate.count({ where: { externalId: "fx-1001-b" } }), 0, "domain match skipped");
      assert.equal(await db.discoveryCandidate.count({ where: { domainKey: "conejoauto.example.com" } }), 1);
    });

    test("WEAK matches are stored and flagged for review, never dropped", async () => {
      await runDiscovery(db, fixtureOnly, VENTURA);
      const first = await candidateByExternalId("fx-2001");
      const second = await candidateByExternalId("fx-2002");
      assert.equal(first.status, "discovered", "the first occurrence is unflagged");
      assert.equal(second.status, "needs_review");
      assert.equal(second.possibleDuplicateCandidateId, first.id);
      assert.equal(second.possibleDuplicateProspectId, null);
      assert.equal(second.duplicateReason, "candidate: same name and city");
    });

    test("a shared phone number alone is flagged, not skipped", async () => {
      const provider: DiscoveryProvider = {
        name: "fixture",
        label: "t",
        discover: async () => [
          { externalId: "a", businessName: "Alpha Auto", city: "Ojai", state: "CA", phone: "(805) 555-0777", sourceUrl: "https://d.example.com/a" },
          { externalId: "b", businessName: "Bravo Motors", city: "Fillmore", state: "CA", phone: "805-555-0777", sourceUrl: "https://d.example.com/b" },
        ],
      };
      const run = await runDiscovery(db, new Map([["fixture", provider]]), VENTURA);
      assert.deepEqual([run.created, run.duplicates, run.flagged], [2, 0, 1]);
      assert.equal((await candidateByExternalId("b")).duplicateReason, "candidate: same phone number");
    });

    test("the city narrows the search", async () => {
      const run = await runDiscovery(db, fixtureOnly, { ...VENTURA, city: "Ventura" });
      assert.equal(run.created, 2);
      assert.equal(run.city, "Ventura");
      assert.equal((await candidateByExternalId("fx-2001")).query, "Independent automotive repair in Ventura, Ventura County, CA");
    });

    test("an invalid run is refused without creating a run", async () => {
      await rejects(runDiscovery(db, fixtureOnly, { ...VENTURA, provider: "nope" }), /available discovery provider/);
      await rejects(runDiscovery(db, fixtureOnly, { ...VENTURA, region: "  " }), /Region is required/);
      await rejects(runDiscovery(db, discoveryProviders({ enableFixtureDiscovery: false }), VENTURA), /available discovery provider/);
      assert.equal(await db.discoveryRun.count(), 0);
    });

    test("the fixture provider is off in production config", () => {
      assert.equal(discoveryProviders({ enableFixtureDiscovery: false }).size, 0);
    });

    test("a provider failure is recorded on the run, redacted, and stores nothing", async () => {
      const broken: DiscoveryProvider = {
        name: "fixture",
        label: "broken",
        discover: async () => {
          throw new Error("401 from https://api.example.com/search?key=SECRET123");
        },
      };
      const run = await runDiscovery(db, new Map([["fixture", broken]]), VENTURA);
      assert.equal(run.status, "failed");
      assert.match(run.error!, /Provider error/);
      assert.doesNotMatch(run.error!, /SECRET123|api\.example\.com/);
      assert.equal(await db.discoveryCandidate.count(), 0);
    });

    test("records the provider returns are counted, and unusable ones are skipped as invalid", async () => {
      const provider: DiscoveryProvider = {
        name: "fixture",
        label: "t",
        discover: async () => [{ businessName: "  " }, { businessName: "Good Garage", city: "Ojai", state: "CA" }],
      };
      const run = await runDiscovery(db, new Map([["fixture", provider]]), VENTURA);
      assert.deepEqual([run.found, run.created, run.invalid], [2, 1, 1]);
    });

    test("a run is capped at MAX_RESULTS_PER_RUN records", async () => {
      const provider: DiscoveryProvider = {
        name: "fixture",
        label: "t",
        discover: async () =>
          Array.from({ length: svc.MAX_RESULTS_PER_RUN + 25 }, (_, i) => ({ externalId: `n${i}`, businessName: `Shop Number ${i}` })),
      };
      const run = await runDiscovery(db, new Map([["fixture", provider]]), VENTURA);
      assert.equal(run.found, svc.MAX_RESULTS_PER_RUN);
    });

    test("fixture data is synthetic (example.com only)", () => {
      for (const b of FIXTURE_BUSINESSES) {
        for (const url of [b.website, b.sourceUrl]) if (url) assert.match(url, /example\.com|facebook\.com/);
      }
    });
  });

  describe("existing prospects are authoritative", () => {
    test("a confident match with a prospect is skipped, and the prospect is untouched", async () => {
      const p = await createProspect(db, readyForm({ businessName: "Conejo Auto", website: "https://www.conejoauto.example.com" }));
      const before = await db.prospect.findUniqueOrThrow({ where: { id: p.id } });
      const run = await runDiscovery(db, fixtureOnly, VENTURA);
      assert.equal(await db.discoveryCandidate.count({ where: { externalId: "fx-1001" } }), 0, "domain matches the prospect");
      assert.ok(run.duplicates >= 1);
      assert.deepEqual(await db.prospect.findUniqueOrThrow({ where: { id: p.id } }), before);
    });

    test("a weak match with a prospect creates a flagged candidate and changes nothing else", async () => {
      const p = await createProspect(db, { businessName: "Harbor Street Garage", city: "Ventura", state: "CA", website: "https://different.example.com" });
      const before = await db.prospect.findUniqueOrThrow({ where: { id: p.id } });
      await runDiscovery(db, fixtureOnly, VENTURA);
      const c = await candidateByExternalId("fx-2001");
      assert.equal(c.status, "needs_review");
      assert.equal(c.possibleDuplicateProspectId, p.id);
      assert.match(c.duplicateReason!, /prospect: same name and city/);
      assert.deepEqual(await db.prospect.findUniqueOrThrow({ where: { id: p.id } }), before);
      assert.equal(await db.prospect.count(), 1, "no new prospect");
    });

    test("a rejected candidate is not resurrected by a later run", async () => {
      await runDiscovery(db, fixtureOnly, VENTURA);
      const c = await candidateByExternalId("fx-1002");
      await changeCandidateStatus(db, c.id, "rejected", "Import specialist only");
      await runDiscovery(db, fixtureOnly, VENTURA);
      const after = await candidateByExternalId("fx-1002");
      assert.equal(after.status, "rejected");
      assert.equal(await db.discoveryCandidate.count({ where: { externalId: "fx-1002" } }), 1);
    });
  });

  describe("manual candidates", () => {
    test("are added with the manual provider and the same validation", async () => {
      const c = await addManualCandidate(db, { businessName: "Ojai Auto", city: "Ojai", state: "ca", website: "ojaiauto.example.com" });
      assert.equal(c.provider, "manual");
      assert.equal(c.state, "CA");
      assert.equal(c.domainKey, "ojaiauto.example.com");
      assert.equal(c.status, "discovered");
      await rejects(addManualCandidate(db, { city: "Ojai" }), /Business name is required/);
      await rejects(addManualCandidate(db, { businessName: "X", phone: "(805) 555-0100" }), /public URL where it is listed/);
      await rejects(addManualCandidate(db, { businessName: "X", website: "javascript:1" }), /valid http\(s\) URL/);
    });

    test("a confident duplicate is refused; a weak match is flagged", async () => {
      await addManualCandidate(db, { businessName: "Ojai Auto", city: "Ojai", state: "CA", website: "https://ojaiauto.example.com" });
      await rejects(
        addManualCandidate(db, { businessName: "Ojai Automotive", website: "https://www.ojaiauto.example.com/x" }),
        /Already a candidate \(same website domain\)/,
        "conflict",
      );
      const weak = await addManualCandidate(db, { businessName: "Ojai Auto", city: "Ojai", state: "CA", website: "https://another.example.com" });
      assert.equal(weak.status, "needs_review");
    });
  });

  describe("research: edits, evidence, lifecycle", () => {
    test("signals are recorded with the prospect validators and keys follow edits", async () => {
      const c = await addManualCandidate(db, { businessName: "Smith Auto", city: "Springfield", state: "IL" });
      await updateCandidate(db, c.id, form({ website: "https://newsite.example.com" }));
      const stored = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: { signals: true } });
      assert.equal(stored.domainKey, "newsite.example.com");
      assert.deepEqual(stored.signals.map((s) => s.key).sort(), ["general_repair_services", "independent_shop"]);
      await rejects(updateCandidate(db, c.id, form({ signal_has_website: "yes" })), /set automatically/);
      await rejects(updateCandidate(db, c.id, form({ website: "", phone: "", phoneSourceUrl: "", signal_no_online_booking: "no" })), /only be observed on a website/);
      await rejects(updateCandidate(db, c.id, form({ phoneSourceUrl: "" })), /public URL where it is listed/);
      await rejects(updateCandidate(db, c.id, form({ businessName: "" })), /Business name is required/);
    });

    test("Researched requires evidence for every recorded signal", async () => {
      const c = await addManualCandidate(db, { businessName: "Smith Auto", website: WEBSITE, city: "Springfield", state: "IL" });
      await updateCandidate(db, c.id, form());
      await changeCandidateStatus(db, c.id, "researching", null);
      await rejects(changeCandidateStatus(db, c.id, "researched", null), /at least one evidence/);
      await addCandidateEvidence(db, c.id, { signalKey: "independent_shop", sourceUrl: `${WEBSITE}/about`, excerpt: "Family owned since 1984." });
      await rejects(changeCandidateStatus(db, c.id, "researched", null), /general_repair_services/);
      await addCandidateEvidence(db, c.id, { signalKey: "general_repair_services", sourceUrl: `${WEBSITE}/services`, excerpt: "Brakes, A/C, diagnostics, oil service." });
      await changeCandidateStatus(db, c.id, "researched", null);
      const done = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(done.status, "researched");
      assert.ok(done.researchedAt);
    });

    test("a Researched candidate can't lose the sourcing of a signal", async () => {
      const c = await researchedCandidate();
      const ev = await db.candidateEvidence.findFirstOrThrow({ where: { candidateId: c.id, signalKey: "independent_shop" } });
      await rejects(deleteCandidateEvidence(db, c.id, ev.id), /independent_shop/);
      await rejects(updateCandidate(db, c.id, form({ signal_digital_inspections: "yes" })), /digital_inspections/);
      await changeCandidateStatus(db, c.id, "researching", null);
      await deleteCandidateEvidence(db, c.id, ev.id);
    });

    test("evidence is validated like a prospect's: known signal, public URL, excerpt <= 280", async () => {
      const c = await addManualCandidate(db, { businessName: "Smith Auto" });
      const ok = { signalKey: "independent_shop", sourceUrl: `${WEBSITE}/a`, excerpt: "Independent." };
      await addCandidateEvidence(db, c.id, ok);
      await rejects(addCandidateEvidence(db, c.id, { ...ok, signalKey: "made_up" }), /Choose the signal/);
      await rejects(addCandidateEvidence(db, c.id, { ...ok, sourceUrl: "ftp://x.example.com" }), /public http/);
      await rejects(addCandidateEvidence(db, c.id, { ...ok, excerpt: "z".repeat(281) }), /at most 280/);
      await rejects(addCandidateEvidence(db, "00000000-0000-4000-8000-000000000000", ok), /not found/, "not_found");
      assert.equal(await db.candidateEvidence.count(), 1);
    });

    test("notes are added and bounded", async () => {
      const c = await addManualCandidate(db, { businessName: "Smith Auto" });
      await addCandidateNote(db, c.id, "  Called; owner out until Monday.  ");
      await rejects(addCandidateNote(db, c.id, " "), /can't be empty/);
      await rejects(addCandidateNote(db, c.id, "x".repeat(2001)), /too long/);
      assert.equal((await db.candidateNote.findFirstOrThrow({ where: { candidateId: c.id } })).body, "Called; owner out until Monday.");
    });

    test("reject / duplicate need a reason, and reopening clears the decision", async () => {
      const c = await addManualCandidate(db, { businessName: "Smith Auto" });
      await rejects(changeCandidateStatus(db, c.id, "rejected", " "), /requires a reason/);
      await changeCandidateStatus(db, c.id, "rejected", "Collision shop only");
      const rejected = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(rejected.decisionReason, "Collision shop only");
      assert.ok(rejected.decidedAt);
      await changeCandidateStatus(db, c.id, "discovered", null);
      const reopened = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(reopened.decisionReason, null);
      assert.equal(reopened.decidedAt, null);
      await rejects(changeCandidateStatus(db, c.id, "approved", "x"), /Use Approve/);
      await rejects(changeCandidateStatus(db, c.id, "bogus", null), /Unknown status/);
    });

    test("racing identical status changes: exactly one applies", async () => {
      const c = await addManualCandidate(db, { businessName: "Smith Auto" });
      const results = await Promise.allSettled([
        changeCandidateStatus(db, c.id, "researching", null),
        changeCandidateStatus(db, c.id, "researching", null),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    });
  });

  describe("research provider findings", () => {
    let n = 0;
    // Each candidate gets its own domain: a shared one would (correctly) be refused as a duplicate.
    const fresh = () =>
      addManualCandidate(db, { businessName: `Smith Auto ${++n}`, website: `https://smith${n}.example.com`, city: "Springfield", state: "IL" });
    const good: ResearchFindings = {
      signals: { independent_shop: "yes", general_repair_services: "yes" },
      evidence: [
        { signalKey: "independent_shop", sourceUrl: `${WEBSITE}/about`, excerpt: "Family owned and operated." },
        { signalKey: "general_repair_services", sourceUrl: `${WEBSITE}/services`, excerpt: "Brakes, A/C, suspension." },
      ],
    };

    test("applies evidence-backed findings and leaves the candidate Researched for a human", async () => {
      const c = await fresh();
      const findings = await new FixtureResearch(good).research({ businessName: c.businessName, website: c.website, city: c.city, state: c.state });
      const updated = await applyResearchFindings(db, c.id, findings, "fixture-research");
      assert.equal(updated.status, "researched");
      assert.equal(await db.candidateEvidence.count({ where: { candidateId: c.id } }), 2);
      const stored = await candidateByExternalIdless(c.id);
      assert.equal(scoreCandidate(stored).qualification, "meets_criteria");
      assert.equal(await db.prospect.count(), 0, "research never creates a prospect");
      assert.match((await db.candidateNote.findFirstOrThrow({ where: { candidateId: c.id } })).body, /Research applied by fixture-research: 2 signal\(s\), 2 evidence item\(s\)/);
    });

    test("unknown stays unknown: a yes/no without evidence is refused", async () => {
      const c = await fresh();
      await rejects(
        applyResearchFindings(db, c.id, { signals: { multiple_bays_or_staff: "yes" }, evidence: [] }, "fixture-research"),
        /multiple_bays_or_staff/,
      );
      await rejects(
        applyResearchFindings(db, c.id, { signals: { independent_shop: "yes" }, evidence: [good.evidence[1]!] }, "fixture-research"),
        /independent_shop/,
      );
      assert.equal(await db.candidateSignal.count(), 0, "nothing partially applied");
    });

    test("invalid findings are refused: unknown keys, derived yes, oversized excerpts", async () => {
      const c = await fresh();
      await rejects(applyResearchFindings(db, c.id, { signals: { in_target_region: "yes" } as never, evidence: [] }, "p"), /Unknown signal/);
      await rejects(
        applyResearchFindings(db, c.id, { signals: { has_website: "yes" }, evidence: [{ signalKey: "has_website", sourceUrl: WEBSITE, excerpt: "x" }] }, "p"),
        /set automatically/,
      );
      await rejects(
        applyResearchFindings(db, c.id, { signals: {}, evidence: [{ signalKey: "independent_shop", sourceUrl: WEBSITE, excerpt: "y".repeat(400) }] }, "p"),
        /at most 280/,
      );
    });

    test("never overwrites contact details a person already entered, and needs a source for new ones", async () => {
      const c = await addManualCandidate(db, { businessName: "Smith Auto Phone", website: "https://phone.example.com", city: "Springfield", state: "IL", phone: "(805) 555-0100", phoneSourceUrl: `${WEBSITE}/contact` });
      await applyResearchFindings(db, c.id, { ...good, contact: { phone: "(999) 555-0000", phoneSourceUrl: "https://elsewhere.example.com" } }, "p");
      assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).phone, "(805) 555-0100");
      const d = await fresh();
      await rejects(applyResearchFindings(db, d.id, { ...good, contact: { email: "shop@smith.example.com" } }, "p"), /Email needs the public URL/);
      await applyResearchFindings(db, d.id, { ...good, contact: { email: "shop@smith.example.com", emailSourceUrl: `${WEBSITE}/contact` } }, "p");
      assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: d.id } })).email, "shop@smith.example.com");
    });

    test("refused for rejected or approved candidates", async () => {
      const c = await fresh();
      await changeCandidateStatus(db, c.id, "rejected", "no");
      await rejects(applyResearchFindings(db, c.id, good, "p"), /Reopen this rejected candidate/);
      const r = await researchedCandidate({ businessName: "Approved Auto", website: "https://approved.example.com" });
      await approveCandidate(db, r.id);
      await rejects(applyResearchFindings(db, r.id, good, "p"), /approved/, "conflict");
    });

    function candidateByExternalIdless(id: string) {
      return db.discoveryCandidate.findUniqueOrThrow({ where: { id }, include: { signals: true } });
    }
  });

  describe("listing and filtering", () => {
    test("filters by status, search, geography, flag, provider, qualification, and band; sorts by score", async () => {
      await runDiscovery(db, fixtureOnly, VENTURA);
      const ids = async (f: svc.CandidateFilters) => (await listCandidates(db, f)).rows.map((r) => r.candidate.externalId ?? r.candidate.businessName);
      assert.equal((await listCandidates(db, {})).total, 6);
      assert.deepEqual(await ids({ status: "needs_review" }), ["fx-2002"]);
      assert.deepEqual(await ids({ flagged: "1" }), ["fx-2002"]);
      assert.deepEqual(await ids({ q: "harbor" }), ["fx-2002", "fx-2001"]);
      assert.deepEqual((await ids({ state: "ca", city: "camarillo" })), ["fx-3001"]);
      assert.deepEqual((await ids({ provider: "manual" })), []);
      assert.equal((await listCandidates(db, { qualification: "unverified" })).total, 6, "nothing researched yet");
      assert.equal((await listCandidates(db, { qualification: "meets_criteria" })).total, 0);
      assert.equal((await listCandidates(db, { band: "low" })).total, 6);
      assert.equal((await listCandidates(db, { status: "nonsense", band: "nonsense", sort: "nonsense" })).total, 6);

      const c = await candidateByExternalId("fx-4001");
      await updateCandidate(db, c.id, form({ businessName: "Simi Valley Motor Works", website: "", phone: "", phoneSourceUrl: "", signal_no_online_booking: "unknown", signal_digital_inspections: "unknown" }));
      assert.deepEqual(await ids({ qualification: "meets_criteria" }), ["fx-4001"]);
      assert.equal((await listCandidates(db, { qualification: "unverified" })).total, 5);
      assert.deepEqual(await ids({ band: "medium" }), ["fx-4001"], "45 points");
      assert.equal((await ids({ sort: "score" }))[0], "fx-4001");
      assert.deepEqual((await ids({ sort: "name" }))[0], "fx-3001");
    });

    test("list rows carry the same scoring result as the detail page (computed, never stored)", async () => {
      await runDiscovery(db, fixtureOnly, VENTURA);
      const { rows } = await listCandidates(db, {});
      const detail = await svc.getCandidateDetail(db, rows[0]!.candidate.id);
      assert.deepEqual(detail!.result, rows[0]!.result);
    });
  });

  describe("approval", () => {
    test("creates a Prospect at status New through the existing path, with facts, signals, evidence, and provenance", async () => {
      const run = await runDiscovery(db, fixtureOnly, VENTURA);
      const c = await candidateByExternalId("fx-1001");
      await updateCandidate(db, c.id, form({ businessName: "Conejo Valley Auto Care", website: "https://conejoauto.example.com", city: "Thousand Oaks", state: "CA", postalCode: "91360", phone: "(805) 555-0101", phoneSourceUrl: "https://directory.example.com/listing/fx-1001" }));
      await changeCandidateStatus(db, c.id, "researching", null);
      await addCandidateEvidence(db, c.id, { signalKey: "independent_shop", sourceUrl: "https://conejoauto.example.com/about", excerpt: "Family owned since 1984." });
      await addCandidateEvidence(db, c.id, { signalKey: "general_repair_services", sourceUrl: "https://conejoauto.example.com/services", excerpt: "Brakes, A/C, diagnostics." });
      await changeCandidateStatus(db, c.id, "researched", null);
      const signalsBefore = await db.candidateSignal.findMany({ where: { candidateId: c.id } });

      const { prospect } = await approveCandidate(db, c.id);

      const p = await db.prospect.findUniqueOrThrow({ where: { id: prospect.id }, include: { signals: true, evidence: true, notes: true, statusChanges: true } });
      assert.equal(p.status, "new", "approval never sets Qualified or Ready to contact");
      assert.match(p.referralCode, /^rb_[a-z0-9]{12}$/);
      assert.equal(p.businessName, "Conejo Valley Auto Care");
      assert.equal(p.website, "https://conejoauto.example.com/");
      assert.deepEqual([p.city, p.state, p.postalCode, p.country], ["Thousand Oaks", "CA", "91360", "US"]);
      assert.equal(p.phone, "(805) 555-0101");
      assert.equal(p.phoneSourceUrl, "https://directory.example.com/listing/fx-1001");

      // Signals: same keys, values, and observation times.
      assert.deepEqual(p.signals.map((s) => [s.key, s.value, s.observedAt.getTime()]).sort(), signalsBefore.map((s) => [s.key, s.value, s.observedAt.getTime()]).sort());
      // Evidence: transferred with excerpts, URLs, and original timestamps.
      assert.equal(p.evidence.length, 2);
      const candEvidence = await db.candidateEvidence.findMany({ where: { candidateId: c.id } });
      assert.deepEqual(p.evidence.map((e) => [e.signalKey, e.sourceUrl, e.excerpt, e.createdAt.getTime()]).sort(), candEvidence.map((e) => [e.signalKey, e.sourceUrl, e.excerpt, e.createdAt.getTime()]).sort());
      // Score cache agrees with scoring.ts run on the candidate.
      const candidate = await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id }, include: { signals: true } });
      assert.equal(p.score, scoreCandidate(candidate).score);
      assert.equal(p.score, 60);
      // History and provenance.
      assert.deepEqual(p.statusChanges.map((h) => [h.fromStatus, h.toStatus, h.reason]), [[null, "new", "Created"]]);
      assert.equal(p.notes.length, 1);
      for (const part of ["Approved by a human", "Provider: fixture", "fx-1001", "directory.example.com/listing/fx-1001", "Independent automotive repair in Ventura County, CA", c.id, run.id]) {
        assert.ok(p.notes[0]!.body.includes(part), `provenance note has ${part}`);
      }

      // The candidate is kept, linked, and frozen.
      assert.equal(candidate.status, "approved");
      assert.equal(candidate.prospectId, prospect.id);
      assert.ok(candidate.approvedAt);
      assert.equal(candidate.provider, "fixture", "discovery provenance is preserved");
      assert.equal(candidate.externalId, "fx-1001");
      assert.equal(candidate.runId, run.id);
      assert.equal(await db.prospect.count(), 1);
    });

    test("approval does not bypass qualification or status rules", async () => {
      // Unverified: only one required criterion established.
      const c = await addManualCandidate(db, { businessName: "Half Known Auto", website: WEBSITE, city: "Ojai", state: "CA", phone: "(805) 555-0100", phoneSourceUrl: `${WEBSITE}/contact` });
      await updateCandidate(db, c.id, form({ businessName: "Half Known Auto", city: "Ojai", state: "CA", signal_general_repair_services: "unknown" }));
      await changeCandidateStatus(db, c.id, "researching", null);
      await addCandidateEvidence(db, c.id, { signalKey: "independent_shop", sourceUrl: `${WEBSITE}/about`, excerpt: "Independent." });
      await changeCandidateStatus(db, c.id, "researched", null);
      const { prospect } = await approveCandidate(db, c.id);
      assert.equal(prospect.status, "new");
      await rejects(changeStatus(db, prospect.id, "qualified", null), /this prospect is Unverified/);
      await rejects(changeStatus(db, prospect.id, "ready_to_contact", null), /Can't move from New/);

      // Meets criteria: Qualified is now available, but only by a separate, explicit step.
      const r = await researchedCandidate({ businessName: "Fully Known Auto", website: "https://fullyknown.example.com", city: "Fillmore", state: "CA" });
      const { prospect: ok } = await approveCandidate(db, r.id);
      assert.equal(ok.status, "new", "a fully qualified candidate still enters as New");
      await changeStatus(db, ok.id, "qualified", null);
      assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: ok.id } })).status, "qualified");
    });

    test("a disqualified candidate can be approved into the pipeline but can never be qualified", async () => {
      const r = await researchedCandidate({ businessName: "Chain Store", website: "https://chain.example.com", city: "Ventura", state: "CA", signal_independent_shop: "no" });
      const { prospect } = await approveCandidate(db, r.id);
      assert.equal(prospect.status, "new");
      await rejects(changeStatus(db, prospect.id, "qualified", null), /Disqualified/);
    });

    test("only Researched or Needs review candidates can be approved", async () => {
      for (const to of ["discovered", "researching"] as const) {
        const c = await addManualCandidate(db, { businessName: `Shop ${to}` });
        if (to === "researching") await changeCandidateStatus(db, c.id, "researching", null);
        await rejects(approveCandidate(db, c.id), /Only Researched or Needs review/);
      }
      const rejected = await addManualCandidate(db, { businessName: "Rejected Shop" });
      await changeCandidateStatus(db, rejected.id, "rejected", "no");
      await rejects(approveCandidate(db, rejected.id), /Only Researched or Needs review/);
      const dup = await addManualCandidate(db, { businessName: "Dup Shop" });
      await changeCandidateStatus(db, dup.id, "duplicate", "same as X");
      await rejects(approveCandidate(db, dup.id), /Only Researched or Needs review/);
      assert.equal(await db.prospect.count(), 0, "rejected and duplicate candidates never become prospects");
    });

    test("a Needs review candidate is approvable once it is evidence-backed, and not before", async () => {
      const c = await addManualCandidate(db, { businessName: "Flagged Auto", website: WEBSITE, city: "Ojai", state: "CA" });
      await changeCandidateStatus(db, c.id, "needs_review", null);
      await rejects(approveCandidate(db, c.id), /at least one evidence/);
      await updateCandidate(db, c.id, form({ businessName: "Flagged Auto", city: "Ojai", state: "CA" }));
      await addCandidateEvidence(db, c.id, { signalKey: "independent_shop", sourceUrl: `${WEBSITE}/a`, excerpt: "Independent." });
      await rejects(approveCandidate(db, c.id), /general_repair_services/);
      await addCandidateEvidence(db, c.id, { signalKey: "general_repair_services", sourceUrl: `${WEBSITE}/b`, excerpt: "Brakes and A/C." });
      const { prospect } = await approveCandidate(db, c.id);
      assert.equal(prospect.status, "new");
    });

    test("an existing prospect with the same domain blocks approval: mark it a duplicate instead", async () => {
      const c = await researchedCandidate({ businessName: "Smith Auto", website: "https://smithauto.example.com", city: "Springfield", state: "IL" });
      await createProspect(db, { businessName: "Smith Automotive", website: "https://www.smithauto.example.com/home" });
      await rejects(approveCandidate(db, c.id), /same website domain already exists.*duplicate/);
      assert.equal(await db.prospect.count(), 1);
      assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "researched", "unchanged after refusal");
      await changeCandidateStatus(db, c.id, "duplicate", "Already a prospect");
    });

    test("approving twice, or editing after approval, is refused", async () => {
      const c = await researchedCandidate();
      await approveCandidate(db, c.id);
      await rejects(approveCandidate(db, c.id), /Already approved/, "conflict");
      await rejects(updateCandidate(db, c.id, form()), /is now a prospect/, "conflict");
      await rejects(addCandidateNote(db, c.id, "late"), /is now a prospect/, "conflict");
      await rejects(changeCandidateStatus(db, c.id, "rejected", "x"), /already a prospect/);
      assert.equal(await db.prospect.count(), 1);
    });

    test("simultaneous approvals create exactly one prospect", async () => {
      const c = await researchedCandidate();
      const results = await Promise.allSettled([approveCandidate(db, c.id), approveCandidate(db, c.id), approveCandidate(db, c.id)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(await db.prospect.count(), 1);
    });

    test("an invalid candidate can't be approved into an invalid prospect", async () => {
      const c = await researchedCandidate();
      // Corrupt the stored record the way a bad provider row might.
      await db.discoveryCandidate.update({ where: { id: c.id }, data: { phone: "555-0100", phoneSourceUrl: null } });
      await rejects(approveCandidate(db, c.id), /public URL where it is listed/);
      assert.equal(await db.prospect.count(), 0);
      assert.equal((await db.discoveryCandidate.findUniqueOrThrow({ where: { id: c.id } })).status, "researched");
    });

    test("approval leaves other prospects and analytics attribution untouched", async () => {
      const other = await createProspect(db, readyForm({ businessName: "Other Shop", website: "https://other.example.com" }));
      const before = await db.prospect.findUniqueOrThrow({ where: { id: other.id } });
      const c = await researchedCandidate();
      await approveCandidate(db, c.id);
      assert.deepEqual(await db.prospect.findUniqueOrThrow({ where: { id: other.id } }), before);
      assert.equal(await db.analyticsSession.count(), 0);
      assert.equal(await db.productEvent.count(), 0);
    });
  });
});
