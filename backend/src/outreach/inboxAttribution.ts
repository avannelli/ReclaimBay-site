import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { ATTEMPTED_STATUSES, normalizeEmail } from "./lifecycle.js";

/** Provider evidence collected outside transactions; no bodies, URLs or tokens. */
export interface InboxEvidence {
  kind: "reply" | "bounce";
  fromEmail: string | null;
  receivedAt: Date | null;
  threadMessageIds: string[];
  markerOutreachIds: string[];
  relatedProviderMessageIds: string[];
  recipientEmails: string[];
  invalidEvidence: boolean;
  selectedIdentity?: { id: string; prospectId: string; recipientEmail: string; providerMessageId: string | null };
}

export interface InboxAttribution {
  status: "matched" | "unmatched" | "unresolved" | "ambiguous";
  outreachId: string | null;
  candidateOutreachIds: string[];
  reason: "unique_identity" | "no_candidate" | "invalid_identity" | "missing_time" | "conflicting_identity" | "multiple_identities" | "insufficient_identity" | "invalid_send_time" | "changed_candidate";
  identity?: InboxEvidence["selectedIdentity"];
}

/** Re-run under the send gate immediately before recording. Never chooses by age/score. */
export async function resolveInboxAttribution(db: Db | Prisma.TransactionClient, evidence: InboxEvidence): Promise<InboxAttribution> {
  const addresses = evidence.kind === "reply" ? (evidence.fromEmail ? [evidence.fromEmail] : []) : evidence.recipientEmails;
  const participants = [...new Set([...addresses, ...(evidence.fromEmail ? [evidence.fromEmail] : [])])];
  const providerIds = [...new Set([...evidence.threadMessageIds, ...evidence.relatedProviderMessageIds])];
  const or: Prisma.OutreachWhereInput[] = [];
  if (providerIds.length) or.push({ providerMessageId: { in: providerIds } });
  if (evidence.markerOutreachIds.length) or.push({ id: { in: evidence.markerOutreachIds } });
  if (participants.length && evidence.receivedAt) or.push({ recipientEmail: { in: participants, mode: "insensitive" }, status: { in: [...ATTEMPTED_STATUSES] }, sentAt: { not: null, lte: evidence.receivedAt } });
  const candidates = or.length ? await db.outreach.findMany({ where: { OR: or }, orderBy: { id: "asc" }, select: { id: true, prospectId: true, recipientEmail: true, providerMessageId: true, sentAt: true, status: true } }) : [];
  const answer = (status: InboxAttribution["status"], reason: InboxAttribution["reason"], outreachId: string | null = null): InboxAttribution => ({ status, reason, outreachId, candidateOutreachIds: candidates.map((o) => o.id) });
  if (evidence.invalidEvidence || !evidence.fromEmail) return answer("unresolved", "invalid_identity");
  if (!candidates.length) return answer("unmatched", "no_candidate");
  if (!evidence.receivedAt) return answer("unresolved", "missing_time");
  const marked = candidates.filter((o) => evidence.markerOutreachIds.includes(o.id));
  const referenced = candidates.filter((o) => o.providerMessageId && evidence.relatedProviderMessageIds.includes(o.providerMessageId));
  const threaded = candidates.filter((o) => o.providerMessageId && evidence.threadMessageIds.includes(o.providerMessageId));
  const addressed = candidates.filter((o) => addresses.includes(normalizeEmail(o.recipientEmail)));
  if (evidence.markerOutreachIds.length > 1 || referenced.length > 1 || (evidence.kind === "bounce" && evidence.recipientEmails.length > 1)) return answer("ambiguous", "multiple_identities");
  if (evidence.markerOutreachIds.length && marked.length !== 1) return answer("unresolved", "conflicting_identity");
  if (marked.length && referenced.length && marked[0]!.id !== referenced[0]!.id) return answer("unresolved", "conflicting_identity");
  const direct = marked.length ? marked : referenced;
  if (!direct.length && addressed.length > 1) return answer("ambiguous", "multiple_identities");
  let supported = direct.length ? direct : addressed;
  // A verified RFC parent can be the operator's manual Gmail response. Its
  // provider identity plus a unique outbound in that conversation supports a
  // delegated reply; a bare conversation ID never does.
  if (!supported.length && evidence.kind === "reply" && threaded.length === 1 && evidence.relatedProviderMessageIds.some((id) => evidence.threadMessageIds.includes(id))) supported = threaded;
  if (!supported.length) return answer("unresolved", "insufficient_identity");
  if (direct.length && addressed.length) {
    // Known sender/DSN identity must agree with the direct message's prospect.
    // A different address with no known competing prospect can still be a delegate.
    const owners = new Set(addressed.map((o) => o.prospectId));
    supported = supported.filter((o) => evidence.kind === "bounce" ? addressed.some((a) => a.id === o.id) : owners.has(o.prospectId));
    if (!supported.length) return answer("unresolved", "conflicting_identity");
  }
  if (evidence.kind === "bounce" && evidence.recipientEmails.length && !addressed.length) return answer("unresolved", "conflicting_identity");
  if (threaded.length) {
    supported = supported.filter((o) => threaded.some((t) => t.id === o.id));
    if (!supported.length) return answer("unresolved", "conflicting_identity");
  }
  if (supported.length !== 1) return answer("ambiguous", "multiple_identities");
  const [only] = supported;
  if (evidence.kind === "bounce" && candidates.some((o) => normalizeEmail(o.recipientEmail) === evidence.fromEmail && o.prospectId !== only!.prospectId)) return answer("unresolved", "conflicting_identity");
  if (!only!.sentAt || !ATTEMPTED_STATUSES.includes(only!.status) || only!.sentAt > evidence.receivedAt) return answer("unresolved", "invalid_send_time");
  const expected = evidence.selectedIdentity;
  if (expected && (only!.id !== expected.id || only!.prospectId !== expected.prospectId || normalizeEmail(only!.recipientEmail) !== expected.recipientEmail || only!.providerMessageId !== expected.providerMessageId)) return answer("unresolved", "changed_candidate");
  return { ...answer("matched", "unique_identity", only!.id), identity: { id: only!.id, prospectId: only!.prospectId, recipientEmail: normalizeEmail(only!.recipientEmail), providerMessageId: only!.providerMessageId } };
}
