/*
 * Read-only projections for the Command Center: the Overview, Health,
 * Activity, Research, and Campaigns. Nothing here drafts, queues, sends,
 * approves, or records anything, and nothing decides anything new: every
 * figure comes from the function that already defines it (named beside it).
 *
 * Two kinds of number, kept apart on purpose:
 *   - operational work (the sending strip, unresolved sends, replies to
 *     classify, drafts): every record, internal tests included, because
 *     they are real messages a person has to handle;
 *   - business figures (funnels, the outreach snapshot, signals): internal
 *     tests excluded, as everywhere else in the admin (REAL_PROSPECT).
 *
 * Each source is loaded on its own (settle): one that fails shows as
 * unavailable on the page, never as zero.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { reviewQueue, STALE_RUN_MS } from "../discovery/service.js";
import { LANE_HINTS } from "../discovery/workQueue.js";
import { invitationActivations } from "../invitations/service.js";
import { readinessErrors } from "../outreach/dispatch.js";
import { REAL_PROSPECT, SENT_INVITATION, outreachMetrics } from "../outreach/metrics.js";
import { ELIGIBLE_LIMIT, STALE_QUEUE_MS, recentActivity } from "../outreach/operations.js";
import { prepareEligibleOutreach } from "../outreach/prepare.js";
import type { OutreachSender } from "../outreach/sender.js";
import type { Status } from "../prospectStatus.js";
import { automaticResearchStatus } from "../research/service.js";
import { loadSummary } from "./stats.js";
import {
  loadSendingFacts,
  rememberedProvider,
  sendingVerdict,
  type ProviderCheckMemo,
  type ProviderKnowledge,
  type SendingFacts,
  type SendingVerdict,
} from "./sendingState.js";
import { openUnsubscribeReviews, shellStatusFrom, type ShellStatus } from "./shell.js";
import { ageText, fmtDate, relTime } from "./ui.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** How many recent invitation-activity rows the Overview reads to count business signals. */
const SIGNAL_SCAN = 500;

// ---------- loading, one source at a time ----------

export type Settled<T> = { ok: true; value: T } | { ok: false };

async function settle<T>(source: string, run: () => Promise<T>, log?: FastifyBaseLogger): Promise<Settled<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    log?.error({ err, source }, "command center source unavailable");
    return { ok: false };
  }
}

const value = <T>(s: Settled<T>): T | null => (s.ok ? s.value : null);

// ---------- system status rail ----------

/** Verified now (checked by this request), recent (a record shows it worked), attention, down, not observable, or off. */
export type RailState = "verified" | "recent" | "attention" | "down" | "unknown" | "off";

export interface RailCell {
  key: "web" | "database" | "sender" | "inbox" | "research" | "discovery" | "dispatcher";
  name: string;
  state: RailState;
  label: string;
  evidence: string;
  href: string;
}

export const RAIL_GLYPHS: Record<RailState, string> = { verified: "●", recent: "◐", attention: "▲", down: "✕", unknown: "◌", off: "○" };

async function pingDatabase(db: Db) {
  const started = performance.now();
  await db.$queryRaw`SELECT 1`;
  return Math.max(1, Math.round(performance.now() - started));
}

/** Discovery runs that look stuck, by processQueuedRuns' own rule (STALE_RUN_MS without a heartbeat), and the latest run. */
async function discoveryRunHealth(db: Db, now: Date) {
  const staleBefore = new Date(now.getTime() - STALE_RUN_MS);
  const [stalled, waiting, running, latest] = await Promise.all([
    db.discoveryRun.count({ where: { status: "running", heartbeatAt: { lt: staleBefore } } }),
    db.discoveryRun.count({ where: { status: "queued", createdAt: { lt: staleBefore } } }),
    db.discoveryRun.count({ where: { status: "running" } }),
    db.discoveryRun.findFirst({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { status: true, error: true, createdAt: true, finishedAt: true } }),
  ]);
  return { stalled, waiting, running, latest };
}

/** The newest reply the mailbox reader recorded (a Gmail message ID), as evidence it has run. Not a heartbeat. */
const latestMailboxReply = (db: Db) =>
  db.outreachReply.findFirst({ where: { gmailMessageId: { not: null } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } });

interface SendingView {
  facts: SendingFacts;
  verdict: SendingVerdict;
  provider: ProviderKnowledge;
  readiness: string[];
}

function senderCell(s: SendingView | null, now: Date): RailCell {
  const base = { key: "sender" as const, name: "Sender", href: "/admin/outreach#provider" };
  if (!s) return { ...base, state: "unknown", label: "Unavailable", evidence: "The sending state could not be loaded." };
  const { verdict, provider, readiness } = s;
  if (verdict.mode === "blocked") return { ...base, state: "down", label: "Blocked", evidence: verdict.blockers[0] ?? "Sending is on but blocked." };
  if (readiness.length) return { ...base, state: "attention", label: "Not ready", evidence: readiness[0]! + (readiness.length > 1 ? ` (+${readiness.length - 1} more)` : "") };
  if (provider.kind === "remembered") {
    return provider.problem
      ? { ...base, state: "attention", label: "Authorization problem", evidence: `Gmail check ${relTime(provider.at, now)}: ${provider.problem}` }
      : { ...base, state: "recent", label: "Authorized", evidence: `Gmail verified live ${relTime(provider.at, now)} on the Sending page.` };
  }
  if (provider.kind === "unchecked") return { ...base, state: "unknown", label: "Not verified here", evidence: "Gmail authorization is checked live on the Sending page only." };
  return { ...base, state: verdict.mode === "off" ? "off" : "unknown", label: verdict.mode === "off" ? "Configured · off" : "Configured", evidence: "This provider has no live check." };
}

function dispatcherCell(s: SendingView | null, now: Date): RailCell {
  const base = { key: "dispatcher" as const, name: "Dispatcher", href: "/admin/outreach" };
  if (!s) return { ...base, state: "unknown", label: "Unavailable", evidence: "The sending state could not be loaded." };
  const { facts, verdict } = s;
  const waiting = facts.waiting.count;
  const last = facts.attention.lastSentAt;
  if (verdict.mode === "off") return { ...base, state: "off", label: "Off", evidence: waiting ? `${waiting} queued wait for the switch.` : "Sending is off; nothing is queued." };
  if (verdict.mode === "blocked") return { ...base, state: "down", label: "Blocked", evidence: "Nothing can be sent until the blocker is fixed." };
  if (verdict.mode === "paused") return { ...base, state: "attention", label: "Paused", evidence: "The daily limit is used up for the rolling 24 hours." };
  if (verdict.stale) return { ...base, state: "attention", label: "Not sending", evidence: `Queued mail has waited over ${STALE_QUEUE_MS / 3_600_000} h with nothing sent.` };
  if (last && now.getTime() - last.getTime() <= STALE_QUEUE_MS) return { ...base, state: "recent", label: "Sent recently", evidence: `Last send ${relTime(last, now)}.` };
  return { ...base, state: "unknown", label: waiting ? "Waiting" : "Idle", evidence: waiting ? `${waiting} queued; no send recorded within ${STALE_QUEUE_MS / 3_600_000} h.` : "Nothing queued. A sender heartbeat isn't recorded." };
}

function researchCell(r: Awaited<ReturnType<typeof automaticResearchStatus>> | null, now: Date): RailCell {
  const base = { key: "research" as const, name: "Research", href: "/admin/research" };
  if (!r) return { ...base, state: "unknown", label: "Unavailable", evidence: "The research worker's records could not be loaded." };
  const day = `${r.researched24h} researched, ${r.failed24h} failed in 24 h`;
  // automaticResearchStatus' own rule: candidates waiting, and no automatic run in the last hour.
  if (r.stale) return { ...base, state: "attention", label: "Not running", evidence: `${r.waitingFresh + r.waitingRetries} candidates wait; no automatic run in the last hour.` };
  if (!r.lastRunAt) return { ...base, state: "unknown", label: "No runs recorded", evidence: "The automatic research worker hasn't queued any run." };
  if (now.getTime() - r.lastRunAt.getTime() <= 60 * 60 * 1000) return { ...base, state: "recent", label: "Ran recently", evidence: `Last automatic run ${relTime(r.lastRunAt, now)} · ${day}.` };
  return { ...base, state: "unknown", label: "Idle", evidence: `Nothing waits. Last automatic run ${relTime(r.lastRunAt, now)}.` };
}

function discoveryCell(d: Awaited<ReturnType<typeof discoveryRunHealth>> | null, now: Date): RailCell {
  const base = { key: "discovery" as const, name: "Discovery", href: "/admin/discovery#runs" };
  if (!d) return { ...base, state: "unknown", label: "Unavailable", evidence: "Discovery runs could not be loaded." };
  if (d.stalled) return { ...base, state: "attention", label: "Run stalled", evidence: `${d.stalled} running without a heartbeat for ${STALE_RUN_MS / 60_000} min.` };
  if (d.waiting) return { ...base, state: "attention", label: "Runs waiting", evidence: `${d.waiting} queued for over ${STALE_RUN_MS / 60_000} min.` };
  if (d.latest?.status === "failed") return { ...base, state: "attention", label: "Last run failed", evidence: "The latest discovery run failed. Inspect its recorded result in Discovery." };
  if (d.running) return { ...base, state: "recent", label: "Running", evidence: `${d.running} run in progress.` };
  if (!d.latest) return { ...base, state: "unknown", label: "No runs yet", evidence: "No discovery run has been recorded." };
  return { ...base, state: "unknown", label: "Idle", evidence: `Last run ${relTime(d.latest.finishedAt ?? d.latest.createdAt, now)} completed.` };
}

function inboxCell(latest: Settled<{ createdAt: Date } | null>, now: Date): RailCell {
  const base = { key: "inbox" as const, name: "Inbox", href: "/admin/outreach/messages?view=replies" };
  if (!latest.ok) return { ...base, state: "unknown", label: "Unavailable", evidence: "Reply records could not be loaded." };
  return {
    ...base,
    state: "unknown",
    label: "Not observable",
    evidence: latest.value ? `No inbox heartbeat. Last reply read from the mailbox ${relTime(latest.value.createdAt, now)}.` : "No inbox heartbeat, and no reply read from the mailbox yet.",
  };
}

export interface SystemStatus {
  at: Date;
  rail: RailCell[];
  sending: SendingView | null;
  shell: ShellStatus | null;
  reviews: Settled<number>;
}

/** The status rail and the sending state: the Overview's top half and the Health page. */
export async function loadSystemStatus(
  db: Db,
  config: Config,
  sender: OutreachSender,
  memo: ProviderCheckMemo | undefined,
  now = new Date(),
  log?: FastifyBaseLogger,
): Promise<SystemStatus> {
  const [ping, facts, reviews, research, discovery, inbox] = await Promise.all([
    settle("database", () => pingDatabase(db), log),
    settle("sending", () => loadSendingFacts(db, config, now), log),
    settle("unsubscribe reviews", () => openUnsubscribeReviews(db), log),
    settle("research", () => automaticResearchStatus(db, now), log),
    settle("discovery runs", () => discoveryRunHealth(db, now), log),
    settle("inbox", () => latestMailboxReply(db), log),
  ]);
  const provider = rememberedProvider(config, memo);
  const readiness = readinessErrors(config, sender);
  let sending: SendingView | null = null;
  if (facts.ok) {
    const f = facts.value;
    const verdict = sendingVerdict({ sw: f.sw, readiness, provider, capacity: f.capacity, queued: f.queued, oldestQueuedAt: f.waiting.oldestQueuedAt, lastSentAt: f.attention.lastSentAt, now });
    sending = { facts: f, verdict, provider, readiness };
  }
  const rail: RailCell[] = [
    { key: "web", name: "Web", state: "verified", label: "Verified now", evidence: `Served this page at ${fmtDate(now).slice(11)}.`, href: "/admin/system" },
    ping.ok
      ? { key: "database", name: "Database", state: "verified", label: "Verified now", evidence: `Read query answered in ${ping.value} ms.`, href: "/admin/system" }
      : { key: "database", name: "Database", state: "down", label: "Down", evidence: "A read query failed on this request.", href: "/admin/system" },
    senderCell(sending, now),
    inboxCell(inbox, now),
    researchCell(value(research), now),
    discoveryCell(value(discovery), now),
    dispatcherCell(sending, now),
  ];
  const shell = sending && reviews.ok ? shellStatusFrom(sending.facts, sending.verdict, provider, reviews.value) : null;
  return { at: now, rail, sending, shell, reviews };
}

// ---------- what needs attention ----------

export type Tier = 1 | 2 | 3 | 4 | 5;
export const TIER_LABELS: Record<Tier, string> = { 1: "Safety", 2: "Inbound", 3: "Pipeline decisions", 4: "Outreach work", 5: "Signals" };

export interface AttentionItem {
  key: string;
  tier: Tier;
  tone: "neg" | "warn" | "info" | "pos";
  count: number;
  title: string;
  why: string;
  /** How long the oldest item has waited, or (signals) how recent the latest is; null when not tracked. */
  age: { kind: "oldest" | "latest"; text: string } | null;
  href: string;
  action: string;
  where: string;
}

const oldest = (dates: (Date | null | undefined)[], now: Date): AttentionItem["age"] => {
  const ds = dates.filter((d): d is Date => d instanceof Date);
  if (!ds.length) return null;
  return { kind: "oldest", text: ageText(new Date(Math.min(...ds.map((d) => d.getTime()))), now) };
};

/** Items in priority order (tiers 1 to 5, then as listed), zero counts left out. Pure. */
export function attentionItems(i: {
  now: Date;
  sending: SendingView | null;
  reviews: Settled<{ count: number; oldest: Date | null }>;
  queue: Settled<Awaited<ReturnType<typeof reviewQueue>>>;
  eligible: Settled<number>;
  drafts: Settled<{ count: number; oldest: Date | null }>;
  signals: Settled<{ count: number; latest: Date | null }>;
}): AttentionItem[] {
  const { now } = i;
  const items: AttentionItem[] = [];
  const s = i.sending;
  if (s) {
    const stuck = s.facts.stuck;
    items.push({
      key: "unresolved",
      tier: 1,
      tone: "neg",
      count: stuck.length,
      title: stuck.length === 1 ? "Resolve an unknown send outcome" : "Resolve unknown send outcomes",
      why: "The provider may or may not have sent these. Check the provider, then record the outcome or discard. They are never retried automatically.",
      age: oldest(stuck.map((m) => m.sendStartedAt), now),
      href: stuck.length === 1 ? `/admin/outreach/${stuck[0]!.id}` : "/admin/outreach#attention",
      action: stuck.length === 1 ? "Open message" : "Review",
      where: "Sending",
    });
    if (s.verdict.mode === "blocked") {
      items.push({ key: "blocked", tier: 1, tone: "neg", count: s.verdict.blockers.length, title: "Unblock sending, or switch it off", why: `Sending is on but nothing can go out: ${s.verdict.blockers[0]}`, age: null, href: "/admin/outreach", action: "Open Sending", where: "Sending" });
    }
    if (s.verdict.stale) {
      items.push({
        key: "stale",
        tier: 1,
        tone: "warn",
        count: s.facts.waiting.count,
        title: "Check the sender job",
        why: `Sending is on, but nothing has gone out for over ${STALE_QUEUE_MS / 3_600_000} hours while mail waits in the queue.`,
        age: oldest([s.facts.waiting.oldestQueuedAt], now),
        href: "/admin/outreach",
        action: "Open Sending",
        where: "Sending",
      });
    }
  }
  if (i.reviews.ok) {
    items.push({ key: "reviews", tier: 1, tone: "neg", count: i.reviews.value.count, title: "Review ambiguous unsubscribe requests", why: "Each stays unsuppressed until you resolve it to one recipient or dismiss it. Nothing is assigned by guesswork.", age: oldest([i.reviews.value.oldest], now), href: "/admin/outreach/unsubscribe-reviews", action: "Review", where: "Unsubscribe reviews" });
  }
  if (s) {
    const a = s.facts.attention;
    items.push({ key: "replies", tier: 2, tone: "warn", count: a.replyCount, title: a.replyCount === 1 ? "Classify a reply" : "Classify replies", why: "Read each reply and record how they answered. An opt-out must be honoured promptly.", age: oldest([a.replies[0]?.repliedAt], now), href: "/admin/outreach/messages?view=replies", action: "Classify", where: "Replies" });
  }
  if (i.queue.ok) {
    const q = i.queue.value;
    // The age of a lane's oldest item, only when every item of the lane is among the ones loaded.
    const laneAge = (lane: "decision" | "ready" | "verify") => {
      const inLane = q.items.filter((it) => it.step.lane === lane);
      return inLane.length === q.counts[lane] ? oldest(inLane.map((it) => it.candidate.discoveredAt), now) : null;
    };
    const dups = q.counts.duplicates;
    items.push({ key: "decide", tier: 3, tone: "warn", count: q.counts.decision, title: "Decide on candidates", why: `${LANE_HINTS.decision}${dups ? ` ${dups} ${dups === 1 ? "is a possible duplicate" : "are possible duplicates"}.` : ""}`, age: laneAge("decision"), href: "/admin/discovery?view=decision", action: "Decide", where: "Discovery" });
    items.push({ key: "approve", tier: 3, tone: "info", count: q.counts.ready, title: "Approve ready candidates", why: `${LANE_HINTS.ready} Approval adds each as a New prospect.`, age: laneAge("ready"), href: "/admin/discovery?view=ready", action: "Review", where: "Discovery" });
    items.push({ key: "verify", tier: 3, tone: "info", count: q.counts.verify, title: "Verify candidate evidence", why: LANE_HINTS.verify, age: laneAge("verify"), href: "/admin/discovery?view=verify", action: "Verify", where: "Discovery" });
  }
  if (i.eligible.ok) {
    items.push({ key: "eligible", tier: 4, tone: "info", count: i.eligible.value, title: "Prepare first drafts", why: "These prospects pass every eligibility check for a first message. Preparing makes drafts only; nothing is queued or sent.", age: null, href: "/admin/outreach/messages?view=eligible", action: "Choose", where: "Prepare" });
  }
  if (i.drafts.ok) {
    items.push({ key: "drafts", tier: 4, tone: "info", count: i.drafts.value.count, title: "Review drafts", why: "Each draft needs your review before it can be queued. Queueing sends nothing by itself.", age: oldest([i.drafts.value.oldest], now), href: "/admin/outreach/messages?status=draft", action: "Review", where: "Messages" });
  }
  if (s) {
    const a = s.facts.attention;
    items.push({ key: "refused", tier: 4, tone: "warn", count: a.failureCount, title: "Look into provider refusals", why: "Refused by the provider in the last 7 days, so not sent. An invalid address is suppressed; anything else can be prepared again once fixed.", age: oldest(a.failureCount <= a.failures.length ? a.failures.map((f) => f.failedAt) : [], now), href: "/admin/outreach/messages?status=failed", action: "Review", where: "Messages" });
  }
  if (i.signals.ok) {
    const sg = i.signals.value;
    items.push({ key: "signals", tier: 5, tone: "pos", count: sg.count, title: "Review invitation engagement", why: `Recorded invitation activity in the last 7 days, among the latest ${SIGNAL_SCAN} activity records. Review it before considering any follow-up.`, age: sg.latest ? { kind: "latest", text: ageText(sg.latest, now) } : null, href: "/admin/outreach/messages?view=activity", action: "See activity", where: "Messages" });
  }
  return items.filter((it) => it.count > 0).sort((a, b) => a.tier - b.tier);
}

// ---------- funnels ----------

/** The pipeline stages a prospect moves through, in order. Exits (not a fit, lost, …) are not stages. */
export const PIPELINE: readonly Status[] = ["new", "qualified", "ready_to_contact", "contacted", "engaged", "meeting", "proposal", "customer"];
/** Statuses that leave the pipeline, shown apart from the inventory's stages. */
export const CLOSED_STATUSES: readonly Status[] = ["not_a_fit", "lost", "do_not_contact", "archived"];

/**
 * For each business prospect (internal tests excluded), count only actual
 * current or historical state records. A later exit does not erase a
 * recorded stage, and missing intermediate stages are never inferred.
 */
async function recordedStages(db: Db): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ stage: string; n: number }[]>`
    SELECT v.st AS stage, COUNT(DISTINCT p.id)::int AS n
      FROM "Prospect" p
      LEFT JOIN "ProspectStatusChange" c ON c."prospectId" = p.id
      CROSS JOIN LATERAL (VALUES (p.status::text), (c."toStatus"::text)) AS v(st)
      WHERE NOT p."internalTest"
      GROUP BY v.st`;
  return new Map(rows.map(r => [r.stage, r.n]));
}

export interface AcquisitionFunnel {
  candidates: number;
  approved: number;
  prospects: number;
  /** Distinct business prospects actually recorded in this current or historical state. */
  everReached: (stage: Status) => number;
  /** outreachMetrics' total row: prospects emailed, reached, replying; invitations opened, activated; outcomes since the first email. */
  outreach: Awaited<ReturnType<typeof outreachMetrics>>[number];
  inventory: Partial<Record<Status, number>>;
}

async function acquisitionFunnel(db: Db): Promise<AcquisitionFunnel> {
  const [candidates, approved, stages, metrics, inventory] = await Promise.all([
    db.discoveryCandidate.count(),
    db.discoveryCandidate.count({ where: { status: "approved" } }),
    recordedStages(db),
    outreachMetrics(db),
    db.prospect.groupBy({ by: ["status"], where: REAL_PROSPECT, _count: { _all: true } }),
  ]);
  const total = inventory.reduce((n, g) => n + g._count._all, 0);
  return {
    candidates,
    approved,
    prospects: total,
    everReached: stage => stages.get(stage) ?? 0,
    outreach: metrics[metrics.length - 1]!,
    inventory: Object.fromEntries(inventory.map((g) => [g.status, g._count._all])),
  };
}

// ---------- outreach, last 7 days ----------

/** Business outreach in the last 7 days (internal tests excluded), each by the record's own timestamp. */
async function lastWeek(db: Db, now: Date) {
  const since = new Date(now.getTime() - WEEK_MS);
  const real = { prospect: REAL_PROSPECT };
  const [sent, replies, optOuts, failed, opened] = await Promise.all([
    db.outreach.count({ where: { sentAt: { gte: since }, ...real } }),
    db.outreachReply.count({ where: { receivedAt: { gte: since }, outreach: real } }),
    db.outreachEvent.count({ where: { type: "unsubscribed", createdAt: { gte: since }, outreach: real } }),
    db.outreach.count({ where: { failedAt: { gte: since }, sentAt: null, ...real } }),
    db.invitation.findMany({ where: { ...SENT_INVITATION, ...real, firstOpenedAt: { not: null } }, select: { id: true, firstOpenedAt: true } }),
  ]);
  // Activation by its one definition (invitationActivations): a real scan by a visitor who arrived through the link, after it opened.
  const activations = await invitationActivations(db, opened.map((i) => i.id));
  return {
    since,
    sent,
    replies,
    optOuts,
    failed,
    opened: opened.filter((i) => i.firstOpenedAt! >= since).length,
    activated: [...activations.values()].filter((d) => d >= since).length,
  };
}

// ---------- recent activity ----------

export interface ActivityEvent {
  key: string;
  at: Date;
  label: string;
  name: string | null;
  href: string;
  kind: "outreach" | "prospects" | "discovery" | "research" | "product";
  internal: boolean;
}

const MESSAGE_EVENT_LABELS: Record<string, string> = {
  drafted: "Draft prepared",
  queued: "Message queued",
  sent: "Message sent",
  delivered: "Message delivered",
  replied: "Reply received",
  unsubscribed: "Opt-out recorded",
  complained: "Spam complaint recorded",
  bounced: "Message bounced",
  failed: "Message failed",
  cancelled: "Message discarded",
};
const PRODUCT_EVENT_LABELS: Record<string, string> = {
  landing_view: "Product visited",
  upload_started: "Upload started",
  scan_completed: "Analysis completed",
  report_exported: "Report exported",
  tour_completed: "Report tour completed",
  contact_clicked: "Contact clicked",
};

/**
 * Recorded events across discovery, research, prospects, outreach, and the
 * product, newest first. Labels are fixed words; free text (event details,
 * reasons, reply text) is never shown here, so no invitation token or
 * provider detail can appear.
 */
export async function commandActivity(db: Db, includeInternal = false, perSource = 50): Promise<ActivityEvent[]> {
  const prospectScope = includeInternal ? {} : REAL_PROSPECT;
  const take = perSource;
  const [messages, statuses, candidates, research, product] = await Promise.all([
    db.outreachEvent.findMany({ where: { outreach: { prospect: prospectScope } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, select: { id: true, type: true, detail: true, createdAt: true, outreach: { select: { id: true, prospect: { select: { businessName: true, internalTest: true } } } } } }),
    db.prospectStatusChange.findMany({ where: { prospect: prospectScope }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, select: { id: true, toStatus: true, createdAt: true, prospect: { select: { id: true, businessName: true, internalTest: true } } } }),
    db.discoveryCandidate.findMany({ orderBy: [{ discoveredAt: "desc" }, { id: "desc" }], take, select: { id: true, businessName: true, provider: true, discoveredAt: true } }),
    db.candidateResearch.findMany({ where: { finishedAt: { not: null } }, orderBy: [{ finishedAt: "desc" }, { id: "desc" }], take, select: { id: true, status: true, finishedAt: true, candidate: { select: { id: true, businessName: true } } } }),
    db.productEvent.findMany({ where: { isSample: false, ...(includeInternal ? {} : { OR: [{ prospectId: null }, { prospect: REAL_PROSPECT }] }) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, select: { id: true, eventType: true, createdAt: true, prospect: { select: { id: true, businessName: true, internalTest: true } } } }),
  ]);
  const events: ActivityEvent[] = [
    ...messages.map((e) => ({
      key: `message-${e.id}`,
      at: e.createdAt,
      // "Classified reply …" is the classification's own event; only its fixed prefix is read, never shown.
      label: e.type === "replied" && e.detail?.startsWith("Classified reply ") ? "Reply classified" : (MESSAGE_EVENT_LABELS[e.type] ?? "Message updated"),
      name: e.outreach.prospect.businessName,
      href: `/admin/outreach/${e.outreach.id}`,
      kind: "outreach" as const,
      internal: e.outreach.prospect.internalTest,
    })),
    ...statuses.map((e) => ({
      key: `status-${e.id}`,
      at: e.createdAt,
      label: e.toStatus === "new" ? "Prospect created" : `Prospect moved to ${e.toStatus.replace(/_/g, " ")}`,
      name: e.prospect.businessName,
      href: `/admin/prospects/${e.prospect.id}`,
      kind: "prospects" as const,
      internal: e.prospect.internalTest,
    })),
    ...candidates.map((e) => ({ key: `candidate-${e.id}`, at: e.discoveredAt, label: e.provider === "manual" ? "Candidate added" : "Candidate discovered", name: e.businessName, href: `/admin/discovery/candidates/${e.id}`, kind: "discovery" as const, internal: false })),
    ...research.map((e) => ({ key: `research-${e.id}`, at: e.finishedAt!, label: e.status === "failed" ? "Research failed" : "Research completed", name: e.candidate.businessName, href: `/admin/discovery/candidates/${e.candidate.id}#research`, kind: "research" as const, internal: false })),
    ...product.map((e) => ({
      key: `product-${e.id}`,
      at: e.createdAt,
      label: PRODUCT_EVENT_LABELS[e.eventType] ?? "Product event",
      name: e.prospect ? e.prospect.businessName : "Direct visitor",
      href: e.prospect ? `/admin/prospects/${e.prospect.id}#activity` : "/admin/analytics",
      kind: "product" as const,
      internal: e.prospect?.internalTest ?? false,
    })),
  ];
  return events.sort((a, b) => b.at.getTime() - a.at.getTime() || a.key.localeCompare(b.key)).slice(0, perSource);
}
export type CommandActivity = ActivityEvent[];

/** Events grouped by UTC day, newest day first. Pure. */
export function groupByDay(events: readonly ActivityEvent[], now: Date): { label: string; events: ActivityEvent[] }[] {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const today = day(now);
  const yesterday = day(new Date(now.getTime() - DAY_MS));
  const groups: { key: string; label: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const k = day(e.at);
    let g = groups.find((x) => x.key === k);
    if (!g) {
      g = { key: k, label: k === today ? "Today" : k === yesterday ? "Yesterday" : k, events: [] };
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups.map(({ label, events }) => ({ label, events }));
}

// ---------- the Overview ----------

export interface OverviewData {
  at: Date;
  system: SystemStatus;
  attention: AttentionItem[];
  /** Sources that couldn't be loaded, so the attention list says it may be incomplete. */
  attentionGaps: string[];
  funnel: Settled<AcquisitionFunnel>;
  candidatesInReview: number | null;
  product: Settled<Awaited<ReturnType<typeof loadSummary>>>;
  week: Settled<Awaited<ReturnType<typeof lastWeek>>>;
  activity: Settled<ActivityEvent[]>;
}

export async function loadOverview(
  db: Db,
  config: Config,
  sender: OutreachSender,
  memo: ProviderCheckMemo | undefined,
  now = new Date(),
  log?: FastifyBaseLogger,
): Promise<OverviewData> {
  const draft = { siteUrl: config.publicSiteUrl, sender: config.outreachSender };
  const [system, reviewAge, queue, eligible, drafts, signals, funnel, product, week, activity] = await Promise.all([
    loadSystemStatus(db, config, sender, memo, now, log),
    settle("unsubscribe review age", () => db.emailedUnsubscribeReview.findFirst({ where: { state: "open" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }), log),
    // The Discovery work queue's own lanes (scores every candidate: the heaviest read here).
    settle("discovery queue", () => reviewQueue(db, {}, "all"), log),
    // The Sending page's own eligibility dry run: nothing is drafted.
    settle("eligibility", async () => {
      const report = await prepareEligibleOutreach(db, { draft, compliance: config, apply: false, limit: ELIGIBLE_LIMIT });
      return db.prospect.count({ where: { id: { in: report.drafted.map(p => p.prospectId) }, ...REAL_PROSPECT } });
    }, log),
    settle("drafts", async () => {
      const [count, first] = await Promise.all([
        db.outreach.count({ where: { status: "draft" } }),
        db.outreach.findFirst({ where: { status: "draft" }, orderBy: { statusChangedAt: "asc" }, select: { statusChangedAt: true } }),
      ]);
      return { count, oldest: first?.statusChangedAt ?? null };
    }, log),
    settle("invitation activity", async () => {
      const rows = (await recentActivity(db, now, SIGNAL_SCAN)).rows.filter((r) => !r.prospect.internalTest);
      return { count: rows.length, latest: rows[0]?.latest ?? null };
    }, log),
    settle("acquisition funnel", () => acquisitionFunnel(db), log),
    settle("product funnel", () => loadSummary(db), log),
    settle("last 7 days", () => lastWeek(db, now), log),
    settle("activity", () => commandActivity(db, false, 12), log),
  ]);
  const reviews: Settled<{ count: number; oldest: Date | null }> =
    system.reviews.ok && reviewAge.ok ? { ok: true, value: { count: system.reviews.value, oldest: reviewAge.value?.createdAt ?? null } } : { ok: false };
  const gaps = [
    !system.sending && "sending",
    !reviews.ok && "unsubscribe reviews",
    !queue.ok && "Discovery queue",
    !eligible.ok && "eligibility",
    !drafts.ok && "drafts",
    !signals.ok && "invitation activity",
  ].filter((g): g is string => Boolean(g));
  return {
    at: now,
    system,
    attention: attentionItems({ now, sending: system.sending, reviews, queue, eligible, drafts, signals }),
    attentionGaps: gaps,
    funnel,
    candidatesInReview: queue.ok ? queue.value.counts.active : null,
    product,
    week,
    activity,
  };
}

// ---------- other read-only workspaces (unchanged in this phase) ----------

export async function researchWorkspace(db: Db, status?: string, q?: string) {
  const valid = ["queued", "running", "completed", "failed"].includes(status ?? "") ? (status as "queued" | "running" | "completed" | "failed") : undefined;
  const search = q?.trim().slice(0, 100);
  const where = { ...(valid ? { status: valid } : {}), ...(search ? { candidate: { businessName: { contains: search, mode: "insensitive" as const } } } : {}) };
  const [rows, total] = await Promise.all([
    db.candidateResearch.findMany({ where, orderBy: [{ queuedAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, status: true, outcome: true, queuedAt: true, finishedAt: true, heartbeatAt: true, pagesFetched: true, warnings: true, candidate: { select: { id: true, businessName: true, city: true, state: true } }, _count: { select: { facts: true, sources: true } } } }),
    db.candidateResearch.count({ where }),
  ]);
  return { rows, total, status: valid, q: search };
}

export async function campaignWorkspace(db: Db) {
  const [metrics, versions] = await Promise.all([
    outreachMetrics(db),
    db.outreach.groupBy({ by: ["campaign", "template"], where: { prospect: REAL_PROSPECT }, _count: { _all: true } }),
  ]);
  return { metrics, versions };
}

/** List presentation data only; eligibility continues to be decided by the existing services. */
export async function prospectListContext(db: Db, ids: string[]) {
  if (!ids.length) return [];
  return db.prospect.findMany({ where: { id: { in: ids } }, select: { id: true, evidence: { where: { signalKey: "collision_repair_services" }, select: { sourceUrl: true } }, outreach: { orderBy: { statusChangedAt: "desc" }, take: 1, select: { status: true, statusChangedAt: true } } } });
}
