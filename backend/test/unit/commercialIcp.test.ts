import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { COMMERCIAL_QUOTES_PER_PAGE, assessCommercialFit, commercialExcerpts, type CommercialQuote } from "../../src/policies/reclaimbay/commercial.js";
import { commercialAuditEntries } from "../../src/discovery/commercial.js";
import { accountSafety } from "../../src/discovery/account.js";
import { classifyOwnership } from "../../src/research/ownership.js";

const quote = (excerpt: string, id = "evidence-a"): CommercialQuote => ({ sourceUrl: "https://shop.example.com/services", excerpt, evidenceId: id, researchId: "run" });
const assess = (...text: string[]) => assessCommercialFit({ quotes: text.map((t, i) => quote(t, `evidence-${i}`)) });
const repair = "Our car repair services include engine repair and brake repair.";
const independent = "We are an independently owned automotive repair shop.";

describe("commercial ICP evidence and dispositions", () => {
  test("ordinary independent car repair passes with high confidence", () => {
    const r = assess(repair, independent);
    assert.equal(r.disposition, "fit"); assert.equal(r.confidence, "high"); assert.equal(r.autonomousHandling, true);
    assert.deepEqual(r.unknowns, ["declined_work_volume", "export_access", "buyer_willingness"]);
  });
  for (const text of ["We only repair trailers and install hitches with welding.", "We exclusively offer RV brake repair and RV engine repair.", "We are exclusively a machine shop providing machining and fabrication.", "We only offer automotive detailing and paint work."]) {
    test(`an explicit excluded business scope: ${text}`, () => assert.equal(assess(text).disposition, "exclude"));
  }
  test("multi-store tire retail excluded even with real mechanical services", () => {
    const r = assess("We operate a tire retail chain with multiple stores.", repair);
    assert.equal(r.disposition, "exclude"); assert.equal(r.findings[0]!.code, "commercial.multi_store_tire_retail");
  });
  test("a tire shop with substantial repair passes", () => assert.equal(assess("Our tire store is family-owned.", repair).disposition, "fit"));
  test("performance label with normal maintenance and repair passes", () => assert.equal(assess("Our performance shop is family-owned.", repair, "We perform routine maintenance for daily drivers.").disposition, "fit"));
  test("actual racing services do not imply normal customer workload", () => assert.equal(assess("We offer race car fabrication and track car setup.", repair).disposition, "review"));
  test("mixed racing and substantial ordinary road-car workload can pass", () => assert.equal(assess("We offer race car fabrication.", repair, independent, "We perform routine maintenance for daily drivers.").disposition, "fit"));
  test("a transmission specialty fits without workflow wording (R16.1)", () => assert.equal(assess("We offer transmission repair.", independent).disposition, "fit"));
  test("specialty with sourced estimates and follow-up can fit", () => assert.equal(assess("We offer transmission repair with written repair estimates and customer follow-up.", independent).disposition, "fit"));
  test("collision repair with an appropriate estimate workflow fits", () => assert.equal(assess("We offer automotive collision repair with written repair estimates.", independent).disposition, "fit"));
  test("adjacent fabrication plus routine passenger-car services can fit", () => assert.equal(assess("Our fabrication business handles trailer work.", repair, independent, "We offer regular maintenance for passenger cars.").disposition, "fit"));
  test("a machine-written service label cannot qualify itself", () => assert.equal(assess("Names engine, brakes: Our friendly team welcomes you.").disposition, "review"));
  test("a name or ownership hint cannot cause automatic exclusion", () => {
    assert.equal(assess("Trailer Hitch Welding Race Machine Tires").disposition, "review");
    assert.equal(assessCommercialFit({ quotes: [quote(repair)], ownership: "chain" }).disposition, "review");
  });
  test("normal repair and explicit exclusive non-car scope conflict", () => {
    const r = assess(repair, "We only repair trailers."); assert.equal(r.disposition, "review");
    assert.equal(r.findings[0]!.code, "commercial.conflicting_scope"); assert.equal(r.findings[0]!.evidence.length, 2);
  });
  test("negated services cannot count as positive repair", () => assert.equal(assess("We do not offer engine repair or brake repair.", independent).disposition, "review"));
  test("not only is not an exclusive exclusion", () => assert.notEqual(assess("We provide not only trailer fabrication but car repairs.").disposition, "exclude"));
  test("dealership alternative is not dealership ownership", () => assert.equal(assess("We are an independent shop and your alternative to the dealership.", repair).disposition, "fit"));
  test("manufacturer ownership needs an actual manufacturer domain, not a make in a name", () => {
    assert.equal(classifyOwnership({ businessName: "Tesla Repair Experts", siteHost: "independent.example.com", labels: ["Tesla Service"], chainOnSite: false, dealerActivity: false, statesIndependent: true, siteLocations: 1 }).ownership, "independent");
  });
  test("unknown independence is medium confidence and cannot be autonomous", () => {
    const r = assess(repair); assert.equal(r.disposition, "fit"); assert.equal(r.confidence, "medium"); assert.equal(r.autonomousHandling, false);
  });
  test("deterministic regardless of evidence ordering; inputs untouched", () => {
    const q = [quote(repair), quote(independent, "b")], before = structuredClone(q);
    assert.deepEqual(assessCommercialFit({ quotes: q }), assessCommercialFit({ quotes: [...q].reverse() })); assert.deepEqual(q, before);
  });
  test("audit entries retain every reference and valid JSON within existing limits", () => {
    const q = Array.from({ length: 40 }, (_, i) => quote(repair, "a".repeat(32) + i));
    const entries = commercialAuditEntries(assessCommercialFit({ quotes: q }), { candidateId: "c", action: "exclude" });
    assert.ok(entries.every(e => e.length <= 2000));
    assert.equal(entries.flatMap(e => JSON.parse(e).references).length, 40);
    assert.ok(entries.every(e => JSON.parse(e).rules === "reclaimbay.commercial@v1"));
  });
  test("quote extraction keeps actual text, never manufactures a finding", () => {
    // Repair services are stored as their own evidence rows; commercial quotes keep what can change a commercial finding.
    assert.deepEqual(commercialExcerpts("Our shop is family-owned. We offer car engine repair. Welcome!"), ["Our shop is family-owned."]);
  });
});

describe("R16.1 commercial safety alignment", () => {
  const verdict = (...text: string[]) => { const r = assess(...text); return `${r.disposition}/${r.confidence}`; };
  describe("ordinary language is not an exclusion", () => {
    for (const text of [
      "We only repair cars and light trucks, no RVs or motorcycles.",
      "We only work on cars, not boats or trailers.",
      "We only paint with factory-matched colors.",
      "We only use OEM parts and factory-matched paint.",
      "Free estimates on all collision repairs.",
    ]) test(JSON.stringify(text), () => assert.notEqual(assess(text, "We provide collision repair.").disposition, "exclude"));
  });
  test("a passenger-only transmission specialist with 'no RVs' wording fits", () =>
    assert.equal(verdict("We specialize in transmission repair and transmission rebuilds.", "We only repair cars and light trucks, no RVs or motorcycles.", independent), "fit/high"));
  test("a collision shop offering free estimates fits; the estimates count as workflow", () => {
    const r = assess("We provide collision repair and auto body work.", "Free estimates on all repairs.", independent);
    assert.equal(r.disposition, "fit"); assert.ok(r.findings.some(f => f.code === "commercial.repair_workflow"));
  });
  test("a collision shop with factory-matched paint fits", () => assert.equal(assess("We provide collision repair.", "We only paint with factory-matched colors.").disposition, "fit"));
  test("single-specialty businesses fit without breadth or workflow terms", () => {
    for (const text of ["We offer brake repair.", "Our muffler shop offers exhaust repair.", "Radiator repair while you wait.", "We offer diesel repair for pickups."]) {
      assert.equal(assess(text).disposition, "fit", text);
    }
  });
  test("hybrid collision and mechanical, and broad mechanical, fit", () => {
    assert.equal(assess("We provide collision repair, brake repair and engine repair.").disposition, "fit");
    assert.equal(assess(repair).disposition, "fit");
  });
  test("generic language alone is still not commercial fit", () => assert.equal(assess("We are a full-service auto repair shop.").disposition, "review"));
  test("affirmative adjacent trades still need quoted passenger-car repair", () => {
    assert.equal(assess("We repair trailers and RVs.").disposition, "review");
    assert.equal(assess("We repair trailers and RVs.", "We offer brake repair for cars and SUVs.").disposition, "fit");
  });
  describe("account-segment exclusions remain explainable dispositions (a person decides; nothing is rejected)", () => {
    test("dealer", () => { const r = assess("We are a dealership service center.", "We offer brake repair."); assert.equal(r.disposition, "exclude"); assert.equal(r.findings[0]!.code, "commercial.dealer_manufacturer"); assert.equal(r.autonomousHandling, false); assert.equal(r.requiresHumanReview, true); });
    test("manufacturer", () => assert.equal(assess("Our manufacturer-owned service center offers brake repair.").findings[0]!.code, "commercial.dealer_manufacturer"));
    test("chain (derived ownership) is held for review", () => assert.equal(assessCommercialFit({ quotes: [quote(repair)], ownership: "chain" }).findings[0]!.code, "commercial.ownership_unresolved"));
    test("manufacturer (derived ownership) is held for review", () => assert.equal(assessCommercialFit({ quotes: [quote(repair)], ownership: "manufacturer" }).disposition, "review"));
    test("national tire retail chain", () => {
      for (const t of ["We are a nationwide tire retail company with tire stores in every state.", "Our tire stores: 40 locations across California."]) {
        const r = assess(t, repair); assert.equal(r.disposition, "exclude", t); assert.equal(r.findings[0]!.code, "commercial.multi_store_tire_retail");
      }
    });
    test("a regional tire-and-repair business is reviewed, not excluded", () => {
      const r = assess("Family tire stores with 3 locations.", repair); assert.equal(r.disposition, "review"); assert.equal(r.findings[0]!.code, "commercial.tire_retail_locations");
    });
  });
  test("genuine exclusive non-passenger scopes are still recognised", () => {
    for (const t of ["We only repair trailers.", "We work exclusively on motorcycles.", "We only offer detailing and ceramic coatings."]) assert.equal(assess(t).disposition, "exclude", t);
  });
  test("quote storage keeps commercial claims, drops general repair copy, and caps a page", () => {
    const page = ["We offer brake repair.", "We are family owned.", "Free estimates.", "We only repair trailers.", "We are a dealership.", "Our tire stores have 3 locations.", ...Array.from({ length: 30 }, (_, i) => `We are independently owned, branch ${i}.`)].join(" ");
    const kept = commercialExcerpts(page);
    assert.ok(!kept.includes("We offer brake repair."));
    for (const s of ["We are family owned.", "Free estimates.", "We only repair trailers.", "We are a dealership.", "Our tire stores have 3 locations."]) assert.ok(kept.includes(s), s);
    assert.equal(kept.length, COMMERCIAL_QUOTES_PER_PAGE);
  });
});

describe("account identity is separate from physical locations", () => {
  const a = { id: "a", businessName: "Neighborhood Service", website: "https://brand.example.com/a", city: "Ventura", state: "CA", phone: "8055550101" };
  const b = { ...a, id: "b", city: "Simi Valley", website: "https://www.brand.example.com/b", phone: "8055550102" };
  test("two locations of one brand cannot be two autonomous accounts", () => assert.equal(accountSafety(a, [a, b], []).code, "shared_brand_locations"));
  test("another location already has a Prospect/account", () => assert.equal(accountSafety(b, [a, b], [{ ...a, id: "prospect" }]).code, "existing_account"));
  test("shared domain with a different business name remains ambiguous", () => assert.equal(accountSafety(a, [{ ...b, businessName: "Unrelated Machine Company" }], []).code, "shared_domain_unresolved"));
  test("a single account identity is clear", () => assert.equal(accountSafety(a, [a], []).clear, true));
});
