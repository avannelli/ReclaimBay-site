/*
 * Outreach message generation: deterministic templates over evidence
 * ReclaimBay already stores. Pure: no database, no network, no model.
 *
 * Every personal detail in a message comes from an OutreachFact, and a fact
 * exists only when the record supports it:
 *
 *   - a stored field (business name, location, the published email), or
 *   - a signal recorded as "yes" that has at least one evidence excerpt.
 *
 * Unknown, "no", and unevidenced signals produce no fact, so the message
 * can't mention them. Excerpts are kept as references, never quoted into
 * the message. What the message says about ReclaimBay itself is fixed text.
 *
 * Links: a first message links its invitation (/invite#<token>); a follow-up
 * reuses the link its first message carried. A follow-up to a message made
 * before invitations existed keeps the prospect's referral link
 * (follow-up@t1), as it always did.
 */

import { collisionEvidenceErrors, collisionFit } from "../research/collisionFit.js";

export const INTRO_TEMPLATE = "intro@t4";
/** A follow-up that reuses its first message's invitation link. */
export const FOLLOW_UP_TEMPLATE = "follow-up@t2";
/** A follow-up to a first message without an invitation (made before invitations existed): the referral link. */
export const LEGACY_FOLLOW_UP_TEMPLATE = "follow-up@t1";

/** The referral link's campaign for a template ("intro@t1" -> "outreach-intro-t1"). */
export const campaignOf = (template: string) => `outreach-${template.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

export interface ComposeInput {
  businessName: string;
  city: string | null;
  state: string | null;
  website: string | null;
  email: string;
  emailSourceUrl: string;
  signals: readonly { key: string; value: string }[];
  evidence: readonly { signalKey: string; sourceUrl: string; excerpt: string }[];
  /**
   * The one link the message carries: for a first message, its invitation
   * (/invite#<token>); for a follow-up, the link its first message carried,
   * or the referral link when that message had no invitation.
   */
  link: string;
  sender: { name: string | null; postalAddress: string | null };
}

export interface OutreachFact {
  key: string;
  /** What the record establishes, in plain words. */
  statement: string;
  /** The signal it rests on, or null for a stored field. */
  signalKey: string | null;
  sourceUrl: string | null;
  excerpt: string | null;
}

export interface ComposedMessage {
  template: string;
  campaign: string;
  subject: string;
  body: string;
  /** The facts the message relies on, in the order it uses them. */
  evidence: OutreachFact[];
}

/** Statements for signals that may support a fact when observed as "yes". */
const SIGNAL_STATEMENTS: Record<string, string> = {
  independent_shop: "It is an independent shop.",
  general_repair_services: "It offers general repair.",
  digital_inspections: "It mentions digital inspections.",
  multiple_bays_or_staff: "It has 3 or more bays or technicians.",
  no_online_booking: "Its website has no online booking.",
  website_not_https: "Its website is not on HTTPS.",
  website_no_recent_date: "Its website shows no date from the last two years.",
};

/**
 * Service names as research records them (src/research/analyze.ts writes
 * "Names <label>, <label>: <quote>"), and how a message says them. Labels
 * outside this list are ignored, so nothing unrecognised reaches a message.
 */
const SERVICE_PHRASES: Record<string, string> = {
  brakes: "brakes",
  "suspension/steering": "suspension and steering",
  "engine diagnostics": "engine diagnostics",
  "maintenance/oil service": "maintenance",
  "A/C": "A/C",
  electrical: "electrical",
  transmission: "transmission",
  "cooling system": "cooling systems",
  exhaust: "exhaust",
};

/** The named services in a research excerpt, as message phrases. */
export function servicesFromExcerpt(excerpt: string): string[] {
  const m = /^Names ([^:]+):/.exec(excerpt);
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((s) => SERVICE_PHRASES[s.trim()])
    .filter((s): s is string => Boolean(s));
}

const list = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;

/** Every fact the record supports, whether or not a template uses it. */
export function outreachFacts(input: ComposeInput): OutreachFact[] {
  const facts: OutreachFact[] = [
    { key: "business_name", statement: `The business is called ${input.businessName}.`, signalKey: null, sourceUrl: null, excerpt: null },
  ];
  const place = [input.city, input.state].filter(Boolean).join(", ");
  if (input.city) facts.push({ key: "location", statement: `It is in ${place}.`, signalKey: null, sourceUrl: null, excerpt: null });
  facts.push({
    key: "recipient",
    statement: `It publishes ${input.email} as its business email.`,
    signalKey: null,
    sourceUrl: input.emailSourceUrl,
    excerpt: null,
  });
  for (const [key, statement] of Object.entries(SIGNAL_STATEMENTS)) {
    if (!input.signals.some((s) => s.key === key && s.value === "yes")) continue;
    const ev = input.evidence.find((e) => e.signalKey === key && e.sourceUrl.trim() && e.excerpt.trim());
    if (!ev) continue;
    let text = statement;
    if (key === "general_repair_services") {
      const services = servicesFromExcerpt(ev.excerpt);
      if (services.length) text = `It offers general repair, including ${list(services)}.`;
    }
    facts.push({ key, statement: text, signalKey: key, sourceUrl: ev.sourceUrl, excerpt: ev.excerpt });
  }
  return facts;
}

/** How every message tells the reader to opt out; sending checks it is there. */
export const OPT_OUT_INSTRUCTION = 'reply "no thanks"';

/** The closing every message carries: who it is from, how to opt out. */
function signOff(input: ComposeInput): string {
  return [
    input.sender.name ? `${input.sender.name}\nReclaimBay` : "The ReclaimBay team",
    "",
    `If you'd rather not hear from us, ${OPT_OUT_INSTRUCTION} and we won't contact ${input.businessName} again.`,
    ...(input.sender.postalAddress ? [input.sender.postalAddress] : []),
  ].join("\n");
}

/** Fixed phrases only: stored excerpts establish a service, never supply email copy. */
function collisionObservation(input: ComposeInput): { observation: string; fact: OutreachFact } | undefined {
  if (!input.signals.some(s => s.key === "collision_repair_services" && s.value === "yes") ||
      collisionEvidenceErrors(input, input.evidence).length) return;
  const services: readonly [RegExp, string][] = [
    [/\bpaintless\s+dent\s+repair\b/i, "paintless dent repair"],
    [/\b(?:automotive|vehicle|car)\s+frame\s+repairs?\b/i, "automotive frame repair"],
    [/\b(?:automotive|vehicle|car)\s+structural\s+repairs?\b/i, "automotive structural repair"],
    [/\bauto(?:motive)?[- ]?body(?:\s+(?:and|&)\s+paint)?\s+(?:repairs?|services?)\b/i, "auto body repair"],
    [/\b(?:collision|accident)(?:[- ]damage)?\s+repairs?\b/i, "collision repair"],
  ];
  for (const evidence of input.evidence.filter(e => e.signalKey === "collision_repair_services")) {
    const fit = collisionFit(input.businessName, [{ url: evidence.sourceUrl, role: "services", parsed: { text: evidence.excerpt } }]);
    if (fit.status !== "primary" && fit.status !== "possible") continue;
    const service = services.find(([pattern]) => pattern.test(fit.excerpt ?? ""))?.[1];
    if (!service) continue;
    return {
      observation: `you offer ${service}`,
      fact: { key: "collision_repair_services", statement: `It offers ${service}.`, signalKey: "collision_repair_services", sourceUrl: evidence.sourceUrl, excerpt: evidence.excerpt },
    };
  }
}

/** The first message uses the approved collision-shop opening unless a verified service supports one observation. */
export function composeIntro(input: ComposeInput): ComposedMessage {
  const facts = new Map(outreachFacts(input).map((f) => [f.key, f]));
  const used: OutreachFact[] = [];
  const use = (key: string) => {
    const f = facts.get(key);
    if (f) used.push(f);
    return f;
  };
  const name = input.businessName;
  use("business_name");
  use("recipient");
  const verified = collisionObservation(input);
  if (verified) used.push(verified.fact);

  const body = [
    `Hi ${name} team,`,
    "",
    `I came across ${name} and noticed ${verified?.observation ?? "you handle collision and body repair"}.`,
    "",
    "One thing we've been looking at is how much repair work can get left behind after an estimate is written — a customer declines it, puts it off, or the work simply never makes it back onto the schedule.",
    "",
    "That's what we built ReclaimBay around. It looks at the repair information a shop already has and helps identify past opportunities that may still be worth recovering.",
    "",
    "See what your shop may be leaving behind →",
    "",
    input.link,
    "",
    "It takes just a few minutes to take a look, and there's nothing to schedule.",
    "",
    "Best,",
    input.sender.name ? `${input.sender.name}\nReclaimBay` : "The ReclaimBay team",
    ...(input.sender.postalAddress ? ["", input.sender.postalAddress] : []),
    "",
    `If you'd rather not receive emails from ReclaimBay, ${OPT_OUT_INSTRUCTION}.`,
  ].join("\n");

  return {
    template: INTRO_TEMPLATE,
    campaign: campaignOf(INTRO_TEMPLATE),
    subject: `A quick question about ${name}`,
    body,
    evidence: used,
  };
}

/**
 * A follow-up to a message that was sent and not answered. It carries the
 * link given: the first message's own invitation link (follow-up@t2), or,
 * for a first message made before invitations, the referral link
 * (follow-up@t1).
 */
export function composeFollowUp(input: ComposeInput, original: { subject: string; sentAt: Date }, opts: { reusesInvitation: boolean }): ComposedMessage {
  const facts = new Map(outreachFacts(input).map((f) => [f.key, f]));
  const used = ["business_name", "recipient"].map((k) => facts.get(k)!);
  const day = original.sentAt.toISOString().slice(0, 10);
  const body = [
    `Hi ${input.businessName} team,`,
    "",
    `Following up on my note from ${day} about declined work. If it would help to see the total value of the work your customers have declined or put off, ReclaimBay shows it from your declined-work report, analyzed privately in your browser: ${input.link}`,
    "",
    signOff(input),
  ].join("\n");
  const template = opts.reusesInvitation ? FOLLOW_UP_TEMPLATE : LEGACY_FOLLOW_UP_TEMPLATE;
  return {
    template,
    campaign: campaignOf(template),
    subject: original.subject.startsWith("Re: ") ? original.subject : `Re: ${original.subject}`,
    body,
    evidence: used,
  };
}
