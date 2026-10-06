/*
 * The sending state, read once and interpreted once, for every admin view
 * that shows it: the Sending page, the top bar, and the Overview. Read-only.
 *
 * Nothing here decides anything new. The switch, readiness, capacity, the
 * stuck-message rule, and the stale-queue rule all come from the dispatcher
 * and operations modules; this file only gathers them and combines them the
 * way the Sending page always has (sendingVerdict).
 */
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { dailyCapacity, sendingStatus, sendingSwitch, stuckMessages, type SendingStatus } from "../outreach/dispatch.js";
import { queueLooksStale, waitingQueue } from "../outreach/operations.js";
import { outreachAttention } from "../outreach/service.js";

/** OFF, ON, BLOCKED, or PAUSED: a name for each tone sendingStatus can return. */
export type SendingMode = "off" | "on" | "blocked" | "paused";

const MODE_BY_TONE: Record<SendingStatus["tone"], SendingMode> = { quiet: "off", pos: "on", neg: "blocked", warn: "paused" };

export const MODE_LABELS: Record<SendingMode, string> = { off: "OFF", on: "ON", blocked: "BLOCKED", paused: "PAUSED" };

/**
 * The result of the Sending page's live provider check, remembered by this
 * server process so other pages can show it with its time instead of calling
 * the provider again. One per app instance; empty after a restart.
 */
export interface ProviderCheck {
  at: Date;
  /** null when the provider could send at that time, else why not. */
  problem: string | null;
}

export function providerCheckMemo() {
  let last: ProviderCheck | null = null;
  return {
    record(problem: string | null, at = new Date()) {
      last = { at, problem };
    },
    last: () => last,
  };
}
export type ProviderCheckMemo = ReturnType<typeof providerCheckMemo>;

/**
 * The provider's state as another page can know it: checked live on this
 * request, remembered from the Sending page's last check, never checked
 * since the server started, or not applicable (no live check exists for it).
 */
export type ProviderKnowledge =
  | { kind: "live"; problem: string | null }
  | { kind: "remembered"; at: Date; problem: string | null }
  | { kind: "unchecked" }
  | { kind: "not_applicable" };

export function rememberedProvider(config: Pick<Config, "outreachProvider">, memo: ProviderCheckMemo | undefined): ProviderKnowledge {
  if (config.outreachProvider !== "gmail") return { kind: "not_applicable" };
  const last = memo?.last();
  return last ? { kind: "remembered", at: last.at, problem: last.problem } : { kind: "unchecked" };
}

const providerProblem = (p: ProviderKnowledge) => (p.kind === "live" || p.kind === "remembered" ? p.problem : null);

/**
 * How the Sending page combines what it knows: every blocker (readiness plus
 * the provider's own problem), the status line, whether queued mail looks
 * stuck behind a stopped sender job, and the mode name. Pure.
 */
export function sendingVerdict(i: {
  sw: { enabled: boolean; at: Date | null };
  readiness: readonly string[];
  provider: ProviderKnowledge;
  capacity: { remaining: number; limit: number };
  queued: number;
  oldestQueuedAt: Date | null;
  lastSentAt: Date | null;
  now: Date;
}) {
  const problem = providerProblem(i.provider);
  const blockers = [...new Set([...i.readiness, ...(problem ? [problem] : [])])];
  const status = sendingStatus({ switchOn: i.sw.enabled, blockers, remaining: i.capacity.remaining, limit: i.capacity.limit, queued: i.queued });
  // "Sending is ON" (tone pos) is the one state where a long-waiting queue means the sender job isn't running.
  const stale = queueLooksStale({ sendingLive: status.tone === "pos", switchedAt: i.sw.at, oldestQueuedAt: i.oldestQueuedAt, lastSentAt: i.lastSentAt, now: i.now });
  return { blockers, status, stale, mode: MODE_BY_TONE[status.tone] };
}
export type SendingVerdict = ReturnType<typeof sendingVerdict>;

/**
 * The records behind the sending state: the switch, the daily capacity as
 * the dispatcher counts it, everything queued, the messages whose send
 * outcome is unknown (stuckMessages, the Sending page's own list), the
 * unclaimed queue, and the outreach attention summary (replies to classify,
 * recent refusals, the last send). Counts include internal tests: they are
 * real messages going through the real sender.
 */
export async function loadSendingFacts(db: Db, config: Pick<Config, "outreachDailyLimit">, now: Date) {
  const [sw, capacity, queued, stuck, waiting, attention] = await Promise.all([
    sendingSwitch(db),
    dailyCapacity(db, config, now),
    db.outreach.count({ where: { status: "queued" } }),
    stuckMessages(db, now),
    waitingQueue(db),
    outreachAttention(db, now),
  ]);
  return { sw, capacity, queued, stuck, waiting, attention };
}
export type SendingFacts = Awaited<ReturnType<typeof loadSendingFacts>>;
