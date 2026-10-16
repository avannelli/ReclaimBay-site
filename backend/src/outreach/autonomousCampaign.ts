/*
 * M2: one bounded autonomous campaign, from launch to its messages, on the existing machinery.
 *
 *   launch     after a preflight (provider live check, sender identity, this deployment's arm, the
 *              switch, queue and capacity, eligible candidates), a person's explicit confirmation
 *              authorizes the campaign (discovery/autonomous.ts) AND switches sending on with that
 *              campaign active, in one send-gate transaction.
 *   prepare    for the campaign's own prospects (created by createProspectAutonomously), the existing
 *              deterministic draft (createOutreachDraft: template, invitation, eligibility), then, under
 *              the send gate and the campaign row lock, the existing queue operation plus a campaign
 *              membership carrying approvedMessageHash: the dispatcher's existing fingerprint check is
 *              unchanged. The message cap counts every membership ever committed (memberships are never
 *              deleted), so cancellations, failures and re-preparations cannot reuse capacity.
 *   stop       emergencyStop switches sending off and stops every autonomous campaign for good, in one
 *              send-gate transaction; preparation, queueing and dispatch all decide under that gate.
 *
 * Nothing here calls a sender. The provider's live check runs outside every transaction.
 */
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { ProspectError } from "../prospects.js";
import {
  activeAutonomousCampaign, autonomousCampaignStatus, autonomousCandidates, authorizeAutonomousCampaignInTx, campaignState, createProspectAutonomously, lockCampaign, recordAutonomousRefusal, refusals,
  AUTONOMOUS_COMMERCIAL_MINIMUM, type AuthorizationInput,
} from "../discovery/autonomous.js";
import type { CommercialMinimum } from "../discovery/acquisition.js";
import { approvedMessageHash } from "./campaigns.js";
import { senderIdentityErrors, type ComplianceConfig } from "./compliance.js";
import { dailyCapacity, readinessErrors, type SendingConfig } from "./dispatch.js";
import { appendSendingControlInTx, MIN_SEND_INTERVAL_MS, sendingPolicy } from "./policy.js";
import { lockSendGate } from "./records.js";
import type { OutreachSender } from "./sender.js";
import { createOutreachDraft, queueOutreachInTx, type DraftOptions } from "./service.js";

type Tx = Prisma.TransactionClient;

export interface PreflightCheck { key: string; label: string; pass: boolean; detail: string; blocking: boolean }
export interface Preflight {
  ok: boolean;
  checks: PreflightCheck[];
  blockers: string[];
  capacity: { used: number; limit: number; remaining: number };
  eligibleCandidates: number;
  commercialMinimum: string;
  minSendIntervalSeconds: number;
}

/**
 * What must hold before a launch. Fails closed: any blocking check that fails refuses the launch.
 * `providerProblem` lets a page reuse a live check it already made (null = authorized); otherwise the
 * provider's live check runs here, outside any transaction.
 */
export async function launchPreflight(db: Db, cfg: SendingConfig & { outreachProvider?: string | null }, sender: OutreachSender, now = new Date(), opts: { providerProblem?: string | null } = {}): Promise<Preflight> {
  const live = opts.providerProblem !== undefined ? opts.providerProblem : sender.enabled ? (sender.check ? await sender.check() : null) : sender.problem ?? "No email provider is configured.";
  const [policy, capacity, queued, active, eligible] = await Promise.all([
    sendingPolicy(db), dailyCapacity(db, cfg, now), db.outreach.count({ where: { status: "queued" } }), activeAutonomousCampaign(db, now), autonomousCandidates(db, now),
  ]);
  const identity = senderIdentityErrors(cfg);
  const check = (key: string, label: string, pass: boolean, detail: string, blocking = true): PreflightCheck => ({ key, label, pass, detail, blocking });
  const checks = [
    check("provider", "Gmail provider", sender.enabled && sender.name === "gmail" && live === null,
      !sender.enabled ? (sender.problem ?? "No email provider is configured.") : sender.name !== "gmail" ? `The provider is ${sender.name}, not Gmail.` : live ?? `Authorized; live check passed for ${cfg.outreachSender.email}.`),
    check("identity", "Sender identity", identity.length === 0, identity.join(" ") || `${cfg.outreachSender.name} <${cfg.outreachSender.email}>, postal address and unsubscribe link configured.`),
    check("arm", "This deployment's sending arm", cfg.outreachSendingArmed, cfg.outreachSendingArmed ? "OUTREACH_SENDING_ENABLED=1 here." : "OUTREACH_SENDING_ENABLED is not 1 for this deployment."),
    check("scheduled_arm", "Scheduled sender and research workers", true,
      "Their arms (OUTREACH_SENDING_ENABLED on the sender service, RESEARCH_AUTORUN_ENABLED on the research worker) are set on those services and cannot be read from here. Nothing is sent until the sender service is armed.", false),
    check("switch", "Sending switch", !policy.enabled, policy.enabled ? "Sending is ON for another campaign. Switch it off (or use the emergency stop) first." : "OFF; the launch switches it on for this campaign only."),
    check("campaign", "No other autonomous campaign", !active, active ? `"${active.name}" is still active until ${active.expiresAt?.toISOString()}.` : "None active."),
    check("queue", "Nothing already queued", queued === 0, queued ? `${queued} queued message(s) outside this campaign must be sent, discarded or resolved first.` : "The queue is empty."),
    check("capacity", "Daily sending capacity", capacity.remaining > 0, `${capacity.used} of ${capacity.limit} used in the last 24 hours; ${capacity.remaining} left. New sends are at least ${MIN_SEND_INTERVAL_MS / 1000} seconds apart.`),
    check("eligible", "Eligible candidates", eligible.length > 0, eligible.length ? `${eligible.length} researched candidate(s) pass the automatic-creation gate now (commercial minimum ${AUTONOMOUS_COMMERCIAL_MINIMUM}).` : "No candidate passes the automatic-creation gate now; there would be nothing to send."),
  ];
  const blockers = checks.filter((c) => c.blocking && !c.pass).map((c) => `${c.label}: ${c.detail}`);
  return { ok: blockers.length === 0, checks, blockers, capacity, eligibleCandidates: eligible.length, commercialMinimum: AUTONOMOUS_COMMERCIAL_MINIMUM, minSendIntervalSeconds: MIN_SEND_INTERVAL_MS / 1000 };
}

/**
 * The one-click launch. The person's explicit confirmation authorizes the bounded campaign and its
 * sending: the campaign is created and the switch turned on with it active, both or neither, under the
 * send gate. Everything the preflight read from the database is re-checked inside that transaction.
 */
export async function launchAutonomousCampaign(db: Db, input: Omit<AuthorizationInput, "via">, cfg: SendingConfig & { outreachProvider?: string | null }, sender: OutreachSender, now = new Date()) {
  if (!input.confirm) throw new ProspectError(["You must explicitly confirm automatic prospect creation and sending within these bounds."]);
  const preflight = await launchPreflight(db, cfg, sender, now);
  if (!preflight.ok) throw new ProspectError(["The campaign can't be launched yet:", ...preflight.blockers]);
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const policy = await sendingPolicy(tx);
    const errors = [...readinessErrors(cfg, sender)];
    if (policy.enabled) errors.push("Sending was switched on meanwhile. Switch it off before launching.");
    if (await tx.outreach.count({ where: { status: "queued" } })) errors.push("Messages were queued meanwhile. Resolve them before launching.");
    if (errors.length) throw new ProspectError(["The campaign can't be launched yet:", ...errors], "conflict");
    const campaign = await authorizeAutonomousCampaignInTx(tx, { ...input, via: "admin" }, now);
    const reason = `Autonomous campaign "${campaign.name}" launched: up to ${campaign.prospectCap} prospects and ${campaign.messageCap} messages until ${campaign.expiresAt!.toISOString()}. ${campaign.authorizedReason}`.slice(0, 500);
    await appendSendingControlInTx(tx, { enabled: true, activeCampaignId: campaign.id }, reason, now);
    return campaign;
  }, { timeout: 30_000 });
}

/**
 * Switches sending off and stops every autonomous campaign for good, together. Always switches off,
 * even with no campaign active; repeating it changes nothing more (a stopped campaign keeps its first reason).
 */
export async function emergencyStop(db: Db, reasonRaw: unknown, now = new Date()) {
  const reason = typeof reasonRaw === "string" ? reasonRaw.replace(/\s+/g, " ").trim().slice(0, 450) : "";
  if (!reason) throw new ProspectError(["An emergency stop needs a reason."]);
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const open = await tx.outreachCampaign.findMany({ where: { mode: "autonomous", stoppedAt: null }, select: { id: true }, orderBy: { id: "asc" } });
    const stopped: string[] = [];
    for (const { id } of open) {
      const c = await lockCampaign(tx, id);
      if (c && !c.stoppedAt) {
        await tx.outreachCampaign.update({ where: { id }, data: { stoppedAt: now, stopReason: `Emergency stop: ${reason}` } });
        stopped.push(id);
      }
    }
    const policy = await sendingPolicy(tx);
    if (policy.enabled || stopped.length) await appendSendingControlInTx(tx, { enabled: false }, `Emergency stop: ${reason}`, now);
    return { stopped, switchedOff: policy.enabled };
  }, { timeout: 30_000 });
}

/** Messages committed against the campaign's authorization: every membership, whatever became of it. */
export const committedMessages = (db: Db | Tx, campaignId: string) => db.outreachCampaignMessage.count({ where: { campaignId } });

/**
 * Commits one prepared draft to the campaign: queue it (the existing validated operation) and record its
 * membership with the reviewed-message fingerprint, both or neither, under the send gate and the campaign
 * row lock. Idempotent for a message that is already a member.
 */
export async function commitCampaignMessage(db: Db, campaignId: string, outreachId: string, cfg: ComplianceConfig, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const campaign = await lockCampaign(tx, campaignId);
    if (!campaign || campaign.mode !== "autonomous") throw new ProspectError(["Not an autonomous campaign."], "not_found");
    const existing = await tx.outreachCampaignMessage.findUnique({ where: { campaignId_outreachId: { campaignId, outreachId } } });
    if (existing) return { committed: false, reason: "already a member" };
    const errors = await commitBlockers(tx, campaign, now);
    if (errors.length) throw new ProspectError(errors, "conflict");
    const o = await tx.outreach.findUnique({ where: { id: outreachId } });
    if (!o) throw new ProspectError(["Outreach not found."], "not_found");
    if (!(await tx.outreachCampaignProspect.findFirst({ where: { campaignId, prospectId: o.prospectId } }))) throw new ProspectError(["This message's prospect was not created by this campaign."]);
    if (o.kind !== "initial" || o.status !== "draft" || o.sendStartedAt || o.sendAttempts) throw new ProspectError(["Only an unsent first-message draft can join the campaign."]);
    if (o.campaign !== campaign.attributionCampaign) throw new ProspectError([`This message's attribution (${o.campaign}) is not the campaign's (${campaign.attributionCampaign}).`]);
    // The existing queue operation: eligibility, suppression, recipient ownership, sender identity, compliance, invitation.
    const queued = await queueOutreachInTx(tx, outreachId, cfg, now);
    await tx.outreachCampaignMessage.create({ data: { campaignId, outreachId, messageHash: approvedMessageHash(queued.outreach) } });
    return { committed: true, reason: null };
  }, { timeout: 30_000 });
}

/** Why the campaign can take no more messages now. Decisive under the send gate and the campaign row lock; a read-only pre-check otherwise. */
async function commitBlockers(tx: Tx | Db, campaign: NonNullable<Awaited<ReturnType<typeof lockCampaign>>>, now: Date) {
  const created = await tx.outreachCampaignProspect.count({ where: { campaignId: campaign.id } });
  const state = campaignState(campaign, created, now);
  if (state === "stopped") return [`The campaign was stopped: ${campaign.stopReason}`];
  if (state === "expired") return ["The campaign has expired."];
  if ((await sendingPolicy(tx)).activeCampaignId !== campaign.id) return ["This campaign is not the active sending campaign (launch it first)."];
  const committed = await committedMessages(tx, campaign.id);
  if (campaign.messageCap === null || committed >= campaign.messageCap) return [`The campaign's message cap (${campaign.messageCap}) is reached.`];
  return [];
}

export interface PrepareCampaignReport {
  committed: { prospectId: string; outreachId: string }[];
  skipped: { prospectId: string; reasons: string[] }[];
  stoppedBecause: string | null;
}

/**
 * Prepares and commits outreach for the campaign's own prospects that have no message in it yet. Safe
 * to repeat and to run concurrently: a draft left by an interrupted run is reused (createOutreachDraft is
 * idempotent), memberships are unique, and every commit re-checks stop, expiry and the message cap.
 */
export async function prepareCampaignOutreach(db: Db, campaignId: string, opts: { draft: DraftOptions; compliance: ComplianceConfig; now?: Date; limit?: number; shouldStop?: () => boolean }): Promise<PrepareCampaignReport> {
  const now = opts.now ?? new Date();
  const report: PrepareCampaignReport = { committed: [], skipped: [], stoppedBecause: null };
  const prospects = await db.outreachCampaignProspect.findMany({
    where: { campaignId, prospect: { outreach: { none: { campaignMemberships: { some: { campaignId } } } } } },
    orderBy: [{ createdAt: "asc" }, { prospectId: "asc" }], select: { prospectId: true },
  });
  // Draft nothing for a campaign that can take no more messages (stopped, expired, not launched, capped).
  const open = async () => {
    const campaign = await db.outreachCampaign.findUnique({ where: { id: campaignId } });
    const blockers = campaign?.mode === "autonomous" ? await commitBlockers(db, campaign, now) : ["Not an autonomous campaign."];
    report.stoppedBecause = blockers.length ? blockers.join(" ") : null;
    return !blockers.length;
  };
  if (!(await open())) return report;
  for (const { prospectId } of prospects.slice(0, opts.limit ?? prospects.length)) {
    if (opts.shouldStop?.()) { report.stoppedBecause = "Stopped: time budget or shutdown."; break; }
    if (!(await open())) break;
    let outreachId: string;
    try {
      outreachId = (await createOutreachDraft(db, prospectId, { ...opts.draft, now })).outreach.id;
    } catch (err) {
      if (!(err instanceof ProspectError)) throw err;
      report.skipped.push({ prospectId, reasons: err.messages });
      continue;
    }
    try {
      const r = await commitCampaignMessage(db, campaignId, outreachId, opts.compliance, now);
      if (r.committed) report.committed.push({ prospectId, outreachId });
    } catch (err) {
      if (!(err instanceof ProspectError)) throw err;
      if (err.kind === "conflict") { report.stoppedBecause = err.messages.join(" "); break; }
      report.skipped.push({ prospectId, reasons: err.messages });
    }
  }
  return report;
}

/** The most prospects one orchestration run creates (the campaign's cap still bounds the total). */
export const AUTONOMOUS_CREATE_PER_RUN = 10;

export interface AutonomousRunReport {
  outcome: "no_campaign" | "not_launched" | "stopped" | "expired" | "done" | "time_budget" | "shutdown";
  campaignId: string | null;
  /** Prospects created this run. */
  created: string[];
  /** Refused by a safeguard; recorded, so not tried again until the candidate changes. */
  held: { candidateId: string; reasons: string[] }[];
  /** Failed unexpectedly; recorded the same way, never retried in a loop. */
  failed: { candidateId: string; error: string }[];
  /** Lost a race or a serialization conflict; simply tried again on a later run. */
  deferred: { candidateId: string; reason: string }[];
  prepare: PrepareCampaignReport | null;
}

/**
 * One bounded orchestration step for the active, launched autonomous campaign, run by the existing
 * research worker after its research pass (never by a request): create prospects for eligible candidates
 * (createProspectAutonomously, at most AUTONOMOUS_CREATE_PER_RUN and the campaign's remaining cap), then
 * prepare and commit their outreach (prepareCampaignOutreach). Every cap, the expiry, the stop and every
 * safeguard is decided inside those functions' own transactions; this only chooses what to try next.
 * Sends nothing: the existing sender job sends committed messages.
 */
export async function runAutonomousCampaign(db: Db, opts: { draft: DraftOptions; compliance: ComplianceConfig; clock?: () => Date; shouldStop?: () => boolean; deadline?: number; createLimit?: number }): Promise<AutonomousRunReport> {
  const clock = opts.clock ?? (() => new Date());
  const report: AutonomousRunReport = { outcome: "done", campaignId: null, created: [], held: [], failed: [], deferred: [], prepare: null };
  const interrupted = (): AutonomousRunReport["outcome"] | null =>
    opts.shouldStop?.() ? "shutdown" : opts.deadline !== undefined && clock().getTime() >= opts.deadline ? "time_budget" : null;
  const campaign = await activeAutonomousCampaign(db, clock());
  if (!campaign) return { ...report, outcome: "no_campaign" };
  report.campaignId = campaign.id;
  if ((await sendingPolicy(db)).activeCampaignId !== campaign.id) return { ...report, outcome: "not_launched" };
  const halted = async () => {
    const status = await autonomousCampaignStatus(db, campaign.id, clock());
    return status?.state === "stopped" || status?.state === "expired" ? status.state : null;
  };

  const status = await autonomousCampaignStatus(db, campaign.id, clock());
  if (status?.state === "active") {
    let room = Math.min(status.remaining, opts.createLimit ?? AUTONOMOUS_CREATE_PER_RUN);
    for (const candidateId of await autonomousCandidates(db, clock(), campaign.commercialMinimum as CommercialMinimum, { campaignId: campaign.id })) {
      if (room <= 0) break;
      const stop = interrupted();
      if (stop) return { ...report, outcome: stop };
      try {
        report.created.push((await createProspectAutonomously(db, candidateId, campaign.id, clock())).prospect.id);
        room--;
      } catch (err) {
        if (err instanceof ProspectError && (err.kind === "conflict" || err.kind === "not_found")) {
          // A campaign-level refusal (stopped, expired, cap) ends the run; anything else is a race, tried later.
          const state = await halted();
          if (state) return { ...report, outcome: state };
          if ((await autonomousCampaignStatus(db, campaign.id, clock()))?.state === "exhausted") break;
          report.deferred.push({ candidateId, reason: err.messages.join(" ").slice(0, 300) });
        } else if (err instanceof ProspectError) {
          await recordAutonomousRefusal(db, candidateId, campaign.id, "refused", err.messages, clock());
          report.held.push({ candidateId, reasons: err.messages });
        } else {
          const error = (err instanceof Error ? err.message : String(err)).replace(/\S+:\/\/\S+/g, "[url]").slice(0, 300);
          await recordAutonomousRefusal(db, candidateId, campaign.id, "error", [error], clock()).catch(() => undefined);
          report.failed.push({ candidateId, error });
        }
      }
    }
  } else if (status?.state === "stopped" || status?.state === "expired") {
    return { ...report, outcome: status.state };
  }

  const stop = interrupted();
  if (stop) return { ...report, outcome: stop };
  const state = await halted();
  if (state) return { ...report, outcome: state };
  report.prepare = await prepareCampaignOutreach(db, campaign.id, { draft: opts.draft, compliance: opts.compliance, now: clock(), shouldStop: () => interrupted() !== null });
  return { ...report, outcome: interrupted() ?? (await halted()) ?? "done" };
}

/** The latest autonomous campaign as the Outreach page shows it (read-only). */
export async function autonomousCampaignOverview(db: Db, now = new Date()) {
  const campaign = await db.outreachCampaign.findFirst({ where: { mode: "autonomous" }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  if (!campaign) return null;
  const [created, members, replies, withoutMessage, refusalNotes] = await Promise.all([
    db.outreachCampaignProspect.count({ where: { campaignId: campaign.id } }),
    db.outreachCampaignMessage.findMany({ where: { campaignId: campaign.id }, select: { outreach: { select: { status: true, sentAt: true } } } }),
    db.outreachReply.count({ where: { outreach: { campaignMemberships: { some: { campaignId: campaign.id } } } } }),
    db.outreachCampaignProspect.count({ where: { campaignId: campaign.id, prospect: { outreach: { none: { campaignMemberships: { some: { campaignId: campaign.id } } } } } } }),
    db.candidateNote.findMany({ where: { body: { contains: `"campaignId":"${campaign.id}"` } }, orderBy: { createdAt: "desc" }, take: 200,
      select: { body: true, candidate: { select: { id: true, businessName: true } } } }),
  ]);
  const held = refusalNotes.flatMap((n) => refusals([n]).filter((r) => r.campaignId === campaign.id).map((r) => ({ candidateId: n.candidate.id, businessName: n.candidate.businessName, kind: r.kind, reasons: r.reasons })));
  const status = (s: string) => members.filter((m) => m.outreach.status === s).length;
  return {
    campaign, created, state: campaignState(campaign, created, now),
    committed: members.length, queued: members.filter((m) => m.outreach.status === "queued" && !m.outreach.sentAt).length,
    sent: members.filter((m) => m.outreach.sentAt).length, failed: status("failed") + status("bounced"), cancelled: status("cancelled"),
    replied: status("replied"), replies, withoutMessage, held: held.slice(0, 10), heldCount: held.length,
  };
}
