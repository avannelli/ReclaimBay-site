/*
 * Outreach funnel, computed from the raw records only: Outreach rows, the two
 * event types that aren't statuses, invitations, and each prospect's status
 * history. Nothing here is stored, so changing a definition never needs a
 * migration. Definitions: OUTREACH.md § Measurement.
 *
 * All time: there is no date window, so a recent campaign has had less time
 * to be opened, answered, or move forward than an old one.
 *
 * Three levels, each counted once, by one campaign:
 *
 *   messages     by the message's own campaign
 *   invitations  by the campaign frozen on the invitation (its first
 *                message's), and only once that message was sent; a
 *                follow-up reuses its first message's invitation
 *   prospects    by the campaign of the prospect's first sent message. A
 *                prospect gets at most one sent first message
 *                (eligibility.ts), so everything from that send on is its
 *                one outreach round, follow-ups included. Outcomes count
 *                only status changes in that round.
 *
 * Revenue isn't recorded anywhere yet (billing comes later).
 */
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { invitationActivations } from "../invitations/service.js";
import { NEGATIVE_REPLIES, POSITIVE_REPLIES, type OutreachStatus } from "./lifecycle.js";

export interface FunnelRow {
  campaign: string;
  /**
   * This campaign's first messages and follow-ups (any status). A row of
   * follow-ups only has no invitation or prospect figures of its own: those
   * are credited to the first message's campaign.
   */
  firstMessages: number;
  followUps: number;

  // ----- messages, by their own campaign -----
  /** Every message ever drafted, whatever its status now. */
  everDrafted: number;
  /** Ever queued (queuedAt), even if cancelled afterwards. */
  everQueued: number;
  /** The provider refused it, so it was never sent (failed, no sentAt). */
  refusedBeforeSending: number;
  /** Handed to the provider (sentAt), whatever happened next. */
  sent: number;
  /** Sent, then reported bounced. */
  bounced: number;
  /** Sent, then reported failed. */
  failedAfterSending: number;
  /** Messages with a reply. Each is exactly one of the four below, so they add up to it. */
  replied: number;
  /** Classified interested. */
  positive: number;
  /** Classified not interested, or asked not to be contacted. */
  negative: number;
  /** Classified other (a question, the wrong person, …). */
  other: number;
  /** Not yet classified. */
  unclassified: number;
  /** Messages whose recipient unsubscribed (by link or by email). */
  unsubscribed: number;
  /** Messages whose recipient marked them as spam. */
  complained: number;

  // ----- invitations, by their own campaign -----
  /** Invitations whose message was sent. One made for a draft that was never sent doesn't count. */
  invitationsSent: number;
  /** Of those, opened at least once (however many times). */
  opened: number;
  /** Of those, activated: a real scan by a visitor who arrived through one (invitationActivations). */
  activated: number;

  // ----- prospects, once each, by the campaign of their first sent message -----
  /** Prospects with a sent message. */
  prospectsEmailed: number;
  /** Of those, prospects with a sent message that hasn't bounced or failed. */
  prospectsReached: number;
  /** Of those, prospects who replied to any of their messages (counted once, however many replies). */
  replyingProspects: number;
  /** Prospects who reached each status at or after their first email (ever, in that round: a prospect can count in several). */
  meetings: number;
  proposals: number;
  customers: number;
  lost: number;
}

/**
 * An invitation that was sent: its message has a sentAt. The funnel's
 * Invitations sent, Opened, and Activated count only these; the activity
 * view's "sent only" filter (operations.ts) uses the same condition.
 */
export const SENT_INVITATION = { outreach: { sentAt: { not: null } } } satisfies Prisma.InvitationWhereInput;

/** Sent, and not bounced or failed: as far as anyone can tell, it arrived. */
const REACHED: readonly OutreachStatus[] = ["sent", "delivered", "replied"];

const OUTCOMES = { meeting: "meetings", proposal: "proposals", customer: "customers", lost: "lost" } as const;
const OUTCOME_STATUSES = Object.keys(OUTCOMES) as (keyof typeof OUTCOMES)[];

const empty = (campaign: string): FunnelRow => ({
  campaign,
  firstMessages: 0,
  followUps: 0,
  everDrafted: 0,
  everQueued: 0,
  refusedBeforeSending: 0,
  sent: 0,
  bounced: 0,
  failedAfterSending: 0,
  replied: 0,
  positive: 0,
  negative: 0,
  other: 0,
  unclassified: 0,
  unsubscribed: 0,
  complained: 0,
  invitationsSent: 0,
  opened: 0,
  activated: 0,
  prospectsEmailed: 0,
  prospectsReached: 0,
  replyingProspects: 0,
  meetings: 0,
  proposals: 0,
  customers: 0,
  lost: 0,
});

/** One row per campaign, plus a total row ("all"). */
export async function outreachMetrics(db: Db): Promise<FunnelRow[]> {
  const [messages, optOuts, invitations, history] = await Promise.all([
    db.outreach.findMany({
      select: { id: true, prospectId: true, kind: true, campaign: true, status: true, queuedAt: true, sentAt: true, replyOutcome: true },
      orderBy: { createdAt: "asc" },
    }),
    // Only the two event types that aren't statuses, not every message's whole log.
    db.outreachEvent.findMany({ where: { type: { in: ["unsubscribed", "complained"] } }, select: { outreachId: true, type: true } }),
    db.invitation.findMany({ where: SENT_INVITATION, select: { id: true, campaign: true, firstOpenedAt: true } }),
    // Outcome statuses of emailed prospects only; which of them fall in the round is decided below.
    db.prospectStatusChange.findMany({
      where: { toStatus: { in: OUTCOME_STATUSES }, prospect: { outreach: { some: { sentAt: { not: null } } } } },
      select: { prospectId: true, toStatus: true, createdAt: true },
    }),
  ]);
  const activations = await invitationActivations(db, invitations.map((i) => i.id));

  const rows = new Map<string, FunnelRow>();
  const total = empty("all");
  const row = (c: string | null) => {
    const key = c ?? "(none)";
    if (!rows.has(key)) rows.set(key, empty(key));
    return rows.get(key)!;
  };

  const unsubscribed = new Set(optOuts.filter((e) => e.type === "unsubscribed").map((e) => e.outreachId));
  const complained = new Set(optOuts.filter((e) => e.type === "complained").map((e) => e.outreachId));
  /** Each emailed prospect's first send, and what its round has shown so far. */
  const rounds = new Map<string, { at: Date; campaign: string | null; reached: boolean; replied: boolean }>();

  for (const m of messages) {
    for (const r of [row(m.campaign), total]) {
      if (m.kind === "initial") r.firstMessages++;
      else r.followUps++;
      r.everDrafted++;
      if (m.queuedAt) r.everQueued++;
      if (m.status === "failed" && !m.sentAt) r.refusedBeforeSending++;
      if (m.sentAt) {
        r.sent++;
        if (m.status === "bounced") r.bounced++;
        if (m.status === "failed") r.failedAfterSending++;
      }
      if (m.status === "replied") {
        r.replied++;
        if (!m.replyOutcome) r.unclassified++;
        else if (POSITIVE_REPLIES.includes(m.replyOutcome)) r.positive++;
        else if (NEGATIVE_REPLIES.includes(m.replyOutcome)) r.negative++;
        else r.other++;
      }
      if (unsubscribed.has(m.id)) r.unsubscribed++;
      if (complained.has(m.id)) r.complained++;
    }
    if (!m.sentAt) continue;
    const round = rounds.get(m.prospectId);
    if (!round) rounds.set(m.prospectId, { at: m.sentAt, campaign: m.campaign, reached: false, replied: false });
    else if (m.sentAt < round.at) Object.assign(round, { at: m.sentAt, campaign: m.campaign });
    const r = rounds.get(m.prospectId)!;
    if (REACHED.includes(m.status)) r.reached = true;
    if (m.status === "replied") r.replied = true;
  }

  for (const i of invitations) {
    for (const r of [row(i.campaign), total]) {
      r.invitationsSent++;
      if (i.firstOpenedAt) r.opened++;
      if (activations.has(i.id)) r.activated++;
    }
  }

  // Statuses reached in each prospect's round: at or after its first send, never before it.
  const reached = new Map<string, Set<keyof typeof OUTCOMES>>();
  for (const h of history) {
    const round = rounds.get(h.prospectId);
    if (!round || h.createdAt < round.at) continue;
    if (!reached.has(h.prospectId)) reached.set(h.prospectId, new Set());
    reached.get(h.prospectId)!.add(h.toStatus as keyof typeof OUTCOMES);
  }
  for (const [prospectId, round] of rounds) {
    const got = reached.get(prospectId);
    for (const r of [row(round.campaign), total]) {
      r.prospectsEmailed++;
      if (round.reached) r.prospectsReached++;
      if (round.replied) r.replyingProspects++;
      for (const s of OUTCOME_STATUSES) if (got?.has(s)) r[OUTCOMES[s]]++;
    }
  }
  return [...rows.values(), total];
}
