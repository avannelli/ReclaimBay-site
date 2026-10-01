import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MatchIndex,
  classifyMatch,
  comparePlace,
  distanceMeters,
  flagReason,
  relate,
  relationReason,
  type IncomingKeys,
  type MatchKeys,
} from "../../src/discovery/dedupe.js";
import { locationKey, namesMatchStrongly, normalizeDomain, normalizeName, phoneKey, streetKey } from "../../src/discovery/normalize.js";

// Thousand Oaks and Oxnard are ~30 km apart; OFFSET is ~10 m.
const TO = { latitude: 34.1781, longitude: -118.8521, locationKey: null };
const OX = { latitude: 34.1975, longitude: -119.1771, locationKey: null };
const OFFSET = 0.00009;

function biz(over: {
  id?: string; kind?: "candidate" | "prospect"; provider?: string; externalId?: string | null;
  name: string; website?: string | null; phone?: string | null; city?: string | null; state?: string | null;
  street?: string | null; at?: { latitude: number; longitude: number } | null;
}): MatchKeys {
  return {
    id: over.id ?? "e1",
    kind: over.kind ?? "candidate",
    provider: over.provider ?? "overture",
    externalId: over.externalId ?? null,
    domainKey: normalizeDomain(over.website),
    nameKey: normalizeName(over.name),
    locationKey: locationKey(over.city ?? null, over.state ?? "CA"),
    phoneKey: phoneKey(over.phone),
    streetKey: streetKey(over.street),
    latitude: over.at?.latitude ?? null,
    longitude: over.at?.longitude ?? null,
  };
}
const incoming = (b: MatchKeys): IncomingKeys => ({ ...b, provider: b.provider ?? "overture", externalId: b.externalId ?? null });

describe("comparePlace", () => {
  test("positions decide when both records have them", () => {
    assert.equal(comparePlace(TO, { ...TO, latitude: TO.latitude + OFFSET }).place, "same");
    assert.equal(comparePlace(TO, OX).place, "different");
    const between = { ...TO, latitude: TO.latitude + 0.0013 }; // ~145 m
    assert.equal(comparePlace(TO, between).place, "unknown");
    assert.ok(Math.abs(distanceMeters(TO, OX) - 30000) < 2000);
  });

  test("street addresses decide when positions are missing, and normalize abbreviations", () => {
    const a = { locationKey: "thousand oaks|CA", streetKey: streetKey("1200 East Thousand Oaks Boulevard, Suite 4") };
    const b = { locationKey: "thousand oaks|CA", streetKey: streetKey("1200 E Thousand Oaks Blvd") };
    assert.equal(comparePlace(a, b).place, "same");
    assert.equal(comparePlace(a, { ...b, streetKey: streetKey("300 S Oxnard Blvd") }).place, "different");
  });

  test("a city alone can prove different, never same", () => {
    assert.equal(comparePlace({ locationKey: "ojai|CA" }, { locationKey: "ventura|CA" }).place, "different");
    assert.equal(comparePlace({ locationKey: "ojai|CA" }, { locationKey: "ojai|CA" }).place, "unknown");
    assert.equal(comparePlace({ locationKey: "ojai|CA" }, { locationKey: null }).place, "unknown");
  });
});

describe("A. same provider record", () => {
  test("same provider and external ID is confident", () => {
    const e = biz({ name: "X", externalId: "fx-1" });
    const v = classifyMatch(incoming(biz({ name: "Totally different", externalId: "fx-1" })), [e]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(v.duplicateOf?.reason, "same provider record");
  });

  test("the same external ID from another provider is not", () => {
    const e = biz({ name: "X", externalId: "fx-1", provider: "osm" });
    assert.equal(classifyMatch(incoming(biz({ name: "Y", externalId: "fx-1" })), [e]).outcome, "NO_MATCH");
  });
});

describe("B/C. same website", () => {
  const site = "https://leonstrans.example.com";

  test("same business, same domain, same location: confident", () => {
    const e = biz({ name: "Leon's Transmissions", website: site, city: "Thousand Oaks", at: TO });
    const v = classifyMatch(incoming(biz({ name: "Leons Transmission Inc.", website: `${site}/about`, city: "Thousand Oaks", at: { latitude: TO.latitude + OFFSET, longitude: TO.longitude } })), [e]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(v.duplicateOf?.reason, "same website and location");
  });

  test("same business, same domain, different location: both kept and linked, not a duplicate", () => {
    const e = biz({ name: "Leon's Transmissions", website: site, city: "Thousand Oaks", at: TO });
    const v = classifyMatch(incoming(biz({ name: "Leon's Transmissions", website: site, city: "Oxnard", at: OX })), [e]);
    assert.equal(v.outcome, "NO_MATCH");
    assert.equal(v.duplicateOf, null);
    assert.deepEqual(v.relatedCandidate, { kind: "candidate", id: "e1", reason: "same website, different location" });
    assert.equal(relationReason(v), "candidate: same website, different location");
  });

  test("an independent multi-location business: every location survives a whole run", () => {
    const idx = new MatchIndex();
    const locs = [
      { city: "Thousand Oaks", at: TO },
      { city: "Oxnard", at: OX },
      { city: "Ventura", at: { latitude: 34.2805, longitude: -119.2945 } },
    ];
    locs.forEach((l, i) => {
      const k = biz({ id: `L${i}`, name: "Bender's Automotive", website: "https://bendersauto.example.com", ...l });
      const v = idx.classify(incoming(k));
      assert.notEqual(v.outcome, "CONFIDENT_DUPLICATE", l.city);
      idx.add(k);
    });
    assert.equal(idx.size, 3);
  });

  test("chain locations sharing the chain's website are related, not duplicates", () => {
    const e = biz({ name: "QuickLube Express", website: "https://quicklube.example.com", city: "Ventura", at: { latitude: 34.2805, longitude: -119.2945 } });
    const v = classifyMatch(incoming(biz({ name: "QuickLube Express", website: "https://quicklube.example.com", city: "Camarillo", at: { latitude: 34.2164, longitude: -119.0376 } })), [e]);
    assert.equal(v.outcome, "NO_MATCH");
    assert.ok(v.relatedCandidate);
  });

  test("two different businesses sharing a domain at the same spot: review, not skip", () => {
    const e = biz({ name: "Swensen Automotive", website: "https://swensenauto.example.com", city: "Ventura", at: TO });
    const v = classifyMatch(incoming(biz({ name: "Derrico Automotive", website: "https://swensenauto.example.com", city: "Ventura", at: TO })), [e]);
    assert.equal(v.outcome, "REVIEW_REQUIRED");
    assert.equal(v.possibleCandidate?.reason, "same website and location, different name");
  });

  test("same website with location unconfirmed: review, never a silent skip", () => {
    const e = biz({ name: "Smith Auto", website: "https://smithauto.example.com", city: "Springfield", state: "IL" });
    const v = classifyMatch(incoming(biz({ name: "Smith Automotive", website: "https://smithauto.example.com", city: null })), [e]);
    assert.equal(v.outcome, "REVIEW_REQUIRED");
    assert.equal(v.possibleCandidate?.reason, "same website, location unconfirmed");
  });

  test("with no address or position on either side, same website + similar name + same city stays confident", () => {
    const e = biz({ name: "Conejo Valley Auto Care", website: "https://conejoauto.example.com", city: "Thousand Oaks" });
    const v = classifyMatch(incoming(biz({ name: "Conejo Valley Auto Care, Inc.", website: "https://www.conejoauto.example.com/contact", city: "Thousand Oaks" })), [e]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(v.duplicateOf?.reason, "same website, name and city");
  });

  test("a matching prospect at the same location is confident; elsewhere it is related", () => {
    const p = biz({ id: "p1", kind: "prospect", name: "Smith Auto", website: "https://smithauto.example.com", city: "Springfield", state: "IL" });
    const same = classifyMatch(incoming(biz({ name: "Smith Auto", website: "https://smithauto.example.com", city: "Springfield", state: "IL" })), [p]);
    assert.equal(same.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(same.duplicateOf?.kind, "prospect");
    const elsewhere = classifyMatch(incoming(biz({ name: "Smith Auto", website: "https://smithauto.example.com", city: "Peoria", state: "IL" })), [p]);
    assert.equal(elsewhere.outcome, "NO_MATCH");
    assert.equal(elsewhere.relatedProspect?.id, "p1");
  });
});

describe("D. shared infrastructure domains never merge shops", () => {
  test("manufacturer, locator, and directory domains have no domain key", () => {
    for (const url of [
      "https://www.acdelco.com/dealer/123",
      "https://locations.autovalue.com/ca/thousand-oaks/gallardos",
      "https://locations.partsprogram.example.com/x",
      "https://store.vioc.com/ca/camarillo",
      "https://instant-auto-lube.hub.biz/",
      "https://wa.me/16266563483",
    ]) {
      assert.equal(normalizeDomain(url), null, url);
    }
  });

  test("two shops listed on the same locator domain are not duplicates", () => {
    const e = biz({ name: "Gallardos Automotive Service", website: "https://locations.autovalue.com/a", city: "Thousand Oaks", at: TO });
    const v = classifyMatch(incoming(biz({ name: "High Tech Tune & Lube", website: "https://locations.autovalue.com/b", city: "Simi Valley", at: OX })), [e]);
    assert.equal(v.outcome, "NO_MATCH");
    assert.equal(v.relatedCandidate, null);
  });

  test("two shops whose 'website' is a manufacturer program are not duplicates", () => {
    const e = biz({ name: "Farr's Automotive", website: "https://www.acdelco.com/farrs", city: "Fillmore" });
    const v = classifyMatch(incoming(biz({ name: "Fillmore Auto-Electric & Tune-Up", website: "https://www.acdelco.com/fae", city: "Fillmore" })), [e]);
    assert.equal(v.outcome, "NO_MATCH");
  });
});

describe("E. same name", () => {
  test("same name and city without location evidence: review", () => {
    const e = biz({ name: "Famous Auto Repair", city: "Santa Paula" });
    const v = classifyMatch(incoming(biz({ name: "Famous Auto Repair", city: "Santa Paula" })), [e]);
    assert.equal(v.outcome, "REVIEW_REQUIRED");
    assert.equal(v.possibleCandidate?.reason, "same name and city");
  });

  test("same name at the same position: confident", () => {
    const e = biz({ name: "Chapo Mufflers", city: "Oxnard", at: OX });
    const v = classifyMatch(incoming(biz({ name: "Chapo Mufflers", city: "Oxnard", at: { latitude: OX.latitude + OFFSET, longitude: OX.longitude } })), [e]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(v.duplicateOf?.reason, "same name at the same location");
  });

  test("same name in the same city at a proven different location: related, not a duplicate", () => {
    const e = biz({ name: "Brake Masters", city: "Oxnard", at: OX });
    const far = { latitude: OX.latitude + 0.02, longitude: OX.longitude }; // ~2.2 km
    const v = classifyMatch(incoming(biz({ name: "Brake Masters", city: "Oxnard", at: far })), [e]);
    assert.equal(v.outcome, "NO_MATCH");
    assert.equal(v.relatedCandidate?.reason, "same name, different location");
  });

  test("a similar name nearby (75-150 m): review", () => {
    const e = biz({ name: "Carrillo's Auto Repair", city: "Oxnard", at: OX });
    const near = { latitude: OX.latitude + 0.0011, longitude: OX.longitude }; // ~120 m
    const v = classifyMatch(incoming(biz({ name: "Carillo's Auto Repair", city: "Oxnard", at: near })), [e]);
    assert.equal(v.outcome, "REVIEW_REQUIRED");
    assert.equal(v.possibleCandidate?.reason, "similar name nearby");
  });

  test("different businesses at the same spot with different names are not linked", () => {
    const e = biz({ name: "Main St Smogs", city: "Santa Paula", at: OX });
    assert.equal(classifyMatch(incoming(biz({ name: "Cortez Auto Repair", city: "Santa Paula", at: OX })), [e]).outcome, "NO_MATCH");
  });
});

describe("F. same phone", () => {
  test("same phone alone: review", () => {
    const e = biz({ name: "Mesa Brake Pros", phone: "(805) 555-4401", city: "Moorpark", at: TO });
    const v = classifyMatch(incoming(biz({ name: "Arroyo Auto Electric", phone: "805.555.4401", city: "Fillmore", at: OX })), [e]);
    assert.equal(v.outcome, "REVIEW_REQUIRED");
    assert.equal(v.possibleCandidate?.reason, "same phone number");
  });

  test("same phone with a similar name at the same location: confident", () => {
    const e = biz({ name: "Brakes & Tires", phone: "(805) 555-0100", city: "Oxnard", street: "100 Main St" });
    const v = classifyMatch(incoming(biz({ name: "Brakes and Tires", phone: "805-555-0100", city: "Oxnard", street: "100 Main Street" })), [e]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
  });
});

describe("G. cross-provider", () => {
  test("an OSM record without a city matches the Overture record by position and name", () => {
    const ov = biz({ provider: "overture", externalId: "ov-1", name: "Jessie's Radiator & Automotive", website: "https://jessiesradiator.example.com", city: "Ventura", at: TO });
    const osm = biz({ provider: "osm", externalId: "node/1", name: "Jessies Radiator and Automotive", city: null, at: { latitude: TO.latitude + OFFSET, longitude: TO.longitude } });
    const v = classifyMatch(incoming(osm), [ov]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
  });

  test("cross-provider same website at another location is related, not merged", () => {
    const ov = biz({ provider: "overture", externalId: "ov-2", name: "Pep Boys", website: "https://pepboys.example.com", city: "Ventura", at: TO });
    const osm = biz({ provider: "osm", externalId: "node/2", name: "Pep Boys", website: "https://pepboys.example.com", city: null, at: OX });
    const v = classifyMatch(incoming(osm), [ov]);
    assert.equal(v.outcome, "NO_MATCH");
    assert.ok(v.relatedCandidate);
  });
});

describe("verdict assembly", () => {
  test("confident outranks review outranks related", () => {
    const site = "https://x.example.com";
    const existing = [
      biz({ id: "rel", name: "X Auto", website: site, city: "Oxnard", at: OX }),
      biz({ id: "rev", name: "Other", phone: "(805) 555-0000", city: "Ojai" }),
      biz({ id: "dup", name: "X Auto", website: site, city: "Thousand Oaks", at: TO }),
    ];
    const v = classifyMatch(incoming(biz({ name: "X Auto", website: site, phone: "(805) 555-0000", city: "Thousand Oaks", at: TO })), existing);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(v.duplicateOf?.id, "dup");
    assert.equal(v.possibleCandidate?.id, "rev");
    assert.equal(v.relatedCandidate?.id, "rel");
  });

  test("candidates are preferred over prospects", () => {
    const v = classifyMatch(incoming(biz({ name: "A", phone: "(805) 555-0001" })), [
      biz({ id: "c1", name: "B", phone: "(805) 555-0001" }),
      biz({ id: "p1", kind: "prospect", name: "C", phone: "(805) 555-0001" }),
    ]);
    assert.equal(v.possibleCandidate?.id, "c1");
    assert.equal(v.possibleProspect?.id, "p1");
    assert.match(flagReason(v)!, /candidate: same phone number; prospect: same phone number/);
  });

  test("nothing overlapping is NO_MATCH with no links", () => {
    const v = classifyMatch(incoming(biz({ name: "Alpha", city: "Ojai" })), [biz({ name: "Beta", city: "Ventura" })]);
    assert.deepEqual(v, { outcome: "NO_MATCH", duplicateOf: null, possibleCandidate: null, possibleProspect: null, relatedCandidate: null, relatedProspect: null });
    assert.equal(relate(incoming(biz({ name: "Alpha", city: "Ojai" })), biz({ name: "Beta", city: "Ventura" })), null);
  });
});

describe("MatchIndex", () => {
  test("gives exactly the same verdicts as a full scan", () => {
    // A deterministic mix of shared names, domains, phones, cities, and positions.
    const names = ["Leon's Transmissions", "Leons Transmission", "QuickLube Express", "Mesa Brake Pros", "Famous Auto Repair", "Chapo Mufflers"];
    const cities = ["Thousand Oaks", "Oxnard", "Ventura", null];
    const records: MatchKeys[] = [];
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 160; i++) {
      const at = rnd(3) === 0 ? null : { latitude: 34.2 + rnd(40) * 0.0004, longitude: -119.0 - rnd(40) * 0.0004 };
      records.push(biz({
        id: `r${i}`,
        kind: rnd(5) === 0 ? "prospect" : "candidate",
        externalId: rnd(4) === 0 ? `x${rnd(20)}` : null,
        name: names[rnd(names.length)]!,
        website: rnd(2) ? `https://site${rnd(6)}.example.com` : null,
        phone: rnd(3) === 0 ? `(805) 555-0${100 + rnd(15)}` : null,
        city: cities[rnd(cities.length)]!,
        street: rnd(4) === 0 ? `${rnd(5) + 1} Main St` : null,
        at,
      }));
    }
    const ordered = (list: MatchKeys[]) => [...list.filter((r) => r.kind === "candidate"), ...list.filter((r) => r.kind === "prospect")];
    const idx = new MatchIndex();
    const seen: MatchKeys[] = [];
    for (const r of records) {
      assert.deepEqual(idx.classify(incoming(r)), classifyMatch(incoming(r), ordered(seen)), r.id);
      idx.add(r);
      seen.push(r);
    }
  });
});

/*
 * Regression cases from the first real Overture import (Ventura County,
 * release 2026-09-23.1): neighbours in a strip or a complex were skipped as
 * "confident" duplicates on one shared word. Name and location alone now
 * need a strong name match at a confirmed place; anything weaker is kept
 * and flagged for a person, never skipped.
 */
describe("name-and-location matches from real data", () => {
  // Real pairs, ~10-70 m apart (coordinates rounded).
  const at = (lat: number, lon: number) => ({ latitude: lat, longitude: lon });

  test("coordinates close together but different street addresses are not the same place", () => {
    const a = { ...at(34.2786, -118.7768), locationKey: "simi valley|CA", streetKey: streetKey("679 E Easy St D") };
    const b = { ...at(34.2788, -118.7771), locationKey: "simi valley|CA", streetKey: streetKey("649 E Easy St") };
    const r = comparePlace(a, b);
    assert.equal(r.place, "unknown");
    assert.ok(r.evidence);
  });

  test("neighbours sharing one word are flagged, not skipped", () => {
    const pairs: [Parameters<typeof biz>[0], Parameters<typeof biz>[0]][] = [
      [
        { name: "Daves' Motor Works", city: "Simi Valley", street: "679 E Easy St D", at: at(34.2786, -118.7768) },
        { name: "Dave's Garage", city: "Simi Valley", street: "649 E Easy St", at: at(34.2788, -118.7771) },
      ],
      [
        { name: "Santa Paula Auto Center", city: "Santa Paula", street: "1055 E Main St", at: at(34.3542, -119.0593) },
        { name: "Santa Paula Automotive Machine Shop", city: "Santa Paula", street: "1085 E Main St", at: at(34.3544, -119.0599) },
      ],
      [
        { name: "Chevo's Diesel Performance", city: "Oxnard", street: "1800 Sunkist Cir #2", at: at(34.2186, -119.1585) },
        { name: "Performance Transmissions", city: "Oxnard", street: "1800 Sunkist Cir", at: at(34.2188, -119.1587) },
      ],
      [
        { name: "Ventura Collision Center", city: "Ventura", street: "3900 Market St", at: at(34.2617, -119.2079) },
        { name: "Buena Vista Collision", city: "Ventura", street: "3900 Market St", at: at(34.2618, -119.2080) },
      ],
      [
        { name: "Auto Body Unlimited", city: "Simi Valley", street: "2180 1st St Unit C8", at: at(34.2731, -118.7006) },
        { name: "World Class Paint & Body", city: "Simi Valley", street: "2180 1st St Ste C3", at: at(34.2733, -118.7008) },
      ],
    ];
    for (const [a, b] of pairs) {
      const v = classifyMatch(incoming(biz({ ...a, id: "in" })), [biz(b)]);
      assert.equal(v.outcome, "REVIEW_REQUIRED", `${a.name} / ${b.name}`);
      assert.equal(v.duplicateOf, null);
    }
  });

  test("the same business under a slightly different name at the same address is still a confident duplicate", () => {
    const a = { name: "Skyline Auto Repair LLC", city: "Thousand Oaks", street: "50 N Skyline Dr # C", at: at(34.1781, -118.8721) };
    const b = { name: "Skyline Auto Repair", city: "Thousand Oaks", street: "50 N Skyline Dr", at: at(34.1781, -118.8721) };
    const v = classifyMatch(incoming(biz({ ...a, id: "in" })), [biz(b)]);
    assert.equal(v.outcome, "CONFIDENT_DUPLICATE");
    assert.equal(v.duplicateOf!.reason, "same name at the same location");
  });

  test("a shared phone still makes a weak name match confident at the same place", () => {
    const a = { name: "Brake Masters", city: "Thousand Oaks", street: "851 E Thousand Oaks Blvd", phone: "+18054493677", at: at(34.1771, -118.8606) };
    const b = { name: "Southern California Break Masters", city: "Thousand Oaks", street: "851 E Thousand Oaks Blvd", phone: "+18054493677", at: at(34.1772, -118.8607) };
    assert.equal(classifyMatch(incoming(biz({ ...a, id: "in" })), [biz(b)]).duplicateOf?.reason, "same phone, name and location");
  });
});

describe("namesMatchStrongly", () => {
  test("needs the shared words to cover half of each name; city words don't count", () => {
    assert.ok(namesMatchStrongly("Skyline Auto Repair LLC", "Skyline Auto Repair"));
    assert.ok(namesMatchStrongly("Leon's Transmissions", "Leons Transmission Inc."));
    assert.ok(!namesMatchStrongly("Chevo's Diesel Performance", "Performance Transmissions"));
    assert.ok(!namesMatchStrongly("Santa Paula Auto Center", "Santa Paula Automotive Machine Shop", ["santa", "paula"]));
    assert.ok(!namesMatchStrongly("Ventura Collision Center", "Buena Vista Collision", ["ventura"]));
    assert.ok(!namesMatchStrongly(null, "X"));
  });
});
