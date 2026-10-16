import { MANUFACTURER_BRANDS, REGIONAL_MAX_LOCATIONS, type OwnershipClass } from "../policies/reclaimbay/readiness.js";

/*
 * Ownership class (research r16), from what the business's own website shows. Which
 * classes may reach Ready is policy (policies/reclaimbay/readiness.ts READY_OWNERSHIP).
 * Unknown independence is "unknown": a warning, never a rejection.
 */
export function classifyOwnership(input: {
  businessName: string;
  siteHost: string;
  /** The site's name, title and top headings. */
  labels: readonly (string | null | undefined)[];
  /** A chain or franchise brand appears on the site itself. */
  chainOnSite: boolean;
  dealerActivity: boolean;
  statesIndependent: boolean;
  siteLocations: number;
}): { ownership: OwnershipClass; reason: string } {
  // A specialist mentioning a make is not manufacturer-owned. Use the manufacturer's actual host.
  const maker = MANUFACTURER_BRANDS.find((b) => input.siteHost.toLowerCase() === `${b}.com` || input.siteHost.toLowerCase().endsWith(`.${b}.com`));
  if (maker) return { ownership: "manufacturer", reason: `A ${maker} manufacturer-operated location.` };
  if (input.dealerActivity && !input.statesIndependent) return { ownership: "dealership", reason: "The site shows dealership activity." };
  if (input.dealerActivity) return { ownership: "possible_dealership", reason: "The site states it is independent but also shows dealership activity." };
  if (input.chainOnSite) return { ownership: "chain", reason: "A franchise or chain brand appears on the site." };
  if (input.siteLocations > REGIONAL_MAX_LOCATIONS) return { ownership: "chain", reason: `The site lists ${input.siteLocations} locations (more than ${REGIONAL_MAX_LOCATIONS}).` };
  if (input.siteLocations >= 2) return { ownership: "regional", reason: `A regional brand: the site lists ${input.siteLocations} locations.` };
  if (input.statesIndependent) return { ownership: "independent", reason: "The site states the business is independent." };
  return { ownership: "unknown", reason: "The site does not state who owns the business." };
}
