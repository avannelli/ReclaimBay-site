import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { categoryTierFor, nameCategory } from "../../src/discovery/categories.js";
import { APPROVABLE_FROM, CANDIDATE_TRANSITIONS } from "../../src/discovery/candidateStatus.js";
import { assessAutoApproval, type AutoApprovalInput } from "../../src/discovery/autoApproval.js";
import { businessTypeOf, targetFit, type FitInput } from "../../src/discovery/targetFit.js";
import { analyze, type Page, type Subject } from "../../src/research/analyze.js";
import { parseHtml } from "@avannelli/aos/html";
import { fitConflict, repairEvidenceErrors, repairFit } from "../../src/research/repairFit.js";
import { composeIntro, type ComposeInput } from "../../src/outreach/compose.js";
import { draftEligibilityErrors } from "../../src/outreach/lifecycle.js";
import { FIT_CRITERION, REQUIRED_CRITERIA, scoreProspect, signalConsistencyErrors, type StoredSignalValue } from "../../src/scoring.js";

/*
 * The automotive repair ICP: does this business perform automotive repair or
 * service work that fits ReclaimBay? Qualified, Not qualified, or Needs
 * verification, decided only from sourced evidence. Collision/body repair is
 * one segment of it, not a requirement.
 */

const SITE = "https://shop.example.com/";
const TODAY = new Date("2026-10-07T12:00:00Z");
const subject = (businessName: string): Subject => ({ businessName, website: SITE, streetAddress: null, city: "Ventura", state: "CA", postalCode: null, providerPhone: "(805) 555-0101", providerBrand: null, providerStatus: null, provider: "fixture" });
const page = (name: string, text: string, role: Page["role"] = "services"): Page => {
  const html = `<html><head><title>${name}</title></head><body><h1>${name}</h1><p>(805) 555-0101</p><p>${text}</p></body></html>`;
  return { url: SITE + (role === "home" ? "" : role), role, parsed: parseHtml(html), html };
};

/** Research one services page, then decide target fit exactly as Discovery does. */
function decide(name: string, text: string, opts: { category?: string } = {}) {
  const a = analyze(subject(name), [page(name, text)], true, TODAY);
  const signals = a.signals.map((s) => ({ key: s.key, value: s.value }));
  const evidence = a.signals.map((s) => ({ signalKey: s.key, sourceUrl: s.sourceUrl, excerpt: s.excerpt }));
  const name0 = nameCategory({ businessName: name, category: opts.category ?? null });
  // Research's website verdict replaces the name-stage verdict, as research/service.ts applies it.
  const category = a.category ?? name0;
  const qualification = scoreProspect({ website: SITE, signals: Object.fromEntries(signals.map((s) => [s.key, s.value as StoredSignalValue])) }).qualification;
  const input: FitInput = { businessName: name, website: SITE, providerCategory: opts.category ?? null, signals, evidence, categoryVerdict: category.verdict, categorySource: category.source, categoryReason: category.reason, qualification };
  return { analysis: a, qualification, type: businessTypeOf(input), ...targetFit(input) };
}

/** Name-stage only: before research, as a freshly discovered candidate. */
function discovered(name: string, category: string | null = null) {
  const c = nameCategory({ businessName: name, category, categoryTier: category ? categoryTierFor("overture", category) : null });
  const input: FitInput = { businessName: name, website: null, providerCategory: category, signals: [], evidence: [], categoryVerdict: c.verdict, categorySource: c.source, categoryReason: c.reason, qualification: scoreProspect({ signals: {} }).qualification };
  return { category: c, type: businessTypeOf(input), ...targetFit(input) };
}

describe("QUALIFIED: verified automotive repair, whatever the segment", () => {
  const cases: [string, string, string, string][] = [
    ["general mechanic", "Joe's Garage", "Our mechanics handle auto repair, brake repair and engine diagnostics.", "General Automotive Repair"],
    ["general automotive repair", "AWS Automotive", "Our services include auto repair, transmission service, brake repair, A/C repair and engine diagnostics.", "General Automotive Repair"],
    ["collision repair", "Harbor Collision", "We offer collision repair.", "Collision / Body Repair"],
    ["auto body repair", "Mario's Auto Body", "Our services include auto body repair.", "Collision / Body Repair"],
    ["mechanical + collision hybrid", "Coastline Auto Center", "We offer collision repair, brake repair and engine diagnostics.", "Hybrid / Multi-Service"],
    ["transmission repair", "Leon's Transmissions", "We specialize in transmission repair and clutch replacement for cars and trucks.", "Transmission / Drivetrain"],
    ["engine repair", "Valley Engine Works", "We provide engine repair and engine rebuilds for cars and trucks.", "Mechanical Specialty"],
    ["diagnostic/electrical repair", "Arroyo Auto Electric", "We offer computer diagnostics and automotive electrical repair.", "Automotive Electrical / Diagnostic"],
    ["diesel repair", "Ventura Diesel", "We provide diesel repair for trucks and fleets.", "Diesel"],
    ["legitimate specialty repair", "Cool Cars", "We offer A/C repair and radiator repair for your car.", "Mechanical Specialty"],
  ];
  for (const [what, name, text, type] of cases) {
    test(what, () => {
      const r = decide(name, text);
      assert.equal(r.analysis.ownership, "verified");
      const repair = r.analysis.signals.find((s) => s.key === FIT_CRITERION);
      assert.equal(repair?.value, "yes", `${name}: ${r.analysis.warnings.join(" ")}`);
      assert.equal(repair!.sourceUrl, SITE + "services");
      assert.ok(repair!.excerpt.length > 0 && repair!.excerpt.length <= 280);
      assert.equal(r.analysis.category?.verdict, "in_target");
      assert.equal(r.qualification, "meets_criteria");
      assert.equal(r.fit, "qualified");
      assert.equal(r.type.label, type);
      assert.equal(r.type.from, "evidence");
      assert.match(r.why, /verified on the business's own website/);
    });
  }
});

describe("NOT QUALIFIED: not an automotive repair business", () => {
  const byName: [string, string][] = [
    ["glass-only", "Coast Auto Glass"],
    ["detailing-only", "Shine Pros Mobile Detailing"],
    ["car wash", "Sunset Car Wash"],
    ["towing", "Rapid Towing"],
    ["vehicle sales without repair evidence", "Ventura Auto Sales"],
    ["parts retailer", "Coast Auto Parts"],
    ["tint/accessories", "Pro Tint & Wraps"],
    ["inspection/smog-only", "Simi Test Only Smog Center"],
  ];
  for (const [what, name] of byName) {
    test(`${what}: ${name}`, () => {
      const r = discovered(name);
      assert.equal(r.category.verdict, "wrong_category");
      assert.equal(r.fit, "not_qualified");
      assert.match(r.why, /^The name indicates /);
    });
  }

  test("tire-only: the website shows only tires, tire services and wheels", () => {
    const r = decide("Valley Tire Center", "We sell new tires. Tire rotation, flat repair and TPMS service. Custom wheels and rims.");
    assert.equal(r.analysis.category?.verdict, "wrong_category");
    assert.equal(r.fit, "not_qualified");
    assert.match(r.why, /^Website describes tires, tire services and wheels; no automotive repair services/);
  });

  test("detailing-only: the website describes detailing and washing, not repair", () => {
    const r = decide("Shine Pros", "Interior detailing, ceramic coatings and paint correction. Hand car wash every day.");
    assert.equal(r.fit, "not_qualified");
    assert.match(r.why, /detailing and car washes; no automotive repair services/);
  });

  test("inspection/smog-only: a sourced test-only statement is a sourced No", () => {
    const r = decide("Simi Smog Center", "We are a test-only smog station. No repairs are performed here.");
    assert.equal(r.analysis.signals.find((s) => s.key === FIT_CRITERION)?.value, "no");
    assert.equal(r.qualification, "disqualified");
    assert.equal(r.fit, "not_qualified");
  });
});

describe("NEEDS VERIFICATION: evidence doesn't settle it", () => {
  test("ambiguous automotive business: the website names no service either way", () => {
    const r = decide("Bill's Automotive", "Welcome to our family business, proudly serving Ventura since 1990. Call us today.");
    assert.equal(r.analysis.signals.find((s) => s.key === FIT_CRITERION), undefined);
    assert.equal(r.fit, "needs_verification");
  });

  test("ambiguous automotive business before research: a lead, never a verdict", () => {
    const r = discovered("Bill's Automotive");
    assert.equal(r.fit, "needs_verification");
    assert.match(r.why, /does not establish whether it performs repair work/);
  });

  test("tire business named only by its name (Mr. Bee's Tires)", () => {
    const r = discovered("Mr. Bee's Tires");
    assert.equal(r.category.verdict, "unclear", "a name can't prove tire-only");
    assert.equal(r.type.label, "Tire Service");
    assert.equal(r.fit, "needs_verification");
    assert.equal(r.why, "Tire Service indicated by the business name, but its automotive repair work has not been verified.");
  });

  test("a tire business with only one repair service on its site: a person verifies", () => {
    const r = decide("Mr. Bee's Tires", "Tires for every car. We offer brake repair.");
    assert.equal(r.analysis.signals.find((s) => s.key === FIT_CRITERION), undefined);
    assert.equal(r.fit, "needs_verification");
    assert.match(r.analysis.warnings.join(" "), /The name indicates tires, and the website names only one repair service; a person must verify/);
  });

  test("dealership without sufficient service evidence", () => {
    const r = decide("Ventura Toyota", "Browse our new inventory. Schedule a test drive today.");
    assert.equal(r.fit, "needs_verification");
    assert.equal(r.analysis.signals.find((s) => s.key === FIT_CRITERION), undefined);
  });

  test("dealership with service evidence still needs a person", () => {
    const r = decide("Ventura Toyota", "Browse our new inventory. Our service department offers brake repair and engine repair.");
    assert.equal(r.analysis.signals.find((s) => s.key === FIT_CRITERION), undefined);
    assert.equal(r.fit, "needs_verification");
    assert.match(r.why, /^A dealership service department; a person must verify its repair work\.$/);
  });

  test("a website that can't establish actual repair activity (too little readable text)", () => {
    const r = decide("Harbor Auto", "Call us.");
    assert.equal(r.fit, "needs_verification");
  });

  test("specialty business where repair/service scope is unclear: cosmetic-only or maintenance-only", () => {
    for (const text of ["We offer paintless dent repair for cars.", "Quick oil changes and tune-ups for your car."]) {
      const r = decide("Specialty Auto", text);
      assert.equal(r.analysis.signals.find((s) => s.key === FIT_CRITERION), undefined, text);
      assert.equal(r.fit, "needs_verification", text);
      assert.match(r.why, /Only maintenance, cosmetic specialty, or RV\/trailer\/boat\/motorcycle services were found/);
    }
  });

  test("contradictory repair statements stay reviewable, never Yes or No", () => {
    const a = analyze(subject("Harbor Repair"), [page("Harbor Repair", "We offer brake repair for cars and trucks.", "home"), page("Harbor Repair", "We do not offer brake repair.")], true, TODAY);
    assert.equal(a.signals.find((s) => s.key === FIT_CRITERION), undefined);
    assert.equal(a.category?.verdict, "unclear");
    assert.match(a.warnings.join(" "), /Automotive repair evidence is contradictory/);
  });
});

describe("collision/body is no longer a required condition", () => {
  test("the only required criterion is verified automotive repair", () => {
    assert.deepEqual([...REQUIRED_CRITERIA], ["automotive_repair_services"]);
  });
  test("a mechanical shop qualifies with collision/body unknown or No", () => {
    assert.equal(scoreProspect({ signals: { automotive_repair_services: "yes" } }).qualification, "meets_criteria");
    assert.equal(scoreProspect({ signals: { automotive_repair_services: "yes", collision_repair_services: "no" } }).qualification, "meets_criteria");
  });
  test("collision/body No alone never disqualifies; collision/body Yes still qualifies a body shop", () => {
    assert.equal(scoreProspect({ signals: { collision_repair_services: "no" } }).qualification, "unverified");
    assert.equal(scoreProspect({ signals: { collision_repair_services: "yes" } }).qualification, "meets_criteria");
  });
  test("a mechanical site whose collision wording contradicts itself is still qualified on its repair evidence", () => {
    const a = analyze(subject("Harbor Repair"), [page("Harbor Repair", "We offer collision repair.", "home"), page("Harbor Repair", "We do not offer collision repair. We offer brake repair and engine repair.")], true, TODAY);
    assert.equal(a.signals.find((s) => s.key === FIT_CRITERION)?.value, "yes");
    assert.equal(fitConflict(a.warnings, "repair"), null, "collision/body wording doesn't block repair-based fit");
    assert.equal(fitConflict(a.warnings, "collision"), "collision/body", "but still blocks fit resting on collision/body evidence");
  });
  test("a collision Yes and an automotive repair No contradict: unknown, and refused on save", () => {
    const r = scoreProspect({ signals: { collision_repair_services: "yes", automotive_repair_services: "no" } });
    assert.equal(r.qualification, "unverified");
    assert.match(signalConsistencyErrors({ signals: { collision_repair_services: "yes", automotive_repair_services: "no" } }).join(" "), /Resolve the contradiction/);
  });
});

describe("opportunity score is separate from qualification", () => {
  test("a high score never qualifies; a low score never disqualifies", () => {
    const high = scoreProspect({ website: SITE, phone: "1", phoneSourceUrl: SITE, signals: { independent_shop: "yes", general_repair_services: "yes", multiple_bays_or_staff: "yes", digital_inspections: "yes", no_online_booking: "yes", website_not_https: "yes", website_no_recent_date: "yes" } });
    assert.equal(high.band, "high");
    assert.equal(high.qualification, "unverified");
    const low = scoreProspect({ signals: { automotive_repair_services: "yes" } });
    assert.equal(low.band, "low");
    assert.equal(low.qualification, "meets_criteria");
  });
  test("every verified repair segment earns the same points: collision/body is not a ranking factor", () => {
    assert.equal(scoreProspect({ signals: { automotive_repair_services: "yes" } }).score, 20);
    assert.equal(scoreProspect({ signals: { collision_repair_services: "yes" } }).score, 20);
    assert.equal(scoreProspect({ signals: { automotive_repair_services: "yes", collision_repair_services: "yes" } }).score, 20);
  });
  test("target fit ignores the score", () => {
    const base: FitInput = { businessName: "Harbor", website: SITE, signals: [], evidence: [], categoryVerdict: "unclear", categorySource: "name", categoryReason: "x", qualification: "unverified" };
    assert.equal(targetFit(base).fit, "needs_verification");
    assert.equal(targetFit({ ...base, signals: [{ key: "independent_shop", value: "yes" }, { key: "multiple_bays_or_staff", value: "yes" }] }).fit, "needs_verification");
  });
});

describe("missing evidence never becomes positive evidence", () => {
  test("no services, no signal", () => {
    assert.deepEqual(repairFit("Harbor", [{ url: SITE, role: "services", parsed: { text: "" } }]), { status: "unknown", sourceUrl: null, excerpt: null, services: [] });
  });
  test("a name alone is never evidence", () => {
    const r = repairFit("Harbor Transmission Repair", [{ url: SITE, role: "services", parsed: { text: "Harbor Transmission Repair. Call us." } }]);
    assert.equal(r.status, "unknown");
  });
  test("third-party, supplier, training and job wording is not this business's repair work", () => {
    for (const text of ["We sell brake repair kits.", "Our directory lists auto repair shops.", "We refer you to partners for transmission repair.", "Training courses in engine repair.", "Auto repair technician job openings."]) {
      assert.equal(repairFit("Harbor", [{ url: SITE, role: "services", parsed: { text } }]).status, "unknown", text);
    }
  });
  test("a component phrase needs automotive context around it: home HVAC, small engines and boats are not automotive repair", () => {
    for (const text of ["We offer AC repair and furnace installation for your home.", "Small engine repair for lawn mowers and chainsaws.", "Marine engine repair and outboard service."]) {
      assert.equal(repairFit("Harbor", [{ url: SITE, role: "services", parsed: { text } }]).status, "unknown", text);
    }
    assert.equal(repairFit("Harbor", [{ url: SITE, role: "services", parsed: { text: "We provide engine repair for cars and trucks." } }]).status, "primary");
  });
  test("the business's own offering counts on any page, including \"our certified mechanics provide…\"", () => {
    const r = repairFit("Harbor", [{ url: SITE, role: "home", parsed: { text: "Our ASE certified mechanics provide brake service, oil changes and check engine light diagnosis." } }]);
    assert.equal(r.status, "primary");
    assert.deepEqual(r.services, ["brakes", "diagnostics", "maintenance"]);
    assert.equal(repairFit("Harbor", [{ url: SITE, role: "home", parsed: { text: "Free estimates on all auto repair work." } }]).status, "unknown", "a home-page mention without an offering stays unknown");
  });
  test("negated services and \"we don't repair X\" are not a business-level No", () => {
    assert.equal(repairFit("Harbor", [{ url: SITE, role: "services", parsed: { text: "We do not repair motorcycles. We offer brake repair for cars." } }]).status, "primary");
    assert.equal(repairFit("Harbor", [{ url: SITE, role: "services", parsed: { text: "Don't ignore your check engine light! We offer engine diagnostics for cars." } }]).status, "primary");
  });
  test("stored excerpts: research's \"Names …:\" summary can't confirm itself", () => {
    const business = { businessName: "Harbor Repair", website: SITE };
    assert.deepEqual(repairEvidenceErrors(business, [{ signalKey: FIT_CRITERION, sourceUrl: SITE + "services", excerpt: "Names brakes, engine: We offer brake repair and engine repair for cars." }]), []);
    assert.match(repairEvidenceErrors(business, [{ signalKey: FIT_CRITERION, sourceUrl: SITE + "services", excerpt: "Names brakes, engine: Welcome to our shop." }])[0]!, /requires sourced automotive repair evidence/);
    assert.match(repairEvidenceErrors(business, [])[0]!, /requires sourced automotive repair evidence/);
    assert.match(repairEvidenceErrors(business, [{ signalKey: FIT_CRITERION, sourceUrl: "https://directory.example.org/harbor", excerpt: "We offer brake repair for cars." }])[0]!, /requires sourced/, "off-site source");
    assert.match(repairEvidenceErrors(business, [{ signalKey: FIT_CRITERION, sourceUrl: SITE, excerpt: "We do not perform repairs." }])[0]!, /contradictory/);
  });
});

describe("provider category alone never establishes qualification", () => {
  for (const category of ["automotive_repair", "auto_body_shop", "transmission_repair"]) {
    test(category, () => {
      const r = discovered("Harbor", category);
      assert.equal(r.category.verdict, "unclear");
      assert.match(r.category.reason, /Provider categories are leads/);
      assert.equal(r.fit, "needs_verification");
      assert.equal(r.type.from, "provider");
    });
  }
  test("names saying \"auto\", \"automotive\", \"car\", \"vehicle\" or \"service\" are leads only", () => {
    for (const name of ["Harbor Auto", "Harbor Automotive", "Harbor Car Service", "Harbor Vehicle Service"]) assert.equal(nameCategory({ businessName: name }).verdict, "unclear", name);
    assert.equal(nameCategory({ businessName: "Rapid Towing Service" }).verdict, "wrong_category", "service doesn't rescue towing");
  });
  test("mechanical, specialist and body repair categories are core discovery leads; tire/inspection are adjacent", () => {
    for (const c of ["automotive_repair", "auto_body_shop", "transmission_repair", "brake_service_and_repair", "engine_repair_service", "auto_electrical_repair"]) assert.equal(categoryTierFor("overture", c), "core", c);
    for (const c of ["tire_dealer_and_repair", "emissions_inspection", "oil_change_station"]) assert.equal(categoryTierFor("overture", c), "adjacent", c);
  });
});

describe("human approval and outreach safeguards are unchanged", () => {
  test("approved is never a status anyone sets; only Researched or Needs review can be approved", () => {
    for (const to of Object.values(CANDIDATE_TRANSITIONS)) assert.ok(!to.includes("approved"));
    assert.deepEqual([...APPROVABLE_FROM], ["researched", "needs_review"]);
  });
  const mechanic = (over: Partial<AutoApprovalInput> = {}): AutoApprovalInput => ({
    businessName: "Joe's Garage", website: SITE, city: "Ventura", state: "CA", postalCode: null, country: "US", phone: null, phoneSourceUrl: null, email: null, emailSourceUrl: null,
    signals: [{ key: FIT_CRITERION, value: "yes", origin: "research" }],
    evidence: [{ signalKey: FIT_CRITERION, origin: "research", sourceUrl: SITE + "services", excerpt: "Names brakes: We offer brake repair for cars." }],
    status: "researched", categoryVerdict: "in_target", categorySource: "website", categoryReason: "The website names automotive repair services (brakes).", websiteVerifiedAt: TODAY,
    latestRun: { status: "completed", outcome: "website_verified", version: "r13", warnings: [], businessType: null },
    ...over,
  });
  test("automatic approval still starts only from Researched and never overrides a person's hold", () => {
    assert.equal(assessAutoApproval(mechanic()).decision, "approve");
    assert.equal(assessAutoApproval(mechanic({ status: "needs_review" })).decision, "review");
    assert.equal(assessAutoApproval(mechanic({ latestRun: { status: "completed", outcome: "website_verified", version: "r13", warnings: ["Automotive repair evidence is contradictory; verify product fit manually."], businessType: null } })).decision, "review");
    assert.equal(assessAutoApproval(mechanic({ latestRun: { status: "completed", outcome: "website_verified", version: "r13", warnings: [], businessType: { value: "dealership", note: null } } })).decision, "review");
  });
  test("outreach still requires Ready to contact, Meets criteria, and a sourced email: a verified mechanic gets no shortcut", () => {
    const ctx = { businessName: "Joe's Garage", hasPublicContact: true, email: "joe@shop.example.com", emailSourceUrl: SITE + "contact", internalTestIdentity: null };
    for (const status of ["new", "qualified", "ready_to_contact"] as const) {
      assert.ok(draftEligibilityErrors("initial", { ...ctx, status, qualification: "unverified" }).length, status);
      assert.ok(draftEligibilityErrors("initial", { ...ctx, status, qualification: "disqualified" }).length, status);
    }
    assert.ok(draftEligibilityErrors("initial", { ...ctx, status: "not_a_fit", qualification: "meets_criteria" }).length);
    assert.deepEqual(draftEligibilityErrors("initial", { ...ctx, status: "ready_to_contact", qualification: "meets_criteria" }), []);
  });

  const intro = (over: Partial<ComposeInput>): ComposeInput => ({
    businessName: "Joe's Garage", city: "Ventura", state: "CA", website: SITE, email: "joe@shop.example.com", emailSourceUrl: SITE + "contact",
    signals: [], evidence: [], link: `https://reclaimbay.com/invite#${"a".repeat(43)}`, sender: { name: "Alex Rivera", postalAddress: "1 Main St" }, ...over,
  });
  test("collision/body shops get exactly the approved opening, as before", () => {
    const body = composeIntro(intro({ businessName: "Harbor Collision", signals: [{ key: "collision_repair_services", value: "yes" }], evidence: [{ signalKey: "collision_repair_services", sourceUrl: SITE + "services", excerpt: "We offer collision repair." }] })).body;
    assert.match(body, /I came across Harbor Collision and noticed you offer collision repair\./);
  });
  test("a verified mechanic is never told it does collision and body repair", () => {
    const m = composeIntro(intro({ signals: [{ key: FIT_CRITERION, value: "yes" }, { key: "collision_repair_services", value: "no" }], evidence: [{ signalKey: FIT_CRITERION, sourceUrl: SITE + "services", excerpt: "Names brakes: We offer brake repair for cars." }] }));
    assert.match(m.body, /I came across Joe's Garage and noticed you handle automotive repair\./);
    assert.doesNotMatch(m.body, /collision|body repair/);
    assert.deepEqual(m.evidence.map((f) => f.key), ["business_name", "recipient", FIT_CRITERION]);
    assert.equal(m.template, "intro@t4");
  });
  test("repair evidence that fails the stored-excerpt check is never cited, and the opening still never claims collision", () => {
    const m = composeIntro(intro({ signals: [{ key: FIT_CRITERION, value: "yes" }], evidence: [{ signalKey: FIT_CRITERION, sourceUrl: "https://elsewhere.example.org/", excerpt: "We offer brake repair for cars." }] }));
    assert.equal(m.evidence.filter((f) => f.signalKey).length, 0);
    assert.match(m.body, /noticed you handle automotive repair\./);
  });
});
