import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StagedPlace } from "../../src/discovery/types.js";
import type { Analysis } from "../../src/research/analyze.js";
import { meteredFetch } from "../../src/replenishment/budget.js";
import { DEFAULT_AREAS, defaultConfig, inArea, LIMIT_BOUNDS, needsSupply, ReplenishmentStop, resolveConfig, safeReason, UNSUITABLE_SOURCE, type Area } from "../../src/replenishment/policy.js";
import { screenBusiness, screeningReasons } from "../../src/replenishment/screen.js";
import { chooseArea } from "../../src/replenishment/service.js";
import { selectFromSource, sourceContext, sourceSkip } from "../../src/replenishment/source.js";
import { independentShop, type Fixture } from "../fixtures/researchSite.js";

const AREA: Area = { key: "test-area", label: "Test area", state: "CA", county: "Ventura County", cities: ["oxnard"], zips: ["93033"] };

const place = (over: Partial<StagedPlace> = {}): StagedPlace => ({
  externalId: "ov-1", businessName: "Saviers Road Auto Repair", website: "https://saviersauto.example.com/", phone: "(805) 555-0101",
  streetAddress: "5577 Saviers Rd", city: "Oxnard", county: "Ventura County", state: "CA", postalCode: "93033", country: "US",
  latitude: 34.17, longitude: -119.17, category: "automotive_repair", categoryTier: "core", brand: null, confidence: 0.95, operatingStatus: "open",
  sourceUrl: null, sources: "meta (CDLA-Permissive-2.0)", ...over,
});

const emptyContext = () => sourceContext("overture", { candidates: [], prospects: [], screenedIds: [] });

/** Routes fixture pages through a physical-fetch double, so the real public transport and the meter both run. */
function fixtureFetch(routes: Record<string, Fixture>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const f = routes[url];
    if (!f) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(f.body ?? "", { status: f.status ?? 200, headers: { "content-type": f.contentType ?? "text/html; charset=utf-8" } });
  };
  return { fetch, calls };
}

describe("replenishment configuration", () => {
  test("defaults are within every bound and start with the Targeted Outreach 03 area", () => {
    const c = resolveConfig(null);
    assert.deepEqual(c, defaultConfig());
    assert.equal(c.areas[0]!.key, "la-west-sfv");
    assert.equal(c.requirePublishedEmail, true);
    for (const [k, b] of Object.entries(LIMIT_BOUNDS)) assert.ok(c.limits[k as keyof typeof c.limits] <= b.max, k);
  });
  test("a stored override is merged over the defaults", () => {
    const c = resolveConfig({ lowSupply: 6, limits: { businesses: 20 }, areas: [AREA] });
    assert.equal(c.lowSupply, 6);
    assert.equal(c.limits.businesses, 20);
    assert.equal(c.limits.fetches, LIMIT_BOUNDS.fetches.default);
    assert.deepEqual(c.areas.map((a) => a.key), ["test-area"]);
  });
  test("hard bounds, unknown settings and inconsistent limits are refused", () => {
    assert.throws(() => resolveConfig({ limits: { businesses: 101 } }), /businesses/);
    assert.throws(() => resolveConfig({ limits: { fetches: 5_000 } }), /fetches/);
    assert.throws(() => resolveConfig({ limits: { perBusinessFetches: 40, fetches: 20 } }), /per-business/);
    assert.throws(() => resolveConfig({ maxSends: 10 }), /Unknown/);
    assert.throws(() => resolveConfig({ limits: { sendsPerDay: 10 } }), /Unknown/);
    assert.throws(() => resolveConfig({ provider: "osm" }), /Overture/);
    assert.throws(() => resolveConfig({ release: "next week" }), /release/);
    assert.throws(() => resolveConfig({ requirePublishedEmail: "no" }), /true or false/);
  });
  test("areas must name a state, a county and cities or ZIP codes", () => {
    assert.throws(() => resolveConfig({ areas: [] }), /Between 1 and 20/);
    assert.throws(() => resolveConfig({ areas: [{ ...AREA, key: "Bad Key" }] }), /key/);
    assert.throws(() => resolveConfig({ areas: [{ ...AREA, county: "Ventura" }] }), /county/);
    assert.throws(() => resolveConfig({ areas: [{ ...AREA, cities: [], zips: [] }] }), /at least one/);
    assert.throws(() => resolveConfig({ areas: [{ ...AREA, zips: ["9303"] }] }), /ZIP/);
    assert.throws(() => resolveConfig({ areas: [AREA, AREA] }), /distinct/);
  });
  test("the default rotation is valid as stored configuration", () => {
    assert.equal(resolveConfig({ areas: DEFAULT_AREAS }).areas.length, DEFAULT_AREAS.length);
  });
  test("supply below the threshold is needed; at it, not", () => {
    assert.equal(needsSupply(9, { lowSupply: 10 }), true);
    assert.equal(needsSupply(10, { lowSupply: 10 }), false);
  });
  test("stored reasons never carry URLs or connection strings", () => {
    assert.equal(safeReason(new Error("failed reading s3://bucket/x and postgresql://u:p@h/db via https://a.example")), "failed reading [url] and [url] via [url]");
  });
});

describe("areas and source filters", () => {
  test("a record is in an area by city or ZIP code, never in another county or state", () => {
    assert.equal(inArea({ city: "Oxnard", postalCode: null, state: "CA", county: "Ventura County" }, AREA), true);
    assert.equal(inArea({ city: "Los Angeles", postalCode: "93033-1234", state: "CA", county: "Ventura County" }, AREA), true);
    assert.equal(inArea({ city: "Camarillo", postalCode: "93010", state: "CA", county: "Ventura County" }, AREA), false);
    assert.equal(inArea({ city: "Oxnard", postalCode: "93033", state: "CA", county: "Los Angeles County" }, AREA), false);
    assert.equal(inArea({ city: "Oxnard", postalCode: "93033", state: "NV", county: "Ventura County" }, AREA), false);
  });
  test("chains, franchises and franchise dealers are never sourced; independent names are", () => {
    for (const name of ["Caliber Collision", "Midas", "Toyota of Thousand Oaks Service", "Pep Boys Auto", "Jiffy Lube", "Tesla Service Center", "Fix Auto Ventura"]) assert.match(name, UNSUITABLE_SOURCE, name);
    for (const name of ["Monaco Motors", "Ingolstadt West", "Canoga Auto Body", "GermanTek Collision", "Saviers Road Auto Repair"]) assert.doesNotMatch(name, UNSUITABLE_SOURCE, name);
  });
  test("each Targeted Outreach 03 filter, and nothing already known", () => {
    const ctx = sourceContext("overture", {
      candidates: [{ id: "c1", provider: "overture", externalId: "ov-known", businessName: "Known Garage", website: "https://knowngarage.example.com", city: "Oxnard", state: "CA", phone: null }],
      prospects: [{ id: "p1", businessName: "Prospect Auto", website: "https://prospectauto.example.com", city: "Oxnard", state: "CA", phone: null }],
      screenedIds: ["ov-screened"],
    });
    assert.equal(sourceSkip(place(), AREA, ctx), null);
    assert.equal(sourceSkip(place({ categoryTier: "adjacent" }), AREA, ctx), "not_core");
    assert.equal(sourceSkip(place({ city: "Camarillo", postalCode: "93010" }), AREA, ctx), "outside_area");
    assert.equal(sourceSkip(place({ website: null }), AREA, ctx), "no_website");
    assert.equal(sourceSkip(place({ operatingStatus: "permanently_closed" }), AREA, ctx), "closed");
    assert.equal(sourceSkip(place({ confidence: 0.4 }), AREA, ctx), "low_confidence");
    assert.equal(sourceSkip(place({ businessName: "Meineke Car Care" }), AREA, ctx), "unsuitable_segment");
    assert.equal(sourceSkip(place({ externalId: "ov-screened" }), AREA, ctx), "already_screened");
    assert.equal(sourceSkip(place({ externalId: "ov-known" }), AREA, ctx), "already_screened");
    assert.equal(sourceSkip(place({ externalId: "ov-2", businessName: "Other Name", website: "https://www.knowngarage.example.com/about" }), AREA, ctx), "known_business");
    assert.equal(sourceSkip(place({ externalId: "ov-3", businessName: "Prospect Auto", website: "https://prospectauto.example.com" }), AREA, ctx), "known_business");
  });
  test("selection stops at the business cap, never picks one business twice, and reports exhaustion", async () => {
    async function* rows() {
      yield [place({ externalId: "a" }), place({ externalId: "a-dup" }), place({ externalId: "b", businessName: "Bravo Brakes", website: "https://bravo.example.com", phone: "(805) 555-0102", streetAddress: "1 B St", latitude: 34.2, longitude: -119.2 })];
      yield [place({ externalId: "c", businessName: "Charlie Collision", website: "https://charlie.example.com", phone: "(805) 555-0103", streetAddress: "1 C St", latitude: 34.25, longitude: -119.25 })];
    }
    const all = await selectFromSource(rows(), AREA, emptyContext(), { businesses: 10, sourceRows: 100 });
    assert.deepEqual(all.selected.map((p) => p.externalId), ["a", "b", "c"]);
    assert.equal(all.skipped.known_business, 1);
    assert.equal(all.exhausted, true);
    const capped = await selectFromSource(rows(), AREA, emptyContext(), { businesses: 1, sourceRows: 100 });
    assert.deepEqual(capped.selected.map((p) => p.externalId), ["a"]);
    assert.equal(capped.exhausted, false);
    const rowCapped = await selectFromSource(rows(), AREA, emptyContext(), { businesses: 10, sourceRows: 2 });
    assert.equal(rowCapped.read, 2);
    assert.equal(rowCapped.exhausted, false);
  });
});

describe("area rotation", () => {
  const areas = [AREA, { ...AREA, key: "second" }, { ...AREA, key: "third" }];
  const at = (iso: string) => new Date(iso);
  test("an area never sourced goes first, in rotation order", () => {
    assert.equal(chooseArea(areas, [], "r1")!.key, "test-area");
    assert.equal(chooseArea(areas, [{ area: "test-area", createdAt: at("2026-10-01"), release: "r1", areaExhausted: false }], "r1")!.key, "second");
  });
  test("then the least recently sourced; an area exhausted for this release is skipped until a new release", () => {
    const history = [
      { area: "test-area", createdAt: at("2026-10-03"), release: "r1", areaExhausted: false },
      { area: "second", createdAt: at("2026-10-01"), release: "r1", areaExhausted: true },
      { area: "third", createdAt: at("2026-10-02"), release: "r1", areaExhausted: false },
    ];
    assert.equal(chooseArea(areas, history, "r1")!.key, "third");
    assert.equal(chooseArea(areas, history, "r2")!.key, "second");
    const allDone = history.map((h) => ({ ...h, areaExhausted: true }));
    assert.equal(chooseArea(areas, allDone, "r1"), null);
  });
});

describe("prescreen decision (Targeted Outreach 03 rules)", () => {
  const analysis = (over: Partial<Analysis> = {}, facts: Record<string, string> = {}): Analysis => ({
    ownership: "verified",
    facts: Object.entries({ ownership_class: "independent", location_identity: "verified_location", service_evidence: "strong", ...facts }).map(([field, value]) => ({ field, value, state: "verified" as never })),
    signals: [{ key: "automotive_repair_services", value: "yes", sourceUrl: "https://x.example/services", excerpt: "Brake repair" }] as Analysis["signals"],
    contact: { email: "Service@Shop.example" },
    warnings: [],
    category: null,
    ...over,
  });
  const rules = { blockedEmails: new Set<string>(), requirePublishedEmail: true };
  test("a verified independent repair shop with a published email passes", () => {
    assert.deepEqual(screeningReasons(analysis(), rules), { reasons: [], email: "service@shop.example" });
  });
  test("each rule keeps a business out", () => {
    assert.deepEqual(screeningReasons(null, rules).reasons, ["site_unreadable"]);
    assert.deepEqual(screeningReasons(analysis({ ownership: "uncertain" }), rules).reasons, ["website_identity_unverified"]);
    assert.deepEqual(screeningReasons(analysis({}, { location_identity: "unverified" }), rules).reasons, ["location_identity_unverified"]);
    assert.deepEqual(screeningReasons(analysis({}, { service_evidence: "weak" }), rules).reasons, ["positive_repair_evidence_insufficient"]);
    assert.deepEqual(screeningReasons(analysis({ signals: [] }), rules).reasons, ["positive_repair_evidence_insufficient"]);
    assert.deepEqual(screeningReasons(analysis({}, { ownership_class: "chain_or_franchise" }), rules).reasons, ["unsuitable_ownership"]);
    assert.deepEqual(screeningReasons(analysis({ warnings: ["Contradictory repair evidence"] }), rules).reasons, ["scope_or_evidence_conflict"]);
    assert.deepEqual(screeningReasons(analysis(), { ...rules, blockedEmails: new Set(["service@shop.example"]) }).reasons, ["suppressed_or_existing_email"]);
    assert.deepEqual(screeningReasons(analysis({ contact: {} }), rules).reasons, ["no_published_email"]);
    assert.deepEqual(screeningReasons(analysis({ contact: {} }), { ...rules, requirePublishedEmail: false }).reasons, []);
  });
});

describe("request budget meter", () => {
  test("counts every physical request and refuses once the cap is reached", async () => {
    const meter = meteredFetch({ fetches: 2, bytes: 1_000 }, async () => new Response("ok"));
    await meter.fetch("https://a.example/1", {});
    await meter.fetch("https://a.example/2", {});
    await assert.rejects(meter.fetch("https://a.example/3", {}), ReplenishmentStop);
    assert.deepEqual(meter.used(), { fetches: 2, bytes: 4 });
    assert.equal(meter.exceeded(), true);
  });
  test("cuts a body off at the byte cap and records it", async () => {
    const meter = meteredFetch({ fetches: 5, bytes: 10 }, async () => new Response("x".repeat(25)));
    const text = await (await meter.fetch("https://a.example/", {})).text();
    assert.equal(text.length, 10);
    assert.equal(meter.used().bytes, 10);
    assert.equal(meter.exceeded(), true);
  });
  test("passes null-body responses through untouched", async () => {
    const meter = meteredFetch({ fetches: 5, bytes: 10 }, async () => new Response(null, { status: 204 }));
    assert.equal((await meter.fetch("https://a.example/", {})).status, 204);
    assert.equal(meter.exceeded(), false);
  });
});

describe("prescreen through the real research transport (no network)", () => {
  const rules = { blockedEmails: new Set<string>(), requirePublishedEmail: true };
  const caps = { fetches: 25, bytes: 8_000_000, pages: 5 };
  test("an independent shop's site passes, with its published email and compact evidence", async () => {
    const web = fixtureFetch(independentShop());
    const r = await screenBusiness(place(), rules, caps, { transportFetch: web.fetch, sleep: async () => undefined });
    assert.equal(r.status, "accepted", JSON.stringify(r));
    assert.equal(r.email, "service@saviersauto.example.com");
    assert.equal(r.fetches, web.calls.length);
    assert.ok(r.bytes > 0);
    assert.equal((r.evidence as { serviceEvidence: string }).serviceEvidence, "strong");
    assert.ok(!JSON.stringify(r.evidence).includes("<html"), "no page bodies are stored");
  });
  test("a site that exceeds the per-business request cap is an error, never accepted on a partial read", async () => {
    const web = fixtureFetch(independentShop());
    const r = await screenBusiness(place(), rules, { ...caps, fetches: 2 }, { transportFetch: web.fetch, sleep: async () => undefined });
    assert.equal(r.status, "error");
    assert.deepEqual(r.reasons, ["request_budget_exceeded"]);
    assert.ok(web.calls.length <= 2);
  });
  test("an unreachable site is rejected as unreadable", async () => {
    const web = fixtureFetch({});
    const r = await screenBusiness(place(), rules, caps, { transportFetch: web.fetch, sleep: async () => undefined });
    assert.equal(r.status, "rejected");
    assert.deepEqual(r.reasons, ["site_unreadable"]);
  });
});
