import type { Db } from "../db.js";
import type { Outreach } from "../generated/prisma/client.js";
import { ProspectError } from "../prospects.js";
import { ATTEMPTED_STATUSES } from "./lifecycle.js";
import { lockOutreach, lockSendGate, logOutreachEvent } from "./records.js";
import { recordSentInTx } from "./service.js";
import type { OutreachSender, SentMessageLookup } from "./sender.js";

export type ReconciliationResult = "reconciled" | "already_recorded" | "not_found" | "ambiguous" | "unavailable" | "ineligible";

/** A claimed queue, or a manual confirmation still missing its provider identity. */
export function canReconcileSent(o: Pick<Outreach, "sendStartedAt" | "senderEmail" | "provider" | "status" | "providerMessageId">): boolean {
  return o.sendStartedAt !== null && o.senderEmail !== null &&
    (o.provider === null || o.provider === "gmail") &&
    (o.status === "queued" || (ATTEMPTED_STATUSES.includes(o.status) && o.providerMessageId === null));
}

/**
 * Reconcile an existing Gmail send, even with sending OFF. Provider reads are
 * outside the gate; the locked re-read wins over the earlier snapshot. Never
 * sends, requeues, or reopens a cancelled/failed message. Revocation after a
 * claim does not erase a historical send (the dispatcher has the same rule).
 */
export async function reconcileSent(db: Db, id: string, sender: OutreachSender, now = new Date()): Promise<ReconciliationResult> {
  const snapshot = await db.outreach.findUnique({ where: { id } });
  if (!snapshot) throw new ProspectError(["Outreach not found."], "not_found");
  if (ATTEMPTED_STATUSES.includes(snapshot.status) && snapshot.providerMessageId) return "already_recorded";
  if (!canReconcileSent(snapshot)) return "ineligible";
  if (sender.name !== "gmail" || !sender.lookupSent) return "unavailable";
  let evidence: SentMessageLookup;
  try {
    evidence = await sender.lookupSent({ outreachId: id, fromEmail: snapshot.senderEmail!, to: snapshot.recipientEmail, subject: snapshot.subject, text: snapshot.body, startedAt: snapshot.sendStartedAt!, checkedAt: now });
  } catch {
    // Provider errors can quote sensitive content: expose only a fixed result.
    evidence = { status: "unavailable" };
  }
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    await lockOutreach(tx, id);
    const current = await tx.outreach.findUniqueOrThrow({ where: { id } });
    if (ATTEMPTED_STATUSES.includes(current.status) && current.providerMessageId) return "already_recorded";
    if (!canReconcileSent(current) || current.sendStartedAt?.getTime() !== snapshot.sendStartedAt?.getTime() ||
        current.sendAttempts !== snapshot.sendAttempts || current.recipientEmail !== snapshot.recipientEmail ||
        current.senderEmail !== snapshot.senderEmail || current.subject !== snapshot.subject || current.body !== snapshot.body) return "ineligible";
    if (evidence.status !== "found") return evidence.status;
    const owner = await tx.outreach.findUnique({ where: { providerMessageId: evidence.providerMessageId }, select: { id: true } });
    if (owner && owner.id !== id) return "ambiguous";
    await recordSentInTx(tx, id, "gmail", evidence.providerMessageId, evidence.sentAt);
    // A manual confirmation may have won the race. Repair its identity/time
    // without rewriting its outcome, duplicating the send event, or claiming again.
    if (current.status !== "queued") {
      await tx.outreach.update({ where: { id }, data: { sentAt: evidence.sentAt, lastSendError: null } });
      if (!(await tx.outreachEvent.findFirst({ where: { outreachId: id, type: "sent" }, select: { id: true } }))) {
        await logOutreachEvent(tx, id, "sent", `gmail ${evidence.providerMessageId}`, evidence.sentAt);
      }
    }
    return "reconciled";
  });
}
