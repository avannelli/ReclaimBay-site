import { normalizeDomain, normalizeName } from "./normalize.js";
import type { Identity } from "./protection.js";

export interface AccountSafety {
  code: "single_identity" | "shared_brand_locations" | "existing_account" | "shared_domain_unresolved";
  clear: boolean;
  candidateIds: string[];
  prospectIds: string[];
  reason: string;
}
/** Prospect is today's account/contact record, not a Location entity. Never elect an account by import order. */
export function accountSafety(c: Identity, candidates: readonly Identity[], prospects: readonly Identity[]): AccountSafety {
  const domain = normalizeDomain(c.website), name = normalizeName(c.businessName ?? "");
  const peers = candidates.filter(p => p.id !== c.id && domain && normalizeDomain(p.website) === domain);
  const accounts = prospects.filter(p => domain && normalizeDomain(p.website) === domain);
  const sameBrand = peers.filter(p => normalizeName(p.businessName ?? "") === name);
  const sorted = (rows: readonly Identity[]) => rows.map(r => r.id).sort();
  if (accounts.length || peers.some(p => p.prospectId)) return { code: "existing_account", clear: false, candidateIds: sorted(peers),
    prospectIds: [...new Set([...accounts.map(p => p.id), ...peers.flatMap(p => p.prospectId ? [p.prospectId] : [])])].sort(),
    reason: "This domain already has a Prospect/account. Review its existing account instead of creating another independent customer." };
  if (sameBrand.length) return { code: "shared_brand_locations", clear: false, candidateIds: sorted(sameBrand), prospectIds: [],
    reason: "Several candidate locations share a brand/domain. A human chooses one coordinated account; automation cannot select a location as a new independent customer." };
  if (peers.length) return { code: "shared_domain_unresolved", clear: false, candidateIds: sorted(peers), prospectIds: [],
    reason: "Different business identities share a domain. Website/account attribution must be resolved before autonomous prospecting." };
  return { code: "single_identity", clear: true, candidateIds: [], prospectIds: [], reason: "No other retained candidate or Prospect shares this account domain." };
}
