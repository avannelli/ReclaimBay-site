/*
 * Provider category -> provider-neutral tier. A DISCOVERY FILTER ONLY:
 * "core" means the provider calls it automotive repair (mechanical,
 * specialist or collision/body), "adjacent" means a related automotive
 * service worth a look. Neither establishes product fit; that is still a
 * researched, evidence-backed signal (src/scoring.ts).
 *
 * The lists come from the Ventura County bake-off and were re-checked
 * against Overture release 2026-09-23.1 (schema v2: `taxonomy`, no
 * `categories`). Anything unlisted has no tier and is not discovered.
 */
import { checkName, type CategoryResult, type CategoryRules, type OutOfScopeTerm } from "./categoryCheck.js";
import type { CategoryTier } from "./types.js";

const TIERS: Record<string, { core: readonly string[]; adjacent: readonly string[] }> = {
  // Overture places taxonomy (taxonomy.primary). Every one sits under
  // travel_and_transportation > vehicle_service > automotive_service; see
  // overtureTier() for the hierarchy check and the deliberate exclusions.
  overture: {
    core: [
      "automotive_repair",
      "auto_body_shop",
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
 * because they are not automotive repair: glass work, cosmetic and accessory
 * services, washing, towing, retail, trailers, tire-only shops.
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

/*
 * Category check rules for ReclaimBay: businesses that perform automotive
 * repair/service work (src/discovery/categoryCheck.ts runs them). Policy, c3:
 *   - in scope: general, mechanical, specialist (engine, transmission,
 *     brakes, electrical, diesel...) and collision/body repair;
 *   - names are leads only (provisional): an in-scope name is "unclear" until
 *     the business's own website or a person establishes its repair work;
 *   - out: glass, detailing, washing, towing, tint/wraps/audio/interlocks,
 *     sales, parts, rentals, driving schools, insurance, parking/storage,
 *     test-only smog, and other trades, unless the name also names repair;
 *   - a name alone can't prove tire-only, smog-only, RV or specialty paint
 *     work: those are "unclear" (weak), never wrong on the name alone.
 * "Auto", "automotive", "car", "vehicle" or "service" alone is not in-scope
 * evidence.
 */
const t = (label: string, pattern: RegExp) => ({ label, pattern });

export const AUTOMOTIVE_CATEGORY_RULES: CategoryRules = {
  id: "automotive@c3",
  target: "automotive repair/service",
  name: {
    provisional: true,
    inScope: [
      t("repair", /\brepairs?\b|\breparaci[oó]n\b/),
      t("a mechanic", /\bmechanics?\b|\bmechanical\b|\bmec[aá]nic[oa]s?\b|\btaller\b/),
      t("auto care", /\b(?:auto|car) ?care\b/),
      t("brakes", /\bbrakes?\b/),
      t("transmissions", /\btransmissions?\b/),
      t("engines", /\bengines?\b/),
      t("tune-ups", /\btune[- ]?ups?\b/),
      t("maintenance", /\bmaintenance\b/),
      t("diagnostics", /\bdiagnostics?\b/),
      t("mufflers and exhaust", /\bmufflers?\b|\bexhaust\b/),
      t("radiators", /\bradiators?\b/),
      t("collision repair", /\bcollision\b|\baccident repair\b/),
      t("auto body repair", /\bauto ?body\b|\bbody ?shop\b|\bbody (?:and|&) paint\b|\bpaint (?:and|&) body\b/),
    ],
    outOfScope: [
      { label: "a test-only smog station", pattern: /\btest[- ]only\b/, strength: "exclusive" },
      { label: "other trades", pattern: /\bgarage doors?\b|\byachts?\b|\bboats?\b|\bmarine\b|\bshoe repair\b/, strength: "exclusive" },
      { label: "auto glass", pattern: /\bglass\b|\bwindshields?\b/, strength: "strong" },
      { label: "detailing", pattern: /\bdetail\w*/, strength: "strong" },
      { label: "a car wash", pattern: /\bcar ?wash\b/, strength: "strong" },
      { label: "towing", pattern: /\btow(?:ing)?\b/, strength: "strong" },
      { label: "accessories", pattern: /\btint\w*|\bwraps?\b|\bstereos?\b|\bcar audio\b|\binterlocks?\b|\baccessor(?:y|ies)\b/, strength: "strong" },
      { label: "upholstery", pattern: /\bupholster\w*/, strength: "strong" },
      { label: "vehicle sales", pattern: /\bsales\b/, strength: "strong" },
      { label: "parts or equipment", pattern: /\bparts\b|\bsuppl(?:y|ies|iers?)\b|\bequipment\b/, strength: "strong" },
      { label: "rentals", pattern: /\brentals?\b|\brent[- ]a[- ]car\b/, strength: "strong" },
      { label: "a driving school", pattern: /\bdriving (?:school|academy)\b/, strength: "strong" },
      { label: "insurance", pattern: /\binsurance\b/, strength: "strong" },
      { label: "parking or storage", pattern: /\bparking\b|\bstorage\b/, strength: "strong" },
      { label: "a locksmith", pattern: /\blocksmith\w*/, strength: "strong" },
      { label: "tires", pattern: /\btires?\b|\btyres?\b/, strength: "weak" },
      { label: "wheels", pattern: /\bwheels?\b|\brims?\b/, strength: "weak" },
      { label: "smog or inspection", pattern: /\bsmog\b|\bemissions?\b|\binspections?\b/, strength: "weak" },
      { label: "RVs", pattern: /\brvs?\b/, strength: "weak" },
      { label: "specialty paint or restoration", pattern: /\bdents?\b|\bpaint\w*|\brestoration\b/, strength: "weak" },
    ],
  },
  website: {
    targetNoun: "automotive repair",
    vocabulary: [
      t("automotive repair", /\b(?:auto(?:motive)?|car|vehicle|truck) repairs?\b|\bmechanics?\b|\bmechanical\b|\bcollision\b|\bauto ?body\b|\bbody (?:repair|shop|work)\b/),
      t("repair services", /\bbrakes?\b|\bengines?\b|\btransmissions?\b|\bdiagnostics?\b|\boil changes?\b|\btune[- ]?ups?\b|\bsuspension\b|\bmufflers?\b|\bexhaust\b|\bradiators?\b|\bsmog repairs?\b/),
      t("Spanish", /\btaller\b|\bmec[aá]nic[oa]s?\b|\bfrenos\b|\breparaci[oó]n de autos\b/),
    ],
    otherTrades: [
      // Automotive businesses that aren't repair: never wrong while the site also uses repair vocabulary.
      t("auto glass", /\bauto glass\b|\bwindshields?\b/),
      t("detailing", /\bdetailing\b|\bceramic coatings?\b|\bpaint correction\b/),
      t("car washes", /\bcar ?wash(?:es)?\b/),
      t("towing", /\btowing\b|\btow trucks?\b|\broadside assistance\b/),
      t("window tint and wraps", /\bwindow tint(?:ing)?\b|\bvehicle wraps?\b|\bpaint protection film\b/),
      t("car audio", /\bcar audio\b|\bcar stereos?\b|\bremote starts?\b/),
      t("tires", /\btires?\b|\btyres?\b/),
      t("tire services", /\btire rotations?\b|\bflat (?:tire )?repairs?\b|\btpms\b|\bwheel balanc\w*/),
      t("wheels", /\brims?\b|\b(?:custom|alloy|aftermarket) wheels?\b|\bwheels? (?:and|&) tires?\b|\btires? (?:and|&) wheels?\b/),
      t("vehicle sales", /\b(?:new|used|pre-owned) (?:cars|vehicles|inventory)\b|\bauto sales\b/),
      t("auto parts", /\bauto parts\b|\bparts store\b/),
      t("vehicle rentals", /\bcar rentals?\b|\brent a car\b/),
      t("driving lessons", /\bdriving (?:school|lessons)\b/),
      t("insurance", /\binsurance (?:quotes?|agency|agents?|policies)\b/),
      t("smog testing", /\bsmog (?:checks?|tests?)\b|\bemissions? test(?:ing|s)?\b/),
      t("locksmiths", /\blocksmith\w*|\bkey (?:fob|programming|replacement)\b/),
      t("vehicle storage", /\b(?:vehicle|car|rv|boat) storage\b/),
      // Other trades entirely.
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

/**
 * What the name says the business is besides repair: the out-of-scope labels
 * ("tires", "auto glass") of a name that names no repair service. Empty when
 * the name also names repair, or names nothing outside the target.
 */
export function nameOutsideTerms(name: string): string[] {
  const has = (p: RegExp) => new RegExp(p.source, "i").test(name);
  if (CATEGORY_RULES.name.inScope.some((t) => has(t.pattern))) return [];
  return [...new Set((CATEGORY_RULES.name.outOfScope as readonly OutOfScopeTerm[]).filter((t) => has(t.pattern)).map((t) => t.label))];
}
