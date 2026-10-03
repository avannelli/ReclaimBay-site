/*
 * Sending queued messages. The only code that calls a sender.
 *
 * Three independent keys must all be on, and every one is re-checked before
 * each individual message:
 *   1. OUTREACH_SENDING_ENABLED=1 in the environment (the deployment arm)
 *   2. the global switch, on in the admin (append-only; off by default, and
 *      switching it off takes effect before the next message)
 *   3. an enabled provider (OUTREACH_PROVIDER; see sender.ts)
 * plus a complete sender identity (name, email, postal address, unsubscribe
 * link).
 *
 * Never two emails for one message:
 *   - a message is claimed compare-and-set before its send; only the
 *     claimer sends it;
 *   - every attempt carries the same idempotency key (the message id);
 *   - a send whose outcome is uncertain is retried only by a provider that
 *     honours that key, within its window; anything else, and any send
 *     interrupted mid-way, waits for a person ("stuck") and is never
 *     retried automatically.
 */
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { ProspectError } from "../prospects.js";
import { listUnsubscribeHeaders, senderIdentityErrors, unsubscribeUrl } from "./compliance.js";
import { messageEligibilityErrors } from "./eligibility.js";
import { moveOutreachInTx, recordSentInTx } from "./service.js";
import { lockOutreach, lockSendGate, suppressEmail } from "./records.js";
import type { OutgoingMessage, OutreachSender, SendResult } from "./sender.js";
import type { Prisma } from "../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
export type SendingConfig = Pick<Config, "outreachSender" | "publicApiUrl" | "outreachSendingArmed"> & Partial<Pick<Config, "outreachDailyLimit">>;

/** How long a provider keeps an idempotency key; retries stop well before. */
export const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
/** A claim this old with no outcome recorded was interrupted mid-send. */
export const STUCK_AFTER_MS = 10 * 60 * 1000;
export const DEFAULT_BATCH = 20;
/** New sends allowed per rolling 24 hours when OUTREACH_DAILY_LIMIT isn't set. */
export const DEFAULT_DAILY_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- the global switch ----------

export async function sendingSwitch(tx: Tx | Db) {
  const last = await tx.outreachControlChange.findFirst({ orderBy: { createdAt: "desc" } });
  return { enabled: last?.sendingEnabled ?? false, reason: last?.reason ?? "Never switched on.", at: last?.createdAt ?? null };
}

/** Why sending can't happen now, the switch aside (empty when everything else is ready). */
export function readinessErrors(cfg: SendingConfig, sender: OutreachSender): string[] {
  const errors: string[] = [];
  if (!cfg.outreachSendingArmed) errors.push("Sending isn't armed for this deployment (OUTREACH_SENDING_ENABLED=1).");
  if (!sender.enabled) errors.push(sender.problem ?? "No email provider is configured.");
  errors.push(...senderIdentityErrors(cfg));
  return errors;
}

/** Everything that stops sending now, the switch included. */
export async function sendingBlockers(db: Db | Tx, cfg: SendingConfig, sender: OutreachSender) {
  const sw = await sendingSwitch(db);
  return [...(sw.enabled ? [] : ["The global sending switch is off."]), ...readinessErrors(cfg, sender)];
}

export interface SendingStatus {
  tone: "pos" | "warn" | "neg" | "quiet";
  glyph: string;
  label: string;
  detail: string;
}

/**
 * Whether mail is actually going out, and if not, why: the first thing an
 * operator needs. The switch can be on while something else blocks sending
 * (an unarmed deployment, a provider that can't send) or while the daily
 * limit is used up, and each of those says so.
 */
export function sendingStatus(s: { switchOn: boolean; blockers: readonly string[]; remaining: number; limit: number; queued: number }): SendingStatus {
  if (!s.switchOn) {
    return { tone: "quiet", glyph: "○", label: "Sending is OFF", detail: "Nothing is sent. Messages can still be prepared and queued; they wait until sending is switched on." };
  }
  if (s.blockers.length) return { tone: "neg", glyph: "✕", label: "Sending is ON, but blocked", detail: `Nothing can be sent: ${s.blockers[0]}` };
  if (s.remaining === 0) {
    return { tone: "warn", glyph: "⏸", label: "Sending is ON, paused by the daily limit", detail: `All ${s.limit} sends for the last 24 hours are used. Sending resumes as that window moves on.` };
  }
  return {
    tone: "pos",
    glyph: "●",
    label: "Sending is ON",
    detail: `${s.queued ? `${s.queued} queued.` : "Nothing is queued."} ${s.remaining} of ${s.limit} daily sends left.`,
  };
}

/**
 * Switches sending on or off for everyone. Off always works and takes effect
 * before the next message. On needs a reason and everything else ready.
 */
export async function setSendingSwitch(db: Db, enabled: boolean, reasonRaw: unknown, cfg: SendingConfig, sender: OutreachSender, now = new Date()) {
  const reason = typeof reasonRaw === "string" ? reasonRaw.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  if (enabled) {
    if (!reason) throw new ProspectError(["Switching sending on needs a reason."]);
    const errors = readinessErrors(cfg, sender);
    if (errors.length) throw new ProspectError(["Sending can't be switched on yet:", ...errors]);
  }
  // Under the send gate: a claim either sees this change or was decided before it.
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    return tx.outreachControlChange.create({ data: { sendingEnabled: enabled, reason: reason || "Switched off.", createdAt: now } });
  });
}

// ---------- dispatch ----------

export interface DispatchOptions {
  config: SendingConfig;
  sender: OutreachSender;
  limit?: number;
  /** List what would be sent; claim and send nothing. */
  dryRun?: boolean;
  now?: () => Date;
}

export interface DispatchReport {
  blockers: string[];
  stoppedBecause: string | null;
  sent: { outreachId: string; providerMessageId: string }[];
  failed: { outreachId: string; reason: string }[];
  uncertain: { outreachId: string; reason: string }[];
  cancelled: { outreachId: string; reasons: string[] }[];
  /** Possibly sent before, now ineligible: left for a person. */
  held: { outreachId: string; reasons: string[] }[];
  /** Certainly not sent; the provider couldn't send. Still queued. */
  unavailable: { outreachId: string; reason: string }[];
  wouldSend: string[];
}

/** New sends started in the last 24 hours (each message counts once, however many attempts). */
export const sentInLastDay = (tx: Tx | Db, now: Date) => tx.outreach.count({ where: { sendStartedAt: { gte: new Date(now.getTime() - DAY_MS) } } });

/** The daily limit as it stands now: the same count the dispatcher enforces. */
export async function dailyCapacity(tx: Tx | Db, cfg: Pick<SendingConfig, "outreachDailyLimit">, now: Date) {
  const limit = cfg.outreachDailyLimit ?? DEFAULT_DAILY_LIMIT;
  const used = await sentInLastDay(tx, now);
  return { used, limit, remaining: Math.max(0, limit - used) };
}

const toMessage = (
  o: { id: string; recipientEmail: string; subject: string; body: string; unsubscribeToken: string | null },
  cfg: SendingConfig,
  attempt: number,
  firstAttemptAt: Date,
): OutgoingMessage => {
  const s = cfg.outreachSender;
  return {
    outreachId: o.id,
    idempotencyKey: `outreach-${o.id}`,
    attempt,
    firstAttemptAt,
    to: o.recipientEmail,
    from: { name: s.name!, email: s.email! },
    replyTo: s.email!,
    subject: o.subject,
    text: o.body,
    headers: listUnsubscribeHeaders(unsubscribeUrl(cfg.publicApiUrl!, o.unsubscribeToken!), s.email!),
  };
};

type Claim =
  | { kind: "stop"; reason: string }
  | { kind: "skip" }
  | { kind: "wouldSend" }
  | { kind: "held"; reasons: string[] }
  | { kind: "cancelled"; reasons: string[] }
  | { kind: "send"; message: OutgoingMessage; before: { sendAttempts: number; sendStartedAt: Date | null; lastSendError: string | null } };

/** Queued messages a dispatcher may take now: never claimed, or an uncertain send it may retry. */
async function candidates(db: Db, sender: OutreachSender, limit: number, now: Date) {
  return db.outreach.findMany({
    where: {
      status: "queued",
      OR: [
        { sendStartedAt: null },
        ...(sender.supportsIdempotency ? [{ lastSendError: { not: null }, sendStartedAt: { gte: new Date(now.getTime() - RETRY_WINDOW_MS) } }] : []),
      ],
    },
    orderBy: { queuedAt: "asc" },
    take: limit,
    select: { id: true },
  });
}

/**
 * Sends up to `limit` queued messages. Safe to run from several processes at
 * once and to repeat: each message is claimed by exactly one of them.
 */
export async function dispatchQueued(db: Db, opts: DispatchOptions): Promise<DispatchReport> {
  const clock = opts.now ?? (() => new Date());
  const { config: cfg, sender } = opts;
  const report: DispatchReport = { blockers: [], stoppedBecause: null, sent: [], failed: [], uncertain: [], cancelled: [], held: [], unavailable: [], wouldSend: [] };
  report.blockers = await sendingBlockers(db, cfg, sender);
  if (report.blockers.length) return report;

  for (const { id } of await candidates(db, sender, opts.limit ?? DEFAULT_BATCH, clock())) {
    const now = clock();
    const claim = await db.$transaction(async (tx): Promise<Claim> => {
      // First, the send gate: everything that could stop this send is decided before or after it, never during.
      // It also serialises the daily limit below, so concurrent dispatchers can't both take the last slot.
      await lockSendGate(tx);
      // The switch and the configuration, again, for every message.
      const blockers = await sendingBlockers(tx, cfg, sender);
      if (blockers.length) return { kind: "stop", reason: blockers.join(" ") };
      const o = await tx.outreach.findUnique({ where: { id }, include: { prospect: { include: { signals: true } } } });
      if (!o || o.status !== "queued") return { kind: "skip" };
      const errors = await messageEligibilityErrors(tx, o, cfg, "send");
      if (errors.length) {
        // Possibly sent already: never cancel it silently; it waits for a person.
        if (o.sendStartedAt) return { kind: "held", reasons: errors };
        if (!opts.dryRun) {
          await moveOutreachInTx(tx, id, "cancelled", { cancelledAt: now, cancelReason: `No longer eligible: ${errors.join(" ")}`.slice(0, 500) }, errors.join(" "), now);
        }
        return { kind: "cancelled", reasons: errors };
      }
      if (opts.dryRun) return { kind: "wouldSend" };
      const retryable = o.sendStartedAt === null || (sender.supportsIdempotency && o.lastSendError !== null);
      if (!retryable) return { kind: "skip" };
      if (o.sendStartedAt === null) {
        // The daily limit, counted under the send gate, so concurrent dispatchers can't both take the last slot.
        const { used, limit, remaining } = await dailyCapacity(tx, cfg, now);
        if (remaining === 0) return { kind: "stop", reason: `The daily sending limit is reached (${used} of ${limit} in the last 24 hours).` };
      }
      // Compare-and-set on the attempt count: exactly one dispatcher wins each attempt.
      const { count } = await tx.outreach.updateMany({
        where: { id, status: "queued", sendAttempts: o.sendAttempts, lastSendError: o.lastSendError },
        data: { sendAttempts: o.sendAttempts + 1, sendStartedAt: o.sendStartedAt ?? now, lastSendError: null },
      });
      if (count !== 1) return { kind: "skip" };
      return {
        kind: "send",
        message: toMessage(o, cfg, o.sendAttempts + 1, o.sendStartedAt ?? now),
        before: { sendAttempts: o.sendAttempts, sendStartedAt: o.sendStartedAt, lastSendError: o.lastSendError },
      };
    });

    if (claim.kind === "stop") {
      report.stoppedBecause = claim.reason;
      break;
    }
    if (claim.kind === "held" || claim.kind === "cancelled") {
      report[claim.kind].push({ outreachId: id, reasons: claim.reasons });
      continue;
    }
    if (claim.kind === "wouldSend") {
      report.wouldSend.push(id);
      continue;
    }
    if (claim.kind === "skip") continue;

    let result: SendResult;
    try {
      result = await sender.send(claim.message);
    } catch (err) {
      // A provider must not throw; if it does, the outcome is unknown.
      result = { status: "uncertain", reason: `The provider threw: ${(err as Error).message}` };
    }
    const at = clock();
    await db.$transaction(async (tx) => {
      await lockSendGate(tx);
      // A provider event about this message may be recorded at this very moment: one after the other.
      await lockOutreach(tx, id);
      if (result.status === "accepted") {
        await recordSentInTx(tx, id, sender.name, result.providerMessageId, at);
        report.sent.push({ outreachId: id, providerMessageId: result.providerMessageId });
      } else if (result.status === "rejected") {
        const o = await tx.outreach.findUniqueOrThrow({ where: { id } });
        if (o.status === "queued") {
          await moveOutreachInTx(tx, id, "failed", { failedAt: at, failureReason: result.reason.slice(0, 500), provider: sender.name }, result.reason, at);
          if (result.invalidRecipient) await suppressEmail(tx, o.recipientEmail, "invalid", result.reason, id, at);
        }
        report.failed.push({ outreachId: id, reason: result.reason });
      } else if (result.status === "unavailable") {
        // Certainly not sent: undo this claim exactly, as if it never happened.
        await tx.outreach.updateMany({ where: { id, status: "queued", sendAttempts: claim.before.sendAttempts + 1 }, data: claim.before });
        report.unavailable.push({ outreachId: id, reason: result.reason });
      } else {
        await tx.outreach.updateMany({ where: { id, status: "queued" }, data: { lastSendError: result.reason.slice(0, 500) || "Unknown error." } });
        report.uncertain.push({ outreachId: id, reason: result.reason });
      }
    });
    if (result.status === "unavailable") {
      report.stoppedBecause = `The provider can't send right now: ${result.reason}`;
      break;
    }
  }
  return report;
}

/**
 * Messages whose send may or may not have happened and that won't be
 * retried automatically: interrupted mid-send, or uncertain past the retry
 * window (or with a provider that can't retry safely). A person checks the
 * provider, then records the outcome or discards the message.
 */
export async function stuckMessages(db: Db, sender: OutreachSender, now = new Date()) {
  const rows = await db.outreach.findMany({
    where: { status: "queued", sendStartedAt: { not: null } },
    select: { id: true, subject: true, recipientEmail: true, sendStartedAt: true, sendAttempts: true, lastSendError: true },
    orderBy: { sendStartedAt: "asc" },
  });
  return rows.filter((r) => {
    const age = now.getTime() - r.sendStartedAt!.getTime();
    if (r.lastSendError === null) return age > STUCK_AFTER_MS;
    return !sender.supportsIdempotency || age > RETRY_WINDOW_MS;
  });
}

/**
 * A person checked the provider and found a stuck message was sent: record
 * it (as the dispatcher would have). Only for claimed, unresolved messages.
 */
export async function confirmStuckSent(db: Db, id: string, provider: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const o = await tx.outreach.findUnique({ where: { id } });
    if (!o) throw new ProspectError(["Outreach not found."], "not_found");
    if (o.status !== "queued" || !o.sendStartedAt) throw new ProspectError(["Only a message whose send was started and never confirmed can be marked as sent."]);
    return recordSentInTx(tx, id, provider, null, now);
  });
}
