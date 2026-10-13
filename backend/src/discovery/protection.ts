import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { relate } from "./dedupe.js";
import { locationKey, normalizeDomain, normalizeName, phoneKey, streetKey } from "./normalize.js";

type Reader = Db | Prisma.TransactionClient;
export interface Identity {
  id: string; businessName: string | null; website: string | null; city: string | null; state: string | null;
  phone: string | null; email?: string | null; providerPhone?: string | null; streetAddress?: string | null;
  latitude?: number | null; longitude?: number | null; provider?: string; externalId?: string | null;
  prospectId?: string | null; possibleDuplicateCandidateId?: string | null; possibleDuplicateProspectId?: string | null;
  relatedCandidateId?: string | null; relatedProspectId?: string | null;
}
export const identityKeys = (c: Identity) => ({
  provider: c.provider ?? "", externalId: c.externalId ?? null, domainKey: normalizeDomain(c.website),
  nameKey: normalizeName(c.businessName ?? ""), locationKey: locationKey(c.city, c.state),
  phoneKey: phoneKey(c.phone) ?? phoneKey(c.providerPhone), streetKey: streetKey(c.streetAddress),
  latitude: c.latitude ?? null, longitude: c.longitude ?? null,
});
const emailKey = (s?: string | null) => s?.trim().toLowerCase() || null;

/** Includes indirect identities: every message's replies, invitations and campaign memberships
 * are protected through its prospect/recipient. No outreach module is imported or mutated. */
export async function protectionIndex(db: Reader) {
  const candidates = await db.discoveryCandidate.findMany();
  const prospects = await db.prospect.findMany({ select: { id: true, businessName: true, website: true, city: true, state: true, phone: true, email: true } });
  const messages = await db.outreach.findMany({ select: { id: true, prospectId: true, recipientEmail: true } });
  const suppressions = await db.emailSuppression.findMany({ select: { id: true, email: true, outreachId: true } });
  const optOuts = await db.emailedUnsubscribeReview.findMany({ select: { senderEmail: true } });
  return { candidates, prospects, messages, suppressions, optOuts };
}
export type ProtectionIndex = Awaited<ReturnType<typeof protectionIndex>>;
export function candidateProtection(c: Identity, index: ProtectionIndex) {
  const ids = new Set([c.prospectId, c.possibleDuplicateProspectId, c.relatedProspectId].filter((x): x is string => !!x));
  const keys = identityKeys(c);
  const matches = index.prospects.flatMap(p => {
    const match = relate(keys, { ...identityKeys(p), id: p.id, kind: "prospect" });
    if (match || (emailKey(c.email) && emailKey(c.email) === emailKey(p.email))) ids.add(p.id);
    return match ? [{ id: p.id, ...match }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
  for (const other of index.candidates) {
    if (!other.prospectId || other.id === c.id) continue;
    if ([c.possibleDuplicateCandidateId, c.relatedCandidateId].includes(other.id) ||
      [other.possibleDuplicateCandidateId, other.relatedCandidateId].includes(c.id) ||
      relate(keys, { ...identityKeys(other), id: other.id, kind: "candidate" })) ids.add(other.prospectId);
  }
  const visited = new Set<string>();
  const pending = [c.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const record = index.candidates.find(row => row.id === id);
    if (!record) continue;
    for (const prospectId of [record.prospectId, record.possibleDuplicateProspectId, record.relatedProspectId]) if (prospectId) ids.add(prospectId);
    for (const target of [record.possibleDuplicateCandidateId, record.relatedCandidateId]) if (target) pending.push(target);
    for (const other of index.candidates) if ([other.possibleDuplicateCandidateId, other.relatedCandidateId].includes(id)) pending.push(other.id);
  }
  const chain = new Set([c.id]);
  let target = c.possibleDuplicateCandidateId;
  let duplicateTargetConflict: string | null = null;
  while (target) {
    if (chain.has(target)) { duplicateTargetConflict = "Duplicate candidate links form a cycle."; break; }
    chain.add(target);
    const record = index.candidates.find(row => row.id === target);
    if (!record) { duplicateTargetConflict = "The original duplicate target no longer exists."; break; }
    target = record.possibleDuplicateCandidateId;
  }
  const messages = index.messages.filter(m => ids.has(m.prospectId) || (emailKey(c.email) && emailKey(c.email) === emailKey(m.recipientEmail)));
  for (const message of messages) ids.add(message.prospectId);
  const emails = new Set([c.email, ...index.prospects.filter(p => ids.has(p.id)).map(p => p.email), ...messages.map(m => m.recipientEmail)].map(emailKey).filter((e): e is string => !!e));
  const suppression = index.suppressions.some(s => emails.has(emailKey(s.email) ?? "") || messages.some(m => s.outreachId === m.id));
  const optOut = index.optOuts.some(o => emails.has(emailKey(o.senderEmail) ?? ""));
  return { protected: ids.size > 0 || suppression || optOut, prospectIds: [...ids].sort(), outreachIds: messages.map(m => m.id).sort(), suppression, optOut, matches, duplicateTargetConflict };
}
