import type { Db } from "../db.js";
import type { Prisma, UnsubscribeReviewReason } from "../generated/prisma/client.js";
import { ProspectError } from "../prospects.js";
import { ATTEMPTED_STATUSES, normalizeEmail } from "./lifecycle.js";
import { lockOutreach, lockSendGate } from "./records.js";
import { unsubscribeOutreachInTx } from "./service.js";

type Tx = Prisma.TransactionClient;
export interface EmailedUnsubscribe {
  mailboxAccount: string;
  gmailMessageId: string;
  senderEmail: string | null;
  receivedAt: Date | null;
  threadMessageIds: string[];
  markerOutreachIds: string[];
}

export const REVIEW_REASONS: Record<UnsubscribeReviewReason, string> = {
  invalid_sender: "The message did not contain one unambiguous sender address.",
  missing_received_time: "Gmail did not supply a valid received time.",
  multiple_candidates: "More than one outbound message could be involved.",
  sender_conflict: "The sender differs from the recipient of the outbound message.",
  unverified_send: "The candidate has no verified send timestamp or eligible send state.",
  historical_mail: "The message was received before the candidate was sent.",
};

/** All plausible identities, never the latest/best candidate. Network evidence is supplied outside the gate. */
async function attribution(tx: Tx | Db, input: EmailedUnsubscribe) {
  const or: Prisma.OutreachWhereInput[] = [];
  if (input.threadMessageIds.length) or.push({ providerMessageId: { in: input.threadMessageIds } });
  if (input.markerOutreachIds.length) or.push({ id: { in: input.markerOutreachIds } });
  if (input.senderEmail && input.receivedAt) or.push({ recipientEmail: { equals: input.senderEmail, mode: "insensitive" }, status: { in: [...ATTEMPTED_STATUSES] }, sentAt: { not: null, lte: input.receivedAt } });
  const candidates = or.length ? await tx.outreach.findMany({ where: { OR: or }, orderBy: { id: "asc" } }) : [];
  let reason: UnsubscribeReviewReason | null = null;
  const [only] = candidates;
  if (!input.senderEmail) reason = "invalid_sender";
  else if (!input.receivedAt) reason = "missing_received_time";
  else if (candidates.length > 1) reason = "multiple_candidates";
  else if (only && normalizeEmail(only.recipientEmail) !== input.senderEmail) reason = "sender_conflict";
  else if (only && (!only.sentAt || !ATTEMPTED_STATUSES.includes(only.status))) reason = "unverified_send";
  else if (only && only.sentAt! > input.receivedAt) reason = "historical_mail";
  return { candidates, reason };
}

/** Exact-subject unsubscribe only: durable ambiguity is never assigned or auto-resolved on reread. */
export async function ingestEmailedUnsubscribe(db: Db, input: EmailedUnsubscribe, apply: boolean, now = new Date()) {
  const mailboxAccount = normalizeEmail(input.mailboxAccount);
  if (!/^[^@\s]+@[^@\s]+$/.test(mailboxAccount) || mailboxAccount.length > 254 || !/^[A-Za-z0-9_-]{1,200}$/.test(input.gmailMessageId)) throw new ProspectError(["Invalid inbound unsubscribe identity."]);
  const senderEmail = input.senderEmail ? normalizeEmail(input.senderEmail) : null;
  const evidence = { ...input, mailboxAccount,
    senderEmail: senderEmail && senderEmail.length <= 254 && /^[^@\s,;<>:"\\]+@[^@\s,;<>:"\\]+$/.test(senderEmail) ? senderEmail : null,
    receivedAt: input.receivedAt && Number.isFinite(input.receivedAt.getTime()) ? input.receivedAt : null };
  if (!apply) {
    const existing = await db.emailedUnsubscribeReview.findUnique({ where: { mailboxAccount_gmailMessageId: { mailboxAccount, gmailMessageId: input.gmailMessageId } } });
    if (existing) return { result: `review_${existing.state}`, outreachId: null, reviewId: existing.id };
    const { candidates, reason } = await attribution(db, evidence);
    return { result: reason ? "would review" : candidates.length ? "would record" : "unmatched", outreachId: reason ? null : candidates[0]?.id ?? null, reviewId: null };
  }
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const identity = { mailboxAccount, gmailMessageId: input.gmailMessageId };
    const existing = await tx.emailedUnsubscribeReview.findUnique({ where: { mailboxAccount_gmailMessageId: identity } });
    if (existing) return { result: `review_${existing.state}`, outreachId: null, reviewId: existing.id };
    // This is the authoritative attribution decision immediately before any suppression.
    const { candidates, reason } = await attribution(tx, evidence);
    if (reason) {
      const review = await tx.emailedUnsubscribeReview.create({ data: {
        ...identity, senderEmail: evidence.senderEmail, receivedAt: evidence.receivedAt, reason, createdAt: now,
        candidates: { create: candidates.map((o) => ({ outreachId: o.id, prospectId: o.prospectId, recipientEmail: normalizeEmail(o.recipientEmail) })) },
      } });
      return { result: "review_open", outreachId: null, reviewId: review.id };
    }
    const [only] = candidates;
    if (!only) return { result: "unmatched", outreachId: null, reviewId: null };
    await lockOutreach(tx, only.id);
    const result = await unsubscribeOutreachInTx(tx, only.id, "by an emailed unsubscribe request", evidence.receivedAt!);
    return { ...result, outreachId: only.id, reviewId: null };
  });
}

/** An explicit operator choice, never a browser-supplied arbitrary outbound ID. */
export async function resolveUnsubscribeReview(db: Db, id: string, action: "resolve" | "dismiss", outreachId: string | undefined, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    await tx.$queryRaw`SELECT id FROM "EmailedUnsubscribeReview" WHERE id = ${id}::uuid FOR UPDATE`;
    const review = await tx.emailedUnsubscribeReview.findUnique({ where: { id }, include: { candidates: true } });
    if (!review) throw new ProspectError(["Unsubscribe review not found."], "not_found");
    if (review.state !== "open") {
      if ((action === "dismiss" && review.state === "dismissed") || (action === "resolve" && review.state === "resolved" && review.resolvedOutreachId === outreachId)) return "already_processed";
      throw new ProspectError(["This review has already been processed. Reload its recorded decision."], "conflict");
    }
    if (action === "dismiss") {
      await tx.emailedUnsubscribeReview.update({ where: { id }, data: { state: "dismissed", resolvedAt: now } });
      return "dismissed";
    }
    const candidate = review.candidates.find((c) => c.outreachId === outreachId);
    if (!candidate) throw new ProspectError(["Choose one of this review's stored candidates."]);
    await lockOutreach(tx, candidate.outreachId);
    const current = await tx.outreach.findUnique({ where: { id: candidate.outreachId } });
    if (!current || current.prospectId !== candidate.prospectId || normalizeEmail(current.recipientEmail) !== candidate.recipientEmail ||
        !review.receivedAt || !current.sentAt || current.sentAt > review.receivedAt || !ATTEMPTED_STATUSES.includes(current.status)) {
      throw new ProspectError(["The candidate's identity or send evidence is no longer valid. No suppression was performed."], "conflict");
    }
    await unsubscribeOutreachInTx(tx, current.id, "after explicit review of an ambiguous emailed unsubscribe", now);
    await tx.emailedUnsubscribeReview.update({ where: { id }, data: { state: "resolved", resolvedAt: now, resolvedOutreachId: current.id } });
    return "resolved";
  });
}

/** Admin projection excludes mailbox/provider IDs, bodies and tokens. */
export function listUnsubscribeReviews(db: Db, page = 1) {
  return db.emailedUnsubscribeReview.findMany({ orderBy: [{ state: "asc" }, { createdAt: "desc" }, { id: "asc" }], take: 100, skip: (page - 1) * 100, select: {
    id: true, senderEmail: true, receivedAt: true, reason: true, state: true, resolvedAt: true, resolvedOutreachId: true,
    candidates: { orderBy: { outreachId: "asc" }, select: { outreachId: true, recipientEmail: true, outreach: { select: { subject: true, sentAt: true, prospect: { select: { id: true, businessName: true } } } } } },
  } });
}
