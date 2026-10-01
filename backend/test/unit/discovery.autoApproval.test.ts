import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  AUTO_APPROVAL_RULES,
  AUTO_APPROVED_PREFIX,
  CRITICAL_WARNINGS,
  NOTED_WARNINGS,
  assessAutoApproval,
  isAutoApproved,
  type AutoApprovalInput,
} from "../../src/discovery/autoApproval.js";

const SRC = "https://saviersauto.example.com/";

/** A clean, verified, independent, in-target general repair shop: every condition holds. */
const clean = (over: Partial<AutoApprovalInput> = {}): AutoApprovalInput => ({
  businessName: "Saviers Road Auto Repair",
  website: SRC,
  city: "Oxnard",
  state: "CA",
  postalCode: "93033",
  country: "US",
  phone: "(805) 555-0101",
  phoneSourceUrl: SRC,
  email: null,
  emailSourceUrl: null,
  signals: [
    { key: "independent_shop", value: "yes" },
    { key: "general_repair_services", value: "yes" },
  ],
  evidence: [{ signalKey: "independent_shop" }, { signalKey: "general_repair_services" }],
  status: "researched",
  categoryVerdict: "in_target",
  categorySource: "website",
  categoryReason: "The website names general repair services (brakes, engine diagnostics).",
  websiteVerifiedAt: new Date("2026-10-01T12:00:00Z"),
  latestRun: { status: "completed", outcome: "website_verified", version: "r11", warnings: [], businessType: { value: "independent", note: null } },
  ...over,
});
const run = (over: Partial<NonNullable<AutoApprovalInput["latestRun"]>>) => ({ ...clean().latestRun!, ...over });

describe("automatic approval (approval@a1)", () => {
  test("a clean, verified, independent, in-target lead is approved, with every reason recorded", () => {
    const a = assessAutoApproval(clean());
    assert.equal(a.decision, "approve");
    assert.equal(
      a.approvalNote,
      `${AUTO_APPROVED_PREFIX} (${AUTO_APPROVAL_RULES}): target category confirmed (in target, from the business's own website), website ownership verified (research r11), independent shop confirmed, general repair confirmed, qualification meets criteria, no blocking warnings.`,
    );
  });

  test("independence unknown: held for review", () => {
    const a = assessAutoApproval(clean({ signals: [{ key: "general_repair_services", value: "yes" }], evidence: [{ signalKey: "general_repair_services" }] }));
    assert.equal(a.decision, "review");
    assert.ok(a.reasons.includes("Independent shop is unknown, not yes."));
    assert.ok(a.reasons.includes("Qualification is Unverified, not Meets criteria."));
    assert.equal(a.approvalNote, null);
  });

  test("general repair not confirmed: held", () => {
    const a = assessAutoApproval(clean({ signals: [{ key: "independent_shop", value: "yes" }], evidence: [{ signalKey: "independent_shop" }] }));
    assert.equal(a.decision, "review");
    assert.ok(a.reasons.includes("Offers general repair is unknown, not yes."));
  });

  test("category unclear or not checked: held; wrong category: blocked", () => {
    assert.equal(assessAutoApproval(clean({ categoryVerdict: "unclear", categoryReason: "The name points to tires." })).decision, "review");
    assert.ok(assessAutoApproval(clean({ categoryVerdict: null })).reasons.includes("The category hasn't been checked yet."));
    const wrong = assessAutoApproval(clean({ categoryVerdict: "wrong_category", categoryReason: "The name indicates auto glass." }));
    assert.equal(wrong.decision, "blocked");
    assert.match(wrong.reasons[0]!, /outside the target category \(The name indicates auto glass\)/);
  });

  test("a person's in-target decision counts as in target", () => {
    const a = assessAutoApproval(clean({ categorySource: "manual" }));
    assert.equal(a.decision, "approve");
    assert.match(a.approvalNote!, /in target, set by a person/);
  });

  test("website ownership not confirmed, or the latest run didn't confirm it: held", () => {
    assert.ok(assessAutoApproval(clean({ websiteVerifiedAt: null })).reasons.includes("Website ownership isn't confirmed."));
    const unconfirmed = assessAutoApproval(clean({ latestRun: run({ outcome: "website_unconfirmed" }) }));
    assert.equal(unconfirmed.decision, "review");
    assert.match(unconfirmed.reasons.join(" "), /didn't confirm the website \(website unconfirmed\)/);
    assert.match(assessAutoApproval(clean({ latestRun: run({ status: "failed", outcome: "website_unreachable" }) })).reasons.join(" "), /latest research run failed/);
    assert.ok(assessAutoApproval(clean({ latestRun: null })).reasons.includes("The candidate has never been researched."));
  });

  test("status: only Researched is approved automatically; a person's Needs review is never overridden", () => {
    assert.ok(assessAutoApproval(clean({ status: "needs_review" })).reasons.includes("It is waiting for a person (Needs review)."));
    assert.equal(assessAutoApproval(clean({ status: "discovered" })).decision, "review");
    assert.equal(assessAutoApproval(clean({ status: "rejected" })).decision, "blocked");
    assert.equal(assessAutoApproval(clean({ status: "duplicate" })).decision, "blocked");
    assert.equal(assessAutoApproval(clean({ status: "approved" })).decision, "approved");
  });

  test("contradicting business types on the website: held", () => {
    for (const value of ["dealership", "chain or franchise", "possibly a chain"]) {
      assert.equal(assessAutoApproval(clean({ latestRun: run({ businessType: { value, note: null } }) })).decision, "review", value);
    }
    const conflict = { value: null, note: "The site states it is independent but also shows dealership activity. Check by hand." };
    assert.equal(assessAutoApproval(clean({ latestRun: run({ businessType: conflict }) })).decision, "review");
    const noStatement = { value: null, note: "No franchise brand or dealership activity found, but the site doesn't state it is independent." };
    assert.equal(assessAutoApproval(clean({ latestRun: run({ businessType: noStatement }) })).decision, "approve", "a person's independence evidence isn't contradicted");
  });

  test("warnings: every blocking kind holds the candidate; the provider phone alone is only noted", () => {
    const blocking = [
      "The website gives a different business address (665 Ventura St, Fillmore 93015) than overture (17958 E Telegraph Rd, Santa Paula, CA 93060). The business may have moved, or the provider's address may be out of date. Verify the current location by hand.",
      "The website says the business has closed.",
      'Research found "independent_shop" = no, but a person recorded yes; the person\'s value was kept.',
      'The website suggests "Wrong category" (…), but a person set the category; the person\'s decision was kept.',
      "The website lists (805) 678-4140; the stored phone (866) 656-5307 was kept.",
      "The website lists several phone numbers and none could be tied to this location. Verify the phone by hand.",
      "A future warning nobody has classified yet.",
    ];
    for (const w of blocking) assert.equal(assessAutoApproval(clean({ latestRun: run({ warnings: [w] }) })).decision, "review", w);
    const noted = assessAutoApproval(clean({ latestRun: run({ warnings: ["The provider's phone is not on the website, which lists (805) 555-0101."] }) }));
    assert.equal(noted.decision, "approve");
    assert.deepEqual(noted.noted, ["the provider's phone is not on the website"]);
    assert.match(noted.approvalNote!, /Noted: the provider's phone is not on the website\.$/);
  });

  test("HOUSE Automotive's real warnings hold it for review (its stored phone is wrong)", () => {
    const house = assessAutoApproval(
      clean({
        latestRun: run({
          version: "r2",
          warnings: ["The provider's phone is not on the website, which lists (866) 656-5307.", "The website lists (805) 678-4140; the stored phone (866) 656-5307 was kept."],
        }),
      }),
    );
    assert.equal(house.decision, "review");
    assert.ok(house.reasons.includes("A research warning needs a person: the website's phone differs from the stored phone."));
  });

  test("the existing approval gate still applies: a signal without evidence holds it", () => {
    const a = assessAutoApproval(clean({ evidence: [{ signalKey: "independent_shop" }] }));
    assert.equal(a.decision, "review");
    assert.match(a.reasons.join(" "), /Every recorded signal needs evidence/);
  });

  test("every warning pattern the rule knows is one research actually writes", () => {
    const research = ["analyze.ts", "service.ts", "researcher.ts"].map((f) => readFileSync(new URL(`../../src/research/${f}`, import.meta.url), "utf8")).join("\n");
    const anchors: Record<string, string> = {
      "the website gives a different business address": "gives a different business address",
      "the website says the business has closed": "The website says the business has closed.",
      "research disagrees with something a person recorded": "but a person recorded",
      "the website's phone differs from the stored phone": "the stored phone ${c.phone} was kept",
      "no phone on the website could be tied to this location": "none could be tied to this location",
      "the provider's phone is not on the website": "The provider's phone is not on the website",
    };
    for (const w of [...CRITICAL_WARNINGS, ...NOTED_WARNINGS]) assert.ok(research.includes(anchors[w.label]!), `research no longer writes: ${w.label}`);
    assert.ok(research.includes("but a person set the category"));
  });

  test("isAutoApproved tells the rule's approvals from a person's", () => {
    assert.equal(isAutoApproved({ status: "approved", decisionReason: `${AUTO_APPROVED_PREFIX} (${AUTO_APPROVAL_RULES}): …` }), true);
    assert.equal(isAutoApproved({ status: "approved", decisionReason: null }), false);
    assert.equal(isAutoApproved({ status: "rejected", decisionReason: "Automatically approved? no" }), false);
  });
});
