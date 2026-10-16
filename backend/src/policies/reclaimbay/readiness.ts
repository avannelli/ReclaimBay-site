/**
 * ReclaimBay's initial ICP for "Ready to approve" (research r16, automation discovery@d2).
 * Policy constants only: the rules that apply them live in research/serviceEvidence.ts,
 * research/location.ts, discovery/relationships.ts and discovery/readiness.ts.
 * Widening the ICP (e.g. to chains) is a change here, not to the evidence rules.
 */

/** How the business is owned, as research classifies it from the business's own website. */
export const OWNERSHIP_CLASSES = ["independent", "regional", "unknown", "chain", "dealership", "possible_dealership", "manufacturer"] as const;
export type OwnershipClass = (typeof OWNERSHIP_CLASSES)[number];

/** Ownership classes that may reach Ready. Unknown independence is a warning, never a rejection. */
export const READY_OWNERSHIP: readonly OwnershipClass[] = ["independent", "regional", "unknown"];

/** A brand with more locations than this on its own website is a chain for the initial ICP. */
export const REGIONAL_MAX_LOCATIONS = 5;

/** Manufacturers that operate their own service and collision centers (held for a person, never auto-rejected). */
export const MANUFACTURER_BRANDS = ["tesla", "rivian", "lucid", "polestar"] as const;

export const OWNERSHIP_LABELS: Record<OwnershipClass, string> = {
  independent: "Independent (stated on its website)",
  regional: `Regional brand (2 to ${REGIONAL_MAX_LOCATIONS} locations)`,
  unknown: "Ownership not stated",
  chain: "Chain or franchise",
  dealership: "Dealership service department",
  possible_dealership: "Possible dealership activity",
  manufacturer: "Manufacturer-owned",
};
