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

/** The send gate's advisory lock key (once the dispatcher's claim lock; the value is unchanged). */
export const SEND_GATE = 73_160_201;

/**
 * The send gate: one global lock, held until the transaction ends. Every
 * top-level transaction that can make or stop a send takes it as its first
 * statement: the dispatcher's claim and result, queueing, discarding, the
 * sending switch, a stuck send confirmed, prospect status changes and edits,
 * replies and their classification, provider events, opt-outs, and revoking
 * an invitation. So a send and anything that could stop it happen one after
 * the other, never interleaved, and two such transactions can never
 * deadlock: they all wait for the same lock first, before any row lock.
 *
 * Rules (a unit test enforces them):
 *   - only those top-level functions take it, as the first statement of
 *     their transaction; helpers (changeStatusInTx, suppressEmail,
 *     cancelOpenOutreach, …) never do: their caller already holds it;
 *   - nothing inside a gated transaction makes a network call: the provider
 *     and Gmail are always called outside, so the gate is held for
 *     milliseconds.
 */
export const lockSendGate = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEND_GATE})`;

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

/** A claim this old with no outcome recorded was interrupted mid-send. */
export const STUCK_AFTER_MS = 10 * 60 * 1000;

/**
 * A send that may be running right now: the dispatcher claimed the message
 * (sendStartedAt), no outcome is recorded yet, and the claim isn't old enough
 * to count as interrupted. Its provider call runs outside any transaction,
 * so only the dispatcher's result may decide it; a person can discard it
 * only once it is interrupted, or its outcome is unknown.
 */
export const sendInProgress = (o: { status: OutreachStatus; sendStartedAt: Date | null; lastSendError: string | null }, now: Date) =>
  o.status === "queued" && o.sendStartedAt !== null && o.lastSendError === null && now.getTime() - o.sendStartedAt.getTime() <= STUCK_AFTER_MS;

/**
 * Manual sent confirmation requires the dispatcher's recorded uncertain
 * outcome. Claim age alone cannot prove that the provider call has ended:
 * even an apparently interrupted send may still return a definite failure.
 */
export const canConfirmStuckSent = (o: { status: OutreachStatus; sendStartedAt: Date | null; lastSendError: string | null }) =>
  o.status === "queued" && o.sendStartedAt !== null && o.lastSendError !== null;

/**
 * Cancels one open message, compare-and-set, with its event. Never one whose
 * send has started: it may have gone out, so the dispatcher's result (or a
 * person, once it is stuck) decides it, never an automatic stop.
 */
async function cancelOne(tx: Tx, open: { id: string; status: OutreachStatus }, reason: string, now: Date) {
  const { count } = await tx.outreach.updateMany({
    where: { id: open.id, status: open.status, sendStartedAt: null },
    data: { status: "cancelled", statusChangedAt: now, cancelledAt: now, cancelReason: reason.slice(0, 500), openForProspectId: null },
  });
  if (count === 1) await logOutreachEvent(tx, open.id, "cancelled", reason, now);
  return count === 1;
}

/**
 * Cancels the prospect's open message (draft or queued), if any, so it can
 * never be sent. Used when the prospect leaves outreach (Do not contact,
 * Lost, …). Returns the id it cancelled. A message whose send has started is
 * left to the dispatcher (cancelOne).
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
 * cancels every open message to it, on any prospect, except one whose send
 * has started (cancelOne). Never removed.
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
