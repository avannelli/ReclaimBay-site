import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calibrateSnapshot, type ReadySnapshot } from "../../src/discovery/calibration.js";
import { calibrationMarkdown } from "../../src/discovery/calibrationReport.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";

/* R16.2 calibration from a read-only snapshot: deterministic, never mutating, and explicit about
 * what is missing evidence versus negative evidence. All businesses and domains are synthetic. */

const AT = "2026-10-14T06:00:00.000Z";
const CLEAR = { protected: false, prospectIds: [] as string[], outreachIds: [] as string[], suppression: false, optOut: false, matches: [] as unknown[], duplicateTargetConflict: null as string | null };
let n = 0;
const uuid = (prefix: string) => `${prefix}${String(++n).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(0, 36);

function candidate(name: string, opts: { version?: string; quotes?: string[]; address?: "verified" | "unverified"; phone?: string; providerPhone?: string; street?: string; website?: string;
  signals?: { key: string; value: string; origin?: string }[]; protection?: typeof CLEAR; facts?: { field: string; value: string; state?: string }[] } = {}) {
  const id = uuid("c");
  const run = uuid("r");
  const website = opts.website ?? `https://${name.toLowerCase().replace(/[^a-z]/g, "")}.example.com/`;
  const quotes = opts.quotes ?? ["Names brakes: Brake repair for cars.", "Names engine: Engine repair for cars."];
  return {
    id, name, city: "Ventura", state: "CA", website, streetAddress: opts.street ?? `${n} Main St`, phone: opts.phone ?? null, providerPhone: opts.providerPhone ?? null,
    status: "researched", prospectId: null, possibleDuplicateCandidateId: null, possibleDuplicateProspectId: null, duplicateReason: null, relatedCandidateId: null, relatedProspectId: null,
    categoryVerdict: "in_target", categoryReason: "Fixture.", websiteVerifiedAt: AT, assessment: { action: "ready", code: "qualified" }, protection: opts.protection ?? CLEAR,
    signals: (opts.signals ?? [{ key: "automotive_repair_services", value: "yes" }]).map((s, i) => ({ id: i + 1, candidateId: id, key: s.key, value: s.value, origin: s.origin ?? "research", observedAt: AT })),
    evidence: quotes.map((excerpt, i) => ({ id: `${id.slice(0, 30)}e${i}`, candidateId: id, signalKey: "automotive_repair_services", sourceUrl: website, excerpt, createdAt: AT, origin: "research", researchId: run })),
    notes: [],
    research: [{ id: run, candidateId: id, status: "completed", version: opts.version ?? "r15", trigger: "cli", outcome: "website_verified", pagesFetched: 3, warnings: [], error: null,
      queuedAt: AT, startedAt: AT, heartbeatAt: AT, finishedAt: AT, candidateRevision: 0, subjectWebsite: website, sources: [{ id: `${run.slice(0, 30)}s`, researchId: run, kind: "website", url: website, finalUrl: null, ok: true }],
      facts: [{ field: "address", value: "1 Main St", state: opts.address ?? "verified" }, ...(opts.facts ?? [])].map((f, i) => ({ id: `${run.slice(0, 30)}f${i}`, researchId: run, field: f.field, value: f.value, state: f.state ?? "verified", sourceId: null, excerpt: null, note: null, confidence: null })) }],
  };
}

function fixture(): ReadySnapshot {
  n = 0;
  const flagged = candidate("Flagged Target Garage");
  return {
    checkedAt: AT, readOnly: "on", deployedCommit: "c0d98e145a828188c7008daf7b292df700754e61",
    candidates: [
      candidate("Strong Stale Garage"),
      candidate("Label Only Garage", { quotes: ["Names collision/body, engine, brakes: We offer collision repair."] }),
      candidate("Loose Label Garage", { quotes: ["Names brakes, engine diagnostics, maintenance/oil service, A/C, transmission: Welcome to our shop."] }),
      candidate("Negative Garage", { quotes: ["We do not perform automotive repairs."], signals: [{ key: "automotive_repair_services", value: "no" }] }),
      candidate("Protected Garage", { protection: { ...CLEAR, protected: true, prospectIds: ["p0000000-0000-4000-8000-000000000000"] } }),
      candidate("Shared Phone One", { phone: "(805) 555-0199" }),
      candidate("Shared Phone Two", { phone: "(805) 555-0199" }),
      candidate("Unverified Address Garage", { address: "unverified" }),
      candidate("Current Rules Garage", { version: RESEARCH_VERSION, facts: [{ field: "location_identity", value: "unverified", state: "uncertain" }] }),
      flagged,
    ],
    neighboring: [{ ...candidate("Flag Raiser"), status: "needs_review", possibleDuplicateCandidateId: flagged.id }],
  } as unknown as ReadySnapshot;
}
const byName = (snapshot: ReadySnapshot) => {
  const r = calibrateSnapshot(snapshot);
  return { result: r, row: (name: string) => r.rows.find((x) => x.name === name)! };
};

describe("R16.2 readiness calibration (snapshot)", () => {
  test("deterministic: same result and report regardless of input order", () => {
    const a = calibrateSnapshot(fixture());
    const shuffled = fixture(); shuffled.candidates.reverse();
    const b = calibrateSnapshot(shuffled);
    assert.deepEqual(a, b);
    assert.equal(calibrationMarkdown(a), calibrationMarkdown(b));
    assert.deepEqual(a.rows.map((r) => r.id), [...a.rows.map((r) => r.id)].sort());
  });
  test("zero mutation: the snapshot passed in is unchanged", () => {
    const s = fixture(); const before = structuredClone(s);
    calibrateSnapshot(s);
    assert.deepEqual(s, before);
  });
  test("stale evidence: an older run is never Ready; it gets one re-read and its projection is marked insufficient", () => {
    const { row } = byName(fixture());
    const r = row("Strong Stale Garage");
    assert.deepEqual([r.current.action, r.current.code, r.immediate], ["research", "policy_refresh", "fresh_research"]);
    assert.equal(r.projection.outcome, "likely_ready_after_reread");
    assert.equal(r.projection.sufficient, false);
    assert.match(r.projection.basis, /insufficient under r16/);
    for (const f of ["location_identity", "page_location", "ownership_class"]) assert.ok(r.projection.missingEvidence.includes(f), f);
  });
  test("missing evidence is distinct from confirmed negative evidence", () => {
    const { row, result } = byName(fixture());
    const negative = row("Negative Garage");
    assert.equal(negative.projection.outcome, "confirmed_negative");
    assert.ok(negative.projection.negativeEvidence.some((e) => e.kind.startsWith("automotive_repair_services=no")));
    const missing = row("Loose Label Garage");
    assert.equal(missing.projection.negativeEvidence.length, 0);
    assert.equal(missing.projection.outcome, "likely_service_evidence_hold");
    assert.equal(result.summary.negativeVersusMissing.confirmedNegative, 1);
  });
  test("a strict historical label is a likely storage artefact; a loose single-word label is not evidence", () => {
    const { row } = byName(fixture());
    const strict = row("Label Only Garage");
    assert.equal(strict.projection.outcome, "likely_restored_by_reread");
    assert.deepEqual(strict.projection.service.labelOnly, ["brakes", "engine"]);
    assert.ok(strict.reviewFlags.some((f) => /storage artefact/.test(f)));
    const loose = row("Loose Label Garage");
    assert.deepEqual(loose.projection.service.labelOnly, []);
    assert.ok(loose.projection.service.looseLabels.includes("brakes"));
    assert.ok(loose.reviewFlags.some((f) => /single-word scan/.test(f)));
  });
  test("protected identities stay protected", () => {
    const { row } = byName(fixture());
    const r = row("Protected Garage");
    assert.deepEqual([r.current.action, r.immediate], ["protected", "protected"]);
    assert.equal(r.projection.outcome, "likely_account_or_duplicate_hold");
  });
  test("duplicate relationships: a shared phone holds both; an unresolvable inbound flag is reported, not held", () => {
    const { row } = byName(fixture());
    for (const name of ["Shared Phone One", "Shared Phone Two"]) {
      const r = row(name);
      assert.ok(r.relationships.blocking.some((b) => /Same phone number/.test(b)), name);
      assert.equal(r.projection.outcome, "likely_account_or_duplicate_hold");
    }
    const flagged = row("Flagged Target Garage");
    assert.deepEqual(flagged.relationships.blocking, []);
    assert.equal(flagged.relationships.unverified.length, 1);
    assert.ok(flagged.reviewFlags.some((f) => /not verifiable/.test(f)));
  });
  test("identity: an unmatched address projects an identity hold", () => {
    assert.equal(byName(fixture()).row("Unverified Address Garage").projection.outcome, "likely_identity_hold");
  });
  test("a current-rules run is judged by the current rules, not projected", () => {
    const r = byName(fixture()).row("Current Rules Garage");
    assert.deepEqual([r.current.action, r.current.code, r.immediate], ["human", "location_identity", "identity_ownership_account_hold"]);
    assert.equal(r.projection.outcome, "current_rules_result");
    assert.deepEqual(r.projection.missingEvidence.filter((m) => m !== "a verified website read"), []);
  });
  test("no research loops: after a verified or blocked re-read no candidate is researched again", () => {
    const { result } = byName(fixture());
    for (const r of result.rows) {
      assert.equal(r.simulation.researchLoop, false, r.name);
      assert.doesNotMatch(r.simulation.afterVerifiedReread, /^research\//, r.name);
      assert.doesNotMatch(r.simulation.afterBlockedReread, /^research\//, r.name);
    }
    assert.equal(result.summary.workload.researchLoops, 0);
  });
  test("summary and report state what leaves Ready, the workload and the data limits", () => {
    const { result } = byName(fixture());
    assert.equal(result.summary.candidates, 10);
    assert.equal(result.summary.leaveReady, 10);
    assert.equal(result.summary.workload.adminBatchesOf25, 1);
    const md = calibrationMarkdown(result);
    for (const s of ["leave Ready", "Requiring fresh research", "Confirmed negative evidence", "Not in the snapshot", "duplicateDecision is absent"]) assert.ok(md.includes(s), s);
  });
});
