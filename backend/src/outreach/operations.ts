/*
 * The Outreach operations views (/admin/outreach/messages): read-only lists
 * over the records outreach already keeps. Nothing here writes, drafts,
 * queues, sends, or tracks. Every definition is borrowed, never restated:
 *
 *   - statuses and kinds   lifecycle.ts
 *   - activation           invitationActivations() (invitations/service.ts)
 *   - a sent invitation    SENT_INVITATION (metrics.ts), for the activity
 *                          view's "sent only" filter, which the funnel's
 *                          Opened and Activated link to
 *   - who is eligible      prepareEligibleOutreach() as a dry run, so the
 *                          one eligibility decision (eligibility.ts)
 *
 * What leaves this module is what a page may show: never a token, a token
 * hash, or an invitation id (ids are used for lookups only, then dropped).
 * Free text that can quote an email (a reply, a provider's reason) is still
 * raw here; the views hide invitation tokens before escaping it.
 */
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { invitationActivations } from "../invitations/service.js";
import { scoringInputFromRecord } from "../prospects.js";
import { scoreProspect } from "../scoring.js";
import { CAMPAIGN_PATTERN } from "../validation.js";
import type { ComplianceConfig } from "./compliance.js";
import { SENT_INVITATION } from "./metrics.js";
import { OUTREACH_KINDS, OUTREACH_STATUSES, type OutreachKind, type OutreachStatus } from "./lifecycle.js";
import { prepareEligibleOutreach } from "./prepare.js";
import type { DraftOptions } from "./service.js";

export const PAGE_SIZE = 50;
/** How far back "recent" invitation activity reaches on the Outreach page. */
export const RECENT_ACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;
/** The most eligible prospects one view looks through (the Outreach page uses the same bound). */
export const ELIGIBLE_LIMIT = 1_000;
/**
 * A queued message waiting longer than this, while sending is on and nothing
 * has been sent for as long, means the sender job isn't running.
 */
export const STALE_QUEUE_MS = 2 * 60 * 60 * 1000;

/** The filter value for messages without a campaign (the funnel's "(none)" row). */
export const NO_CAMPAIGN = "(none)";

export const MESSAGE_VIEWS = ["messages", "replies", "activity", "eligible"] as const;
export type MessageView = (typeof MESSAGE_VIEWS)[number];

export interface MessageFilters {
  view: MessageView;
  status: OutreachStatus | null;
  kind: OutreachKind | null;
  /** A campaign, or NO_CAMPAIGN for messages without one. */
  campaign: string | null;
  /** Activity: activated invitations only. */
  activated: boolean;
  /** Activity: invitations whose message was sent only (the funnel's Invitations sent, SENT_INVITATION). */
  sent: boolean;
  page: number;
}

const CAMPAIGN_RE = new RegExp(CAMPAIGN_PATTERN);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);

/** Query string to filters. Anything unrecognised is ignored rather than rejected, as on the other admin lists. */
export function parseMessageFilters(q: Record<string, unknown>): MessageFilters {
  const campaign = typeof q.campaign === "string" && (q.campaign === NO_CAMPAIGN || CAMPAIGN_RE.test(q.campaign)) ? q.campaign : null;
  const page = typeof q.page === "string" && /^\d{1,5}$/.test(q.page) ? Math.max(1, Number(q.page)) : 1;
  return {
    view: oneOf(MESSAGE_VIEWS, q.view) ?? "messages",
    status: oneOf(OUTREACH_STATUSES, q.status),
    kind: oneOf(OUTREACH_KINDS, q.kind),
    campaign,
    activated: q.activated === "1",
    sent: q.sent === "1",
    page,
  };
}

const campaignWhere = (campaign: string | null) => (campaign === null ? {} : { campaign: campaign === NO_CAMPAIGN ? null : campaign });
const pageOf = (page: number) => ({ skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE });

const MESSAGE_SELECT = {
  id: true,
  kind: true,
  template: true,
  campaign: true,
  subject: true,
  status: true,
  statusChangedAt: true,
  recipientEmail: true,
  queuedAt: true,
  sendStartedAt: true,
  sentAt: true,
  failureReason: true,
  cancelReason: true,
  lastSendError: true,
  repliedAt: true,
  replyOutcome: true,
  replySummary: true,
  prospect: { select: { id: true, businessName: true } },
  invitation: { select: { id: true, firstOpenedAt: true, openCount: true, revokedAt: true } },
} satisfies Prisma.OutreachSelect;

type MessageRecord = Prisma.OutreachGetPayload<{ select: typeof MESSAGE_SELECT }>;

/** What a page may know about a message's invitation: no id, no hash. */
export interface InvitationSummary {
  firstOpenedAt: Date | null;
  openCount: number;
  revokedAt: Date | null;
  activatedAt: Date | null;
}
export type MessageRow = Omit<MessageRecord, "invitation"> & { invitation: InvitationSummary | null };

/** Attaches activation (one query for the whole page) and drops the invitation ids. */
async function withActivation(db: Db, rows: MessageRecord[]): Promise<MessageRow[]> {
  const activations = await invitationActivations(db, rows.flatMap((r) => (r.invitation ? [r.invitation.id] : [])));
  return rows.map(({ invitation: inv, ...r }) => ({
    ...r,
    invitation: inv ? { firstOpenedAt: inv.firstOpenedAt, openCount: inv.openCount, revokedAt: inv.revokedAt, activatedAt: activations.get(inv.id) ?? null } : null,
  }));
}

/** Messages, newest change first, filtered and paged in the database. */
export async function listMessages(db: Db, f: MessageFilters) {
  const where: Prisma.OutreachWhereInput = { ...(f.status ? { status: f.status } : {}), ...(f.kind ? { kind: f.kind } : {}), ...campaignWhere(f.campaign) };
  const [total, rows] = await Promise.all([
    db.outreach.count({ where }),
    db.outreach.findMany({ where, orderBy: [{ statusChangedAt: "desc" }, { id: "asc" }], ...pageOf(f.page), select: MESSAGE_SELECT }),
  ]);
  return { total, rows: await withActivation(db, rows) };
}

/** Replied messages: every unclassified reply first, then the classified ones; newest reply first within each. */
export async function listReplies(db: Db, f: MessageFilters) {
  const where: Prisma.OutreachWhereInput = { status: "replied", ...(f.kind ? { kind: f.kind } : {}), ...campaignWhere(f.campaign) };
  const [total, unclassified, rows] = await Promise.all([
    db.outreach.count({ where }),
    db.outreach.count({ where: { ...where, replyOutcome: null } }),
    db.outreach.findMany({
      where,
      orderBy: [{ replyOutcome: { sort: "asc", nulls: "first" } }, { repliedAt: "desc" }, { id: "asc" }],
      ...pageOf(f.page),
      select: MESSAGE_SELECT,
    }),
  ]);
  return { total, unclassified, rows: await withActivation(db, rows) };
}

/**
 * Opened invitations, newest activity first: an open, or activation by its
 * one definition (invitationActivations). Light rows only, so the order can
 * include activation, which isn't a stored column.
 */
async function invitationActivity(db: Db, f: { campaign: string | null; activated: boolean; sent: boolean }) {
  const opened = await db.invitation.findMany({
    where: { firstOpenedAt: { not: null }, ...campaignWhere(f.campaign), ...(f.sent ? SENT_INVITATION : {}) },
    select: { id: true, lastOpenedAt: true },
  });
  const activations = await invitationActivations(db, opened.map((i) => i.id));
  return opened
    .map((i) => {
      const activatedAt = activations.get(i.id) ?? null;
      const opens = i.lastOpenedAt?.getTime() ?? 0;
      const latest = activatedAt && activatedAt.getTime() > opens ? activatedAt : i.lastOpenedAt;
      return { id: i.id, activatedAt, latest: latest!, latestKind: latest === activatedAt ? ("activated" as const) : ("opened" as const) };
    })
    .filter((i) => !f.activated || i.activatedAt)
    .sort((a, b) => b.latest.getTime() - a.latest.getTime() || a.id.localeCompare(b.id));
}

export interface ActivityRow {
  prospect: { id: string; businessName: string | null };
  outreach: { id: string; subject: string; status: OutreachStatus; recipientEmail: string };
  campaign: string | null;
  firstOpenedAt: Date | null;
  openCount: number;
  revokedAt: Date | null;
  activatedAt: Date | null;
  latest: Date;
  latestKind: "opened" | "activated";
}

/** The display rows for some activity items, in their order. */
async function activityRows(db: Db, items: Awaited<ReturnType<typeof invitationActivity>>): Promise<ActivityRow[]> {
  if (!items.length) return [];
  const records = await db.invitation.findMany({
    where: { id: { in: items.map((i) => i.id) } },
    select: {
      id: true,
      campaign: true,
      firstOpenedAt: true,
      openCount: true,
      revokedAt: true,
      prospect: { select: { id: true, businessName: true } },
      outreach: { select: { id: true, subject: true, status: true, recipientEmail: true } },
    },
  });
  const byId = new Map(records.map((r) => [r.id, r]));
  return items.flatMap((i) => {
    const r = byId.get(i.id);
    if (!r) return [];
    return [{ prospect: r.prospect, outreach: r.outreach, campaign: r.campaign, firstOpenedAt: r.firstOpenedAt, openCount: r.openCount, revokedAt: r.revokedAt, activatedAt: i.activatedAt, latest: i.latest, latestKind: i.latestKind }];
  });
}

export async function listActivity(db: Db, f: MessageFilters) {
  const items = await invitationActivity(db, f);
  const { skip, take } = pageOf(f.page);
  return { total: items.length, rows: await activityRows(db, items.slice(skip, skip + take)) };
}

/** Invitation activity since `since`, for the Outreach page's attention list. */
export async function recentActivity(db: Db, now = new Date(), take = 10) {
  const since = now.getTime() - RECENT_ACTIVITY_MS;
  const items = (await invitationActivity(db, { campaign: null, activated: false, sent: false })).filter((i) => i.latest.getTime() >= since);
  return { count: items.length, rows: await activityRows(db, items.slice(0, take)) };
}

export interface EligibleRow {
  id: string;
  businessName: string | null;
  city: string | null;
  state: string | null;
  email: string | null;
  emailSourceUrl: string | null;
  score: number;
  qualification: ReturnType<typeof scoreProspect>["qualification"];
  known: number;
  totalSignals: number;
  evidence: number;
}

/**
 * Who a first draft could be prepared for right now: the same dry run the
 * Outreach page counts (nothing is drafted, no invitation is made), in its
 * order (highest score first), with what the prospect list shows.
 */
export async function listEligible(db: Db, f: MessageFilters, opts: { draft: DraftOptions; compliance: ComplianceConfig }) {
  const report = await prepareEligibleOutreach(db, { draft: opts.draft, compliance: opts.compliance, apply: false, limit: ELIGIBLE_LIMIT });
  const ids = report.drafted.map((d) => d.prospectId);
  const { skip, take } = pageOf(f.page);
  const pageIds = ids.slice(skip, skip + take);
  const prospects = pageIds.length
    ? await db.prospect.findMany({ where: { id: { in: pageIds } }, include: { signals: true, _count: { select: { evidence: true } } } })
    : [];
  const byId = new Map(prospects.map((p) => [p.id, p]));
  const rows = pageIds.flatMap((id): EligibleRow[] => {
    const p = byId.get(id);
    if (!p) return [];
    const result = scoreProspect(scoringInputFromRecord(p));
    return [
      {
        id: p.id,
        businessName: p.businessName,
        city: p.city,
        state: p.state,
        email: p.email,
        emailSourceUrl: p.emailSourceUrl,
        score: result.score,
        qualification: result.qualification,
        known: result.known,
        totalSignals: result.total,
        evidence: p._count.evidence,
      },
    ];
  });
  return { total: ids.length, capped: ids.length >= ELIGIBLE_LIMIT, rows };
}

/** Campaigns that have messages, for the filter. */
export async function messageCampaigns(db: Db) {
  const grouped = await db.outreach.groupBy({ by: ["campaign"], _count: { _all: true }, orderBy: { campaign: "asc" } });
  return grouped.map((g) => ({ campaign: g.campaign ?? NO_CAMPAIGN, count: g._count._all }));
}

/**
 * Whether queued mail is waiting with no sender job running. Only when
 * sending is on and nothing blocks it (the status the Outreach page shows as
 * "Sending is ON", which also means daily capacity is left), the switch has
 * been on for the whole threshold, a message has waited unclaimed beyond it,
 * and nothing has been sent within it. A queue that is merely draining one
 * message per run keeps sending, so it never trips this. Pure.
 */
export function queueLooksStale(s: { sendingLive: boolean; switchedAt: Date | null; oldestQueuedAt: Date | null; lastSentAt: Date | null; now: Date }): boolean {
  if (!s.sendingLive || !s.oldestQueuedAt || !s.switchedAt) return false;
  const cutoff = s.now.getTime() - STALE_QUEUE_MS;
  return s.switchedAt.getTime() <= cutoff && s.oldestQueuedAt.getTime() <= cutoff && (!s.lastSentAt || s.lastSentAt.getTime() <= cutoff);
}

/** Queued messages no dispatcher has claimed yet: how many, and the oldest's queue time. */
export async function waitingQueue(db: Db) {
  const [count, oldest] = await Promise.all([
    db.outreach.count({ where: { status: "queued", sendStartedAt: null } }),
    db.outreach.findFirst({ where: { status: "queued", sendStartedAt: null }, orderBy: { queuedAt: "asc" }, select: { queuedAt: true } }),
  ]);
  return { count, oldestQueuedAt: oldest?.queuedAt ?? null };
}
