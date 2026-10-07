import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { categoryTierFor, nameCategory, overtureTier } from "../../src/discovery/categories.js";
import { automatedMayReplace } from "../../src/discovery/categoryCheck.js";
import { analyze, type Page, type Subject } from "../../src/research/analyze.js";
import { parseHtml } from "../../src/research/html.js";
import { pickPages } from "../../src/research/researcher.js";
import { scoreProspect } from "../../src/scoring.js";
import { assessAutoApproval, type AutoApprovalInput } from "../../src/discovery/autoApproval.js";

const SITE = "https://harbor.example.com/";
const subject: Subject = { businessName: "Harbor Collision", website: SITE, streetAddress: null, city: "Ventura", state: "CA", postalCode: null, providerPhone: "(805) 555-0101", providerBrand: null, providerStatus: null, provider: "fixture" };
const page = (text: string, role: Page["role"] = "services", title = subject.businessName): Page => {
  const html = `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>(805) 555-0101</p><p>${text}</p></body></html>`;
  return { url: SITE + (role === "home" ? "" : role), role, parsed: parseHtml(html), html };
};
const result = (text: string, over: Partial<Subject> = {}) => analyze({ ...subject, ...over }, [page(text)], true, new Date("2026-10-05T12:00:00Z"));
const fitSignal = (r: ReturnType<typeof result>) => r.signals.find(s => s.key === "collision_repair_services");
const qualification = (r: ReturnType<typeof result>) => scoreProspect({ website: SITE, signals: Object.fromEntries(r.signals.map(s => [s.key, s.value])) }).qualification;

describe("collision/body: one segment of the automotive repair ICP", () => {
  test("body shops and mechanical repair are both default core discovery categories", () => {
    assert.deepEqual(overtureTier({ primary: "auto_body_shop", hierarchy: ["automotive_service", "auto_body_shop"] }), { tier: "core", category: "auto_body_shop" });
    assert.equal(categoryTierFor("overture", "automotive_repair"), "core");
    for (const primary of ["auto_glass_service", "auto_detailing", "towing_service", "car_wash", "tire_shop", "car_window_tinting", "hydrogen_refit_service"]) assert.equal(overtureTier({ primary, hierarchy: ["automotive_service", primary] }).tier, null);
  });
  for (const name of ["Harbor Collision", "Harbor Collision Repair", "Harbor Auto Body & Paint", "Harbor Auto Repair", "Performance Auto Repair", "Joe's Glass & Collision", "Unknown Business"]) {
    test(`name alone remains provisional: ${name}`, () => assert.equal(nameCategory({ businessName: name }).verdict, "unclear"));
  }
  test("glass alone is outside, and a provider category alone never verifies fit", () => {
    assert.equal(nameCategory({ businessName: "Joe's Glass" }).verdict, "wrong_category");
    assert.equal(nameCategory({ businessName: "Harbor", category: "auto_body_shop", categoryTier: "core" }).verdict, "unclear");
  });
  for (const text of ["We provide collision repair.", "We perform auto body repair.", "We offer accident repair.", "Our services include automotive body repair.", "We offer vehicle panel repair.", "We provide automotive structural repair after a collision.", "We provide insurance collision repair.", "Collision repair, brakes, oil changes and engine diagnostics."]) {
    test(`sourced primary repair evidence qualifies: ${text}`, () => {
      const r = result(text);
      assert.equal(r.ownership, "verified"); assert.equal(fitSignal(r)?.value, "yes");
      assert.equal(fitSignal(r)?.sourceUrl, SITE + "services"); assert.ok(fitSignal(r)?.excerpt);
      assert.equal(r.category?.verdict, "in_target"); assert.equal(qualification(r), "meets_criteria");
    });
  }
  for (const text of ["We replace windshields and auto glass.", "We detail cars and polish paint.", "We sell tires and align wheels.", "We tow vehicles.", "We wash cars.", "We install vehicle accessories and window tint.", "We work with insurance.", "We provide paint services.", ""]) {
    test(`non-repair or missing services never create fit: ${JSON.stringify(text)}`, () => {
      const r = result(text); assert.notEqual(fitSignal(r)?.value, "yes"); assert.notEqual(qualification(r), "meets_criteria");
    });
  }
  for (const text of ["Brake repairs and oil changes.", "We offer automotive repairs."]) {
    test(`mechanical repair is not collision/body, and no longer needs to be: ${JSON.stringify(text)}`, () => {
      const r = result(text); assert.notEqual(fitSignal(r)?.value, "yes"); assert.equal(qualification(r), "meets_criteria");
    });
  }
  for (const text of ["We do not offer collision repair.", "We don't provide auto body repair.", "We no longer perform collision repair.", "We cannot perform vehicle body repair.", "Collision repair is not offered here.", "Collision repair is not provided here.", "Collision repair is not performed here.", "Collision repair is unavailable."]) {
    test(`negative statements are not positive evidence: ${text}`, () => assert.equal(fitSignal(result(text))?.value, "no"));
  }
  for (const text of ["We supply collision repair equipment.", "Our directory lists collision repair shops.", "We refer you to partners for collision repair.", "We offer software for collision repair.", "Our training courses cover automotive body repair.", "We provide collision repair coverage.", "We recommend collision repair shops.", "We outsource collision repair.", "We subcontract collision repair.", "We sell collision repair products.", "We sell collision repair materials.", "We sell collision repair tools."]) {
    test(`third-party/service references do not establish fit: ${text}`, () => assert.equal(fitSignal(result(text)), undefined));
  }
  test("the business name alone does not become repair evidence", () => assert.equal(fitSignal(result("")), undefined));
  test("negative shorthand and typographic apostrophes never create Yes", () => {
    for (const text of ["No collision repair offered here.", "We don’t offer collision repair."]) assert.notEqual(fitSignal(result(text))?.value, "yes");
  });
  test("a wrong website cannot create a verified collision signal", () => {
    const r = result("We provide collision repair.", { businessName: "Another Business", providerPhone: "(805) 555-9999" });
    assert.notEqual(r.ownership, "verified"); assert.equal(fitSignal(r), undefined);
  });
  test("contradictory service statements remain reviewable, not Yes or No", () => {
    const r = analyze(subject, [page("We provide collision repair.", "home"), page("We do not offer collision repair.")], true, new Date("2026-10-05"));
    assert.equal(fitSignal(r), undefined); assert.equal(r.category?.verdict, "unclear"); assert.match(r.warnings.join(" "), /contradictory/);
    assert.equal(fitSignal(result("We offer collision repair and we do not offer collision repair.")), undefined);
    assert.equal(fitSignal(result("We offer collision repair, and collision repair is not provided here.")), undefined);
    assert.equal(fitSignal(result("We offer collision repair. Collision repair is unavailable.")), undefined);
  });
  test("dealership departments and specialty-only dent/paint services await human verification", () => {
    for (const text of ["We sell new vehicles. We provide collision repair.", "We provide automotive paintless dent repair.", "We provide automotive refinishing."]) {
      const r = result(text); assert.equal(fitSignal(r), undefined); assert.equal(r.category?.verdict, "unclear");
      assert.match(r.warnings.join(" "), /human verification/);
    }
  });
  test("chain ownership and mechanical No cannot disqualify a verified body shop", () => {
    const r = result("We offer collision repair and windshield replacement.", { providerBrand: "Caliber", businessName: subject.businessName });
    assert.equal(qualification(r), "meets_criteria");
    assert.equal(scoreProspect({ signals: { collision_repair_services: "yes", independent_shop: "no", general_repair_services: "no" } }).qualification, "meets_criteria");
  });
  test("historical mechanical Yes does not become collision evidence", () => {
    assert.equal(scoreProspect({ signals: { independent_shop: "yes", general_repair_services: "yes" } }).qualification, "unverified");
    assert.equal(scoreProspect({ signals: { collision_repair_services: "yes" } }).band, "low");
    assert.equal(scoreProspect({ signals: { collision_repair_services: "yes" } }).qualification, "meets_criteria");
  });
  test("service-page selection recognizes collision/body-specific links", () => {
    const p = page('<a href="/collision">Collision</a><a href="/contact">Contact</a>', "home");
    assert.ok(pickPages(p, 4).some(link => link.url.endsWith("/collision") && link.role === "services"));
  });
  test("automatic category updates still preserve explicit human decisions", () => {
    assert.equal(automatedMayReplace({ verdict: "wrong_category", source: "manual" }, { verdict: "in_target", source: "website", reason: "Verified collision repair", sourceUrl: SITE, rules: "collision@c2" }), false);
  });
  test("automatic approval requires collision-specific evidence and holds contradictions", () => {
    const c: AutoApprovalInput = { businessName: subject.businessName, website: SITE, city: "Ventura", state: "CA", postalCode: null, country: "US", phone: null, phoneSourceUrl: null, email: null, emailSourceUrl: null,
      signals: [{ key: "collision_repair_services", value: "yes" }], evidence: [{ signalKey: "collision_repair_services", sourceUrl: SITE, excerpt: "We offer collision repair." }], status: "researched", categoryVerdict: "in_target", categorySource: "website", categoryReason: "Verified", websiteVerifiedAt: new Date(), latestRun: { status: "completed", outcome: "website_verified", version: "r12", warnings: [], businessType: null } };
    assert.equal(assessAutoApproval(c).decision, "approve");
    assert.equal(assessAutoApproval({ ...c, evidence: [{ signalKey: "collision_repair_services" }] }).decision, "review");
    assert.equal(assessAutoApproval({ ...c, latestRun: { ...c.latestRun!, warnings: ["Collision/body evidence is contradictory; verify product fit manually."] } }).decision, "review");
  });
});
