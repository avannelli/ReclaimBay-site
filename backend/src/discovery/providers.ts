/*
 * Discovery provider and importer registry.
 *
 *   overture        Overture Maps Places: a background provider reading the
 *                   latest staged import of the Overture importer
 *                   (overture.ts, loaded by npm run discovery:import). The
 *                   only real provider. Available everywhere; it has
 *                   nothing to read until an import has been run.
 *
 * Deterministic FIXTURES of clearly synthetic businesses (example.com data)
 * exercise the workflow and tests, and are offered only outside production:
 *
 *   fixture         a small synchronous provider (runs inside the request);
 *   fixture-staged  a background provider reading the latest staged import
 *                   of the fixture importer (see staging.ts).
 *
 * To add a provider: implement ProviderImporter (a background job loads a
 * release into staging) and register a staged provider over it here.
 */
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { categoryTierFor } from "./categories.js";
import { OVERTURE, createOvertureImporter } from "./overture.js";
import { createStagedProvider } from "./staging.js";
import type { DiscoveredBusiness, DiscoveryProvider, DiscoveryTarget, ImportScope, ProviderImporter, StagedPlace } from "./types.js";

/** Synthetic. Shapes cover clean records, duplicates, and weak matches. */
export const FIXTURE_BUSINESSES: readonly (DiscoveredBusiness & { region: string })[] = [
  {
    region: "ventura county",
    externalId: "fx-1001",
    businessName: "Conejo Valley Auto Care",
    website: "https://conejoauto.example.com",
    city: "Thousand Oaks",
    state: "CA",
    postalCode: "91360",
    phone: "(805) 555-0101",
    sourceUrl: "https://directory.example.com/listing/fx-1001",
  },
  {
    region: "ventura county",
    externalId: "fx-1002",
    businessName: "Oak Park Import Repair",
    website: "https://oakparkimport.example.com",
    city: "Thousand Oaks",
    state: "CA",
    postalCode: "91360",
    phone: "(805) 555-0102",
    sourceUrl: "https://directory.example.com/listing/fx-1002",
  },
  {
    // Same business as fx-1001 under a new provider ID: caught by domain.
    region: "ventura county",
    externalId: "fx-1001-b",
    businessName: "Conejo Valley Auto Care, Inc.",
    website: "https://www.conejoauto.example.com/contact",
    city: "Thousand Oaks",
    state: "CA",
    sourceUrl: "https://directory.example.com/listing/fx-1001-b",
  },
  {
    // Same name and city as fx-2001 but a different site: flagged, not dropped.
    region: "ventura county",
    externalId: "fx-2001",
    businessName: "Harbor Street Garage",
    website: "https://harborstreet.example.com",
    city: "Ventura",
    state: "CA",
    postalCode: "93001",
    phone: "(805) 555-0201",
    sourceUrl: "https://directory.example.com/listing/fx-2001",
  },
  {
    region: "ventura county",
    externalId: "fx-2002",
    businessName: "Harbor Street Garage",
    website: "https://harborstgarage.example.com",
    city: "Ventura",
    state: "CA",
    phone: "(805) 555-0299",
    sourceUrl: "https://directory.example.com/listing/fx-2002",
  },
  {
    // A social page is not a website of its own; no phone source means no phone.
    region: "ventura county",
    externalId: "fx-3001",
    businessName: "Camarillo Brake & Tire",
    website: "https://www.facebook.com/camarillobrake",
    city: "Camarillo",
    state: "CA",
    phone: "805-555-0301",
  },
  {
    region: "ventura county",
    externalId: "fx-4001",
    businessName: "Simi Valley Motor Works",
    city: "Simi Valley",
    state: "CA",
    postalCode: "93065",
    sourceUrl: "https://directory.example.com/listing/fx-4001",
  },
  {
    region: "san diego county",
    externalId: "fx-9001",
    businessName: "Coastline Automotive",
    website: "https://coastlineauto.example.com",
    city: "Oceanside",
    state: "CA",
    sourceUrl: "https://directory.example.com/listing/fx-9001",
  },
];

const fixtureProvider: DiscoveryProvider = {
  name: "fixture",
  label: "Fixture (synthetic test data)",
  async discover(target: DiscoveryTarget) {
    const region = target.region.toLowerCase();
    const city = target.city?.toLowerCase().trim() ?? "";
    return FIXTURE_BUSINESSES.filter(
      (b) => region.includes(b.region) && (!city || b.city?.toLowerCase() === city),
    ).map(({ region: _region, ...business }) => business);
  },
};

/**
 * Synthetic staged places for the fixture importer, in an Overture-like
 * shape (category codes map through categories.ts). They reproduce the
 * multi-location cases from the Ventura County bake-off.
 */
const S = (p: Partial<StagedPlace> & { externalId: string; businessName: string }): StagedPlace => ({
  state: "CA",
  country: "US",
  county: "Ventura County",
  confidence: 0.92,
  operatingStatus: "open",
  ...p,
  categoryTier: categoryTierFor("overture", p.category ?? "automotive_repair"),
  category: p.category ?? "automotive_repair",
});
export const FIXTURE_STAGED_PLACES: readonly StagedPlace[] = [
  // One independent with two locations sharing a website: both must survive.
  S({ externalId: "st-101", businessName: "Leon's Transmissions", category: "transmission_repair", website: "https://leonstrans.example.com", streetAddress: "1200 E Thousand Oaks Blvd", city: "Thousand Oaks", postalCode: "91362", latitude: 34.1781, longitude: -118.8521, phone: "(805) 555-1101" }),
  S({ externalId: "st-102", businessName: "Leon's Transmissions", category: "transmission_repair", website: "https://leonstrans.example.com/oxnard", streetAddress: "300 S Oxnard Blvd", city: "Oxnard", postalCode: "93030", latitude: 34.1975, longitude: -119.1771, phone: "(805) 555-1102" }),
  // The same Thousand Oaks shop again under another record: a true duplicate.
  S({ externalId: "st-103", businessName: "Leons Transmission Inc.", category: "transmission_repair", website: "https://www.leonstrans.example.com", streetAddress: "1200 East Thousand Oaks Boulevard", city: "Thousand Oaks", latitude: 34.17815, longitude: -118.85205, phone: "(805) 555-1101" }),
  // A chain: three locations on one website.
  S({ externalId: "st-201", businessName: "QuickLube Express", brand: "QuickLube", category: "oil_change_station", website: "https://quicklube.example.com", streetAddress: "10 Main St", city: "Ventura", latitude: 34.2805, longitude: -119.2945, phone: "(805) 555-2201" }),
  S({ externalId: "st-202", businessName: "QuickLube Express", brand: "QuickLube", category: "oil_change_station", website: "https://quicklube.example.com", streetAddress: "500 Ventura Blvd", city: "Camarillo", latitude: 34.2164, longitude: -119.0376, phone: "(805) 555-2202" }),
  S({ externalId: "st-203", businessName: "QuickLube Express", brand: "QuickLube", category: "oil_change_station", website: "https://quicklube.example.com", streetAddress: "77 Los Angeles Ave", city: "Simi Valley", latitude: 34.2694, longitude: -118.7815, phone: "(805) 555-2203" }),
  // Two different shops listed on the same parts-program locator domain.
  S({ externalId: "st-301", businessName: "Gallardo Motor Service", website: "https://locations.partsprogram.example.com/gallardo", streetAddress: "45 Pine St", city: "Santa Paula", latitude: 34.3542, longitude: -119.0593, phone: "(805) 555-3301" }),
  S({ externalId: "st-302", businessName: "Hightower Tune & Lube", website: "https://locations.partsprogram.example.com/hightower", streetAddress: "900 Tapo St", city: "Simi Valley", latitude: 34.2856, longitude: -118.7184, phone: "(805) 555-3302" }),
  // Same phone, different name, far apart: flagged for review, both kept.
  S({ externalId: "st-401", businessName: "Mesa Brake Pros", category: "brake_service_and_repair", website: "https://mesabrake.example.com", streetAddress: "12 Mesa Rd", city: "Moorpark", latitude: 34.2856, longitude: -118.8820, phone: "(805) 555-4401" }),
  S({ externalId: "st-402", businessName: "Arroyo Auto Electric", category: "auto_electrical_repair", website: "https://arroyoelectric.example.com", streetAddress: "8 Arroyo Dr", city: "Fillmore", latitude: 34.3992, longitude: -118.9181, phone: "(805) 555-4401" }),
  // Adjacent tier, closed, low confidence, out of county, unrelated category.
  S({ externalId: "st-501", businessName: "Rios Tire Service", category: "tire_dealer_and_repair", streetAddress: "60 Rose Ave", city: "Oxnard", latitude: 34.1890, longitude: -119.1601, phone: "(805) 555-5501" }),
  S({ externalId: "st-601", businessName: "Old Grove Garage", operatingStatus: "permanently_closed", streetAddress: "3 Grove Ln", city: "Ojai", latitude: 34.4480, longitude: -119.2429 }),
  S({ externalId: "st-602", businessName: "Car Part Auto", confidence: 0.26, city: "Oxnard", latitude: 34.2, longitude: -119.18 }),
  S({ externalId: "st-701", businessName: "Coastline Auto Repair", county: "San Diego County", streetAddress: "1 Coast Hwy", city: "Oceanside", latitude: 33.1959, longitude: -117.3795 }),
  S({ externalId: "st-801", businessName: "Harbor Auto Insurance", category: "auto_insurance", city: "Ventura", latitude: 34.27, longitude: -119.29 }),
];

/** Loads the synthetic places as if they were a provider release. */
export const fixtureImporter: ProviderImporter = {
  provider: "fixture-staged",
  label: "Fixture importer (synthetic test data)",
  async *fetch(_release: string, scope: ImportScope) {
    const state = scope.region.split("-")[1];
    const rows = FIXTURE_STAGED_PLACES.filter((p) => p.state === state);
    for (let i = 0; i < rows.length; i += 5) yield rows.slice(i, i + 5);
  },
};

/** Importers runnable by the discovery:import script, keyed by provider. */
export function providerImporters(config: Pick<Config, "enableFixtureDiscovery">): Map<string, ProviderImporter> {
  const importers = new Map<string, ProviderImporter>();
  const overture = createOvertureImporter();
  importers.set(overture.provider, overture);
  if (config.enableFixtureDiscovery) importers.set(fixtureImporter.provider, fixtureImporter);
  return importers;
}

/** Label shown for the Overture provider in the admin. */
export const OVERTURE_LABEL = "Overture Maps Places";

/** Providers available to this process, keyed by name. */
export function discoveryProviders(
  config: Pick<Config, "enableFixtureDiscovery">,
  db?: Db,
): Map<string, DiscoveryProvider> {
  const providers = new Map<string, DiscoveryProvider>();
  if (db) {
    const overture = createStagedProvider(db, { name: OVERTURE, label: OVERTURE_LABEL });
    providers.set(overture.name, overture);
  }
  if (config.enableFixtureDiscovery) {
    providers.set(fixtureProvider.name, fixtureProvider);
    if (db) {
      const staged = createStagedProvider(db, { name: "fixture-staged", label: "Fixture, staged release (background)" });
      providers.set(staged.name, staged);
    }
  }
  return providers;
}
