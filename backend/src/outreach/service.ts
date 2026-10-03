/*
 * Outreach service: drafts, the message lifecycle, and its events.
 *
 * Safety, by construction:
 *   - Drafting reads stored records and writes one row; it makes no network
 *     call. Only dispatch.ts sends, behind a global switch.
 *   - One open message (draft or queued) per prospect, enforced by a unique
 *     column, so repeating "draft" returns the existing draft.
 *   - Every message is its own row and every change is compare-and-set with
 *     an event row; a follow-up or a retry is a new row, never an overwrite.
 *   - Suppressed addresses (bounced, complained, unsubscribed, invalid) never
 *     get another message, on any prospect.
 *   - Outreach never writes the prospect's signals, evidence, or fields. It
 *     only moves the prospect's status, through the same validated path as
 *     a person, and only where that move is allowed.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { Config } from "../config.js";
import type { Outreach, Prisma } from "../generated/prisma/client.js";
import type { Status } from "../prospectStatus.js";
import { FIELD_LIMITS, ProspectError, changeStatusInTx, referralUrl, scoringInputFromRecord } from "../prospects.js";
import { scoreProspect } from "../scoring.js";
import type { ComplianceConfig } from "./compliance.js";
import { createInvitationInTx, sentInvitationLink } from "../invitations/service.js";
import { invitationUrl, newInvitationToken } from "../invitations/tokens.js";
import { campaignOf, composeFollowUp, composeIntro, LEGACY_FOLLOW_UP_TEMPLATE, type ComposedMessage } from "./compose.js";
import {
  ATTEMPTED_STATUSES,
  OPEN_STATUSES,
  REPLY_OUTCOME_LABELS,
  REPLY_PROSPECT_STATUS,
  isReplyOutcome,
  normalizeEmail,
  outreachTransitionErrors,
  type OutreachKind,
  type OutreachStatus,
  type ReplyOutcome,
} from "./lifecycle.js";
import { messageEligibilityErrors, outreachEligibility } from "./eligibility.js";
import { isSuppressed, lockOutreach, lockSendGate, logOutreachEvent, suppressEmail } from "./records.js";

type Tx = Prisma.TransactionClient;

export interface DraftOptions {
  siteUrl: string;
  sender: Config["outreachSender"];
  /** Draft a follow-up to this message instead of a first message. */
  followUpOfId?: string;
  now?: Date;
}

const notFound = () => new ProspectError(["Outreach not found."], "not_found");

const prospectForDraft = (tx: Tx | Db, id: string) =>
  tx.prospect.findUnique({ where: { id }, include: { signals: true, evidence: { orderBy: { createdAt: "asc" } } } });

/**
 * Everything a draft needs, checked (eligibility.ts decides): why it can't
 * be drafted, or the message it would be. Reads only.
 *
 * Links: a first message carries `invitationLink`, its invitation made in the
 * same transaction (a preview, which makes none, shows a placeholder). A
 * follow-up reuses the link its first message carried; a first message made
 * before invitations had none, so its follow-up keeps the referral link. A
 * follow-up whose first message's invitation was revoked is refused: its link
 * no longer works.
 */
async function planDraft(tx: Tx | Db, prospectId: string, opts: DraftOptions, invitationLink?: string) {
  const p = await prospectForDraft(tx, prospectId);
  if (!p) throw new ProspectError(["Prospect not found."], "not_found");
  const kind: OutreachKind = opts.followUpOfId ? "follow_up" : "initial";
  const { errors, open, original } = await outreachEligibility(tx, { stage: "prepare", kind, prospect: p, followUpOfId: opts.followUpOfId });

  let link = invitationLink ?? `${opts.siteUrl.replace(/\/+$/, "")}/invite#(the invitation, made when the draft is stored)`;
  let reusesInvitation = false;
  if (kind === "follow_up" && original && !errors.length) {
    const sent = await sentInvitationLink(tx, original);
    if (sent.kind === "revoked") errors.push("The first message's invitation was revoked, so a follow-up would link to a page that no longer works.");
    else if (sent.kind === "link") [link, reusesInvitation] = [sent.url, true];
    else link = referralUrl(opts.siteUrl, p.referralCode, campaignOf(LEGACY_FOLLOW_UP_TEMPLATE));
  }

  let message: ComposedMessage | null = null;
  if (!errors.length) {
    const composeInput = {
      businessName: p.businessName!,
      city: p.city,
      state: p.state,
      website: p.website,
      email: p.email!,
      emailSourceUrl: p.emailSourceUrl!,
      signals: p.signals,
      evidence: p.evidence,
      link,
      sender: { name: opts.sender.name, postalAddress: opts.sender.postalAddress },
    };
    message = kind === "initial" ? composeIntro(composeInput) : composeFollowUp(composeInput, { subject: original!.subject, sentAt: original!.sentAt! }, { reusesInvitation });
  }
  return { prospect: p, kind, errors, open, original, message };
}

/** What drafting would do, without writing anything (dry runs, the admin page). */
export async function previewOutreachDraft(db: Db, prospectId: string, opts: DraftOptions) {
  const plan = await planDraft(db, prospectId, opts);
  return { kind: plan.kind, errors: plan.errors, open: plan.open, message: plan.message, businessName: plan.prospect.businessName };
}

/** A unique violation on the open slot (the adapter reports the field in meta or the message). */
const isUniqueClash = (err: unknown, field: string) =>
  (err as { code?: string }).code === "P2002" && `${JSON.stringify((err as { meta?: unknown }).meta ?? null)} ${(err as Error).message}`.includes(field);

/**
 * Generates and stores a draft for the prospect. Idempotent: when the
 * prospect already has an open message, that one is returned unchanged
 * (created: false). Never sends.
 *
 * A first message gets its invitation in the same transaction
 * (createInvitationInTx): its link is written into the message, only the
 * token's hash is stored, and if either part fails neither exists.
 */
export async function createOutreachDraft(db: Db, prospectId: string, opts: DraftOptions) {
  const now = opts.now ?? new Date();
  try {
    return await db.$transaction(async (tx) => {
      const token = opts.followUpOfId ? null : newInvitationToken();
      const plan = await planDraft(tx, prospectId, opts, token ? invitationUrl(opts.siteUrl, token) : undefined);
      if (plan.open) return { outreach: plan.open, created: false };
      if (plan.errors.length || !plan.message) throw new ProspectError(plan.errors);
      const m = plan.message;
      const p = plan.prospect;
      const outreach = await tx.outreach.create({
        data: {
          prospectId,
          kind: plan.kind,
          followUpOfId: plan.original?.id ?? null,
          template: m.template,
          campaign: m.campaign,
          subject: m.subject,
          body: m.body,
          evidence: m.evidence as unknown as Prisma.InputJsonValue,
          generatedAt: now,
          recipientEmail: normalizeEmail(p.email!),
          recipientSourceUrl: p.emailSourceUrl!,
          senderName: opts.sender.name,
          senderEmail: opts.sender.email,
          unsubscribeToken: randomBytes(24).toString("base64url"),
          status: "draft",
          statusChangedAt: now,
          openForProspectId: prospectId,
          createdAt: now,
        },
      });
      await logOutreachEvent(tx, outreach.id, "drafted", `${m.template}, ${m.evidence.length} fact(s)`, now);
      if (token) await createInvitationInTx(tx, outreach.id, opts.siteUrl, now, token);
      return { outreach, created: true };
    });
  } catch (err) {
    // Two drafts racing: the unique open slot lets one win; return it.
    if (!isUniqueClash(err, "openForProspectId")) throw err;
    const open = await db.outreach.findFirst({ where: { prospectId, status: { in: [...OPEN_STATUSES] } } });
    if (!open) throw err;
    return { outreach: open, created: false };
  }
}

/**
 * Moves a message, compare-and-set, with its event. Idempotent for a repeat
 * of the same move (changed: false, no event).
 */
export async function moveOutreachInTx(
  tx: Tx,
  id: string,
  to: OutreachStatus,
  data: Prisma.OutreachUpdateManyMutationInput,
  detail: string | null,
  now: Date,
  providerEventId?: string | null,
) {
  const current = await tx.outreach.findUnique({ where: { id } });
  if (!current) throw notFound();
  if (current.status === to) return { outreach: current, changed: false };
  const errors = outreachTransitionErrors(current.status, to);
  if (errors.length) throw new ProspectError(errors);
  const { count } = await tx.outreach.updateMany({
    where: { id, status: current.status },
    data: { ...data, status: to, statusChangedAt: now, ...(OPEN_STATUSES.includes(to) ? {} : { openForProspectId: null }) },
  });
  if (count !== 1) throw new ProspectError(["The message changed meanwhile. Reload and try again."], "conflict");
  await logOutreachEvent(tx, id, to, detail, now, providerEventId);
  return { outreach: (await tx.outreach.findUnique({ where: { id } }))!, changed: true };
}

/** Moves the prospect's status when that move is allowed from where it is; otherwise leaves it. */
export async function advanceProspect(tx: Tx, prospectId: string, to: Status, reason: string, now: Date) {
  try {
    return await changeStatusInTx(tx, prospectId, to, reason, now);
  } catch (err) {
    if (err instanceof ProspectError && err.kind === "invalid") return null;
    throw err;
  }
}

const cleanText = (v: unknown, max: number, label: string) => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (t.length > max) throw new ProspectError([`${label} is too long (max ${max}).`]);
  return t || null;
};

/** Discards an unsent message. The row and its history stay. */
export async function discardOutreach(db: Db, id: string, reasonRaw?: unknown, now = new Date()) {
  const reason = cleanText(reasonRaw, FIELD_LIMITS.reason, "Reason") ?? "Discarded by a person.";
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    return moveOutreachInTx(tx, id, "cancelled", { cancelledAt: now, cancelReason: reason }, reason, now);
  });
}

// ---------- queueing ----------

const withProspect = { prospect: { include: { signals: true } } } as const;

/**
 * What stops a draft from being queued: the one eligibility decision for the
 * queue step, and, for a first message, a revoked invitation. Revoking leaves
 * the prospect exactly as eligible as before; it is this message whose link
 * no longer works, as for a follow-up (planDraft). The message page shows the
 * same list, so it never offers a Queue that would be refused.
 */
export async function queueBlockers(tx: Tx | Db, o: Outreach & { prospect: Parameters<typeof messageEligibilityErrors>[1]["prospect"] }, cfg: ComplianceConfig): Promise<string[]> {
  const errors = await messageEligibilityErrors(tx, o, cfg, "queue");
  if (o.kind === "initial" && (await sentInvitationLink(tx, o)).kind === "revoked") {
    errors.push("This message's invitation was revoked, so its link no longer works. Discard this draft and prepare a new one.");
  }
  return errors;
}

/**
 * Approves a message for sending. Everything sending needs is checked first
 * (eligibility, suppression, sender identity, the message's opt-out and
 * postal address). A first message moves the prospect to Ready to contact
 * (through Qualified), by the same rules a person uses. Nothing is sent
 * here: dispatch.ts sends queued messages when sending is switched on.
 *
 * Records the prospect's score as the current scoring model computes it now
 * (queuedScore, queuedScoreVersion), once: a message is queued only from a
 * draft, and nothing else writes them, so later rescoring never changes them.
 */
export async function queueOutreach(db: Db, id: string, cfg: ComplianceConfig, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    // One queueing operation at a time per message: a concurrent click waits, then sees the committed result.
    await lockOutreach(tx, id);
    const o = await tx.outreach.findUnique({ where: { id }, include: withProspect });
    if (!o) throw notFound();
    if (o.status === "queued") return { outreach: o, changed: false };
    if (o.status !== "draft") throw new ProspectError(outreachTransitionErrors(o.status, "queued"));
    const errors = await queueBlockers(tx, o, cfg);
    if (errors.length) throw new ProspectError(errors);
    if (o.kind === "initial") {
      // Eligibility guarantees New, Qualified, or Ready to contact: walk forward one step at a time.
      const path: Status[] = ["new", "qualified", "ready_to_contact"];
      for (let at = o.prospect.status; at !== "ready_to_contact"; ) {
        const next = path[path.indexOf(at) + 1]!;
        await changeStatusInTx(tx, o.prospectId, next, `Outreach queued (${o.template}).`, now);
        at = next;
      }
    }
    const scored = scoreProspect(scoringInputFromRecord(o.prospect));
    return moveOutreachInTx(tx, id, "queued", { queuedAt: now, queuedScore: scored.score, queuedScoreVersion: scored.version }, null, now);
  });
}

// ---------- what the provider reports ----------

/**
 * Records that the provider accepted the message. Tolerant of order: a
 * webhook may have reported it first. A first send moves the prospect from
 * Ready to contact to Contacted.
 */
export async function recordSentInTx(tx: Tx, id: string, provider: string, providerMessageId: string | null, now: Date, providerEventId?: string | null) {
  const o = await tx.outreach.findUnique({ where: { id } });
  if (!o) throw notFound();
  if (o.status !== "queued") {
    if (providerMessageId && !o.providerMessageId && ATTEMPTED_STATUSES.includes(o.status)) {
      await tx.outreach.update({ where: { id }, data: { providerMessageId: providerMessageId.slice(0, 200), provider: provider.slice(0, 40) } });
    }
    return { changed: false, prospect: null };
  }
  await moveOutreachInTx(
    tx,
    id,
    "sent",
    { sentAt: now, provider: provider.slice(0, 40), providerMessageId: providerMessageId?.slice(0, 200) ?? null, lastSendError: null },
    `${provider}${providerMessageId ? ` ${providerMessageId}` : ""}`,
    now,
    providerEventId,
  );
  const prospect = await advanceProspect(tx, o.prospectId, "contacted", `Outreach sent (${o.template}).`, now);
  return { changed: true, prospect };
}

/** A provider notification, normalised. Adapters translate their webhooks into this. */
export interface ProviderEvent {
  provider: string;
  type: "sent" | "delivered" | "bounced" | "failed" | "complained";
  /** The provider's id for this notification; a repeat is ignored. */
  providerEventId?: string | null;
  providerMessageId?: string | null;
  /** Fallback match, when the provider echoes our id back (tags, headers). */
  outreachId?: string | null;
  reason?: string | null;
  /** For bounces: false for a temporary (soft) bounce, which changes nothing. */
  permanent?: boolean;
  at?: Date;
}

export type ProviderEventResult = "recorded" | "duplicate" | "unknown_message" | "ignored";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Records one provider event, idempotently: a repeated notification (same
 * providerEventId, or the same status again) changes nothing. Events that
 * don't fit the message's state are ignored, never thrown, so a webhook
 * endpoint can always answer 2xx. Reports about one message are applied one
 * at a time (lockOutreach): a copy arriving concurrently waits, then finds
 * the first one recorded and is a duplicate.
 *
 *   sent        queued -> sent (prospect Ready to contact -> Contacted)
 *   delivered   -> delivered
 *   bounced     -> bounced; the address is suppressed (permanent bounces only)
 *   failed      -> failed
 *   complained  logged; the address is suppressed; the prospect becomes Do not contact
 */
export async function applyProviderEvent(db: Db, ev: ProviderEvent): Promise<{ result: ProviderEventResult; outreachId: string | null }> {
  const at = ev.at ?? new Date();
  const eventId = ev.providerEventId?.slice(0, 200) ?? null;
  const o =
    (ev.providerMessageId ? await db.outreach.findUnique({ where: { providerMessageId: ev.providerMessageId.slice(0, 200) } }) : null) ??
    (ev.outreachId && UUID_RE.test(ev.outreachId) ? await db.outreach.findUnique({ where: { id: ev.outreachId } }) : null);
  if (!o) return { result: "unknown_message", outreachId: null };
  if (eventId && (await db.outreachEvent.findUnique({ where: { providerEventId: eventId }, select: { id: true } }))) {
    return { result: "duplicate", outreachId: o.id };
  }
  if (ev.type === "bounced" && ev.permanent === false) return { result: "ignored", outreachId: o.id };
  const reason = ev.reason?.slice(0, 500) ?? null;

  try {
    const result = await db.$transaction(async (tx): Promise<ProviderEventResult> => {
      await lockSendGate(tx);
      await lockOutreach(tx, o.id);
      // Checked again under the lock: a concurrent copy may have just recorded it.
      if (eventId && (await tx.outreachEvent.findUnique({ where: { providerEventId: eventId }, select: { id: true } }))) return "duplicate";
      const current = (await tx.outreach.findUniqueOrThrow({ where: { id: o.id } })).status;
      // Any report from the provider means it went out: record the send first.
      if (current === "queued" && ev.type !== "failed") {
        await recordSentInTx(tx, o.id, ev.provider, ev.providerMessageId ?? null, at, ev.type === "sent" ? eventId : null);
        if (ev.type === "sent") return "recorded";
      } else if (ev.type === "sent") {
        if (!ATTEMPTED_STATUSES.includes(current)) return "ignored";
        await recordSentInTx(tx, o.id, ev.provider, ev.providerMessageId ?? null, at);
        return "duplicate";
      }
      const status = (await tx.outreach.findUniqueOrThrow({ where: { id: o.id } })).status;
      if (ev.type === "complained") {
        if (await tx.outreachEvent.findFirst({ where: { outreachId: o.id, type: "complained" }, select: { id: true } })) return "duplicate";
        await logOutreachEvent(tx, o.id, "complained", reason ?? "Marked as spam by the recipient.", at, eventId);
        await suppressEmail(tx, o.recipientEmail, "complained", reason, o.id, at);
        await advanceProspect(tx, o.prospectId, "do_not_contact", "The recipient marked outreach as spam.", at);
        return "recorded";
      }
      const to: OutreachStatus = ev.type;
      if (status === to) return "duplicate";
      if (outreachTransitionErrors(status, to).length) return "ignored";
      const data: Prisma.OutreachUpdateManyMutationInput =
        to === "delivered" ? { deliveredAt: at } : { failedAt: at, failureReason: reason, lastSendError: null };
      await moveOutreachInTx(tx, o.id, to, data, reason, at, eventId);
      if (to === "bounced") await suppressEmail(tx, o.recipientEmail, "bounced", reason, o.id, at);
      return "recorded";
    });
    return { result, outreachId: o.id };
  } catch (err) {
    // The same notification processed twice at once: the unique id lets one win.
    if (isUniqueClash(err, "providerEventId")) return { result: "duplicate", outreachId: o.id };
    throw err;
  }
}

// ---------- replies and opt-outs ----------

/** Applies a reply outcome to the prospect (and suppresses the address for Do not contact). */
async function applyReplyOutcome(tx: Tx, o: { id: string; prospectId: string; recipientEmail: string }, outcome: ReplyOutcome | null, now: Date) {
  const label = outcome ? REPLY_OUTCOME_LABELS[outcome] : "not yet classified";
  if (outcome === "do_not_contact") await suppressEmail(tx, o.recipientEmail, "unsubscribed", "Asked not to be contacted in a reply.", o.id, now);
  return advanceProspect(tx, o.prospectId, REPLY_PROSPECT_STATUS[outcome ?? "unclassified"], `Replied to outreach: ${label}.`, now);
}

/**
 * Records a reply. With an outcome, as a person read it: interested or other
 * -> Engaged, not interested -> Lost, asked not to be contacted -> Do not
 * contact (permanent, and the address is suppressed). Without one (an inbound
 * reply nobody has read yet) the prospect becomes Engaged and the reply waits
 * for classifyReply(). Recording the same reply again changes nothing.
 */
export async function recordReply(db: Db, id: string, raw: { outcome?: unknown; summary?: unknown; requireOutcome?: boolean }, now = new Date()) {
  const outcome = typeof raw.outcome === "string" && isReplyOutcome(raw.outcome) ? raw.outcome : null;
  if (!outcome && (raw.requireOutcome || (typeof raw.outcome === "string" && raw.outcome !== ""))) throw new ProspectError(["Choose how the business replied."]);
  const summary = cleanText(raw.summary, FIELD_LIMITS.note, "Reply summary");
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    await lockOutreach(tx, id);
    return recordReplyInTx(tx, id, outcome, summary, now);
  });
}

async function recordReplyInTx(tx: Tx, id: string, outcome: ReplyOutcome | null, summary: string | null, now: Date) {
  const result = await moveOutreachInTx(tx, id, "replied", { repliedAt: now, replyOutcome: outcome, replySummary: summary }, outcome ? REPLY_OUTCOME_LABELS[outcome] : "Not yet classified", now);
  const prospect = result.changed ? await applyReplyOutcome(tx, result.outreach, outcome, now) : null;
  return { ...result, prospect };
}

/** Classifies a reply recorded without an outcome. Once only. */
export async function classifyReply(db: Db, id: string, outcomeRaw: unknown, now = new Date()) {
  const outcome = typeof outcomeRaw === "string" && isReplyOutcome(outcomeRaw) ? outcomeRaw : null;
  if (!outcome) throw new ProspectError(["Choose how the business replied."]);
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const o = await tx.outreach.findUnique({ where: { id } });
    if (!o) throw notFound();
    if (o.status !== "replied") throw new ProspectError(["Only a reply can be classified."]);
    if (o.replyOutcome) throw new ProspectError([`This reply is already classified as ${REPLY_OUTCOME_LABELS[o.replyOutcome]}.`]);
    const { count } = await tx.outreach.updateMany({ where: { id, replyOutcome: null }, data: { replyOutcome: outcome } });
    if (count !== 1) throw new ProspectError(["The reply changed meanwhile. Reload and try again."], "conflict");
    await logOutreachEvent(tx, id, "replied", `Classified: ${REPLY_OUTCOME_LABELS[outcome]}`, now);
    return { prospect: await applyReplyOutcome(tx, o, outcome, now) };
  });
}

/** An inbound email, normalised. A future inbox integration translates into this. */
export interface InboundReply {
  fromEmail: string;
  /** The provider's id of the message being answered (In-Reply-To), when known. */
  inReplyToProviderMessageId?: string | null;
  summary?: string | null;
  at?: Date;
}

/**
 * Matches an inbound email to the message it answers (by provider message
 * id, else the latest sent message to that address) and records it as an
 * unclassified reply. Unmatched mail is reported, never guessed at.
 */
export async function recordInboundReply(db: Db, reply: InboundReply) {
  const from = normalizeEmail(reply.fromEmail);
  const byId = reply.inReplyToProviderMessageId
    ? await db.outreach.findUnique({ where: { providerMessageId: reply.inReplyToProviderMessageId.slice(0, 200) } })
    : null;
  const o =
    byId ??
    (await db.outreach.findFirst({
      where: { recipientEmail: { equals: from, mode: "insensitive" }, status: { in: [...ATTEMPTED_STATUSES] } },
      orderBy: { sentAt: "desc" },
    }));
  if (!o) return { result: "unmatched" as const, outreachId: null };
  const summary = cleanText(reply.summary ?? undefined, FIELD_LIMITS.note, "Reply summary");
  const result = await db.$transaction(async (tx) => {
    await lockSendGate(tx);
    // Decided under the lock, so a concurrent copy of this reply, or a bounce, can't slip in between.
    await lockOutreach(tx, o.id);
    const status = (await tx.outreach.findUniqueOrThrow({ where: { id: o.id }, select: { status: true } })).status;
    if (status === "replied") return "duplicate" as const;
    if (outreachTransitionErrors(status, "replied").length) return "ignored" as const;
    await recordReplyInTx(tx, o.id, null, summary, reply.at ?? new Date());
    return "recorded" as const;
  });
  return { result, outreachId: o.id };
}

/**
 * An unsubscribe request for one message: from the one-click link, or an
 * "unsubscribe" email (the List-Unsubscribe mailto). Suppresses the address,
 * makes the prospect Do not contact (cancelling anything open), and logs it
 * once. Repeating it changes nothing.
 */
export async function unsubscribeOutreach(db: Db, outreachId: string, via: string, now = new Date()) {
  const o = await db.outreach.findUnique({ where: { id: outreachId } });
  if (!o) return { result: "unknown" as const };
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    await lockOutreach(tx, o.id);
    const already = await tx.outreachEvent.findFirst({ where: { outreachId: o.id, type: "unsubscribed" }, select: { id: true } });
    await suppressEmail(tx, o.recipientEmail, "unsubscribed", `Unsubscribed ${via}.`, o.id, now);
    await advanceProspect(tx, o.prospectId, "do_not_contact", `Unsubscribed ${via}.`, now);
    if (already) return { result: "duplicate" as const };
    await logOutreachEvent(tx, o.id, "unsubscribed", `Unsubscribed ${via}.`, now);
    return { result: "recorded" as const };
  });
}

/** One-click unsubscribe (the List-Unsubscribe link). Unknown tokens are reported as such. */
export async function unsubscribeByToken(db: Db, token: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return { result: "unknown" as const };
  const o = await db.outreach.findUnique({ where: { unsubscribeToken: token }, select: { id: true } });
  if (!o) return { result: "unknown" as const };
  return unsubscribeOutreach(db, o.id, "with the link in an outreach email", now);
}

// ---------- reads ----------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What needs a person on the Outreach page: replies nobody has classified yet
 * (an opt-out must be honoured promptly) and messages the provider refused in
 * the last week. Also when the last message went out, which shows whether
 * the scheduled sender is running.
 */
export async function outreachAttention(db: Db, now = new Date(), take = 20) {
  const failedSince = { status: "failed" as const, failedAt: { gte: new Date(now.getTime() - WEEK_MS) } };
  const toClassify = { status: "replied" as const, replyOutcome: null };
  const [replies, replyCount, failures, failureCount, last] = await Promise.all([
    db.outreach.findMany({ where: toClassify, orderBy: { repliedAt: "asc" }, take, select: { id: true, subject: true, recipientEmail: true, repliedAt: true } }),
    db.outreach.count({ where: toClassify }),
    db.outreach.findMany({ where: failedSince, orderBy: { failedAt: "desc" }, take, select: { id: true, subject: true, recipientEmail: true, failedAt: true, failureReason: true } }),
    db.outreach.count({ where: failedSince }),
    db.outreach.aggregate({ _max: { sentAt: true } }),
  ]);
  return { replies, replyCount, failures, failureCount, lastSentAt: last._max.sentAt };
}

/** The prospect's messages, newest first, and whether a first message can be drafted. */
export async function prospectOutreach(db: Db, prospectId: string, opts: DraftOptions) {
  const [messages, preview] = await Promise.all([
    db.outreach.findMany({ where: { prospectId }, orderBy: { createdAt: "desc" } }),
    previewOutreachDraft(db, prospectId, opts),
  ]);
  return { messages, canDraft: !preview.open && !preview.errors.length, draftErrors: preview.errors, open: preview.open };
}

export async function getOutreachDetail(db: Db, id: string, cfg?: ComplianceConfig) {
  const o = await db.outreach.findUnique({
    where: { id },
    include: {
      prospect: { include: { signals: true } },
      events: { orderBy: { createdAt: "asc" } },
      followUpOf: { select: { id: true, subject: true, status: true } },
      followUps: { select: { id: true, subject: true, status: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!o) return null;
  const queueErrors = cfg && o.status === "draft" ? await queueBlockers(db, o, cfg) : [];
  const suppressed = await isSuppressed(db, o.recipientEmail);
  return { ...o, queueErrors, suppressed };
}

