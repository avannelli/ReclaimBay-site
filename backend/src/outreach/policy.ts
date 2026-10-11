import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { ProspectError } from "../prospects.js";
import { lockSendGate } from "./records.js";

type Tx = Prisma.TransactionClient;
export const DEFAULT_ADMIN_DAILY_LIMIT = 25;
export const MAX_ADMIN_DAILY_LIMIT = 500;
/** A shared claim-time gate, including concurrent dispatcher processes. */
export const MIN_SEND_INTERVAL_MS = 60_000;

export function parseDailyLimit(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw new ProspectError(["Daily limit must be a whole number from 1 to 500."]);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ADMIN_DAILY_LIMIT) {
    throw new ProspectError(["Daily limit must be a whole number from 1 to 500."]);
  }
  return limit;
}

export async function sendingPolicy(tx: Db | Tx) {
  const row = await tx.outreachControlChange.findFirst({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return {
    enabled: row?.sendingEnabled ?? false,
    dailyLimit: row?.dailyLimit ?? DEFAULT_ADMIN_DAILY_LIMIT,
    activeCampaignId: row?.activeCampaignId ?? null,
    reason: row?.reason ?? "Never switched on.",
    at: row?.createdAt ?? null,
  };
}

/** Caller owns the send gate. Keep append-only state strictly ordered. */
export async function appendSendingControlInTx(tx: Tx, changes: { enabled?: boolean; dailyLimit?: number; activeCampaignId?: string }, reason: string, now: Date) {
  const current = await sendingPolicy(tx);
  return tx.outreachControlChange.create({ data: {
    sendingEnabled: changes.enabled ?? current.enabled,
    dailyLimit: changes.dailyLimit ?? current.dailyLimit,
    activeCampaignId: changes.activeCampaignId ?? current.activeCampaignId,
    reason,
    createdAt: new Date(Math.max(now.getTime(), (current.at?.getTime() ?? -1) + 1)),
  } });
}

/** Changing capacity does not start a campaign, queue, arm, or enable sending. */
export async function setDailyLimit(db: Db, value: unknown, reasonRaw: unknown, now = new Date()) {
  const dailyLimit = parseDailyLimit(value);
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim().slice(0, 500) : "";
  if (!reason) throw new ProspectError(["Give a reason for changing the daily limit."]);
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    return appendSendingControlInTx(tx, { dailyLimit }, reason, now);
  });
}
