/*
 * Outreach lifecycle. Pure rules, enforced by src/outreach/service.ts.
 *
 * Three questions, each answered in one place:
 *
 *   Was outreach attempted?        an Outreach row exists past "draft"
 *   What happened to the message?  Outreach.status, below
 *   What came of it commercially?  the prospect's status (prospectStatus.ts)
 *
 * A message moves
 *
 *   draft -> queued -> sent -> delivered -> replied
 *
 * and can end bounced, failed, or cancelled. Every end state is final: a
 * retry or a follow-up is a new message, so no history is overwritten.
 * Sending goes through dispatch.ts, behind a global switch; there is no
 * provider yet, so nothing can be sent (see sender.ts).
 */
import { STATUS_LABELS, statusRequirementErrors, type Status, type StatusContext } from "../prospectStatus.js";

export const OUTREACH_STATUSES = ["draft", "queued", "sent", "delivered", "bounced", "failed", "replied", "cancelled"] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const OUTREACH_STATUS_LABELS: Record<OutreachStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  failed: "Failed",
  replied: "Replied",
  cancelled: "Cancelled",
};

export const OUTREACH_STATUS_MEANINGS: Record<OutreachStatus, string> = {
  draft: "Generated and stored for review. Not sent.",
  queued: "Approved for sending; waiting for the sender.",
  sent: "Handed to the email provider.",
  delivered: "The provider reported delivery.",
  bounced: "The provider reported that the address rejected it.",
  failed: "The provider could not send it.",
  replied: "The business replied.",
  cancelled: "Discarded before sending.",
};

/** Where each message status may move. Anything not listed is refused. */
export const OUTREACH_TRANSITIONS: Record<OutreachStatus, readonly OutreachStatus[]> = {
  draft: ["queued", "cancelled"],
  queued: ["sent", "failed", "cancelled"],
  // A provider can accept a message and fail it afterwards (quota, rejection).
  sent: ["delivered", "bounced", "failed", "replied"],
  delivered: ["bounced", "replied"],
  bounced: [],
  failed: [],
  replied: [],
  cancelled: [],
};

/** Not yet sent: at most one per prospect (enforced by a unique column). */
export const OPEN_STATUSES: readonly OutreachStatus[] = ["draft", "queued"];
/** Reached the provider: outreach was attempted. */
export const ATTEMPTED_STATUSES: readonly OutreachStatus[] = ["sent", "delivered", "bounced", "replied"];
/** Sent with no reply and no bounce: a follow-up may be prepared. */
export const AWAITING_REPLY: readonly OutreachStatus[] = ["sent", "delivered"];

export const isOpen = (s: OutreachStatus) => OPEN_STATUSES.includes(s);

export const OUTREACH_KINDS = ["initial", "follow_up"] as const;
export type OutreachKind = (typeof OUTREACH_KINDS)[number];
export const OUTREACH_KIND_LABELS: Record<OutreachKind, string> = { initial: "First message", follow_up: "Follow-up" };

export const REPLY_OUTCOMES = ["interested", "not_interested", "do_not_contact", "other"] as const;
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];
export const isReplyOutcome = (v: string): v is ReplyOutcome => (REPLY_OUTCOMES as readonly string[]).includes(v);

export const REPLY_OUTCOME_LABELS: Record<ReplyOutcome, string> = {
  interested: "Interested",
  not_interested: "Not interested",
  do_not_contact: "Asked not to be contacted",
  other: "Other (a question, wrong person, …)",
};

/**
 * What a reply does to the prospect's status, applied only when the move is
 * allowed from where the prospect is. "Asked not to be contacted" always
 * applies: Do not contact is reachable from every status. A reply nobody
 * has classified yet counts as a conversation (Engaged).
 */
export const REPLY_PROSPECT_STATUS: Record<ReplyOutcome | "unclassified", Status> = {
  unclassified: "engaged",
  interested: "engaged",
  other: "engaged",
  not_interested: "lost",
  do_not_contact: "do_not_contact",
};

/** Positive and negative replies, for counting. */
export const POSITIVE_REPLIES: readonly ReplyOutcome[] = ["interested"];
export const NEGATIVE_REPLIES: readonly ReplyOutcome[] = ["not_interested", "do_not_contact"];

const EMAIL_RE = /^[^\s@"<>(),;:]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
/** A deliverable-looking address: one @, a dotted domain, no display name or list. */
export const isValidEmail = (email: string) => email.length <= 254 && EMAIL_RE.test(email);
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Prospect statuses a first message may be drafted for. */
export const INITIAL_DRAFT_STATUSES: readonly Status[] = ["new", "qualified", "ready_to_contact"];
/** Prospect statuses a follow-up may be drafted for: contacted, no reply yet. */
export const FOLLOW_UP_STATUSES: readonly Status[] = ["contacted"];
/**
 * Prospect statuses that end outreach. Entering one cancels any open
 * message, so nothing drafted earlier can be sent afterwards.
 */
export const OUTREACH_CLOSED: readonly Status[] = ["customer", "not_a_fit", "lost", "do_not_contact", "archived"];

export interface DraftContext extends StatusContext {
  status: Status;
  email: string | null;
  emailSourceUrl: string | null;
}

/**
 * Why a message can't be drafted for this prospect (empty when it can). A
 * first message needs everything Ready to contact needs, plus a published
 * business email: email is the only channel.
 */
export function draftEligibilityErrors(kind: OutreachKind, p: DraftContext): string[] {
  if (p.status === "do_not_contact") return ["This prospect must never be contacted."];
  const allowed = kind === "initial" ? INITIAL_DRAFT_STATUSES : FOLLOW_UP_STATUSES;
  const errors: string[] = [];
  if (!allowed.includes(p.status)) {
    errors.push(
      kind === "initial"
        ? `A first message is only prepared for ${allowed.map((s) => STATUS_LABELS[s]).join(", ")} prospects; this one is ${STATUS_LABELS[p.status]}.`
        : `A follow-up is only prepared for ${allowed.map((s) => STATUS_LABELS[s]).join(", ")} prospects; this one is ${STATUS_LABELS[p.status]}.`,
    );
  }
  // The same requirements as Ready to contact; the contact one is narrowed to email below.
  errors.push(
    ...statusRequirementErrors("ready_to_contact", p)
      .filter((e) => !/public business phone or email/.test(e))
      .map((e) => e.replace(/^Ready to contact requires/, "Outreach requires")),
  );
  if (!p.email || !p.emailSourceUrl) errors.push("Outreach requires a public business email with the URL where it was found.");
  else if (!isValidEmail(p.email)) errors.push(`The business email ${p.email} isn't a valid address.`);
  return [...new Set(errors)];
}

/** Empty when a message may move from one status to the other. */
export function outreachTransitionErrors(from: OutreachStatus, to: OutreachStatus): string[] {
  if (from === to) return [`Already ${OUTREACH_STATUS_LABELS[to]}.`];
  if (!OUTREACH_TRANSITIONS[from].includes(to)) {
    return [`Can't move a message from ${OUTREACH_STATUS_LABELS[from]} to ${OUTREACH_STATUS_LABELS[to]}.`];
  }
  return [];
}
