/*
 * Discovery provider registry.
 *
 * No commercial or network provider is configured. The only provider is a
 * deterministic FIXTURE of clearly synthetic businesses (example.com data),
 * used to exercise the workflow and tests. It is offered only outside
 * production. Real candidates in production come from "Add candidate" in the
 * admin until a provider is chosen; see "Provider requirements" in
 * DISCOVERY.md. To add one, implement DiscoveryProvider and register it here.
 */
import type { Config } from "../config.js";
import type { DiscoveredBusiness, DiscoveryProvider, DiscoveryTarget } from "./types.js";

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

/** Providers available to this process, keyed by name. */
export function discoveryProviders(config: Pick<Config, "enableFixtureDiscovery">): Map<string, DiscoveryProvider> {
  const providers = new Map<string, DiscoveryProvider>();
  if (config.enableFixtureDiscovery) providers.set(fixtureProvider.name, fixtureProvider);
  return providers;
}
