/*
 * What an operator needs to decide in one glance: what the business does
 * (business type), whether that is ReclaimBay's market (target fit), and why,
 * in one sentence. Pure presentation over what is already recorded: the
 * category check, qualification (scoring.ts), and sourced evidence. Nothing
 * here is stored, changes a status, or affects the opportunity score, and it
 * never turns missing evidence into a positive.
 *
 *   qualified           automotive repair fit is verified with a source
 *   not_qualified       outside the target category, or sourced evidence of no repair work
 *   needs_verification  anything else: a person or research still has to establish it
 */
import { normalizeDomain, isOnBusinessSite } from "./normalize.js";
import { REPAIR_SERVICES, namedServices, repairFit } from "../research/repairFit.js";
import { FIT_CRITERION, type Qualification } from "../scoring.js";

export type TargetFit = "qualified" | "not_qualified" | "needs_verification";

export const TARGET_FIT_LABELS: Record<TargetFit, string> = {
  qualified: "Qualified",
  not_qualified: "Not qualified",
  needs_verification: "Needs verification",
};

export const BUSINESS_TYPES = [
  "General Automotive Repair",
  "Collision / Body Repair",
  "Hybrid / Multi-Service",
  "Mechanical Specialty",
  "Automotive Electrical / Diagnostic",
  "Transmission / Drivetrain",
  "Diesel",
  "Dealership Service",
  "Fleet Service",
  "Oil Change / Maintenance",
  "Tire Service",
  "Glass",
  "Detailing / Wash",
  "Towing",
  "Vehicle Sales",
  "Parts / Accessories",
  "Inspection / Smog",
  "Other",
] as const;
export type BusinessTypeLabel = (typeof BUSINESS_TYPES)[number];

export interface BusinessType {
  label: BusinessTypeLabel;
  /** Where it comes from: sourced repair evidence, or only the name or provider category (a lead). */
  from: "evidence" | "name" | "provider" | null;
  /** The verified repair services, when from evidence. */
  services: string[];
}

export interface FitInput {
  businessName: string;
  website: string | null;
  providerCategory?: string | null;
  signals: readonly { key: string; value: string }[];
  evidence: readonly { signalKey: string; sourceUrl?: string; excerpt?: string }[];
  categoryVerdict: string | null;
  categorySource?: string | null;
  categoryReason: string | null;
  qualification: Qualification;
}

const yes = (c: FitInput, key: string) => c.signals.some((s) => s.key === key && s.value === "yes");
const MECHANICAL = new Set(REPAIR_SERVICES.filter(([label, kind]) => kind === "repair" && label !== "collision/body").map(([label]) => label));

/** Services named by the sourced evidence behind repair fit: research's "Names …:" summary, or the quote itself. */
function verifiedServices(c: FitInput): string[] {
  const out = new Set<string>();
  for (const e of c.evidence) {
    if (!e.excerpt) continue;
    if (e.signalKey === FIT_CRITERION && yes(c, FIT_CRITERION)) {
      const named = namedServices(e.excerpt);
      const found = named.length ? named : repairFit(c.businessName, [{ url: e.sourceUrl ?? "", role: "services", parsed: { text: e.excerpt } }]).services;
      found.forEach((s) => out.add(s));
    }
    if (e.signalKey === "collision_repair_services" && yes(c, "collision_repair_services")) out.add("collision/body");
  }
  if (yes(c, "collision_repair_services")) out.add("collision/body");
  return [...new Set(REPAIR_SERVICES.map(([label]) => label))].filter((l) => out.has(l));
}

/** Mechanical work a body shop does as part of accident repair: it doesn't make a body shop a hybrid. */
const COLLISION_ADJACENT = new Set(["general repair", "suspension/steering", "A/C", "cooling system", "electrical"]);

/** A name says "vehicle" only with a vehicle word: "Surfboard Repair" or "Smith Diagnostics" says nothing automotive. */
const AUTO_WORD = /\b(?:auto(?:s|motive)?|cars?|vehicles?|trucks?|motors?)\b/i;
const NAME_TYPES: [RegExp, BusinessTypeLabel, RegExp?][] = [
  // [pattern, label, and a vehicle word the name must also have when the pattern alone isn't automotive]
  [/\btest[- ]only\b|\bsmog\b|\bemissions?\b/i, "Inspection / Smog"],
  [/\binspections?\b/i, "Inspection / Smog", AUTO_WORD],
  [/\bdealership\b/i, "Dealership Service"],
  [/\bfleet\b/i, "Fleet Service"],
  [/\bcollision\b|\bauto ?body\b|\bbody (?:and|&) paint\b|\bpaint (?:and|&) body\b/i, "Collision / Body Repair"],
  [/\bbody ?shop\b/i, "Collision / Body Repair", AUTO_WORD],
  [/\btransmissions?\b|\bdrive ?(?:train|line)\b/i, "Transmission / Drivetrain"],
  [/\bdiesel\b/i, "Diesel"],
  [/\bauto(?:motive)? electric\w*|\b(?:auto(?:motive)?|car|vehicle|engine)\s+diagnostics?\b/i, "Automotive Electrical / Diagnostic"],
  [/\bbrakes?\b|\bmufflers?\b|\bradiators?\b/i, "Mechanical Specialty"],
  [/\bexhaust\b|\bengines?\b/i, "Mechanical Specialty", AUTO_WORD],
  [/\bmechanics?\b|\bmechanical\b|\b(?:auto|car) ?care\b|\btaller\b/i, "General Automotive Repair"],
  [/\brepairs?\b/i, "General Automotive Repair", AUTO_WORD],
  [/\boil change\b|\blube\b|\btune[- ]?ups?\b/i, "Oil Change / Maintenance"],
  [/\btires?\b|\btyres?\b|\bwheels?\b/i, "Tire Service"],
  [/\bglass\b|\bwindshields?\b/i, "Glass"],
  [/\bdetail\w*|\bcar ?wash\b/i, "Detailing / Wash"],
  [/\btow(?:ing)?\b/i, "Towing"],
  [/\bsales\b/i, "Vehicle Sales"],
  [/\bparts\b|\btint\w*|\bwraps?\b|\bstereos?\b|\bcar audio\b|\baccessor(?:y|ies)\b/i, "Parts / Accessories"],
];

const PROVIDER_TYPES: Record<string, BusinessTypeLabel> = {
  automotive_repair: "General Automotive Repair",
  "shop=car_repair": "General Automotive Repair",
  "craft=car_repair": "General Automotive Repair",
  auto_body_shop: "Collision / Body Repair",
  brake_service_and_repair: "Mechanical Specialty",
  engine_repair_service: "Mechanical Specialty",
  exhaust_and_muffler_repair: "Mechanical Specialty",
  transmission_repair: "Transmission / Drivetrain",
  auto_electrical_repair: "Automotive Electrical / Diagnostic",
  truck_repair: "Diesel",
  oil_change_station: "Oil Change / Maintenance",
  tire_dealer_and_repair: "Tire Service",
  "shop=tyres": "Tire Service",
  emissions_inspection: "Inspection / Smog",
  car_inspection: "Inspection / Smog",
  "amenity=vehicle_inspection": "Inspection / Smog",
};

/** What the business does: from sourced repair evidence when there is some, otherwise a lead from its name or provider category. */
export function businessTypeOf(c: FitInput): BusinessType {
  const services = verifiedServices(c);
  // Research's dealership evidence (independent shop: No) labels a vehicle dealer; never a business outside the target.
  const dealer = c.categoryVerdict !== "wrong_category" && c.evidence.some((e) => e.signalKey === "independent_shop" && /^Dealership\b/.test(e.excerpt ?? ""));
  if (services.length) {
    const collision = services.includes("collision/body");
    const mechanical = services.filter((s) => MECHANICAL.has(s));
    const has = (...labels: string[]) => labels.some((l) => services.includes(l));
    const label: BusinessTypeLabel = dealer
      ? "Dealership Service"
      : /\bfleet\b/i.test(c.businessName)
        ? "Fleet Service"
        : collision && mechanical.some((s) => !COLLISION_ADJACENT.has(s))
          ? "Hybrid / Multi-Service"
          : collision
            ? "Collision / Body Repair"
            : has("general repair") || mechanical.length >= 3
              ? "General Automotive Repair"
              : has("diesel")
                ? "Diesel"
                : has("transmission/drivetrain")
                  ? "Transmission / Drivetrain"
                  : mechanical.length && mechanical.every((s) => s === "diagnostics" || s === "electrical")
                    ? "Automotive Electrical / Diagnostic"
                    : mechanical.length
                      ? "Mechanical Specialty"
                      : has("maintenance")
                        ? "Oil Change / Maintenance"
                        : "Other";
    return { label, from: "evidence", services };
  }
  if (dealer) return { label: "Dealership Service", from: "evidence", services: [] };
  const byName = NAME_TYPES.find(([re, , needs]) => re.test(c.businessName) && (!needs || needs.test(c.businessName)));
  if (byName) return { label: byName[1], from: "name", services: [] };
  const byProvider = c.providerCategory ? PROVIDER_TYPES[c.providerCategory.trim().toLowerCase()] : undefined;
  if (byProvider) return { label: byProvider, from: "provider", services: [] };
  return { label: "Other", from: null, services: [] };
}

const list = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** Where the evidence for fit came from, in words. */
function where(c: FitInput): string {
  const sources = c.evidence.filter((e) => (e.signalKey === FIT_CRITERION || e.signalKey === "collision_repair_services") && e.sourceUrl).map((e) => e.sourceUrl!);
  return normalizeDomain(c.website) && sources.length && sources.every((u) => isOnBusinessSite(u, c.website)) ? " on the business's own website" : " with a public source";
}

const QUALIFIED_WHAT: Partial<Record<BusinessTypeLabel, string>> = {
  "General Automotive Repair": "General automotive repair verified",
  "Collision / Body Repair": "Collision and body repair services verified",
  "Hybrid / Multi-Service": "Mechanical and collision/body repair verified",
  "Mechanical Specialty": "Specialty mechanical repair verified",
  "Automotive Electrical / Diagnostic": "Automotive electrical and diagnostic repair verified",
  "Transmission / Drivetrain": "Transmission and drivetrain repair verified",
  Diesel: "Diesel repair verified",
  "Dealership Service": "Dealership service repair verified",
  "Fleet Service": "Fleet repair service verified",
  "Oil Change / Maintenance": "Maintenance service verified",
};

/** Qualified, not qualified, or needs verification, with the reason in one sentence. */
export function targetFit(c: FitInput, type: BusinessType = businessTypeOf(c)): { fit: TargetFit; why: string } {
  const reason = (s: string | null) => (s ? `${s.replace(/\.$/, "")}.` : null);
  if (c.categoryVerdict === "wrong_category") {
    return { fit: "not_qualified", why: reason(c.categoryReason) ?? "The category check says this isn't an automotive repair business." };
  }
  if (c.qualification === "disqualified") {
    return { fit: "not_qualified", why: "Sourced evidence says this business performs no automotive repair." };
  }
  if (c.qualification === "meets_criteria") {
    const services = type.services.filter((s) => s !== "collision/body" && s !== "general repair");
    const what = (type.from === "evidence" && QUALIFIED_WHAT[type.label]) || "Automotive repair verified";
    return { fit: "qualified", why: `${what}${where(c)}${services.length ? ` (${list(services)})` : ""}.` };
  }
  if (c.categoryVerdict === "unclear" && c.categorySource === "website" && c.categoryReason) return { fit: "needs_verification", why: reason(c.categoryReason)! };
  if (type.from === "name" || type.from === "provider") {
    return {
      fit: "needs_verification",
      why: `${type.label} indicated by the ${type.from === "name" ? "business name" : "provider category"}, but its automotive repair work has not been verified.`,
    };
  }
  return { fit: "needs_verification", why: "Automotive business identified, but available evidence does not establish whether it performs repair work." };
}
