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
import { checkName, type CategoryResult, type CategoryRules } from "./categoryCheck.js";
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

/*
 * Category check rules for ReclaimBay: businesses that perform general
 * automotive repair (src/discovery/categoryCheck.ts runs them). Policy, v1:
 *   - tire shops are in when they also repair; a tire-only name is "unclear"
 *     (a name alone can't prove tire-only), never wrong on its own;
 *   - RV repair, heavy-truck-only repair, boats, and test-only smog stations
 *     are out; a name that also names autos or cars ("Auto & RV Care") is
 *     unclear instead, since it may serve both;
 *   - light-duty truck repair, smog + repair, and mobile mechanics are in;
 *   - body, glass, tint, wraps, detailing, washing, towing, upholstery,
 *     audio, ignition interlocks, sales, parts, and machine shops are out
 *     (the same kinds of business categories.ts already leaves out when the
 *     provider labels them correctly), unless the name also names repair.
 * "Auto" or "automotive" alone is not in-scope evidence: "Mario's Auto Body"
 * names no repair service.
 */
const t = (label: string, pattern: RegExp) => ({ label, pattern });

export const AUTOMOTIVE_CATEGORY_RULES: CategoryRules = {
  id: "automotive@c1",
  target: "general automotive repair",
  name: {
    inScope: [
      t("repair", /\brepairs?\b|\breparaci[oó]n\b/),
      t("service", /\bservices?\b/),
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
      t("alignment", /\balignments?\b/),
    ],
    outOfScope: [
      // Out even with "repair" -- unless the name also names autos or cars (then weak: unclear).
      { label: "RV repair", pattern: /^(?!.*\b(?:auto|car)s?\b).*\brvs?\b/, strength: "exclusive" },
      { label: "RV repair", pattern: /\brvs?\b/, strength: "weak" },
      { label: "heavy trucks", pattern: /^(?!.*\b(?:auto|car)s?\b).*(?:\bheavy[- ]?duty\b|\bsemi[- ]?trucks?\b|\bbig rigs?\b)/, strength: "exclusive" },
      { label: "heavy trucks", pattern: /\bheavy[- ]?duty\b|\bsemi[- ]?trucks?\b|\bbig rigs?\b/, strength: "weak" },
      { label: "a test-only smog station", pattern: /\btest[- ]only\b/, strength: "exclusive" },
      { label: "garage doors", pattern: /\bgarage doors?\b/, strength: "exclusive" },
      { label: "yachts", pattern: /\byachts?\b/, strength: "exclusive" },
      { label: "boats", pattern: /^(?!.*\b(?:auto|car)s?\b).*(?:\bboats?\b|\bmarine\b)/, strength: "exclusive" },
      { label: "boats", pattern: /\bboats?\b|\bmarine\b/, strength: "weak" },
      { label: "auto glass", pattern: /\bglass\b|\bwindshields?\b/, strength: "strong" },
      { label: "body work", pattern: /\b(?:auto)?body\b|\bdents?\b/, strength: "strong" },
      { label: "collision repair", pattern: /\bcollision\b/, strength: "strong" },
      { label: "paint", pattern: /\bpaint\w*/, strength: "strong" },
      { label: "window tint", pattern: /\btint\w*/, strength: "strong" },
      { label: "vehicle wraps", pattern: /\bwraps?\b/, strength: "strong" },
      { label: "detailing", pattern: /\bdetail\w*/, strength: "strong" },
      { label: "a car wash", pattern: /\bcar ?wash\b/, strength: "strong" },
      { label: "towing", pattern: /\btow(?:ing)?\b/, strength: "strong" },
      { label: "upholstery", pattern: /\bupholster\w*/, strength: "strong" },
      { label: "ignition interlocks", pattern: /\binterlocks?\b/, strength: "strong" },
      { label: "car audio", pattern: /\bstereos?\b|\bcar audio\b/, strength: "strong" },
      { label: "vehicle sales", pattern: /\bsales\b/, strength: "strong" },
      { label: "parts", pattern: /\bparts\b/, strength: "strong" },
      { label: "a machine shop", pattern: /\bmachine shops?\b|\bmachining\b/, strength: "strong" },
      { label: "carburetors", pattern: /\bcarburet\w*/, strength: "strong" },
      { label: "tires", pattern: /\btires?\b|\btyres?\b/, strength: "weak" },
      { label: "wheels", pattern: /\bwheels?\b|\brims?\b/, strength: "weak" },
    ],
  },
  website: {
    targetNoun: "automotive",
    vocabulary: [
      t("vehicles", /\bauto(?:s|motive|mobiles?)?\b|\bcars?\b|\bvehicles?\b|\btrucks?\b|\bsuvs?\b/),
      t("repair work", /\bmechanics?\b|\bbrakes?\b|\bengines?\b|\btransmissions?\b|\boil changes?\b|\btune[- ]?ups?\b|\bsmog\b|\btires?\b|\bmufflers?\b|\bradiators?\b/),
      t("Spanish", /\btaller\b|\bmec[aá]nic[oa]s?\b|\bfrenos\b|\bveh[ií]culos?\b|\bcarros?\b|\bcoches?\b|\bllantas\b|\bautom[oó]vil(?:es)?\b/),
    ],
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

/** The rules of the vertical this deployment serves. */
export const CATEGORY_RULES = AUTOMOTIVE_CATEGORY_RULES;

/** The name-stage category check for a candidate. */
export const nameCategory = (c: { businessName: string; category?: string | null; categoryTier?: string | null }): CategoryResult =>
  checkName(CATEGORY_RULES, { name: c.businessName, providerCategory: c.category ?? null, providerTier: c.categoryTier ?? null });
