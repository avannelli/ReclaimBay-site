import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, test } from "node:test";
import {
  candidateScoringInput,
  candidateToProspectInput,
  provenanceNote,
  researchGateErrors,
  scoreCandidate,
  unevidencedSignals,
  type CandidateFacts,
} from "../../src/discovery/approval.js";
import { statusRequirementErrors } from "../../src/prospectStatus.js";
import { SIGNALS, scoreProspect } from "../../src/scoring.js";

const WEB = "https://smithauto.example.com";
const facts = (over: Partial<CandidateFacts> = {}): CandidateFacts => ({
  businessName: "Smith Auto",
  website: WEB,
  city: "Springfield",
  state: "IL",
  postalCode: "62701",
  country: "US",
  phone: "(555) 010-0100",
  phoneSourceUrl: `${WEB}/contact`,
  email: null,
  emailSourceUrl: null,
  signals: [
    { key: "independent_shop", value: "yes" },
    { key: "general_repair_services", value: "yes" },
    { key: "collision_repair_services", value: "yes" },
  ],
  ...over,
});

describe("scoring reuse", () => {
  test("a candidate scores exactly as a prospect with the same facts (same function, same result)", () => {
    const c = facts();
    assert.deepEqual(scoreCandidate(c), scoreProspect(candidateScoringInput(c)));
    // independent 25 + repair 20 + public contact 10 + website 5
    assert.equal(scoreCandidate(c).score, 60);
  });

  test("qualification states come from the existing rules", () => {
    assert.equal(scoreCandidate(facts()).qualification, "meets_criteria");
    assert.equal(scoreCandidate(facts({ signals: [{ key: "independent_shop", value: "yes" }] })).qualification, "unverified");
    assert.equal(scoreCandidate(facts({ signals: [] })).qualification, "unverified");
    const dq = scoreCandidate(facts({ signals: [{ key: "collision_repair_services", value: "no" }, { key: "general_repair_services", value: "yes" }] }));
    assert.equal(dq.qualification, "disqualified");
    assert.deepEqual(dq.disqualifiedBy, ["collision_repair_services"]);
  });

  test("score and qualification stay independent for candidates too", () => {
    const dq = scoreCandidate(
      facts({
        signals: [
          { key: "collision_repair_services", value: "no" },
          { key: "general_repair_services", value: "yes" },
          { key: "multiple_bays_or_staff", value: "yes" },
        ],
      }),
    );
    assert.equal(dq.qualification, "disqualified");
    assert.equal(dq.score, 10 + 15 + 10 + 5);
    assert.equal(dq.band, "medium", "band reflects the score alone");
  });

  test("discovery confidence can't become qualification: a bare discovered record is Unverified", () => {
    const r = scoreCandidate(facts({ signals: [], phone: null, phoneSourceUrl: null }));
    assert.equal(r.qualification, "unverified");
    assert.deepEqual(r.unverifiedCriteria, ["collision_repair_services"]);
  });

  test("there is no second scoring implementation in the discovery code", async () => {
    const dir = new URL("../../src/discovery/", import.meta.url);
    for (const name of await readdir(dir)) {
      const src = await readFile(new URL(name, dir), "utf8");
      assert.doesNotMatch(src, /\bweight\b/i, `${name} mentions weights`);
      assert.doesNotMatch(src, /BAND_THRESHOLDS|SIGNALS\s*=/, `${name} redefines scoring`);
    }
  });
});

describe("candidateToProspectInput (approval mapping)", () => {
  test("maps business facts, contact with source, and signals; unrecorded signals are unknown", () => {
    const { input, errors } = candidateToProspectInput(facts());
    assert.deepEqual(errors, []);
    assert.equal(input.fields.businessName, "Smith Auto");
    assert.equal(input.fields.website, `${WEB}/`);
    assert.equal(input.fields.phone, "(555) 010-0100");
    assert.equal(input.fields.phoneSourceUrl, `${WEB}/contact`);
    assert.equal(input.signals.independent_shop, "yes");
    assert.equal(input.signals.digital_inspections, "unknown");
    assert.equal(Object.keys(input.signals).length, SIGNALS.length);
  });

  test("is held to the prospect validators: contact without a source is refused", () => {
    const { errors } = candidateToProspectInput(facts({ phoneSourceUrl: null }));
    assert.match(errors.join(), /public URL where it is listed/);
  });

  test("is held to the consistency rules: a website signal without a website is refused", () => {
    const { errors } = candidateToProspectInput(
      facts({ website: null, signals: [{ key: "website_not_https", value: "yes" }] }),
    );
    assert.match(errors.join(), /only be observed on a website/);
  });

  test("approval never implies a later status: the prospect gates still apply to the mapped facts", () => {
    // Unverified facts map fine, but Qualified/Ready to contact would be refused by the existing rules.
    const unverified = facts({ signals: [{ key: "independent_shop", value: "yes" }] });
    assert.deepEqual(candidateToProspectInput(unverified).errors, []);
    const result = scoreCandidate(unverified);
    const ctx = { businessName: unverified.businessName, hasPublicContact: true, qualification: result.qualification };
    assert.match(statusRequirementErrors("qualified", ctx).join(), /Unverified/);
    assert.match(statusRequirementErrors("ready_to_contact", ctx).join(), /Unverified/);
  });

  test("a provider phone is never mapped: it is unverified, so the prospect has no contact and can't be Ready to contact", () => {
    const fromProvider = { ...facts({ phone: null, phoneSourceUrl: null }), providerPhone: "(805) 555-1101" } as CandidateFacts;
    const { input, errors } = candidateToProspectInput(fromProvider);
    assert.deepEqual(errors, []);
    assert.equal(input.fields.phone, null);
    assert.equal(input.fields.phoneSourceUrl, null);
    assert.doesNotMatch(JSON.stringify(input), /555-1101/);
    const result = scoreCandidate(fromProvider);
    assert.equal(result.breakdown.find((s) => s.key === "public_business_contact")!.state, "unknown");
    const ctx = { businessName: fromProvider.businessName, hasPublicContact: false, qualification: result.qualification };
    assert.match(statusRequirementErrors("ready_to_contact", ctx).join(), /requires a public business phone or email/);
  });
});

describe("evidence gate helpers", () => {
  test("finds recorded signals with no evidence, ignoring retired keys", () => {
    const signals = [{ key: "independent_shop" }, { key: "general_repair_services" }, { key: "retired_signal" }];
    assert.deepEqual(unevidencedSignals(signals, [{ signalKey: "independent_shop" }]), ["general_repair_services"]);
  });

  test("researchGateErrors combines the count and per-signal checks", () => {
    assert.equal(researchGateErrors([], []).length, 1);
    assert.equal(researchGateErrors([{ key: "independent_shop" }], [{ signalKey: "digital_inspections" }]).length, 1);
    assert.deepEqual(researchGateErrors([{ key: "independent_shop" }], [{ signalKey: "independent_shop" }]), []);
  });
});

describe("provenance", () => {
  test("records where the candidate came from", () => {
    const note = provenanceNote({
      provider: "fixture",
      externalId: "fx-1001",
      sourceUrl: "https://directory.example.com/listing/fx-1001",
      query: "Independent automotive repair in Thousand Oaks, Ventura County, CA",
      discoveredAt: new Date("2026-10-02T12:00:00Z"),
      candidateId: "cand-1",
      runId: "run-1",
    });
    for (const part of ["Approved by a human", "fixture", "fx-1001", "directory.example.com", "Thousand Oaks", "2026-10-02", "cand-1", "run-1"]) {
      assert.ok(note.includes(part), part);
    }
    assert.ok(note.length <= 2000);
  });

  test("a staged provider's release is recorded", () => {
    const note = provenanceNote({
      provider: "overture", externalId: "08f2", sourceUrl: null, query: null,
      discoveredAt: new Date("2026-10-02T00:00:00Z"), candidateId: "c", runId: "r", release: "2026-09-23.0",
    });
    assert.match(note, /Release: 2026-09-23\.0\./);
  });

  test("a manual candidate without a source still records its provider", () => {
    const note = provenanceNote({
      provider: "manual", externalId: null, sourceUrl: null, query: null,
      discoveredAt: new Date("2026-10-02T00:00:00Z"), candidateId: "c", runId: null,
    });
    assert.match(note, /Provider: manual\./);
    assert.doesNotMatch(note, /Provider ID|Discovery source|Search:|Run:/);
  });
});

describe("privacy boundaries in the data model", () => {
  test("the candidate tables have no place for personal, customer, or report data", async () => {
    const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    const models = [...schema.matchAll(/^model (Discovery\w+|Candidate\w+) \{([\s\S]*?)^\}/gm)];
    assert.ok(models.length >= 5, "found the discovery models");
    for (const [, name, body] of models) {
      const fields = body!
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((f) => f && !f.startsWith("//") && !f.startsWith("@@"));
      for (const f of fields) {
        assert.doesNotMatch(f!, /owner|personal|home|social|review|customer|declined|amount|vehicle|pageBody|html/i, `${name}.${f}`);
      }
    }
  });

  test("evidence excerpts are capped at 280 characters in the schema", async () => {
    const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    assert.match(schema, /model CandidateEvidence \{[\s\S]*excerpt\s+String\s+@db\.VarChar\(280\)/);
  });
});
