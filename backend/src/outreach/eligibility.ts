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
 */
import type { Db } from "../db.js";
import type { Outreach, Prisma } from "../generated/prisma/client.js";
import { STATUS_LABELS } from "../prospectStatus.js";
import { scoringInputFromRecord } from "../prospects.js";
import { hasPublicContact, scoreProspect } from "../scoring.js";
import { messageComplianceErrors, senderIdentityErrors, type ComplianceConfig, type MessageForCompliance } from "./compliance.js";
import {
  ATTEMPTED_STATUSES,
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
  /** For a first message: another first message to this prospect that reached the provider. */
  firstSent: { sentAt: Date | null } | null;
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
  const [suppressed, history] = await Promise.all([
    addresses.length ? tx.emailSuppression.findMany({ where: { email: { in: addresses } }, select: { email: true, reason: true }, orderBy: { email: "asc" } }) : [],
    tx.outreach.findMany({ where: { prospectId: p.id }, orderBy: { createdAt: "asc" } }),
  ]);
  const others = r.message ? history.filter((o) => o.id !== r.message!.stored.id) : history;
  const original = r.followUpOfId ? (history.find((o) => o.id === r.followUpOfId) ?? null) : null;
  const errors = eligibilityErrors({
    stage: r.stage,
    kind: r.kind,
    prospect: {
      status: p.status,
      businessName: p.businessName,
      hasPublicContact: hasPublicContact(input),
      qualification: scoreProspect(input).qualification,
      email: p.email,
      emailSourceUrl: p.emailSourceUrl,
    },
    suppressed,
    bounced: Boolean(p.email) && history.some((o) => o.status === "bounced" && normalizeEmail(o.recipientEmail) === normalizeEmail(p.email!)),
    firstSent: r.kind === "initial" ? (others.find((o) => o.kind === "initial" && ATTEMPTED_STATUSES.includes(o.status)) ?? null) : null,
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
  return (await outreachEligibility(tx, { stage, kind: o.kind, prospect: o.prospect, message: { stored: o, cfg } })).errors;
}
