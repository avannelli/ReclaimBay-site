/*
 * Provider category -> provider-neutral tier. A DISCOVERY FILTER ONLY:
 * "core" means the provider calls it automotive body repair, "adjacent"
 * means a related automotive service worth a look. Neither establishes
 * collision/body product fit; that is still a researched, evidence-backed
 * signal (src/scoring.ts).
 *
 * The lists come from the Ventura County bake-off and were re-checked
 * against Overture release 2026-09-23.1 (schema v2: `taxonomy`, no
 * `categories`). Anything unlisted has no tier and is not discovered.
 */
import { checkName, type CategoryResult, type CategoryRules } from "./categoryCheck.js";
import type { CategoryTier } from "./types.js";

const TIERS: Record<string, { core: readonly string[]; adjacent: readonly string[] }> = {
  // Overture places taxonomy (taxonomy.primary). Every one sits under
  // travel_and_transportation > vehicle_service > automotive_service; see
  // overtureTier() for the hierarchy check and the deliberate exclusions.
  overture: {
    core: [
      "auto_body_shop",
    ],
    adjacent: [
      "automotive_repair",
      "brake_service_and_repair",
      "engine_repair_service",
      "transmission_repair",
      "exhaust_and_muffler_repair",
      "auto_electrical_repair",
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
    core: [], // No OSM discovery provider is registered; no unverified body-category alias.
    adjacent: ["shop=car_repair", "craft=car_repair", "shop=tyres", "amenity=vehicle_inspection"],
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
 * because they do not establish collision/body repair: glass work,
 * cosmetic and accessory services, washing, towing, retail, trailers.
 * Handled conservatively: excluded, and counted on the import so an
 * operator can see them.
 */
export const OVERTURE_EXCLUDED_AUTOMOTIVE = [
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

/* Collision/body ICP. Names are leads; only sourced repair evidence establishes fit. */
const t = (label: string, pattern: RegExp) => ({ label, pattern });

export const AUTOMOTIVE_CATEGORY_RULES: CategoryRules = {
  id: "collision@c2",
  target: "automotive collision/body repair",
  name: {
    provisional: true,
    inScope: [
      t("collision repair", /\bcollision\b|\baccident repair\b/),
      t("auto body repair", /\bauto ?body\b|\bbody ?shop\b/),
    ],
    outOfScope: [
      { label: "glass", pattern: /\bglass\b|\bwindshields?\b/, strength: "strong" },
      { label: "tires", pattern: /\btires?\b|\btyres?\b/, strength: "strong" },
      { label: "detailing", pattern: /\bdetail\w*/, strength: "strong" },
      { label: "washing", pattern: /\bcar ?wash\b/, strength: "strong" },
      { label: "towing", pattern: /\btow(?:ing)?\b/, strength: "strong" },
      { label: "accessories", pattern: /\btint\w*|\bwraps?\b|\bstereos?\b|\bcar audio\b|\binterlocks?\b/, strength: "strong" },
      { label: "other trades", pattern: /\bgarage doors?\b|\byachts?\b|\bboats?\b|\bshoe repair\b/, strength: "exclusive" },
      { label: "parts or equipment", pattern: /\bparts\b|\bsuppl(?:y|ies|iers?)\b|\bequipment\b/, strength: "strong" },
      { label: "specialty repair", pattern: /\bdents?\b|\bpaint\w*|\brestoration\b|\bstructural\b/, strength: "weak" },
    ],
  },
  website: {
    targetNoun: "collision/body",
    vocabulary: [t("collision/body context", /\bcollision\b|\baccident\b|\bauto ?body\b|\bbody repair\b|\bvehicle.*structural repair\b/)],
    otherTrades: [
      t("shoe repair", /\bshoes?\b|\bcobbler/),
      t("boot repair", /\bboots?\b/),
      t("vacuum repair", /\bvacuums?\b/),
      t("lamp repair", /\blamps?\b/),
      t("sharpening", /\bsharpening\b/),
      t("luggage repair", /\bluggage\b/),
      t("sewing machines", /\bsewing\b/),
      t("handbags", /\bpurses?\b|\bhandbags?\b/),
      t("jewelry", /\bjewel(?:le)?ry\b/),
      t("watch repair", /\bwatch(?:es)? repair\b/),
      t("appliances", /\bappliances?\b/),
      t("garage doors", /\bgarage doors?\b/),
      t("heating and plumbing", /\bhvac\b|\bfurnaces?\b|\bplumb(?:ing|ers?)\b/),
      t("roofing", /\broofing\b/),
      t("solar", /\bsolar\b/),
      t("boats", /\byachts?\b|\bboats?\b/),
      t("computer and phone repair", /\bcomputer repair\b|\blaptops?\b|\bphone repair\b/),
    ],
    minOtherTrades: 2,
    minReadableChars: 500,
  },
};

export const CATEGORY_RULES = AUTOMOTIVE_CATEGORY_RULES;
export const nameCategory = (c: { businessName: string; category?: string | null; categoryTier?: string | null }): CategoryResult =>
  checkName(CATEGORY_RULES, { name: c.businessName, providerCategory: c.category ?? null, providerTier: c.categoryTier ?? null });
