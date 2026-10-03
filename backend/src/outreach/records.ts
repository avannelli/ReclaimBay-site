/*
 * Low-level outreach writes, shared by the outreach service and the prospect
 * service. Each runs inside the caller's transaction.
 */
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { OPEN_STATUSES, normalizeEmail, type OutreachStatus } from "./lifecycle.js";

type Tx = Prisma.TransactionClient;
type EventType = OutreachStatus | "drafted" | "complained" | "unsubscribed";
export type SuppressionReason = "bounced" | "complained" | "unsubscribed" | "invalid";

/**
 * Locks one message's row until the transaction ends. Everything that records
 * what happened to a sent message (provider events, replies, opt-outs, the
 * dispatcher's outcome) takes it first, so two reports about the same message
 * are applied one after the other, the second seeing the first's result,
 * instead of failing each other's compare-and-set.
 */
export const lockOutreach = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM "Outreach" WHERE id = ${id}::uuid FOR UPDATE`;

/**
 * Every status change of a message is logged here, in the same transaction.
 * `providerEventId` is unique: the same webhook can never be logged twice.
 */
export const logOutreachEvent = (tx: Tx, outreachId: string, type: EventType, detail: string | null, at: Date, providerEventId?: string | null) =>
  tx.outreachEvent.create({
    data: { outreachId, type: type === "draft" ? "drafted" : type, detail: detail?.slice(0, 500) ?? null, providerEventId: providerEventId ?? null, createdAt: at },
  });

/** Cancels one open message, compare-and-set, with its event. */
async function cancelOne(tx: Tx, open: { id: string; status: OutreachStatus }, reason: string, now: Date) {
  const { count } = await tx.outreach.updateMany({
    where: { id: open.id, status: open.status },
    data: { status: "cancelled", statusChangedAt: now, cancelledAt: now, cancelReason: reason.slice(0, 500), openForProspectId: null },
  });
  if (count === 1) await logOutreachEvent(tx, open.id, "cancelled", reason, now);
  return count === 1;
}

/**
 * Cancels the prospect's open message (draft or queued), if any, so it can
 * never be sent. Used when the prospect leaves outreach (Do not contact,
 * Lost, …). Returns the id it cancelled.
 */
export async function cancelOpenOutreach(tx: Tx, prospectId: string, reason: string, now = new Date()): Promise<string | null> {
  const open = await tx.outreach.findFirst({ where: { prospectId, status: { in: [...OPEN_STATUSES] } }, select: { id: true, status: true } });
  if (!open) return null;
  return (await cancelOne(tx, open, reason, now)) ? open.id : null;
}

export const isSuppressed = async (tx: Tx | Db, email: string) =>
  Boolean(await tx.emailSuppression.findUnique({ where: { email: normalizeEmail(email) }, select: { id: true } }));

/**
 * Adds an address to the suppression list (the first reason is kept) and
 * cancels every open message to it, on any prospect. Never removed.
 */
export async function suppressEmail(tx: Tx, emailRaw: string, reason: SuppressionReason, detail: string | null, outreachId: string | null, now = new Date()) {
  const email = normalizeEmail(emailRaw);
  await tx.emailSuppression.upsert({
    where: { email },
    create: { email, reason, detail: detail?.slice(0, 500) ?? null, outreachId, createdAt: now },
    update: {},
  });
  const open = await tx.outreach.findMany({
    where: { recipientEmail: { equals: email, mode: "insensitive" }, status: { in: [...OPEN_STATUSES] } },
    select: { id: true, status: true },
  });
  for (const o of open) await cancelOne(tx, o, `The address ${email} is suppressed (${reason}).`, now);
}
