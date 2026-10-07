/*
 * Outreach eligibility: the one decision about whether a business may get a
 * message, used at every step so preparing, queueing, and sending can never
 * disagree about it.
 *
 *   prepare  may a message be drafted for this prospect now?
 *   queue    may this stored draft be approved for sending?
 *   send     may this queued message leave now? Re-checked right before each
 *            send, so anything that changed after queueing stops it.
 *
 * eligibilityErrors() is the rule, pure. outreachEligibility() reads the
 * stored facts it needs and applies it. Nothing here writes.
 *
 * Recipients. A message's recipient is Outreach.recipientEmail, normalized
 * and fixed when it is drafted; the dispatcher sends to that and nothing
 * else. These rules keep it the right one, at every step:
 *   - it is still the prospect's business email (an edit since stops it);
 *   - a follow-up goes to the address its first message went to;
 *   - an address is only ever contacted for one business: once a message to
 *     it may have reached the provider (wasContacted), no other prospect's
 *     message is prepared, queued, or sent to it. At send time this is
 *     decided under the send gate, so two prospects' claims can't both pass.
 */
import type { Db } from "../db.js";
import type { Outreach, Prisma } from "../generated/prisma/client.js";
import { internalTestIdentity } from "../internalTest.js";
import { STATUS_LABELS } from "../prospectStatus.js";
import { scoringInputFromRecord } from "../prospects.js";
import { hasPublicContact, scoreProspect } from "../scoring.js";
import { messageComplianceErrors, senderIdentityErrors, type ComplianceConfig, type MessageForCompliance } from "./compliance.js";
import { FOLLOW_UP_TEMPLATE, INTRO_TEMPLATE } from "./compose.js";
import {
  AWAITING_REPLY,
  OPEN_STATUSES,
  OUTREACH_STATUS_LABELS,
  draftEligibilityErrors,
  normalizeEmail,
  type DraftContext,
  type OutreachKind,
  type OutreachStatus,
} from "./lifecycle.js";

type Tx = Prisma.TransactionClient;

/**
 * Whether a message may have reached its recipient: its send started, and it
 * wasn't refused before it went out (failed without sentAt: the provider
 * said it wasn't sent). Sent, delivered, bounced, and replied messages
 * count; so does one whose outcome is unknown, or that was cancelled after
 * its send started, since it may have gone out. A send undone because the
 * provider was unavailable has no sendStartedAt, so it doesn't count.
 * CONTACTED below is the same test as a database filter: keep them in step.
 */
export const wasContacted = (o: { status: OutreachStatus; sentAt: Date | null; sendStartedAt: Date | null }) =>
  o.sentAt !== null || (o.sendStartedAt !== null && o.status !== "failed");
const CONTACTED = { OR: [{ sentAt: { not: null } }, { sendStartedAt: { not: null }, status: { not: "failed" } }] } satisfies Prisma.OutreachWhereInput;

export const ELIGIBILITY_STAGES = ["prepare", "queue", "send"] as const;
export type EligibilityStage = (typeof ELIGIBILITY_STAGES)[number];

/** Everything the rule needs, already read from the records. */
export interface EligibilityFacts {
  stage: EligibilityStage;
  kind: OutreachKind;
  prospect: DraftContext;
  /** Suppression entries for the addresses involved: the prospect's email, and a stored message's recipient. */
  suppressed: readonly { email: string; reason: string }[];
  /** A message to the prospect's current email bounced. */
  bounced: boolean;
  /** For a first message: another first message to this prospect that may have reached it (wasContacted). */
  firstSent: { sentAt: Date | null } | null;
  /** One of the addresses involved was already contacted for another prospect (wasContacted). */
  contactedElsewhere?: { email: string; businessName: string | null } | null;
  /** For a follow-up: the address its first message was sent to. */
  firstRecipient?: string | null;
  /** For a follow-up being prepared: the message it answers (null when it isn't this prospect's), and whether it already has one. */
  followUp?: { original: { status: OutreachStatus; sentAt: Date | null } | null; alreadyFollowedUp: boolean };
  /** For queue and send: the stored message, and the configured sender it must match. */
  message?: { stored: MessageForCompliance; cfg: ComplianceConfig };
}

/** Why this business must not get this message now (empty when it may). */
export function eligibilityErrors(f: EligibilityFacts): string[] {
  const p = f.prospect;
  const errors = draftEligibilityErrors(f.kind, p);
  // Sending a first message needs Ready to contact; queueing moves it there.
  if (f.stage === "send" && f.kind === "initial" && p.status !== "ready_to_contact") {
    errors.push(`A first message is only sent to Ready to contact prospects; this one is ${STATUS_LABELS[p.status]}.`);
  }
  if (f.message && (!p.email || normalizeEmail(p.email) !== normalizeEmail(f.message.stored.recipientEmail))) {
    errors.push("The prospect's business email changed since this message was prepared. Discard it and prepare it again.");
  }
  for (const s of f.suppressed) errors.push(`The address ${s.email} is suppressed (${s.reason}); it must not be emailed again.`);
  if (f.contactedElsewhere) {
    const other = f.contactedElsewhere.businessName ?? "another business";
    errors.push(`The address ${f.contactedElsewhere.email} was already contacted for ${other}. An address is only ever emailed for one business.`);
  }
  if (f.kind === "follow_up" && f.firstRecipient && (!p.email || normalizeEmail(p.email) !== f.firstRecipient)) {
    errors.push(`A follow-up goes to the address the first message was sent to (${f.firstRecipient}), and the business email has changed since. It can't be followed up by email.`);
  }
  if (f.bounced && p.email) errors.push(`A message to ${p.email} bounced. Correct the business email before preparing another.`);
  if (f.kind === "initial" && f.firstSent) {
    errors.push(
      f.stage === "prepare"
        ? `A first message was already sent${f.firstSent.sentAt ? ` on ${f.firstSent.sentAt.toISOString().slice(0, 10)}` : ""}. Prepare a follow-up to it instead.`
        : "A first message was already sent to this prospect.",
    );
  }
  if (f.followUp) {
    const o = f.followUp.original;
    if (!o) errors.push("The message to follow up isn't one of this prospect's.");
    else if (!AWAITING_REPLY.includes(o.status) || !o.sentAt) {
      errors.push(`Only a sent message without a reply can be followed up; that one is ${OUTREACH_STATUS_LABELS[o.status]}.`);
    } else if (f.followUp.alreadyFollowedUp) errors.push("That message already has a follow-up.");
  }
  if (f.message) errors.push(...senderIdentityErrors(f.message.cfg), ...messageComplianceErrors(f.message.stored, f.message.cfg));
  return [...new Set(errors)];
}

type ProspectForEligibility = Prisma.ProspectGetPayload<{ include: { signals: true } }>;

export interface EligibilityRequest {
  stage: EligibilityStage;
  kind: OutreachKind;
  prospect: ProspectForEligibility;
  /** Preparing a follow-up to this message. */
  followUpOfId?: string;
  /** Queueing or sending a follow-up: the first message it follows (its recipient must be the same). */
  firstMessageId?: string | null;
  /** Queueing or sending: the stored message and the configured sender. */
  message?: { stored: MessageForCompliance & { id: string }; cfg: ComplianceConfig };
}

/**
 * Reads what the rule needs and applies it. Also returns the prospect's open
 * message and the message a follow-up answers, which preparing needs anyway.
 */
export async function outreachEligibility(tx: Tx | Db, r: EligibilityRequest): Promise<{ errors: string[]; open: Outreach | null; original: Outreach | null }> {
  const p = r.prospect;
  const input = scoringInputFromRecord(p);
  const addresses = [...new Set([p.email, r.message?.stored.recipientEmail].filter((e): e is string => Boolean(e)).map(normalizeEmail))];
  const [suppressed, history, elsewhere] = await Promise.all([
    addresses.length ? tx.emailSuppression.findMany({ where: { email: { in: addresses } }, select: { email: true, reason: true }, orderBy: { email: "asc" } }) : [],
    tx.outreach.findMany({ where: { prospectId: p.id }, orderBy: { createdAt: "asc" } }),
    addresses.length
      ? tx.outreach.findFirst({
          where: { prospectId: { not: p.id }, recipientEmail: { in: addresses, mode: "insensitive" }, ...CONTACTED },
          orderBy: { createdAt: "asc" },
          select: { recipientEmail: true, prospect: { select: { businessName: true } } },
        })
      : null,
  ]);
  const others = r.message ? history.filter((o) => o.id !== r.message!.stored.id) : history;
  const original = r.followUpOfId ? (history.find((o) => o.id === r.followUpOfId) ?? null) : null;
  const firstId = r.followUpOfId ?? r.firstMessageId;
  const first = firstId ? (history.find((o) => o.id === firstId) ?? null) : null;
  const errors = eligibilityErrors({
    stage: r.stage,
    kind: r.kind,
    prospect: {
      status: p.status,
      businessName: p.businessName,
      hasPublicContact: hasPublicContact(input),
      qualification: scoreProspect(input).qualification,
      // An internal outreach test is held to its controlled identity instead of business qualification.
      internalTestIdentity: internalTestIdentity(p),
      email: p.email,
      emailSourceUrl: p.emailSourceUrl,
    },
    suppressed,
    bounced: Boolean(p.email) && history.some((o) => o.status === "bounced" && normalizeEmail(o.recipientEmail) === normalizeEmail(p.email!)),
    firstSent: r.kind === "initial" ? (others.find((o) => o.kind === "initial" && wasContacted(o)) ?? null) : null,
    contactedElsewhere: elsewhere ? { email: normalizeEmail(elsewhere.recipientEmail), businessName: elsewhere.prospect.businessName } : null,
    firstRecipient: r.kind === "follow_up" && first ? normalizeEmail(first.recipientEmail) : null,
    followUp: r.followUpOfId
      ? { original, alreadyFollowedUp: Boolean(original) && history.some((o) => o.followUpOfId === original!.id && o.status !== "cancelled") }
      : undefined,
    message: r.message,
  });
  return { errors, open: history.find((o) => OPEN_STATUSES.includes(o.status)) ?? null, original };
}

/** A stored message at the queue or send step: the same decision, for its prospect, recipient, and sender. */
export async function messageEligibilityErrors(
  tx: Tx | Db,
  o: Outreach & { prospect: ProspectForEligibility },
  cfg: ComplianceConfig,
  stage: "queue" | "send",
): Promise<string[]> {
  const { errors } = await outreachEligibility(tx, { stage, kind: o.kind, prospect: o.prospect, firstMessageId: o.followUpOfId, message: { stored: o, cfg } });
  if (stage === "send") {
    // The dispatcher holds the send gate, as does revocation. Read again before
    // claiming or using daily capacity; follow-ups reuse the first invitation.
    const outreachId = o.kind === "follow_up" ? o.followUpOfId : o.id;
    const invitation = outreachId
      ? await tx.invitation.findUnique({ where: { outreachId }, select: { revokedAt: true } })
      : null;
    if (invitation?.revokedAt) {
      errors.push("The invitation for this message was revoked, so its link no longer works.");
    } else if (!invitation && (o.template === INTRO_TEMPLATE || o.template === FOLLOW_UP_TEMPLATE || o.body.includes("/invite#"))) {
      // Legacy referral-link messages never had an invitation; keep them working.
      errors.push("The invitation for this message is missing, so its link no longer works.");
    }
  }
  return errors;
}
