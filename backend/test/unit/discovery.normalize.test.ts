import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cleanDiscovered, locationKey, normalizeDomain, normalizeName, phoneKey } from "../../src/discovery/normalize.js";
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
    city: "Thousand Oaks",
    state: "ca",
    postalCode: "91360",
    phone: "(805) 555-0101",
    sourceUrl: "https://directory.example.com/listing/1",
  };

  test("cleans and validates a normal record", () => {
    const r = cleanDiscovered(base);
    assert.ok(r.ok);
    assert.deepEqual(r.value, {
      businessName: "Conejo Valley Auto Care",
      website: "https://conejoauto.example.com/",
      city: "Thousand Oaks",
      state: "CA",
      postalCode: "91360",
      country: "US",
      phone: "(805) 555-0101",
      phoneSourceUrl: "https://directory.example.com/listing/1",
      sourceUrl: "https://directory.example.com/listing/1",
      externalId: "fx-1",
    });
  });

  test("rejects a record without a usable name", () => {
    for (const businessName of ["", "   ", "!!!"]) assert.equal(cleanDiscovered({ businessName }).ok, false, businessName);
  });

  test("a social or listing page is not a website, so it can't satisfy 'has a website'", () => {
    const r = cleanDiscovered({ ...base, website: "https://www.facebook.com/conejoauto" });
    assert.ok(r.ok);
    assert.equal(r.value.website, null);
  });

  test("a phone without a public source URL is dropped, not stored unsourced", () => {
    const r = cleanDiscovered({ ...base, sourceUrl: null });
    assert.ok(r.ok);
    assert.equal(r.value.phone, null);
    assert.equal(r.value.phoneSourceUrl, null);
    assert.equal(r.value.website, "https://conejoauto.example.com/", "the rest is kept");
  });

  test("invalid values are dropped individually and the record survives", () => {
    const r = cleanDiscovered({ ...base, phone: "call us", website: "javascript:alert(1)" });
    assert.ok(r.ok);
    assert.equal(r.value.phone, null);
    assert.equal(r.value.website, null);
    assert.equal(r.value.businessName, "Conejo Valley Auto Care");
  });

  test("privacy: only the allowed business fields survive; anything else a provider sends is discarded", () => {
    const hostile = {
      ...base,
      ownerName: "Jane Smith",
      ownerEmail: "jane@home.example.com",
      homeAddress: "1 Private Lane",
      reviews: ["great!"],
      pageBody: "x".repeat(10_000),
    } as unknown as DiscoveredBusiness;
    const r = cleanDiscovered(hostile);
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.value).sort(), [
      "businessName",
      "city",
      "country",
      "externalId",
      "phone",
      "phoneSourceUrl",
      "postalCode",
      "sourceUrl",
      "state",
      "website",
    ]);
    assert.doesNotMatch(JSON.stringify(r.value), /Jane|home\.example|Private Lane|great|xxxxx/);
  });

  test("over-long values are truncated to the column limits", () => {
    const r = cleanDiscovered({ ...base, businessName: "A".repeat(300), externalId: "e".repeat(500) });
    assert.ok(r.ok);
    assert.equal(r.value.businessName.length, 120);
    assert.equal(r.value.externalId!.length, 200);
  });
});
