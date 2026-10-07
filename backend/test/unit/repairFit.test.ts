import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { businessTypeOf, targetFit, type FitInput } from "../../src/discovery/targetFit.js";
import { analyze, type Page, type Subject } from "../../src/research/analyze.js";
import { parseHtml } from "../../src/research/html.js";
import { repairEvidenceErrors, repairFit } from "../../src/research/repairFit.js";
import { FIT_CRITERION } from "../../src/scoring.js";

/*
 * Research r14: the repair classifier's correctness fixes, from the local
 * Ventura County validation. Scoped negation; body/paint and computer-scan
 * vocabulary that other trades share; and a business describing itself.
 */

const SITE = "https://shop.example.com/";
const fit = (text: string, role: Page["role"] = "home", name = "Test Business") => repairFit(name, [{ url: SITE, role, parsed: { text } }]);
const services = (text: string, role: Page["role"] = "home") => fit(text, role).services;

describe("scoped negation: excluded services are never positive evidence", () => {
  const cases: [string, string, string[]][] = [
    ["everything except X", "We handle everything except engine repair and transmission repair for cars.", []],
    ["all services excluding X", "We provide all services excluding transmission repair for cars.", []],
    ["X other than Y", "We do brake repair other than transmission repair for cars and trucks.", ["brakes"]],
    ["with the exception of X", "We service all vehicles, with the exception of diesel repair.", []],
    ["except for X, we offer Y", "Except for diesel repair, we offer brake repair and engine repair for cars.", ["engine", "brakes"]],
    ["we do not perform X", "We do not perform transmission repair on cars.", []],
    ["we don't offer X", "We don't offer engine repair for cars.", []],
    ["we offer Y and do not offer X", "We offer brake repair and do not offer diesel repair for trucks.", ["brakes"]],
    ["X is not offered", "Transmission repair is not offered at this location for cars.", []],
    ["X is unavailable", "Diesel repair is currently unavailable for trucks.", []],
    ["no X", "No collision repairs at this location.", []],
  ];
  for (const [form, text, expected] of cases) {
    test(`${form}: ${text}`, () => assert.deepEqual(services(text, form === "X is not offered" ? "services" : "home"), expected));
  }

  test("a negative word that isn't about an offering excludes nothing", () => {
    assert.deepEqual(services("Don't ignore your check engine light! We offer engine diagnostics for cars."), ["diagnostics"]);
    assert.deepEqual(services("You can't beat our prices. We offer brake repair for cars."), ["brakes"]);
  });

  test("an exclusion ends with its clause: what the business does after it is still positive", () => {
    assert.deepEqual(services("We repair all makes, other than diesels; we offer brake repair and A/C repair for cars."), ["brakes", "A/C"]);
  });

  test("an excluded service contradicted elsewhere on the site is a conflict, never a Yes", () => {
    const r = repairFit("Test Business", [
      { url: SITE, role: "home", parsed: { text: "We offer transmission repair for cars." } },
      { url: SITE + "services", role: "services", parsed: { text: "We handle everything except transmission repair." } },
    ]);
    assert.equal(r.status, "conflict");
  });

  test("Hobby RV regression: an RV house-systems service excluding engine and transmission work is not qualified", () => {
    const sentence = "We work on residential and commercial units and handle everything except engine and transmission repairs, allowing us to stay focused on electrical, plumbing, roofing, and interior systems.";
    assert.deepEqual(fit(sentence).services, [], "nothing in the excluded clause counts");
    // The real site: a services menu of RV house systems, the sentence above, and its name and phone.
    const subject: Subject = { businessName: "Hobby RV", website: SITE, streetAddress: null, city: "Port Hueneme", state: "CA", postalCode: null, providerPhone: "(805) 214-4139", providerBrand: null, providerStatus: null, provider: "fixture" };
    const html = `<html><head><title>Hobby RV</title></head><body><h1>Hobby RV</h1><p>(805) 214-4139</p><p>Services Mobile RV Repair RV Awning Repair RV Water Heater Repair RV Furnace Repair RV AC Repair RV Slide-Out Repair. ${sentence} Mobile RV repair for vehicles on the road.</p></body></html>`;
    const a = analyze(subject, [{ url: SITE, role: "home", parsed: parseHtml(html), html }], true, new Date("2026-10-07T12:00:00Z"));
    assert.equal(a.ownership, "verified");
    assert.notEqual(a.signals.find((s) => s.key === FIT_CRITERION)?.value, "yes");
    assert.notEqual(a.category?.verdict, "in_target");
  });

  test("a stored excerpt that only names an excluded service is not repair evidence", () => {
    const errors = repairEvidenceErrors({ businessName: "Test Business", website: SITE }, [{ signalKey: FIT_CRITERION, sourceUrl: SITE, excerpt: "We handle everything except transmission repairs for cars." }]);
    assert.match(errors[0]!, /requires sourced automotive repair evidence/);
  });
});

describe("repair of an RV, trailer, boat or motorcycle", () => {
  test("is for a person to verify, never automotive repair by itself", () => {
    const r = fit("Services Mobile RV Repair RV Awning Repair RV Furnace Repair RV AC Repair RV electrical repair for vehicles on the road.", "services");
    assert.equal(r.status, "possible");
    assert.equal(fit("We offer motorcycle brake repair and boat engine repair for your vehicles.", "services").status, "possible");
  });
  test("a car or truck shop that also works on RVs still qualifies on its own work", () => {
    assert.equal(fit("We offer brake repair for cars and also RV AC repair.").status, "primary");
    assert.equal(fit("We offer truck brake repair and diesel repair.").status, "primary");
  });
});

describe("site navigation is not a third party", () => {
  test("a Privacy Policy link or an Employment menu item doesn't hide the business's own services", () => {
    const nav = "Home About Privacy Policy Services Auto Air Quality Service Auto Body and Paint Computer Code Scans Paintless Dent Repair Gallery Employment Positions Contact";
    assert.deepEqual(services(nav, "services"), ["collision/body", "diagnostics", "dent/paint"]);
  });
  test("job postings and insurance policies still are", () => {
    assert.equal(fit("Employment opportunities: auto repair technician wanted for brake repair on cars.", "services").status, "unknown");
    assert.equal(fit("Your insurance policy may cover collision repair.", "services").status, "unknown");
  });
});

describe("collision/body vocabulary", () => {
  test("bodywork and paintwork count with automotive words in the sentence", () => {
    assert.deepEqual(services("Services: Bodywork, Paintwork, post-accident restorations for your car.", "services"), ["collision/body", "dent/paint"]);
    assert.deepEqual(services("We offer auto bodywork for every vehicle."), ["collision/body"]);
  });
  test("paintwork alone is cosmetic: a person verifies it", () => {
    assert.equal(fit("We offer car paintwork and touch-ups.").status, "possible");
  });
  test("the same words from other trades never count", () => {
    for (const text of ["Relaxing bodywork and massage after a car accident injury.", "Equine bodywork for horses and riders.", "Interior and exterior house paint work.", "We do paint work on homes, fences and decks."]) {
      assert.equal(fit(text, "services").status, "unknown", text);
    }
  });
  test("a site about cars isn't enough for bodywork: the sentence must say so", () => {
    const r = repairFit("Test Business", [{ url: SITE, role: "home", parsed: { text: "We love cars." } }, { url: SITE + "services", role: "services", parsed: { text: "Professional bodywork sessions." } }]);
    assert.equal(r.status, "unknown");
  });
  test("auto body and paint, collision and paint, and auto repair body shop", () => {
    assert.deepEqual(services("Services Auto Air Quality Service Auto Body and Paint Paintless Dent Repair", "services"), ["collision/body", "dent/paint"]);
    assert.deepEqual(services("We are a full service Collision and Paint shop."), ["collision/body"]);
    assert.deepEqual(services("Our services: auto repair body shop work for every car.", "services"), ["general repair", "collision/body"]);
  });
  test("a business name is never the evidence, however the site writes it", () => {
    assert.equal(fit("Adons Auto Body and Paint. Call us today.", "services", "Adon's Auto Body & Paint").status, "unknown");
    assert.equal(fit("Harbor Collision & Paint", "services", "Harbor Collision and Paint").status, "unknown");
  });
});

describe("computer scans", () => {
  for (const text of ["Services Auto Air Quality Service Auto Body and Paint Computer Code Scans", "We offer computer diagnostics for cars and trucks.", "Diagnostic computer scans for your vehicle.", "We offer vehicle computer diagnostics."]) {
    test(`automotive diagnostics: ${text}`, () => assert.ok(services(text, "services").includes("diagnostics")));
  }
  test("computer services of another kind never count", () => {
    for (const text of ["Laptop and PC computer diagnostics and virus scans.", "Computer scans for malware on your desktop."]) assert.equal(fit(text, "services").status, "unknown", text);
  });
  test("a site about cars isn't enough for a generic computer scan: the sentence must say so", () => {
    const r = repairFit("Test Business", [{ url: SITE, role: "home", parsed: { text: "Welcome, car lovers." } }, { url: SITE + "services", role: "services", parsed: { text: "We offer computer scans." } }]);
    assert.equal(r.status, "unknown");
  });
});

describe("a business describing itself on its own site", () => {
  for (const text of ["We are an auto repair shop in Oxnard.", "Your full-service auto repair shop in Oxnard.", "Auto repair shop serving Ventura since 1990.", "We are a full service Collision and Paint shop.", "Pinky's Tire Service is an auto repair shop and tire dealer."]) {
    test(text, () => assert.equal(fit(text).status, "primary"));
  }
  test("a question or a bare title isn't a self-description", () => {
    assert.equal(fit("What is an auto repair shop? Read our guide.").status, "unknown");
    assert.equal(fit("Trusted and Recommended Auto Repair Body Shop for Simi Valley").status, "unknown");
  });
  test("a self-description of another business isn't this one's", () => {
    assert.equal(fit("Our partner is an auto repair shop in Oxnard.").status, "unknown");
    assert.equal(fit("Find an auto repair shop near me.").status, "unknown");
  });
  test("the business's own name is never a self-description", () => {
    assert.equal(fit("Joe's Auto Repair Shop serving Ventura", "home", "Joe's Auto Repair Shop").status, "unknown");
  });
});

describe("business type labels", () => {
  const input = (over: Partial<FitInput>): FitInput => ({ businessName: "Test Business", website: SITE, signals: [], evidence: [], categoryVerdict: "unclear", categorySource: "name", categoryReason: "x", qualification: "unverified", ...over });
  const verified = (excerpt: string, over: Partial<FitInput> = {}) =>
    input({ signals: [{ key: FIT_CRITERION, value: "yes" }], evidence: [{ signalKey: FIT_CRITERION, sourceUrl: SITE, excerpt }], categoryVerdict: "in_target", qualification: "meets_criteria", ...over });

  test("collision with accident-related suspension work is collision, not hybrid (World Class Collision)", () => {
    assert.equal(businessTypeOf(verified("Names general repair, collision/body, suspension/steering: We specialize in collision repair and structural repairs.")).label, "Collision / Body Repair");
  });
  test("collision with a real mechanical service is hybrid", () => {
    assert.equal(businessTypeOf(verified("Names general repair, collision/body, diagnostics: Auto repair, collision repair.")).label, "Hybrid / Multi-Service");
    assert.equal(businessTypeOf(verified("Names collision/body, brakes: Collision repair and brake repair.")).label, "Hybrid / Multi-Service");
  });
  test("a name without a vehicle word never becomes an automotive label (Woollybear Surfboard Repair)", () => {
    for (const businessName of ["Woollybear Surfboard Repair", "Smith Diagnostics", "Valley Engine Works", "Ding Repair Shop", "The Body Shop"]) {
      const t = businessTypeOf(input({ businessName }));
      assert.equal(t.label, "Other", businessName);
      assert.equal(targetFit(input({ businessName }), t).fit, "needs_verification");
    }
  });
  test("a name with a vehicle word is still a lead, labeled from the name", () => {
    assert.deepEqual([businessTypeOf(input({ businessName: "Oxnard Auto Repair" })).label, businessTypeOf(input({ businessName: "Oxnard Auto Repair" })).from], ["General Automotive Repair", "name"]);
    assert.equal(businessTypeOf(input({ businessName: "Smith Auto Diagnostics" })).label, "Automotive Electrical / Diagnostic");
    assert.equal(businessTypeOf(input({ businessName: "Joe's Brakes" })).label, "Mechanical Specialty");
  });
  test("a provider category that is automotive still labels a non-descriptive name", () => {
    assert.equal(businessTypeOf(input({ businessName: "Woollybear", providerCategory: "automotive_repair" })).label, "General Automotive Repair");
  });
  test("Dealership Service needs vehicle-dealer evidence on a business in the target, not a wrap shop that serves dealerships (Wrap Labs)", () => {
    const dealerEvidence = { signalKey: "independent_shop", sourceUrl: SITE, excerpt: "Dealership: Fleet branding, company vehicles, and dealership inventory wrapped." };
    const wrap = input({ businessName: "Wrap Labs", evidence: [dealerEvidence], categoryVerdict: "wrong_category", categoryReason: "The name indicates accessories." });
    assert.equal(businessTypeOf(wrap).label, "Parts / Accessories");
    assert.equal(targetFit(wrap).fit, "not_qualified");
    const dealer = input({ businessName: "Kirby Subaru of Ventura", evidence: [{ ...dealerEvidence, excerpt: "Dealership (subaru): Browse our new inventory." }] });
    assert.equal(businessTypeOf(dealer).label, "Dealership Service");
  });
});
