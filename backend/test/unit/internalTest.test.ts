import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, test } from "node:test";
import { INTERNAL_TEST_IDENTITY, internalTestIdentity, internalTestIdentityErrors } from "../../src/internalTest.js";
import { draftEligibilityErrors } from "../../src/outreach/lifecycle.js";
import { composeFollowUp, composeIntro, outreachFacts, type ComposeInput } from "../../src/outreach/compose.js";
import { statusRequirementErrors } from "../../src/prospectStatus.js";
import { internalTestFormErrors, parseProspectInput } from "../../src/prospects.js";

/*
 * The internal outreach test (Prospect.internalTest) is a database mark set
 * once, at creation, by one function. It is ReclaimBay's own controlled
 * identity, not a business, so it is special-cased in exactly two decisions:
 * the status rules hold it to that identity instead of business
 * qualification, and composition states what it is instead of business
 * facts. Nothing that queues, sends, records, or reads the inbox knows it
 * exists: every sending check applies to it unchanged.
 */

const SRC = new URL("../../src/", import.meta.url);
const files = (dir: URL): string[] =>
  readdirSync(dir).flatMap((f) => {
    const u = new URL(f, dir);
    if (statSync(u).isDirectory()) return f === "generated" ? [] : files(new URL(`${f}/`, dir)).map((g) => `${f}/${g}`);
    return f.endsWith(".ts") ? [f] : [];
  });
const read = (f: string) => readFileSync(new URL(f, SRC), "utf8");
const mentioning = files(SRC).filter((f) => read(f).includes("internalTest"));

const { businessName, email, emailSourceUrl } = INTERNAL_TEST_IDENTITY;
const IDENTITY = { businessName, email, emailSourceUrl, website: null, phone: null };

describe("internal outreach test: one mark, set once, special-cased only where it isn't a business", () => {
  test("only these files mention it", () => {
    assert.deepEqual(mentioning.sort(), [
      "admin/commandCenter.ts", // read-only metric exclusions and activity labels
      "admin/outreachViews.ts", // label
      "admin/prospectViews.ts", // label, the form, its identity
      "admin/stats.ts", // excluded from the analytics summary and prospect intent
      "admin/ui.ts", // the label itself
      "internalTest.ts", // the controlled identity
      "outreach/compose.ts", // its one truthful fact, in place of business facts
      "outreach/eligibility.ts", // passes its identity to the status rules
      "outreach/metrics.ts", // excluded from the funnel
      "outreach/operations.ts", // selected for the label
      "outreach/service.ts", // passes the mark to composition
      "prospectStatus.ts", // its identity in place of qualification
      "prospects.ts", // the one creation path; no edits or evidence
      "routes/admin.ts", // the form's route; no edit page
      "routes/adminOutreach.ts", // read-only prospect filter labels
    ]);
  });

  test("nothing that queues, sends, records, or reads the inbox special-cases it", () => {
    for (const f of ["outreach/dispatch.ts", "outreach/records.ts", "outreach/prepare.ts", "outreach/compliance.ts", "outreach/lifecycle.ts", "outreach/gmail.ts", "outreach/gmailInbox.ts", "outreach/inboxAttribution.ts", "outreach/sender.ts", "outreach/reconcile.ts", "outreach/emailedUnsubscribe.ts", "invitations/service.ts", "research/collisionFit.ts", "scoring.ts"]) {
      assert.doesNotMatch(read(f), /internalTest/i, `${f} treats every prospect alike`);
    }
    // Eligibility only hands its identity to the status rules; every other check is shared.
    assert.deepEqual([...read("outreach/eligibility.ts").matchAll(/internalTest\w*/g)].map((m) => m[0]), ["internalTestIdentity", "internalTest", "internalTestIdentity", "internalTestIdentity"], "the import, its module path, and the one use");
    assert.deepEqual([...read("outreach/service.ts").matchAll(/internalTest\w*/g)].map((m) => m[0]), ["internalTest", "internalTest"]);
  });

  test("it is written in exactly two places: insertProspect stores what createInternalTestProspect passes", () => {
    const writes = [...read("prospects.ts").matchAll(/internalTest: ([^,\n}]+)/g)].map((m) => m[1]!.trim());
    assert.deepEqual(writes, ["details.internalTest === true", "true"]);
    assert.match(read("prospects.ts"), /export async function createInternalTestProspect[\s\S]*?internalTestFormErrors\(raw\)[\s\S]*?\{ internalTest: true, notes: \[INTERNAL_TEST_NOTE\] \}/);
    for (const f of ["admin/stats.ts", "outreach/metrics.ts", "outreach/operations.ts"]) {
      for (const m of read(f).matchAll(/internalTest: ([^,\n}]+)/g)) assert.ok(["false", "true", "p.internalTest", "boolean;"].includes(m[1]!.trim()), `${f}: ${m[0]}`);
    }
  });

  test("the prospect form's fields never carry it: a submitted internalTest is ignored", () => {
    const { input } = parseProspectInput({ businessName: "Smith Auto", internalTest: "true", confirmInternalTest: "yes" });
    assert.equal("internalTest" in input.fields, false);
    assert.equal(JSON.stringify(input).includes("internalTest"), false);
  });

  test("its identity is the controlled mailbox and the public page documenting it", () => {
    assert.deepEqual(INTERNAL_TEST_IDENTITY, {
      businessName: "ReclaimBay Internal Test",
      email: "reclaimbay.test@gmail.com",
      emailSourceUrl: "https://reclaimbay.com/internal-test-contact",
    });
    const page = readFileSync(new URL("../../../app/internal-test-contact/page.tsx", import.meta.url), "utf8");
    assert.match(page, /reclaimbay\.test@gmail\.com<\/strong> is a controlled ReclaimBay\s+internal testing address/, "the provenance page names exactly this mailbox");
  });
});

describe("internal test identity and status rules", () => {
  test("only the exact identity passes; any business detail or other recipient fails", () => {
    assert.deepEqual(internalTestIdentityErrors(IDENTITY), []);
    assert.deepEqual(internalTestIdentityErrors({ ...IDENTITY, email: " ReclaimBay.Test@Gmail.com " }), [], "the address compares normalized");
    assert.match(internalTestIdentityErrors({ ...IDENTITY, email: "owner@smithauto.com" }).join(" "), /recipient must be reclaimbay\.test@gmail\.com/);
    assert.match(internalTestIdentityErrors({ ...IDENTITY, emailSourceUrl: "https://smithauto.com/contact" }).join(" "), /documented at https:\/\/reclaimbay\.com\/internal-test-contact/);
    assert.match(internalTestIdentityErrors({ ...IDENTITY, businessName: "Smith Auto Body" }).join(" "), /must be named "ReclaimBay Internal Test"/);
    assert.match(internalTestIdentityErrors({ ...IDENTITY, website: "https://smithauto.com" }).join(" "), /no website or phone/);
    assert.equal(internalTestIdentity({ ...IDENTITY, internalTest: false }), null, "a business is never held to it");
    assert.deepEqual(internalTestIdentity({ ...IDENTITY, internalTest: true }), []);
  });

  test("an internal test needs its identity, not qualification, for Qualified and Ready to contact", () => {
    const ctx = { businessName, hasPublicContact: true, qualification: "unverified" as const };
    assert.deepEqual(statusRequirementErrors("ready_to_contact", { ...ctx, internalTestIdentity: [] }), []);
    assert.deepEqual(statusRequirementErrors("qualified", { ...ctx, internalTestIdentity: [] }), []);
    assert.match(statusRequirementErrors("ready_to_contact", { ...ctx, internalTestIdentity: ["An internal test's recipient must be x."] }).join(" "), /^Ready to contact requires the controlled internal-test identity/);
    // A business with the same facts still needs Meets criteria, with or without the field.
    for (const business of [ctx, { ...ctx, internalTestIdentity: null }]) {
      assert.match(statusRequirementErrors("ready_to_contact", business).join(" "), /requires Qualification "Meets criteria"/);
      assert.match(statusRequirementErrors("qualified", business).join(" "), /requires Qualification "Meets criteria"/);
    }
    const draft = { ...ctx, status: "new" as const, email, emailSourceUrl };
    assert.deepEqual(draftEligibilityErrors("initial", { ...draft, internalTestIdentity: [] }), []);
    assert.match(draftEligibilityErrors("initial", draft).join(" "), /Outreach requires Qualification "Meets criteria"/);
    assert.match(draftEligibilityErrors("initial", { ...draft, internalTestIdentity: ["An internal test's recipient must be x."] }).join(" "), /^Outreach requires the controlled internal-test identity/);
    assert.deepEqual(draftEligibilityErrors("initial", { ...draft, status: "do_not_contact", internalTestIdentity: [] }), ["This prospect must never be contacted."]);
  });

  test("the creation form takes only the confirmation: no business details, signals, or other recipient", () => {
    assert.deepEqual(internalTestFormErrors({ confirmInternalTest: "yes" }), []);
    assert.deepEqual(internalTestFormErrors({ confirmInternalTest: "yes", ...INTERNAL_TEST_IDENTITY, signal_independent_shop: "unknown" }), [], "the identity itself may be submitted");
    assert.match(internalTestFormErrors({}).join(" "), /Confirm that this is ReclaimBay's own internal outreach test identity/);
    assert.match(internalTestFormErrors({ confirmInternalTest: "yes", email: "owner@smithauto.com" }).join(" "), /Email of an internal test is always reclaimbay\.test@gmail\.com/);
    assert.match(internalTestFormErrors({ confirmInternalTest: "yes", emailSourceUrl: "https://smithauto.com/contact" }).join(" "), /Email source URL of an internal test is always/);
    assert.match(internalTestFormErrors({ confirmInternalTest: "yes", businessName: "Smith Auto Body" }).join(" "), /Business name of an internal test is always ReclaimBay Internal Test/);
    assert.match(internalTestFormErrors({ confirmInternalTest: "yes", website: "https://smithauto.com" }).join(" "), /has no website/);
    assert.match(internalTestFormErrors({ confirmInternalTest: "yes", signal_collision_repair_services: "yes" }).join(" "), /records no business signals/);
  });

  test("no business may use the internal test's mailbox or name", () => {
    assert.match(parseProspectInput({ businessName: "Smith Auto", email: "ReclaimBay.Test@gmail.com", emailSourceUrl: "https://smithauto.com/c" }).errors.join(" "), /internal-test mailbox/);
    assert.match(parseProspectInput({ businessName: "reclaimbay  internal test" }).errors.join(" "), /internal outreach test's name/);
    assert.deepEqual(parseProspectInput({ businessName: "Smith Auto", email: "owner@smithauto.com", emailSourceUrl: "https://smithauto.com/c" }).errors, []);
  });
});

describe("internal test composition: what it is, never a business claim", () => {
  const INVITE = `https://reclaimbay.com/invite#${"a".repeat(43)}`;
  const SENDER = { name: "Alex Rivera", postalAddress: "1 Main St, Ventura, CA 93001" };
  const input = (over: Partial<ComposeInput> = {}): ComposeInput => ({
    businessName, city: null, state: null, website: null, email, emailSourceUrl,
    signals: [], evidence: [], internalTest: true, link: INVITE, sender: SENDER, ...over,
  });
  const TRUTH = "This is ReclaimBay's internal outreach test, not a business. Its recipient, reclaimbay.test@gmail.com, is a mailbox ReclaimBay controls, documented at https://reclaimbay.com/internal-test-contact.";

  test("its one fact states what it is, sourced to the public test-contact page", () => {
    assert.deepEqual(outreachFacts(input()), [{ key: "internal_test", statement: TRUTH, signalKey: null, sourceUrl: emailSourceUrl, excerpt: null }]);
    const intro = composeIntro(input());
    assert.deepEqual(intro.evidence, outreachFacts(input()));
    const followUp = composeFollowUp(input(), { subject: intro.subject, sentAt: new Date("2026-10-01T00:00:00Z") }, { reusesInvitation: true });
    assert.deepEqual(followUp.evidence, outreachFacts(input()));
    for (const facts of [intro.evidence, followUp.evidence]) {
      const text = JSON.stringify(facts);
      assert.doesNotMatch(text, /publishes|as its business email|The business is called|It offers/, "no business claim");
    }
  });

  test("it never yields a business fact, even if given business signals and evidence", () => {
    const site = "https://smithauto.example.com";
    const facts = outreachFacts(input({
      signals: [{ key: "collision_repair_services", value: "yes" }, { key: "independent_shop", value: "yes" }],
      evidence: [{ signalKey: "collision_repair_services", sourceUrl: `${site}/services`, excerpt: "We offer collision repair." }, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." }],
    }));
    assert.deepEqual(facts.map((f) => f.key), ["internal_test"]);
    assert.deepEqual(composeIntro(input({ website: site, signals: [{ key: "collision_repair_services", value: "yes" }], evidence: [{ signalKey: "collision_repair_services", sourceUrl: `${site}/services`, excerpt: "We offer collision repair." }] })).evidence.map((f) => f.key), ["internal_test"]);
  });

  test("the message is the production template, addressed to the internal test identity", () => {
    const business = composeIntro(input({ internalTest: false }));
    const internal = composeIntro(input());
    assert.equal(internal.body, business.body, "the copy under test is exactly what a business gets");
    assert.equal(internal.subject, "A quick question about ReclaimBay Internal Test");
    assert.deepEqual(business.evidence.map((f) => f.key), ["business_name", "recipient"], "a business keeps its facts");
  });
});
