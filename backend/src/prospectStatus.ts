/*
 * Prospect lifecycle. Pure rules, enforced by the service layer for every
 * status change and every edit.
 *
 *   new -> qualified -> ready_to_contact -> contacted -> engaged
 *       -> meeting -> proposal -> customer
 *
 * with exits to not_a_fit, lost (declined after contact), and archived, a
 * way back to new (reopen), and do_not_contact, which is terminal: a
 * compliance flag that must keep a shop out of all future outreach, so
 * nothing in the app can undo it.
 *
 * This is the commercial outcome. What happened to each message (sent,
 * delivered, bounced, replied) is tracked per message in src/outreach.
 */

import type { Qualification } from "./scoring.js";

export const STATUSES = [
  "new",
  "qualified",
  "ready_to_contact",
  "contacted",
  "engaged",
  "meeting",
  "proposal",
  "customer",
  "not_a_fit",
  "lost",
  "do_not_contact",
  "archived",
] as const;

export type Status = (typeof STATUSES)[number];

export const isStatus = (v: string): v is Status => (STATUSES as readonly string[]).includes(v);

export const STATUS_LABELS: Record<Status, string> = {
  new: "New",
  qualified: "Qualified",
  ready_to_contact: "Ready to contact",
  contacted: "Contacted",
  engaged: "Engaged",
  meeting: "Meeting",
  proposal: "Proposal",
  customer: "Customer",
  not_a_fit: "Not a fit",
  lost: "Lost",
  do_not_contact: "Do not contact",
  archived: "Archived",
};

export const STATUS_MEANINGS: Record<Status, string> = {
  new: "Added, not yet researched.",
  qualified: "Verified collision/body product fit (Qualification: Meets criteria).",
  ready_to_contact: "Qualified, and has a public business phone or email with the URL where it was found.",
  contacted: "Reached out to at least once.",
  engaged: "Replied, visited through their referral link, or is otherwise in conversation.",
  meeting: "A call or meeting is scheduled or has taken place.",
  proposal: "An offer has been made and is awaiting a decision.",
  customer: "Using ReclaimBay.",
  not_a_fit: "Researched and ruled out.",
  lost: "Declined after being contacted.",
  do_not_contact: "Asked not to be contacted, or must not be. Permanent.",
  archived: "Set aside without a decision.",
};

/** Where each status may move. Anything not listed is refused. */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  new: ["qualified", "not_a_fit", "do_not_contact", "archived"],
  qualified: ["ready_to_contact", "new", "not_a_fit", "do_not_contact", "archived"],
  ready_to_contact: ["contacted", "qualified", "not_a_fit", "do_not_contact", "archived"],
  contacted: ["engaged", "lost", "not_a_fit", "do_not_contact", "archived"],
  engaged: ["meeting", "proposal", "customer", "contacted", "lost", "not_a_fit", "do_not_contact", "archived"],
  meeting: ["proposal", "customer", "engaged", "lost", "do_not_contact", "archived"],
  proposal: ["customer", "meeting", "engaged", "lost", "do_not_contact", "archived"],
  customer: ["engaged", "do_not_contact", "archived"],
  not_a_fit: ["new", "do_not_contact", "archived"],
  lost: ["engaged", "do_not_contact", "archived"],
  archived: ["new", "do_not_contact"],
  do_not_contact: [],
};

/** Statuses a future outreach feature may ever select from. */
export const OUTREACH_ELIGIBLE: readonly Status[] = ["ready_to_contact"];

/** Changes that must say why. */
export const REASON_REQUIRED: readonly Status[] = ["do_not_contact", "not_a_fit", "lost"];

/** What the rules need to know about a prospect. */
export interface StatusContext {
  businessName: string | null;
  hasPublicContact: boolean;
  /** From the required criteria only. The score never affects status rules. */
  qualification: Qualification;
  /**
   * Only for a prospect marked as an internal outreach test (internalTest.ts):
   * why it isn't the controlled internal-test identity, empty when it is.
   * It claims to be no business, so this replaces qualification and the
   * public-contact rule. Absent or null for every business.
   */
  internalTestIdentity?: readonly string[] | null;
}

/**
 * Requirements that must hold for as long as a prospect is in a status.
 * Checked when entering it and on every edit while in it.
 */
export function statusRequirementErrors(status: Status, ctx: StatusContext): string[] {
  const errors: string[] = [];
  if (ctx.internalTestIdentity) {
    if (status === "qualified" || status === "ready_to_contact") {
      errors.push(...ctx.internalTestIdentity.map((e) => `${STATUS_LABELS[status]} requires the controlled internal-test identity: ${e}`));
    }
    return errors;
  }
  if (status === "qualified" || status === "ready_to_contact") {
    if (!ctx.businessName?.trim()) errors.push(`${STATUS_LABELS[status]} requires a business name.`);
    if (ctx.qualification === "disqualified") {
      errors.push(`${STATUS_LABELS[status]} requires Qualification "Meets criteria"; this prospect is Disqualified (a required criterion is "no").`);
    } else if (ctx.qualification === "unverified") {
      errors.push(`${STATUS_LABELS[status]} requires Qualification "Meets criteria"; this prospect is Unverified (a required criterion is still unknown).`);
    }
  }
  if (status === "ready_to_contact" && !ctx.hasPublicContact) {
    errors.push("Ready to contact requires a public business phone or email, with the URL where it was found.");
  }
  return errors;
}

/** Empty when the change is allowed, otherwise every reason it isn't. */
export function transitionErrors(
  from: Status,
  to: Status,
  ctx: StatusContext,
  reason: string | null,
): string[] {
  if (from === to) return [`Already ${STATUS_LABELS[to]}.`];
  if (from === "do_not_contact") return ["Do not contact is permanent and can't be changed."];
  if (!TRANSITIONS[from].includes(to)) {
    return [`Can't move from ${STATUS_LABELS[from]} to ${STATUS_LABELS[to]}.`];
  }
  const errors = statusRequirementErrors(to, ctx);
  if (REASON_REQUIRED.includes(to) && !reason?.trim()) {
    errors.push(`Moving to ${STATUS_LABELS[to]} requires a reason.`);
  }
  return errors;
}
