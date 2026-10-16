import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseHtml } from "@avannelli/aos/html";
import { analyze, type Page, type Subject } from "../../src/research/analyze.js";
import { affirms, assessServiceEvidence, concreteServicesIn, tradeContext } from "../../src/research/serviceEvidence.js";
import { addressKeysIn, classifyLocation, evidencePageAllowed } from "../../src/research/location.js";
import { classifyOwnership } from "../../src/research/ownership.js";
import { duplicateRelationships, type RelationshipRow } from "../../src/discovery/relationships.js";
import { assessReadiness } from "../../src/discovery/readiness.js";
import type { AutomationCandidate, Protection } from "../../src/discovery/automationPolicy.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import { READY_OWNERSHIP } from "../../src/policies/reclaimbay/readiness.js";
import { suiteKey } from "../../src/discovery/normalize.js";

/* Research r16 / discovery@d2 qualification rules. Each rule is tested both ways:
 * the false positive is blocked, and a legitimate repair business still passes. */

const q = (excerpt: string, url = "https://shop.example.com/services", title?: string) => ({ url, excerpt, title });
const svc = (businessName: string, ...excerpts: string[]) => assessServiceEvidence({ businessName, quotes: excerpts.map((e) => q(e)) });

describe("r16 service evidence: concrete services, not automotive-sounding language", () => {
  for (const generic of ["We offer quality auto repairs backed by years of experience!", "Most people worry when they need car repairs done.", "Complete car care from your local auto experts.", "Our factory-trained technicians care for your vehicle.", "We are an auto repair shop serving Ventura."]) {
    test(`generic language alone is not service evidence: ${generic}`, () => {
      assert.equal(svc("Harbor Auto", generic).strength, "none");
    });
  }
  test("two concrete services, each quoted, are strong", () => {
    const r = svc("Harbor Auto", "We offer brake repair.", "Our services include engine repair.");
    assert.equal(r.strength, "strong");
    assert.deepEqual(r.counted.map((c) => c.label), ["engine", "brakes"]);
    for (const c of r.counted) assert.match(c.excerpt, new RegExp(`^Names ${c.label}: `));
  });
  test("one non-specialist concrete service is weak", () => assert.equal(svc("Harbor Auto", "We offer brake repair and oil changes.").strength, "weak"));
  test("make specialists are not service specialists: German auto + one service is weak", () => {
    assert.equal(svc("German Auto Specialist", "Brake repair for BMW and Mercedes.").strength, "weak");
    assert.equal(svc("German Auto Specialist", "Brake repair and engine diagnostics for BMW and Mercedes.").strength, "strong");
  });
  const specialists: [string, string, string][] = [
    ["Leon's Transmissions", "We specialize in transmission repair.", "transmission/drivetrain"],
    ["Accurate Muffler Shop", "Muffler repair while you wait.", "exhaust"],
    ["Valley Radiator", "Radiator repair and replacement.", "cooling system"],
    ["Coast Brakes", "Brake repair for cars and trucks.", "brakes"],
    ["Arroyo Auto Electric", "Automotive electrical repair.", "electrical"],
    ["Ventura Diesel", "Diesel repair for pickups.", "diesel"],
    ["Pro Alignment Center", "Suspension repair and steering repair.", "suspension/steering"],
    ["Harbor Collision", "We offer collision repair.", "collision/body"],
    ["DriveshaftPro", "Driveshaft repair and balancing.", "transmission/drivetrain"],
    ["Pacific Carburetor Co", "Carburetor rebuild for classic cars.", "engine"],
  ];
  for (const [name, text, label] of specialists) {
    test(`a matching specialist qualifies on one service: ${name}`, () => {
      const r = svc(name, text);
      assert.equal(r.strength, "strong", r.reason);
      assert.equal(r.specialist, label);
    });
  }
  test("a self-description states a specialty too", () => assert.equal(svc("Coast Auto", "We are transmission specialists: transmission repair.").specialist, "transmission/drivetrain"));
  test("each counted service needs its own quote: a machine label never counts", () => {
    const r = svc("Harbor Auto", "Names brakes, engine, transmission/drivetrain: We offer brake repair.");
    assert.deepEqual(r.counted.map((c) => c.label), ["brakes"]);
    assert.equal(r.strength, "weak");
  });
  test("the loose single-word scan cannot qualify: bare service words are not repair phrases", () => {
    assert.equal(svc("Harbor Auto", "Brakes Suspension Electrical Battery Transmission Exhaust").strength, "none");
  });
  test("the business name is never evidence", () => assert.deepEqual(concreteServicesIn("Champion Transmission Repair", "Champion Transmission Repair"), []));
});

describe("r16 adjacent and specialty businesses", () => {
  test("trailer service is not passenger-vehicle repair: held for a person", () => {
    const r = assessServiceEvidence({ businessName: "Eckhart Trailer Hitch And Welding", siteTitles: ["Custom Trailer Hitches & Welding"], quotes: [q("Axle & Brake Replacement, Burnt Trailer Brakes, packing the bearings", "https://eckharts.example.com/products/trailer-services.html")] });
    assert.notEqual(r.strength, "strong");
    assert.deepEqual(r.trades.sort(), ["hitch", "trailer", "welding"]);
  });
  test("RV-only repair is not counted", () => assert.notEqual(svc("Coast RV Service", "RV AC repair and RV brake repair.").strength, "strong"));
  test("hitch-only is held as outside the initial ICP", () => {
    const r = assessServiceEvidence({ businessName: "Hitch Pros", quotes: [q("Hitch installation for any vehicle.")] });
    assert.equal(r.outsideIcp, true);
  });
  for (const [name, text] of [["Valley Welding", "Custom welding and repairs."], ["Empire Fabrication", "Custom fabrication and roll cages."], ["Camarillo Machine Company", "CNC machining services."]] as const) {
    test(`${name}: no concrete passenger-vehicle repair, not strong`, () => assert.notEqual(svc(name, text).strength, "strong"));
  }
  test("legitimate car repair at a welding shop qualifies on its own evidence", () => {
    assert.equal(svc("Valley Welding & Auto", "We offer car brake repair.", "Our technicians perform truck engine repair.").strength, "strong");
  });
  test("an adjacent page only discounts its own quotes: a repair shop's hitch page is not its business", () => {
    const r = assessServiceEvidence({ businessName: "Harbor Auto", quotes: [q("Trailer brake repair and hitch installation.", "https://shop.example.com/trailer-hitches"), q("Brake repair and engine repair for cars.", "https://shop.example.com/services")] });
    assert.equal(r.strength, "strong");
    assert.ok(r.trades.includes("hitch"));
  });
  test("performance/motorsports need two concrete services (no specialist exception)", () => {
    assert.equal(svc("Penta Motorsports", "Engine repair and rebuilds.").strength, "weak");
    assert.equal(svc("Penta Motorsports", "Engine repair and brake repair.").strength, "strong");
    assert.equal(assessServiceEvidence({ businessName: "Demand", siteTitles: ["Demand is a Custom Auto Shop"], quotes: [q("Engine repair.")] }).strength, "weak");
  });
  test("tire-only is not repair; a tire shop with two non-tire repair services is", () => {
    assert.equal(svc("Valley Tire Center", "Tire rotation, flat repair and TPMS service.").strength, "none");
    assert.equal(svc("Jason's Tires N' Wheels", "Engine repair and replacement, and transmission repair.").strength, "strong");
    assert.equal(svc("Jason's Tires N' Wheels", "Brake repair.").strength, "weak");
  });
  test("paint/restoration only is cosmetic, never strong", () => assert.equal(svc("Executive Paintworks", "Automotive paint work and dent repair.").strength, "none"));
  test("mobile mechanics need two concrete services", () => {
    assert.equal(svc("Ventura Mobile Brakes", "Brake repair at your home.").strength, "weak");
    assert.equal(svc("Ventura Mobile Mechanic", "Brake repair and A/C repair at your driveway.").strength, "strong");
  });
  test("trade context reads the name, titles and URL paths", () => {
    assert.deepEqual(tradeContext({ businessName: "Coast Auto", titles: ["RV & Trailer Service"], urls: ["https://x.example.com/welding-shop"] }).sort(), ["RV", "trailer", "welding"]);
    assert.deepEqual(tradeContext({ businessName: "Harbor Auto Repair", titles: ["Harbor Auto Repair"] }), []);
  });
});

describe("R16.2 negation, specialty, collision, hybrid, tire and ambiguous descriptions", () => {
  const ctx = (businessName: string, ...excerpts: string[]) => assessServiceEvidence({ businessName, quotes: excerpts.map((e) => q(e)) });
  for (const ruledOut of [
    "Brake repair for cars and trucks, no RVs or motorcycles.",
    "Brake repair for cars and trucks, except boats and motorcycles.",
    "We do brake repair on cars and SUVs, not trailers or campers.",
    "Brake repair for cars and pickups (no RV work).",
  ]) {
    test(`a ruled-out trade does not discount passenger repair in an adjacent context: ${JSON.stringify(ruledOut)}`, () => {
      const r = ctx("Harbor Auto & Trailer", ruledOut, "Engine repair for cars and SUVs.");
      assert.equal(r.strength, "strong", r.reason);
      assert.deepEqual(r.counted.map((c) => c.label), ["engine", "brakes"]);
    });
  }
  test("an affirmed trade still discounts the quote in an adjacent context", () => {
    const r = ctx("Harbor Auto & Trailer", "Brake repair for cars, RVs and trailers.", "Engine repair for cars and SUVs.");
    assert.deepEqual(r.counted.map((c) => c.label), ["engine"]);
    assert.equal(r.strength, "weak");
  });
  test("recorded business trades with a ruled-out quote", () => {
    const r = assessServiceEvidence({ businessName: "Coast Garage", trades: ["trailer"], quotes: [q("Transmission repair for cars and trucks, no RVs or motorcycles."), q("A/C repair for cars.")] });
    assert.equal(r.strength, "strong", r.reason);
  });
  test("a plain repair shop that says 'no RVs or motorcycles' keeps its services", () => {
    assert.equal(ctx("Harbor Auto Repair", "We repair cars and trucks, no RVs or motorcycles.", "Brake repair and engine repair.").strength, "strong");
  });
  test("the negation helper reads the clause, not the whole sentence", () => {
    assert.equal(affirms(/\brvs?\b/i, "Cars and trucks, no RVs."), false);
    assert.equal(affirms(/\brvs?\b/i, "No cars here: RV repair only."), true);
    assert.equal(affirms(/\btrailers?\b/i, "We do not just fix cars, but also trailers."), true);
  });
  describe("specialty", () => {
    test("a stated specialty qualifies on one quoted service; the same service at a general shop is weak", () => {
      assert.equal(ctx("Harbor Transmission", "We rebuild and repair transmissions: transmission repair.").strength, "strong");
      assert.equal(ctx("Harbor Auto Repair", "Transmission repair.").strength, "weak");
    });
    test("a specialist that rules out trades stays a specialist", () => {
      const r = ctx("Coast Transmissions", "Transmission repair for cars and light trucks, no RVs or motorcycles.");
      assert.equal(r.strength, "strong"); assert.equal(r.specialist, "transmission/drivetrain");
    });
  });
  describe("collision", () => {
    test("collision-only shop named for it is strong; body and paint is collision work", () => {
      assert.equal(ctx("Harbor Collision Center", "We offer collision repair.").strength, "strong");
      assert.deepEqual(concreteServicesIn("", "Auto body and paint for all makes."), ["collision/body"]);
    });
    test("collision at a general shop needs a second service", () => {
      assert.equal(ctx("Harbor Auto", "We offer collision repair.").strength, "weak");
      assert.equal(ctx("Harbor Auto", "We offer collision repair.", "Brake repair too.").strength, "strong");
    });
  });
  test("hybrid collision and mechanical is strong on two quoted services", () => {
    const r = ctx("Harbor Auto Body & Repair", "Collision repair and auto body work.", "Brake repair and engine diagnostics.");
    assert.equal(r.strength, "strong"); assert.ok(r.counted.length >= 2);
  });
  describe("tire shops", () => {
    test("tire service alone is none; one repair service is weak; two are strong", () => {
      assert.equal(ctx("Harbor Tire", "Tire rotation, balancing and flat repair.").strength, "none");
      assert.equal(ctx("Harbor Tire", "Brake repair.").strength, "weak");
      assert.equal(ctx("Harbor Tire", "Brake repair.", "Wheel alignment and suspension repair.").strength, "strong");
    });
    test("a tire shop's 'no RVs' wording does not discount its repair", () => {
      assert.equal(ctx("Harbor Tire & Auto", "Brake repair for cars and trucks, no RVs or motorcycles.", "Engine repair.").strength, "strong");
    });
  });
  describe("ambiguous descriptions are missing evidence, never negative evidence", () => {
    for (const text of ["We service all makes and models.", "Your one-stop shop for car care.", "We fix cars.", "Oil changes and tire rotations.", "Quality work at fair prices."]) {
      test(JSON.stringify(text), () => {
        const r = ctx("Harbor Auto", text);
        assert.equal(r.strength, "none"); assert.equal(r.counted.length, 0); assert.equal(r.outsideIcp, false);
      });
    }
  });
});

describe("r16 location identity", () => {
  const page = (url: string, over: Partial<{ nameOnPage: boolean; ownAddress: boolean; addressKeys: string[]; isStored: boolean }> = {}) => ({ url, isStored: false, nameOnPage: true, ownAddress: false, addressKeys: [], ...over });
  const OWN = "964 Chambers Ln";
  test("own location page: name + this address", () => {
    const r = classifyLocation({ subjectStreet: OWN, providerPhoneOnSite: false, pages: [page("https://d.example.com/simi-valley/", { isStored: true, ownAddress: true, addressKeys: ["964 chambers ln"] })] });
    assert.equal(r.identity, "verified_location");
    assert.equal(r.pages[0]!.location, "own_location");
  });
  test("single-location homepage: name + the provider's phone, no other address", () => {
    const r = classifyLocation({ subjectStreet: OWN, providerPhoneOnSite: true, pages: [page("https://d.example.com/", { isStored: true }), page("https://d.example.com/services")] });
    assert.equal(r.identity, "single_location_site");
    assert.deepEqual(r.pages.map((p) => p.location), ["own_site", "own_site"]);
  });
  test("identity never rests on a conflicting phone", () => {
    assert.equal(classifyLocation({ subjectStreet: OWN, providerPhoneOnSite: false, pages: [page("https://d.example.com/", { isStored: true })] }).identity, "unverified");
  });
  test("parent brand homepage: service evidence only after this location's page verified it", () => {
    const r = classifyLocation({ subjectStreet: OWN, providerPhoneOnSite: true, pages: [page("https://d.example.com/", { isStored: true, addressKeys: ["1561 los angeles ave", "2457 palma dr"] }), page("https://d.example.com/simi-valley/", { ownAddress: true, addressKeys: ["964 chambers ln"] })] });
    assert.equal(r.identity, "verified_location");
    assert.equal(r.pages[0]!.location, "brand");
    assert.equal(evidencePageAllowed("brand", "verified_location"), true);
    assert.equal(evidencePageAllowed("brand", "single_location_site"), false);
  });
  test("multi-address site without this location's address: unverified", () => {
    const r = classifyLocation({ subjectStreet: OWN, providerPhoneOnSite: true, pages: [page("https://d.example.com/", { isStored: true, addressKeys: ["1561 los angeles ave", "2457 palma dr"] })] });
    assert.equal(r.identity, "unverified");
    assert.equal(r.siteLocations, 2);
  });
  test("another location's page: mismatch, never evidence", () => {
    const r = classifyLocation({ subjectStreet: "620 Maulhardt Ave", providerPhoneOnSite: true, pages: [page("https://dp.example.com/ventura", { isStored: true, addressKeys: ["2457 palma dr"] })] });
    assert.equal(r.identity, "other_location");
    assert.equal(r.pages[0]!.location, "other_location");
    assert.equal(evidencePageAllowed("other_location", "verified_location"), false);
  });
  test("unrelated business on the same domain: mismatch", () => {
    const r = classifyLocation({ subjectStreet: "61 N Aviador St", providerPhoneOnSite: false, pages: [page("https://camarillocarcare.example.com/", { isStored: true, nameOnPage: false, addressKeys: ["2739 e daily dr"] })] });
    assert.equal(r.identity, "mismatch");
    assert.equal(r.pages[0]!.location, "other_business");
  });
  test("another spelling of this address is not another location", () => {
    assert.equal(classifyLocation({ subjectStreet: "5577 Saviers Rd", providerPhoneOnSite: true, pages: [page("https://s.example.com/", { isStored: true, ownAddress: true, addressKeys: ["5577 saviers rd", "5577 s saviers rd"] })] }).siteLocations, 1);
  });
  test("street addresses are read from text and structured data", () => {
    assert.deepEqual(addressKeysIn("Visit us at 1561 Los Angeles Ave, Ventura or 964 Chambers Ln, Simi Valley.").sort(), ["1561 los angeles ave", "964 chambers ln"]);
    assert.deepEqual(addressKeysIn("Our 6 service bays since 1988.", ["2739 E Daily Dr"]), ["2739 e daily dr"]);
  });
  // R16.1: a copyright or founding year followed by a name with a street word is not a second location.
  for (const text of ["© 2025 Saviers Road Auto Repair", "Copyright © 2010-2025 Harbor Boulevard Garage", "(c) 2024 Main Street Motors. All rights reserved.", "Since 1988 Oak Avenue Auto has served Oxnard.", "Est. 1972 Elm Street Garage", "Founded 1999 Pacific Highway Automotive"]) {
    test(`a notice year is not a house number: ${JSON.stringify(text)}`, () => assert.deepEqual(addressKeysIn(text), []));
  }
  test("a ZIP code is not a house number for the name that follows it", () => {
    assert.deepEqual(addressKeysIn("5577 Saviers Rd, Oxnard, CA 93033 © 2025 Saviers Road Auto Repair"), ["5577 saviers rd"]);
    assert.deepEqual(addressKeysIn("Oxnard, CA 93033 Saviers Road Auto Repair"), []);
  });
  test("a real second address beside a copyright notice still counts", () => {
    assert.deepEqual(addressKeysIn("Also at 2025 Harbor Blvd, Ventura. © 2025 Saviers Road Auto Repair"), ["2025 harbor blvd"]);
  });
});

describe("r16 location identity on real pages (analyze)", () => {
  const SITE = "https://dependable.example.com/";
  const subject = (over: Partial<Subject>): Subject => ({ businessName: "Dependable Car Care", website: SITE, streetAddress: null, city: null, state: "CA", postalCode: null, providerPhone: null, providerBrand: null, providerStatus: null, provider: "fixture", ...over });
  const pg = (url: string, role: Page["role"], title: string, body: string): Page => {
    const html = `<html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
    return { url, role, parsed: parseHtml(html), html };
  };
  const brandHome = pg(SITE, "home", "Auto Repair Shop Ventura & Simi Valley - Dependable Car Care", "<p>Ventura: 1561 Los Angeles Ave · (805) 659-2957</p><p>Simi Valley: 964 Chambers Ln · (805) 581-9013</p>");
  const services = pg(SITE + "services", "services", "Dependable Car Care Services", "<p>Our services include brake repair, engine repair and transmission repair.</p>");
  test("a brand location whose address is on the site is verified, and brand services count", () => {
    const a = analyze(subject({ city: "Simi Valley", streetAddress: "964 Chambers Ln", providerPhone: "(805) 581-9013" }), [brandHome, services], true, new Date("2026-10-14"));
    assert.equal(a.facts.find((f) => f.field === "location_identity")?.value, "verified_location");
    assert.equal(a.facts.find((f) => f.field === "ownership_class")?.value, "regional");
    assert.ok(a.signals.filter((s) => s.key === "automotive_repair_services").length >= 3);
    assert.equal(a.contact.phone, "(805) 581-9013");
  });
  test("a brand location whose address is not on the site gets no repair Yes and no contact phone", () => {
    const a = analyze(subject({ city: "Thousand Oaks", streetAddress: "100 Main St", providerPhone: "(805) 581-9013" }), [brandHome, services], true, new Date("2026-10-14"));
    assert.equal(a.facts.find((f) => f.field === "location_identity")?.value, "unverified");
    assert.equal(a.signals.some((s) => s.key === "automotive_repair_services"), false);
    assert.equal(a.contact.phone, undefined);
    assert.equal(a.facts.find((f) => f.field === "phone")?.state, "uncertain");
  });
  test("a stored page of another location is a mismatch with a blocking warning", () => {
    const ventura = pg("https://dp.example.com/ventura", "home", "DriveshaftPro Ventura", "<p>DriveshaftPro · 2457 Palma Dr, Ventura · (805) 555-0100</p><p>We offer driveshaft repair.</p>");
    const a = analyze({ ...subject({}), businessName: "DriveshaftPro - Oxnard", website: "https://dp.example.com/ventura", streetAddress: "620 Maulhardt Ave", city: "Oxnard", providerPhone: "(805) 555-0100" }, [ventura], true, new Date("2026-10-14"));
    assert.equal(a.facts.find((f) => f.field === "location_identity")?.value, "other_location");
    assert.match(a.warnings.join(" "), /another location's page/);
    assert.equal(a.signals.some((s) => s.key === "automotive_repair_services"), false);
  });
  test("R16.1: a copyright line naming the business is not a second location; a family-owned single site is independent", () => {
    const home = pg("https://saviers.example.com/", "home", "Saviers Road Auto Repair", "<p>Family owned and operated since 1988.</p><p>Call (805) 555-0101 · 5577 Saviers Rd, Oxnard, CA 93033</p><footer>© 2025 Saviers Road Auto Repair</footer>");
    const svcPage = pg("https://saviers.example.com/services", "services", "Services", "<p>We provide brake repair, engine repair and A/C repair.</p><footer>© 2025 Saviers Road Auto Repair</footer>");
    const a = analyze({ ...subject({}), businessName: "Saviers Road Auto Repair", website: "https://saviers.example.com/", streetAddress: "5577 Saviers Rd", city: "Oxnard", providerPhone: "(805) 555-0101" }, [home, svcPage], true, new Date("2026-10-14"));
    assert.equal(a.facts.find((f) => f.field === "site_locations")?.value, "1");
    assert.equal(a.facts.find((f) => f.field === "ownership_class")?.value, "independent");
    assert.deepEqual(a.facts.filter((f) => f.field === "page_location").map((f) => f.value), ["own_location", "own_site"]);
  });
});

describe("r16 ownership", () => {
  const own = (over: Partial<Parameters<typeof classifyOwnership>[0]>) => classifyOwnership({ businessName: "Harbor Auto", siteHost: "harbor.example.com", labels: [], chainOnSite: false, dealerActivity: false, statesIndependent: false, siteLocations: 1, ...over }).ownership;
  test("independent", () => assert.equal(own({ statesIndependent: true }), "independent"));
  test("a regional brand with up to 5 locations", () => assert.equal(own({ siteLocations: 3 }), "regional"));
  test("more than 5 locations is a chain", () => assert.equal(own({ siteLocations: 8 }), "chain"));
  test("a franchise brand on the site is a chain", () => assert.equal(own({ chainOnSite: true }), "chain"));
  test("dealership activity", () => assert.equal(own({ dealerActivity: true }), "dealership"));
  test("independent but with dealership activity", () => assert.equal(own({ dealerActivity: true, statesIndependent: true }), "possible_dealership"));
  test("manufacturer-owned", () => assert.equal(own({ businessName: "Tesla Collision Thousand Oaks", siteHost: "tesla.com" }), "manufacturer"));
  test("unknown independence", () => assert.equal(own({}), "unknown"));
  test("the initial ICP allows independent, regional and unknown only", () => assert.deepEqual([...READY_OWNERSHIP], ["independent", "regional", "unknown"]));
});

describe("r16 duplicate relationships", () => {
  const row = (id: string, over: Partial<RelationshipRow> = {}): RelationshipRow => ({ id: id.padEnd(36, "0"), businessName: id, status: "researched", website: null, phone: null, providerPhone: null, streetAddress: null, possibleDuplicateCandidateId: null, duplicateDecision: null, ...over });
  const me = row("me", { website: "https://shop.example.com/", phone: "(805) 555-0101", streetAddress: "270 N Aviador St #L" });
  const rel = (...others: RelationshipRow[]) => duplicateRelationships(me, [me, ...others]);
  test("an incoming duplicate flag blocks", () => assert.equal(rel(row("a", { status: "needs_review", possibleDuplicateCandidateId: me.id })).blocking.length, 1));
  test("an incoming chain through a closed duplicate blocks", () => {
    const closed = row("c", { status: "duplicate", possibleDuplicateCandidateId: me.id });
    assert.match(rel(closed, row("n", { status: "needs_review", possibleDuplicateCandidateId: closed.id })).blocking.join(" "), /n\s/);
  });
  test("a resolved 'not a duplicate' never blocks", () => {
    assert.deepEqual(rel(row("a", { possibleDuplicateCandidateId: me.id, duplicateDecision: "not_duplicate", phone: "(805) 555-0101" })).blocking, []);
  });
  test("an exact shared phone with an active candidate blocks", () => assert.match(rel(row("p", { providerPhone: "805-555-0101" })).blocking.join(), /Same phone/));
  test("the same website and street address blocks", () => assert.match(rel(row("d", { website: "https://www.shop.example.com/x", streetAddress: "270 N Aviador St" })).blocking.join(), /Same website and street address/));
  test("the same website and phone blocks", () => assert.match(rel(row("d", { website: "https://shop.example.com/", phone: "805.555.0101" })).blocking.join(), /Same website and phone/));
  test("the same website at a different location is a multi-location peer, not a duplicate", () => {
    const r = rel(row("v", { website: "https://shop.example.com/ventura", streetAddress: "1561 Los Angeles Ave", phone: "(805) 555-0199" }));
    assert.deepEqual(r.blocking, []);
    assert.equal(r.multiLocationPeers.length, 1);
  });
  test("the same street in a different suite is only a warning", () => {
    const r = rel(row("s", { streetAddress: "270 N Aviador St #B" }));
    assert.deepEqual(r.blocking, []);
    assert.equal(r.warnings.length, 1);
  });
  test("the same street and the same suite blocks", () => assert.match(rel(row("s", { streetAddress: "270 N Aviador St Unit L" })).blocking.join(), /suite/));
  test("closed records (approved, rejected) are not live duplicates here", () => assert.deepEqual(rel(row("r", { status: "rejected", phone: "(805) 555-0101" })).blocking, []));
  test("suites are read from #, Ste, Suite, Unit", () => assert.deepEqual(["5956 E Los Angeles Ave Ste 8", "126 N Wood Rd #114", "1 Main St Suite A", "9 Elm St"].map(suiteKey), ["8", "114", "a", null]));
});

describe("r16 Ready assessment", () => {
  const RUN = "run-r16-0000-0000-0000-000000000000";
  const src = (id: string, url: string) => ({ id, researchId: RUN, kind: "website", url, finalUrl: null, ok: true });
  const fact = (field: string, value: string | null, extra: Record<string, unknown> = {}) => ({ id: `${field}-${Math.random()}`, researchId: RUN, field, value, state: "verified", confidence: null, sourceId: null, excerpt: null, note: null, ...extra });
  const ev = (excerpt: string, url = "https://shop.example.com/services", researchId = RUN) => ({ id: `e-${Math.random()}`, candidateId: "c", signalKey: "automotive_repair_services", sourceUrl: url, excerpt, origin: "research", researchId, createdAt: new Date() });
  const base = (over: { facts?: ReturnType<typeof fact>[]; evidence?: ReturnType<typeof ev>[]; version?: string } = {}) => ({
    id: "c", businessName: "Harbor Auto Repair", website: "https://shop.example.com/",
    evidence: over.evidence ?? [ev("Names brakes: We offer brake repair."), ev("Names engine: Engine repair for cars.")],
    research: [{ id: RUN, version: over.version ?? RESEARCH_VERSION, status: "completed", outcome: "website_verified", subjectWebsite: "https://shop.example.com/",
      sources: [src("s-home", "https://shop.example.com/"), src("s-svc", "https://shop.example.com/services")],
      facts: over.facts ?? [fact("location_identity", "verified_location"), fact("ownership_class", "unknown"), fact("site_locations", "1"), fact("business_name", "Harbor Auto Repair"),
        fact("page_location", "own_location", { sourceId: "s-home" }), fact("page_location", "own_site", { sourceId: "s-svc" }), fact("phone", "(805) 555-0101"), fact("email", "x@shop.example.com")] }],
  }) as unknown as AutomationCandidate;
  const protection = (rel: Partial<Protection["relationships"]> = {}) => ({ relationships: { blocking: [], multiLocationPeers: [], warnings: [], ...rel } }) as unknown as Protection;
  const assess = (c = base(), p = protection()) => assessReadiness(c, p, c.research[0]!);
  const withFact = (field: string, value: string | null, extra = {}) => base({ facts: [...(base().research[0]!.facts.filter((f) => f.field !== field)), fact(field, value, extra)] as never });

  test("all conditions present: Ready", () => {
    const r = assess();
    assert.equal(r.ready, true, r.reason);
    assert.match(r.warnings.join(" "), /Ownership is not stated/);
  });
  test("an older-rules run needs a current-rules re-read (never Ready)", () => assert.equal(assess(base({ version: "r15" })).code, "stale_rules"));
  test("identity not verified", () => assert.equal(assess(withFact("location_identity", "unverified")).code, "location_identity"));
  test("another location's page", () => assert.equal(assess(withFact("location_identity", "other_location")).code, "location_identity"));
  test("a single-location identity is not enough when another candidate uses the website elsewhere", () => {
    assert.equal(assess(withFact("location_identity", "single_location_site"), protection({ multiLocationPeers: ["Other (12345678)"] })).code, "location_identity");
    assert.equal(assess(withFact("location_identity", "single_location_site")).ready, true);
  });
  test("an unresolved duplicate relationship", () => assert.equal(assess(base(), protection({ blocking: ["Same phone number as X."] })).code, "duplicate_relationship"));
  for (const o of ["chain", "dealership", "possible_dealership", "manufacturer"]) test(`ownership ${o} is outside the initial ICP`, () => assert.equal(assess(withFact("ownership_class", o)).code, "ownership"));
  test("independent and regional ownership pass", () => {
    assert.equal(assess(withFact("ownership_class", "independent")).ready, true);
    assert.equal(assess(withFact("ownership_class", "regional")).ready, true);
  });
  test("a tire retailer with several locations is held for ownership", () => {
    const c = base({ facts: [...base().research[0]!.facts.filter((f) => f.field !== "site_locations"), fact("site_locations", "3")] as never });
    (c as { businessName: string }).businessName = "American Tire Stores";
    assert.equal(assess(c).code, "ownership");
  });
  test("weak service evidence", () => assert.equal(assess(base({ evidence: [ev("Names brakes: We offer brake repair.")] })).code, "service_evidence"));
  test("generic language only", () => assert.equal(assess(base({ evidence: [ev("Names general repair: We offer quality auto repairs.")] })).code, "service_evidence"));
  test("an adjacent trade without passenger-vehicle repair", () => {
    const trailer = (quotes: string[]) => base({ facts: [...base().research[0]!.facts, fact("trade_context", "trailer")] as never, evidence: quotes.map((x) => ev(x)) });
    assert.equal(assess(trailer(["Names brakes: Brake repair and bearing packing.", "Names engine: Axle and engine repair."])).code, "adjacent_trade");
    assert.equal(assess(trailer(["Names brakes: Brake repair for cars and trucks.", "Names engine: Engine repair for your car."])).ready, true, "passenger-vehicle repair still qualifies");
  });
  test("hitch-only is held as outside the ICP", () => {
    const c = base({ evidence: [ev("Names hitch: Hitch installation.")] });
    (c as { businessName: string }).businessName = "Hitch Pros";
    assert.equal(assess(c).code, "outside_icp");
  });
  test("evidence from another run never counts", () => assert.equal(assess(base({ evidence: [ev("Names brakes: Brake repair.", undefined, "older"), ev("Names engine: Engine repair.", undefined, "older")] })).code, "service_evidence"));
  test("evidence from another location's page never counts", () => {
    const facts = base().research[0]!.facts.map((f) => (f.field === "page_location" && f.sourceId === "s-svc" ? { ...f, value: "other_location" } : f));
    assert.equal(assess(base({ facts: facts as never })).code, "service_evidence");
  });
  test("contact is separate: an unverified phone keeps Ready but is flagged for outreach", () => {
    const r = assess(withFact("phone", "(805) 555-0101", { state: "uncertain" }));
    assert.equal(r.ready, true);
    assert.match(r.warnings.join(" "), /never use a phone for outreach/);
  });
  test("a missing email keeps Ready; outreach still needs a verified recipient", () => {
    const r = assess(withFact("email", null, { state: "not_found" }));
    assert.equal(r.ready, true);
    assert.match(r.warnings.join(" "), /verified recipient/);
  });
});

describe("r16 hitch-only versus trailer/hitch/welding", () => {
  test("a trailer, hitch and welding business is an adjacent trade for a person, not the hitch-only hold", () => {
    const r = assessServiceEvidence({ businessName: "Eckhart Trailer Hitch And Welding", quotes: [{ url: "https://e.example.com/", excerpt: "Trailer brake replacement." }] });
    assert.equal(r.outsideIcp, false);
    assert.notEqual(r.strength, "strong");
  });
});
