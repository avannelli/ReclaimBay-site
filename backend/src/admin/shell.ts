/*
 * The live part of the admin shell: the sending strip in the top bar and the
 * counts beside Sending, Replies, and Unsubscribe reviews. Read-only, from
 * the same definitions as the Sending page (sendingState.ts).
 *
 * Pages render the shell with placeholders (views.ts); the admin scope fills
 * them in once per signed-in HTML response. A page that has already loaded
 * the same records (the Overview) hands them over instead of loading twice.
 * If the status can't be loaded, the strip says so and no count is shown:
 * never a zero that only means "the query failed".
 */
import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { readinessErrors } from "../outreach/dispatch.js";
import type { OutreachSender } from "../outreach/sender.js";
import {
  MODE_LABELS,
  loadSendingFacts,
  rememberedProvider,
  sendingVerdict,
  type ProviderCheckMemo,
  type ProviderKnowledge,
  type SendingFacts,
  type SendingMode,
  type SendingVerdict,
} from "./sendingState.js";
import { esc, fmtDate } from "./ui.js";
import { NAV_COUNT_KEYS, SHELL_STATUS_SLOT, navCountSlot } from "./views.js";

export interface ShellStatus {
  mode: SendingMode;
  glyph: string;
  detail: string;
  queued: number;
  capacity: { used: number; limit: number; remaining: number };
  /** Messages whose send outcome is unknown (stuckMessages). */
  unresolved: number;
  provider: ProviderKnowledge;
  /** Replies nobody has classified yet (outreachAttention). */
  replies: number;
  /** Emailed unsubscribe requests waiting for a decision. */
  reviews: number;
}

export const openUnsubscribeReviews = (db: Db) => db.emailedUnsubscribeReview.count({ where: { state: "open" } });

/** The shell status from records already loaded (the Overview's), so nothing is read twice. */
export function shellStatusFrom(facts: SendingFacts, verdict: SendingVerdict, provider: ProviderKnowledge, reviews: number): ShellStatus {
  return {
    mode: verdict.mode,
    glyph: verdict.status.glyph,
    detail: verdict.status.detail,
    queued: facts.queued,
    capacity: facts.capacity,
    unresolved: facts.stuck.length,
    provider,
    replies: facts.attention.replyCount,
    reviews,
  };
}

export async function loadShellStatus(db: Db, config: Config, sender: OutreachSender, memo: ProviderCheckMemo | undefined, now = new Date()): Promise<ShellStatus> {
  const [facts, reviews] = await Promise.all([loadSendingFacts(db, config, now), openUnsubscribeReviews(db)]);
  const provider = rememberedProvider(config, memo);
  const verdict = sendingVerdict({
    sw: facts.sw,
    readiness: readinessErrors(config, sender),
    provider,
    capacity: facts.capacity,
    queued: facts.queued,
    oldestQueuedAt: facts.waiting.oldestQueuedAt,
    lastSentAt: facts.attention.lastSentAt,
    now,
  });
  return shellStatusFrom(facts, verdict, provider, reviews);
}

/** What the strip can say about the provider when the switch is on and no live check ran on this page. */
function providerNote(s: ShellStatus, now: Date): string {
  if (s.mode !== "on") return "";
  if (s.provider.kind === "unchecked") return "Gmail not verified since restart";
  if (s.provider.kind === "remembered") return `Gmail verified ${Math.max(0, Math.round((now.getTime() - s.provider.at.getTime()) / 60_000))} min ago`;
  return "";
}

/** The top bar's sending strip: state, queue, capacity, unresolved sends. A link to the Sending page. */
export function sendbar(s: ShellStatus | null, now: Date): string {
  if (!s) {
    return `<a class="sendbar m-unknown" href="/admin/outreach" title="The sending status could not be loaded."><span class="sb-state"><span aria-hidden="true">◌</span>Sending status unavailable</span></a>`;
  }
  const note = providerNote(s, now);
  return `<a class="sendbar m-${s.mode}" href="/admin/outreach" title="${esc(s.detail)}">
<span class="sb-state"><span aria-hidden="true">${esc(s.glyph)}</span>SENDING ${MODE_LABELS[s.mode]}</span>
<span><span class="sb-k">Queue</span><b>${s.queued}</b></span>
<span title="Remaining capacity for send attempts in the rolling 24-hour window"><span class="sb-k">Capacity</span><b>${s.capacity.remaining}/${s.capacity.limit}</b></span>
<span${s.unresolved ? ' class="sb-alert"' : ""}><span class="sb-k">Unresolved</span><b>${s.unresolved}</b></span>${note ? `\n<span class="sb-note">${esc(note)}</span>` : ""}
</a>`;
}

/** A nav count, shown only when something is waiting. */
export function navCount(key: (typeof NAV_COUNT_KEYS)[number], s: ShellStatus | null): string {
  if (!s) return "";
  const [n, tone, words] =
    key === "sending" ? [s.unresolved, "neg", "unresolved"] : key === "replies" ? [s.replies, "warn", "to classify"] : [s.reviews, "neg", "open"];
  return n > 0 ? `<span class="nav-n n-${tone}">${n}<span class="sr-only"> ${words}</span></span>` : "";
}

/** Fills the shell's placeholders in a rendered page. */
export function fillShell(html: string, s: ShellStatus | null, now: Date): string {
  let out = html.replaceAll(SHELL_STATUS_SLOT, sendbar(s, now));
  for (const key of NAV_COUNT_KEYS) out = out.replaceAll(navCountSlot(key), navCount(key, s));
  return out;
}

/** Records a status a route already loaded, so the response hook doesn't load it again. */
const provided = new WeakMap<FastifyRequest, ShellStatus | null>();
export const provideShellStatus = (req: FastifyRequest, s: ShellStatus | null) => void provided.set(req, s);
export const providedShellStatus = (req: FastifyRequest) => provided.get(req);

/** For the Health page and tests: when the strip's provider knowledge dates from. */
export const providerKnowledgeText = (p: ProviderKnowledge) =>
  p.kind === "remembered" ? `last live check ${fmtDate(p.at)}` : p.kind === "unchecked" ? "not checked since the server started" : p.kind === "live" ? "checked live now" : "no live check for this provider";
