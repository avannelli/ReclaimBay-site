import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bboxOf, countySlug, fetchCountyBoundary, inBoundary, polygonsOf, type Boundary, type Polygon } from "../../src/discovery/boundaries.js";
import { overtureTier } from "../../src/discovery/categories.js";
import { cleanDiscovered } from "../../src/discovery/normalize.js";
import {
  createOvertureImporter,
  displayName,
  isOvertureRelease,
  mapOvertureRow,
  resolveOvertureRelease,
  sourcesOf,
  stateOf,
  websiteOf,
  type OvertureRow,
} from "../../src/discovery/overture.js";
import { overturePlacesSql } from "../../src/discovery/overtureSource.js";
import type { ImportStats, StagedPlace } from "../../src/discovery/types.js";

// A square "county" around Oxnard/Ventura, with a hole, for boundary tests.
const SQUARE: Polygon = [
  [[-119.3, 34.1], [-119.0, 34.1], [-119.0, 34.4], [-119.3, 34.4], [-119.3, 34.1]],
  [[-119.21, 34.31], [-119.19, 34.31], [-119.19, 34.33], [-119.21, 34.33], [-119.21, 34.31]],
];
const BOUNDARY: Boundary = { name: "Ventura County", state: "CA", geoid: "06111", bbox: bboxOf([SQUARE]), polygons: [SQUARE] };

const AUTO = ["travel_and_transportation", "vehicle_service", "automotive_service"];
const row = (over: Partial<OvertureRow> = {}): OvertureRow => ({
  id: "08f2a1b2-0000-4000-8000-000000000001",
  name: "  Saviers   Road Auto Repair ",
  taxonomy: { primary: "automotive_repair", hierarchy: [...AUTO, "automotive_repair"], alternates: null },
  confidence: 0.92,
  operating_status: "open",
  websites: ["https://www.facebook.com/saviersauto", "http://www.saviersauto.example.com/"],
  phones: ["+18055550101", "(805) 555-0199"],
  brand: null,
  addresses: [{ freeform: "5577 Saviers Rd", locality: "Oxnard", postcode: "93033-8634", region: "CA", country: "US" }],
  sources: [
    { dataset: "meta", license: "CDLA-Permissive-2.0" },
    { dataset: "Overture", license: "CDLA-Permissive-2.0" },
    { dataset: "Foursquare", license: "Apache-2.0" },
    { dataset: "meta", license: "CDLA-Permissive-2.0" },
  ],
  lon: -119.1773,
  lat: 34.1468,
  ...over,
});

const ctx = { boundary: BOUNDARY };
const place = (r: OvertureRow): StagedPlace => {
  const m = mapOvertureRow(r, ctx);
  assert.ok("place" in m, `expected a place, got ${JSON.stringify(m)}`);
  return m.place;
};
const skip = (r: OvertureRow) => {
  const m = mapOvertureRow(r, ctx);
  assert.ok("skip" in m, "expected the row to be left out");
  return m.skip;
};

describe("Overture releases", () => {
  const catalog = {
    latest: "2026-09-23.1",
    links: [
      { rel: "root", href: "https://stac.overturemaps.org/catalog.json" },
      { rel: "child", href: "https://stac.overturemaps.org/2026-08-19.0/catalog.json" },
      { rel: "child", href: "https://stac.overturemaps.org/2026-09-23.0/catalog.json" },
      { rel: "child", href: "https://stac.overturemaps.org/2026-09-23.1/catalog.json" },
    ],
  };
  const fetchJson = async () => catalog;

  test("release names look like 2026-09-23.1", () => {
    assert.ok(isOvertureRelease("2026-09-23.1"));
    assert.ok(!isOvertureRelease("2026-09-23"));
    assert.ok(!isOvertureRelease("latest"));
    assert.ok(!isOvertureRelease("2026-09-23.1/../x"));
  });

  test('"latest" resolves to the release Overture\'s catalog names as latest', async () => {
    assert.equal(await resolveOvertureRelease("latest", fetchJson), "2026-09-23.1");
  });

  test("an explicit release must still be published; an expired or unknown one is refused", async () => {
    assert.equal(await resolveOvertureRelease("2026-08-19.0", fetchJson), "2026-08-19.0");
    await assert.rejects(resolveOvertureRelease("2026-06-17.0", fetchJson), /not available\. Available: 2026-08-19\.0, 2026-09-23\.0, 2026-09-23\.1/);
    await assert.rejects(resolveOvertureRelease("next", fetchJson), /not an Overture release name/);
  });
});

describe("Overture categories → tiers (a discovery filter only)", () => {
  const tax = (primary: string, hierarchy = [...AUTO, primary], alternates: string[] | null = null) => ({ primary, hierarchy, alternates });

  test("general and mechanical repair is core", () => {
    for (const c of ["automotive_repair", "transmission_repair", "brake_service_and_repair", "engine_repair_service", "exhaust_and_muffler_repair", "auto_electrical_repair"]) {
      const h = c === "automotive_repair" ? [...AUTO, c] : [...AUTO, "automotive_repair", c];
      assert.deepEqual(overtureTier(tax(c, h)), { tier: "core", category: c }, c);
    }
  });

  test("related automotive services are adjacent", () => {
    for (const c of ["automotive_service", "tire_dealer_and_repair", "oil_change_station", "emissions_inspection", "truck_repair", "car_inspection"]) {
      const h = c === "automotive_service" ? AUTO : [...AUTO, c];
      assert.equal(overtureTier(tax(c, h)).tier, "adjacent", c);
    }
  });

  test("body, glass, cosmetic, washing, towing, retail, and trailer categories are excluded, conservatively", () => {
    for (const c of ["auto_body_shop", "car_wash", "auto_detailing", "towing_service", "tire_shop", "trailer_repair", "wheel_and_rim_repair", "windshield_installation_and_repair"]) {
      assert.deepEqual(overtureTier(tax(c)), { tier: null, reason: "excluded_automotive", category: c }, c);
    }
  });

  test("an unknown future automotive category is excluded until it is reviewed", () => {
    assert.equal(overtureTier(tax("hydrogen_refit_service")).tier, null);
  });

  test("only the primary category decides: repair as an alternate is not enough", () => {
    const gas = tax("gas_station", ["travel_and_transportation", "gas_station"], ["automotive_repair"]);
    assert.deepEqual(overtureTier(gas), { tier: null, reason: "alternate_only", category: "gas_station" });
  });

  test("a repair category outside the automotive branch of the hierarchy does not count", () => {
    assert.equal(overtureTier(tax("automotive_repair", ["services_and_business", "automotive_repair"])).tier, null);
  });

  test("missing taxonomy and unrelated places are not discovered", () => {
    assert.equal(overtureTier(null).tier, null);
    assert.deepEqual(overtureTier({ primary: "", hierarchy: [] }), { tier: null, reason: "no_category", category: null });
    assert.equal(overtureTier(tax("pizza_restaurant", ["food_and_drink", "restaurant", "pizza_restaurant"])).tier, null);
  });
});

describe("mapping an Overture place", () => {
  test("keeps the GERS ID, name, address, coordinates, category, status, confidence, and sources", () => {
    const p = place(row());
    assert.deepEqual(p, {
      externalId: "08f2a1b2-0000-4000-8000-000000000001",
      businessName: "Saviers Road Auto Repair",
      website: "http://www.saviersauto.example.com/",
      phone: "+18055550101",
      streetAddress: "5577 Saviers Rd",
      city: "Oxnard",
      county: "Ventura County",
      state: "CA",
      postalCode: "93033-8634",
      country: "US",
      latitude: 34.1468,
      longitude: -119.1773,
      category: "automotive_repair",
      categoryTier: "core",
      brand: null,
      confidence: 0.92,
      operatingStatus: "open",
      sourceUrl: null,
      sources: "meta (CDLA-Permissive-2.0); Foursquare (Apache-2.0)",
    });
  });

  test("privacy: emails, socials, and the raw record are never carried over", () => {
    const hostile = { ...row(), emails: ["owner@home.example.com"], socials: ["https://instagram.com/owner"], ownerName: "Jane" } as unknown as OvertureRow;
    const p = place(hostile);
    assert.doesNotMatch(JSON.stringify(p), /owner@|instagram|Jane/);
  });

  test("the region may be 'CA' or 'US-CA'; the boundary decides the state", () => {
    assert.equal(stateOf("CA"), "CA");
    assert.equal(stateOf("US-CA"), "CA");
    assert.equal(stateOf("California"), null);
    assert.equal(place(row({ addresses: [{ freeform: "1 Main St", locality: "Ventura", region: "US-CA", country: "US" }] })).state, "CA");
  });

  test("a non-US address is ignored; a place with no address keeps its coordinates", () => {
    const p = place(row({ addresses: [{ freeform: "1 Rue X", locality: "Paris", country: "FR" }] }));
    assert.equal(p.streetAddress, null);
    assert.equal(p.city, null);
    const q = place(row({ addresses: null }));
    assert.equal(q.latitude, 34.1468);
  });

  test("the website is the first that is the business's own; social and listing pages never are", () => {
    assert.equal(websiteOf(["https://www.yelp.com/biz/x", "https://shop.example.com"]), "https://shop.example.com/");
    assert.equal(websiteOf(["https://www.facebook.com/x", "https://locations.autovalue.com/ca/x"]), null);
    assert.equal(websiteOf(null), null);
    assert.equal(
      websiteOf(["https://www.intoxalock.com/locations/ca/ventura/4505-telephone-rd?utm_medium=yext&utm_source=facebook#map"]),
      "https://www.intoxalock.com/locations/ca/ventura/4505-telephone-rd",
      "tracking parameters are dropped",
    );
  });

  test("the provider phone is staged as the provider's phone and stays UNVERIFIED after cleaning", () => {
    const staged = place(row());
    assert.equal(staged.phone, "+18055550101");
    const cleaned = cleanDiscovered({ ...staged, phone: staged.phone, release: "2026-09-23.1" });
    assert.ok(cleaned.ok);
    assert.equal(cleaned.value.providerPhone, "+18055550101");
    assert.ok(!("phone" in cleaned.value), "no verified phone can come from a provider record");
    assert.ok(!("phoneSourceUrl" in cleaned.value));
  });

  test("operating status keeps Overture's three values; anything else is dropped", () => {
    assert.equal(place(row({ operating_status: "permanently_closed" })).operatingStatus, "permanently_closed");
    assert.equal(place(row({ operating_status: "temporarily_closed" })).operatingStatus, "temporarily_closed");
    assert.equal(place(row({ operating_status: "maybe" })).operatingStatus, null);
    assert.equal(place(row({ operating_status: null })).operatingStatus, null);
  });

  test("a branch named only by its street takes its brand; a real shop name is never rewritten", () => {
    assert.equal(displayName("E Los Angeles Ave", "Jiffy Lube"), "Jiffy Lube (E Los Angeles Ave)");
    assert.equal(displayName("West 5th Street", "Jiffy Lube"), "Jiffy Lube (West 5th Street)");
    assert.equal(displayName("W. Daily Dr", "Jiffy Lube"), "Jiffy Lube (W. Daily Dr)");
    assert.equal(displayName("E Thompson Blvd", null), "E Thompson Blvd", "no brand: left as reported");
    assert.equal(displayName("Main Street Auto Repair", "Main Street Auto"), "Main Street Auto Repair");
    assert.equal(displayName("Jiffy Lube Oil Change", "Jiffy Lube"), "Jiffy Lube Oil Change");
    assert.equal(place(row({ name: "Arneill Road", brand: "Jiffy Lube" })).businessName, "Jiffy Lube (Arneill Road)");
  });

  test("confidence outside 0..1 is dropped; brand is kept as reported", () => {
    assert.equal(place(row({ confidence: 1.5 })).confidence, null);
    assert.equal(place(row({ brand: "Jiffy Lube" })).brand, "Jiffy Lube");
  });

  test("upstream sources leave out Overture's own derived entries and repeat each dataset once", () => {
    assert.equal(sourcesOf([{ dataset: "Overture-signals" }, { dataset: "BrightQuery", license: "CDLA-Permissive-2.0" }]), "BrightQuery (CDLA-Permissive-2.0)");
    assert.equal(sourcesOf(null), null);
  });

  test("malformed or partial records are left out, never guessed", () => {
    assert.equal(skip(row({ id: null })), "malformed");
    assert.equal(skip(row({ id: "  " })), "malformed");
    assert.equal(skip(row({ name: null })), "malformed");
    assert.equal(skip(row({ lon: null })), "malformed");
    assert.equal(skip(row({ lat: Number.NaN })), "malformed");
    assert.equal(skip(row({ lat: 0, lon: 0 })), "malformed");
    assert.equal(skip(row({ lat: 95 })), "malformed");
  });

  test("controlled geography: places outside the county boundary (or in a hole) are left out", () => {
    assert.equal(skip(row({ lon: -118.78, lat: 34.03 })), "outside_area", "Malibu, outside the box");
    assert.equal(skip(row({ lon: -119.2, lat: 34.32 })), "outside_area", "inside the hole");
  });

  test("non-repair places are left out with the reason", () => {
    assert.equal(skip(row({ taxonomy: { primary: "auto_body_shop", hierarchy: [...AUTO, "auto_body_shop"] } })), "excluded_automotive");
    assert.equal(skip(row({ taxonomy: null })), "no_category");
  });
});

describe("county boundaries", () => {
  test("slugs are stable across spellings", () => {
    assert.equal(countySlug("Ventura County"), "ventura");
    assert.equal(countySlug("ventura"), "ventura");
    assert.equal(countySlug("St. Mary's Parish"), "st-mary-s");
    assert.equal(countySlug("Doña Ana County"), "dona-ana");
  });

  test("point-in-polygon handles multipolygons and holes", () => {
    const islands: Polygon = [[[-119.5, 33.2], [-119.4, 33.2], [-119.4, 33.3], [-119.5, 33.3], [-119.5, 33.2]]];
    const b = { bbox: bboxOf([SQUARE, islands]), polygons: [SQUARE, islands] };
    assert.ok(inBoundary(b, -119.1, 34.2));
    assert.ok(inBoundary(b, -119.45, 33.25), "second polygon");
    assert.ok(!inBoundary(b, -119.2, 34.32), "hole");
    assert.ok(!inBoundary(b, -118.0, 34.2));
    assert.throws(() => polygonsOf({ type: "Point", coordinates: [0, 0] }), /Unsupported boundary geometry/);
  });

  test("the Census lookup asks for the county in its state and needs exactly one match", async () => {
    let asked = "";
    const geometry = { type: "Polygon", coordinates: [SQUARE[0]] };
    const one = async (url: string) => {
      asked = `${new URL(url).host} ${new URL(url).searchParams.get("where")}`;
      return { features: [{ properties: { NAME: "Ventura County", GEOID: "06111" }, geometry }] };
    };
    const b = await fetchCountyBoundary("ca", "Ventura County", one);
    assert.match(asked, /tigerweb\.geo\.census\.gov/);
    assert.match(asked, /STATE='06' AND \(BASENAME='Ventura' OR NAME='Ventura County'\)/);
    assert.deepEqual([b.name, b.state, b.geoid], ["Ventura County", "CA", "06111"]);
    await assert.rejects(fetchCountyBoundary("CA", "Ventura", async () => ({ features: [] })), /found 0/);
    await assert.rejects(fetchCountyBoundary("ZZ", "Ventura", one), /Unknown state/);
    await assert.rejects(fetchCountyBoundary("CA", "x'; DROP", one), /doesn't look like a county name/);
  });
});

describe("the Overture importer", () => {
  const rows = [
    row(),
    row({ id: "08f2a1b2-0000-4000-8000-000000000002", name: "Oxnard Transmission", taxonomy: { primary: "transmission_repair", hierarchy: [...AUTO, "automotive_repair", "transmission_repair"] } }),
    row({ id: "08f2a1b2-0000-4000-8000-000000000001" }), // repeated GERS ID across files
    row({ id: "08f2a1b2-0000-4000-8000-000000000003", taxonomy: { primary: "car_wash", hierarchy: [...AUTO, "car_wash"] } }),
    row({ id: "08f2a1b2-0000-4000-8000-000000000004", lon: -118.78, lat: 34.03 }),
    row({ id: null }),
  ];
  const source = (batches: OvertureRow[][]) => ({
    async *query() {
      for (const b of batches) yield b;
    },
  });
  const importer = (batches: OvertureRow[][]) =>
    createOvertureImporter({ source: source(batches), boundary: async () => BOUNDARY, fetchJson: async () => ({ latest: "2026-09-23.1", links: [] }) });

  test("refuses a whole-state import: one county at a time", () => {
    assert.match(importer([]).checkScope!({ region: "US-CA" })!, /one county at a time/);
    assert.equal(importer([]).checkScope!({ region: "US-CA", county: "Ventura County" }), null);
  });

  test("stages only repair places inside the county, once each, and counts everything it left out", async () => {
    const stats: ImportStats = {};
    const out: StagedPlace[] = [];
    for await (const b of importer([rows.slice(0, 3), rows.slice(3)]).fetch("2026-09-23.1", { region: "US-CA", county: "Ventura County" }, stats)) out.push(...b);
    assert.deepEqual(out.map((p) => p.externalId), ["08f2a1b2-0000-4000-8000-000000000001", "08f2a1b2-0000-4000-8000-000000000002"]);
    assert.equal(stats.read, 6);
    assert.equal(stats.staged, 2);
    assert.equal(stats.repeatedId, 1);
    assert.equal(stats.excluded_automotive, 1);
    assert.equal(stats["excluded:car_wash"], 1);
    assert.equal(stats.outside_area, 1);
    assert.equal(stats.malformed, 1);
    assert.equal(stats["tier:core"], 2);
    assert.match(String(stats.source), /^s3:\/\/overturemaps-us-west-2\/release\/2026-09-23\.1\/theme=places\/type=place\/$/);
    assert.match(String(stats.boundary), /TIGERweb county 06111/);
  });

  test("an empty provider result yields nothing and reports zero", async () => {
    const stats: ImportStats = {};
    const out: StagedPlace[] = [];
    for await (const b of importer([[]]).fetch("2026-09-23.1", { region: "US-CA", county: "Ventura County" }, stats)) out.push(...b);
    assert.deepEqual(out, []);
    assert.equal(stats.read, 0);
    assert.equal(stats.staged, 0);
  });

  test("the importer resolves 'latest' through Overture's catalog", async () => {
    assert.equal(await importer([]).resolveRelease!("latest"), "2026-09-23.1");
  });
});

describe("the Overture query", () => {
  test("reads only the release's places, inside the box, automotive branch or tiered alternates", () => {
    const sql = overturePlacesSql("2026-09-23.1", [-119.5, 33.2, -118.6, 34.9]);
    assert.match(sql, /read_parquet\('s3:\/\/overturemaps-us-west-2\/release\/2026-09-23\.1\/theme=places\/type=place\/\*'/);
    assert.match(sql, /bbox\.xmin >= -119\.5000000 AND bbox\.xmax <= -118\.6000000/);
    assert.match(sql, /list_contains\(taxonomy\.hierarchy, 'automotive_service'\)/);
    assert.match(sql, /'automotive_repair'/);
    assert.doesNotMatch(sql, /emails|socials/, "never selects contact columns it doesn't need");
  });

  test("refuses anything that isn't a release name or a finite box (no injection)", () => {
    assert.throws(() => overturePlacesSql("2026-09-23.1') --", [0, 0, 1, 1]), /Not an Overture release/);
    assert.throws(() => overturePlacesSql("2026-09-23.1", [Number.NaN, 0, 1, 1]), /finite/);
  });
});
