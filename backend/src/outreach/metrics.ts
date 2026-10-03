/*
 * Outreach funnel, computed from the raw records only: Outreach rows, their
 * append-only events, and each prospect's status history. Nothing here is
 * stored, so changing a definition never needs a migration.
 *
 * Commercial outcomes are attributed to the campaign of the prospect's first
 * sent message. Revenue isn't recorded anywhere yet (billing comes later).
 */
import type { Db } from "../db.js";
import { NEGATIVE_REPLIES, POSITIVE_REPLIES } from "./lifecycle.js";

export interface FunnelRow {
  campaign: string;
  drafted: number;
  /** Approved for sending (each message once, even if later cancelled). */
  queued: number;
  prospectsEntered: number;
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  replied: number;
  positive: number;
  negative: number;
  unclassified: number;
  unsubscribed: number;
  complained: number;
  meetings: number;
  proposals: number;
  customers: number;
  lost: number;
}

const empty = (campaign: string): FunnelRow => ({
  campaign,
  drafted: 0,
  queued: 0,
  prospectsEntered: 0,
  sent: 0,
  delivered: 0,
  bounced: 0,
  failed: 0,
  replied: 0,
  positive: 0,
  negative: 0,
  unclassified: 0,
  unsubscribed: 0,
  complained: 0,
  meetings: 0,
  proposals: 0,
  customers: 0,
  lost: 0,
});

/** One row per campaign, plus a total row ("all"). */
export async function outreachMetrics(db: Db): Promise<FunnelRow[]> {
  const messages = await db.outreach.findMany({
    select: { prospectId: true, campaign: true, status: true, queuedAt: true, sentAt: true, deliveredAt: true, replyOutcome: true, events: { select: { type: true } } },
    orderBy: { createdAt: "asc" },
  });
  const rows = new Map<string, FunnelRow>();
  const total = empty("all");
  const row = (c: string | null) => {
    const key = c ?? "(none)";
    if (!rows.has(key)) rows.set(key, empty(key));
    return rows.get(key)!;
  };
  const firstCampaign = new Map<string, string | null>();
  for (const m of messages) {
    for (const r of [row(m.campaign), total]) {
      r.drafted++;
      if (m.queuedAt) r.queued++;
      if (m.sentAt) r.sent++;
      if (m.deliveredAt) r.delivered++;
      if (m.status === "bounced") r.bounced++;
      if (m.status === "failed") r.failed++;
      if (m.status === "replied") {
        r.replied++;
        if (m.replyOutcome && POSITIVE_REPLIES.includes(m.replyOutcome)) r.positive++;
        else if (m.replyOutcome && NEGATIVE_REPLIES.includes(m.replyOutcome)) r.negative++;
        else if (!m.replyOutcome) r.unclassified++;
      }
      if (m.events.some((e) => e.type === "unsubscribed")) r.unsubscribed++;
      if (m.events.some((e) => e.type === "complained")) r.complained++;
    }
    if (m.sentAt && !firstCampaign.has(m.prospectId)) firstCampaign.set(m.prospectId, m.campaign);
  }

  const history = await db.prospectStatusChange.findMany({
    where: { prospectId: { in: [...firstCampaign.keys()] } },
    select: { prospectId: true, toStatus: true },
  });
  const reached = new Map<string, Set<string>>();
  for (const h of history) {
    if (!reached.has(h.prospectId)) reached.set(h.prospectId, new Set());
    reached.get(h.prospectId)!.add(h.toStatus);
  }
  for (const [prospectId, campaign] of firstCampaign) {
    const got = reached.get(prospectId) ?? new Set();
    for (const r of [row(campaign), total]) {
      r.prospectsEntered++;
      if (got.has("meeting")) r.meetings++;
      if (got.has("proposal")) r.proposals++;
      if (got.has("customer")) r.customers++;
      if (got.has("lost")) r.lost++;
    }
  }
  return [...rows.values(), total];
}
