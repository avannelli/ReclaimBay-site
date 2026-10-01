import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cleanDiscovered, isOnBusinessSite, locationKey, namesSimilar, normalizeDomain, normalizeName, phoneKey, streetKey } from "../../src/discovery/normalize.js";
import type { DiscoveredBusiness } from "../../src/discovery/types.js";

describe("normalizeDomain", () => {
  test("identifies a business's own site regardless of scheme, www, path, and case", () => {
    for (const url of [
      "https://www.SmithAuto.com/contact",
      "http://smithauto.com",
      "smithauto.com/services?x=1",
      "https://smithauto.com:8443/",
    ]) {
      assert.equal(normalizeDomain(url), "smithauto.com", url);
    }
  });

  test("keeps subdomains distinct from the apex", () => {
    assert.equal(normalizeDomain("https://shop.smithauto.com"), "shop.smithauto.com");
  });

  test("listing and social hosts never identify a business", () => {
    for (const url of [
      "https://www.facebook.com/smithauto",
      "https://m.facebook.com/smithauto",
      "https://www.yelp.com/biz/smith-auto",
      "https://maps.google.com/?cid=1",
      "https://instagram.com/smithauto",
      "https://linktr.ee/smith",
      "http://gmail.com/",
      "http://www.superpages.com/",
      "http://listyourwebsite.com/",
    ]) {
      assert.equal(normalizeDomain(url), null, url);
    }
  });

  test("garbage and empty input is null", () => {
    for (const v of [null, undefined, "", "not a url", "javascript:alert(1)", "ftp://smithauto.com"]) {
      assert.equal(normalizeDomain(v), null, String(v));
    }
  });
});

describe("normalizeName", () => {
  test("ignores case, punctuation, accents, ampersands, and legal suffixes", () => {
    assert.equal(normalizeName("Smith Auto, Inc."), "smith auto");
    assert.equal(normalizeName("SMITH AUTO LLC"), "smith auto");
    assert.equal(normalizeName("Smith's Auto"), "smiths auto");
    assert.equal(normalizeName("Smith’s Auto"), "smiths auto");
    assert.equal(normalizeName("Garage Zéro"), "garage zero");
    assert.equal(normalizeName("Brake & Tire"), "brake and tire");
    assert.equal(normalizeName("The Muffler Shop"), "muffler shop");
  });

  test("does not collapse genuinely different businesses", () => {
    assert.notEqual(normalizeName("Smith Auto"), normalizeName("Smith Auto Body"));
    assert.notEqual(normalizeName("Smith Auto Repair"), normalizeName("Smith Auto"));
  });

  test("a name made only of a suffix word is kept rather than emptied", () => {
    assert.equal(normalizeName("Co"), "co");
    assert.equal(normalizeName("!!!"), "");
  });
});

describe("locationKey and phoneKey", () => {
  test("location needs a city; state is case-insensitive", () => {
    assert.equal(locationKey("Thousand Oaks", "ca"), "thousand oaks|CA");
    assert.equal(locationKey("  THOUSAND   OAKS ", "CA"), "thousand oaks|CA");
    assert.equal(locationKey(null, "CA"), null);
    assert.equal(locationKey("", "CA"), null);
    assert.equal(locationKey("Ventura", null), "ventura|");
  });

  test("phone is ten digits however it is formatted; partial numbers don't match", () => {
    for (const p of ["(805) 555-0101", "805-555-0101", "+1 805 555 0101", "1.805.555.0101", "805 555 0101 "]) {
      assert.equal(phoneKey(p), "8055550101", p);
    }
    assert.equal(phoneKey("555-0101"), null);
    assert.equal(phoneKey(null), null);
    assert.equal(phoneKey("call us"), null);
  });
});

describe("cleanDiscovered", () => {
  const base: DiscoveredBusiness = {
    externalId: " fx-1 ",
    businessName: "  Conejo   Valley Auto Care ",
    website: "conejoauto.example.com",
    streetAddress: " 1200  E Thousand Oaks Blvd ",
    city: "Thousand Oaks",
    state: "ca",
    postalCode: "91360",
    latitude: 34.17812345678,
    longitude: -118.8521,
    phone: "(805) 555-0101",
    sourceUrl: "https://directory.example.com/listing/1",
    category: "automotive_repair",
    categoryTier: "core",
    brand: "  Conejo Group ",
    confidence: 0.92,
    operatingStatus: "open",
    retrievedAt: new Date("2026-10-01T00:00:00Z"),
    release: "2026-09-23.1",
    sources: "meta (CDLA-Permissive-2.0)",
  };

  test("cleans and validates a normal record, including provenance and location", () => {
    const r = cleanDiscovered(base);
    assert.ok(r.ok);
    assert.deepEqual(r.value, {
      businessName: "Conejo Valley Auto Care",
      website: "https://conejoauto.example.com/",
      streetAddress: "1200 E Thousand Oaks Blvd",
      city: "Thousand Oaks",
      state: "CA",
      postalCode: "91360",
      country: "US",
      latitude: 34.178123,
      longitude: -118.8521,
      providerPhone: "(805) 555-0101",
      sourceUrl: "https://directory.example.com/listing/1",
      externalId: "fx-1",
      category: "automotive_repair",
      categoryTier: "core",
      brand: "Conejo Group",
      confidence: 0.92,
      operatingStatus: "open",
      retrievedAt: new Date("2026-10-01T00:00:00Z"),
      release: "2026-09-23.1",
      sources: "meta (CDLA-Permissive-2.0)",
    });
  });

  test("rejects a record without a usable name", () => {
    for (const businessName of ["", "   ", "!!!"]) assert.equal(cleanDiscovered({ businessName }).ok, false, businessName);
  });

  test("a social, listing, locator, or manufacturer page is not a website, so it can't satisfy 'has a website'", () => {
    for (const website of [
      "https://www.facebook.com/conejoauto",
      "https://locations.autovalue.com/ca/x",
      "https://www.acdelco.com/x",
      "https://x.hub.biz/",
      "http://wa.me/18055550101",
    ]) {
      const r = cleanDiscovered({ ...base, website });
      assert.ok(r.ok);
      assert.equal(r.value.website, null, website);
    }
  });

  test("a provider phone is kept as UNVERIFIED provider contact, with or without a source URL", () => {
    for (const sourceUrl of [null, "https://directory.example.com/listing/1"]) {
      const r = cleanDiscovered({ ...base, sourceUrl });
      assert.ok(r.ok);
      assert.equal(r.value.providerPhone, "(805) 555-0101");
      assert.ok(!("phone" in r.value), "there is no verified phone field on a cleaned provider record");
      assert.ok(!("phoneSourceUrl" in r.value));
    }
  });

  test("invalid values are dropped individually and the record survives", () => {
    const r = cleanDiscovered({
      ...base,
      phone: "call us",
      website: "javascript:alert(1)",
      latitude: 200,
      confidence: 3,
      operatingStatus: "maybe",
      categoryTier: "platinum" as "core",
    });
    assert.ok(r.ok);
    assert.equal(r.value.providerPhone, null);
    assert.equal(r.value.website, null);
    assert.equal(r.value.latitude, null);
    assert.equal(r.value.longitude, null, "coordinates are dropped as a pair");
    assert.equal(r.value.confidence, null);
    assert.equal(r.value.operatingStatus, null);
    assert.equal(r.value.categoryTier, null);
    assert.equal(r.value.businessName, "Conejo Valley Auto Care");
  });

  test("operating status wording is normalized to three values", () => {
    const st = (operatingStatus: string) => (cleanDiscovered({ ...base, operatingStatus }) as { value: { operatingStatus: unknown } }).value.operatingStatus;
    assert.equal(st("open"), "open");
    assert.equal(st("permanently_closed"), "permanently_closed");
    assert.equal(st("Closed"), "permanently_closed");
    assert.equal(st("temporarily closed"), "temporarily_closed");
  });

  test("(0, 0) coordinates are treated as missing", () => {
    const r = cleanDiscovered({ ...base, latitude: 0, longitude: 0 });
    assert.ok(r.ok);
    assert.equal(r.value.latitude, null);
  });

  test("privacy: only the allowed business fields survive; anything else a provider sends is discarded", () => {
    const hostile = {
      ...base,
      ownerName: "Jane Smith",
      ownerEmail: "jane@home.example.com",
      emails: ["jane@home.example.com"],
      socials: ["https://instagram.com/jane"],
      homeAddress: "1 Private Lane",
      reviews: ["great!"],
      pageBody: "x".repeat(10_000),
    } as unknown as DiscoveredBusiness;
    const r = cleanDiscovered(hostile);
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.value).sort(), [
      "brand",
      "businessName",
      "category",
      "categoryTier",
      "city",
      "confidence",
      "country",
      "externalId",
      "latitude",
      "longitude",
      "operatingStatus",
      "postalCode",
      "providerPhone",
      "release",
      "retrievedAt",
      "sourceUrl",
      "sources",
      "state",
      "streetAddress",
      "website",
    ]);
    assert.doesNotMatch(JSON.stringify(r.value), /Jane|home\.example|Private Lane|great|instagram|xxxxx/);
  });

  test("over-long values are truncated to the column limits", () => {
    const r = cleanDiscovered({ ...base, businessName: "A".repeat(300), externalId: "e".repeat(500), brand: "b".repeat(300), category: "c".repeat(300) });
    assert.ok(r.ok);
    assert.equal(r.value.businessName.length, 120);
    assert.equal(r.value.externalId!.length, 200);
    assert.equal(r.value.brand!.length, 120);
    assert.equal(r.value.category!.length, 100);
  });
});

describe("location and name helpers", () => {
  test("streetKey normalizes abbreviations and ignores units", () => {
    assert.equal(streetKey("1200 East Thousand Oaks Boulevard, Suite 4"), "1200 e thousand oaks blvd");
    assert.equal(streetKey("1200 E. Thousand Oaks Blvd #4"), "1200 e thousand oaks blvd");
    assert.equal(streetKey("Main Street"), null, "no house number");
    assert.equal(streetKey(null), null);
  });

  test("namesSimilar matches spelling variants but not different shops", () => {
    assert.ok(namesSimilar("Leon's Transmissions", "Leons Transmission Inc."));
    assert.ok(namesSimilar("Big Brand Tire & Service", "Big Brand Tire Company"));
    assert.ok(namesSimilar("Carrillo's Auto Repair", "Carillo's Auto Repair"));
    assert.ok(!namesSimilar("Smith Auto", "Jones Auto"));
    assert.ok(!namesSimilar("Jim's Tire Center", "Jiffy Lube"));
    assert.ok(!namesSimilar("Auto Repair", "Auto Service"), "only generic words: not similar");
    assert.ok(!namesSimilar(null, "X"));
  });

  test("isOnBusinessSite accepts the business's own domain and subdomains only", () => {
    assert.ok(isOnBusinessSite("https://smithauto.example.com/contact", "https://www.smithauto.example.com"));
    assert.ok(isOnBusinessSite("https://shop.smithauto.example.com/x", "smithauto.example.com"));
    assert.ok(!isOnBusinessSite("https://www.yelp.com/biz/smith", "https://smithauto.example.com"));
    assert.ok(!isOnBusinessSite("https://smithauto.example.com.evil.example/x", "https://smithauto.example.com"));
    assert.ok(!isOnBusinessSite("https://smithauto.example.com/x", null), "no website stored: nothing can be on it");
    assert.ok(!isOnBusinessSite("https://locations.autovalue.com/x", "https://locations.autovalue.com/y"), "shared domains never count");
  });
});
