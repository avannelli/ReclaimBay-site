/*
 * Provider category -> provider-neutral tier. A DISCOVERY FILTER ONLY:
 * "core" means the provider calls it general/mechanical repair, "adjacent"
 * means a related automotive service worth a look. Neither establishes
 * "Offers general repair"; that is still a researched, evidence-backed
 * signal (src/scoring.ts).
 *
 * The lists come from the Ventura County bake-off and were re-checked
 * against Overture release 2026-09-23.1 (schema v2: `taxonomy`, no
 * `categories`). Anything unlisted has no tier and is not discovered.
 */
import type { CategoryTier } from "./types.js";

const TIERS: Record<string, { core: readonly string[]; adjacent: readonly string[] }> = {
  // Overture places taxonomy (taxonomy.primary). Every one sits under
  // travel_and_transportation > vehicle_service > automotive_service; see
  // overtureTier() for the hierarchy check and the deliberate exclusions.
  overture: {
    core: [
      "automotive_repair",
      "brake_service_and_repair",
      "engine_repair_service",
      "transmission_repair",
      "exhaust_and_muffler_repair",
      "auto_electrical_repair",
    ],
    adjacent: [
      "automotive_service",
      "tire_dealer_and_repair",
      "oil_change_station",
      "emissions_inspection",
      "truck_repair",
      "car_inspection",
    ],
  },
  // OpenStreetMap tags, written key=value.
  osm: {
    core: ["shop=car_repair", "craft=car_repair"],
    adjacent: ["shop=tyres", "amenity=vehicle_inspection"],
  },
};

/** The tier for a provider's category code, or null when it isn't repair-related. */
export function categoryTierFor(provider: string, category: string | null | undefined): CategoryTier | null {
  if (!category) return null;
  const lists = TIERS[provider];
  if (!lists) return null;
  const c = category.trim().toLowerCase();
  if (lists.core.includes(c)) return "core";
  if (lists.adjacent.includes(c)) return "adjacent";
  return null;
}

/*
 * Automotive categories Overture uses that are deliberately NOT discovered,
 * because they are not general or mechanical repair: body and glass work,
 * cosmetic and accessory services, washing, towing, retail, trailers.
 * Handled conservatively: excluded, and counted on the import so an
 * operator can see them.
 */
export const OVERTURE_EXCLUDED_AUTOMOTIVE = [
  "auto_body_shop",
  "auto_detailing",
  "car_wash",
  "towing_service",
  "auto_customization",
  "auto_glass_service",
  "windshield_installation_and_repair",
  "car_window_tinting",
  "tire_shop",
  "auto_restoration_service",
  "auto_security",
  "auto_upholstery",
  "automotive_consultant",
  "trailer_repair",
  "wheel_and_rim_repair",
  "vehicle_wrap",
  "car_buyer",
  "car_stereo_installation",
  "automobile_registration_service",
] as const;

/** The branch of Overture's taxonomy every tiered category must sit in. */
const OVERTURE_AUTOMOTIVE = "automotive_service";

export type OvertureClass =
  | { tier: CategoryTier; category: string }
  | { tier: null; reason: "no_category" | "not_automotive" | "excluded_automotive" | "alternate_only"; category: string | null };

/**
 * Classifies an Overture place from its `taxonomy`. Only the PRIMARY
 * category decides the tier, and it must sit under automotive_service in
 * its hierarchy, so a same-named category elsewhere in the taxonomy can't
 * match. A place whose only repair category is an alternate (e.g. a gas
 * station that also lists automotive_repair) is not discovered: counted as
 * "alternate_only". Automotive categories not on either list are counted as
 * "excluded_automotive" and never discovered, including categories Overture
 * adds in future releases, until they are reviewed and listed here.
 */
export function overtureTier(
  taxonomy: { primary?: string | null; hierarchy?: readonly string[] | null; alternates?: readonly string[] | null } | null | undefined,
): OvertureClass {
  const primary = taxonomy?.primary?.trim().toLowerCase() || null;
  if (!primary) return { tier: null, reason: "no_category", category: null };
  const hierarchy = taxonomy?.hierarchy ?? [];
  const automotive = hierarchy.includes(OVERTURE_AUTOMOTIVE);
  const tier = automotive ? categoryTierFor("overture", primary) : null;
  if (tier) return { tier, category: primary };
  if (automotive) return { tier: null, reason: "excluded_automotive", category: primary };
  if ((taxonomy?.alternates ?? []).some((a) => categoryTierFor("overture", a))) {
    return { tier: null, reason: "alternate_only", category: primary };
  }
  return { tier: null, reason: "not_automotive", category: primary };
}

/** Category codes a provider maps into the given tiers (for import filters). */
export function categoriesFor(provider: string, tiers: readonly CategoryTier[]): string[] {
  const lists = TIERS[provider];
  if (!lists) return [];
  return tiers.flatMap((t) => lists[t]);
}

export const TIER_LABELS: Record<CategoryTier, string> = {
  core: "Core repair category",
  adjacent: "Adjacent category",
};
