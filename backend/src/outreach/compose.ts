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
 * the message. What the message says about ReclaimBay itself is fixed text
 * taken from the public site.
 */

export const INTRO_TEMPLATE = "intro@t1";
export const FOLLOW_UP_TEMPLATE = "follow-up@t1";

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
  /** The prospect's referral link, built by the caller with this template's campaign. */
  referralUrl: string;
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
    const ev = input.evidence.find((e) => e.signalKey === key);
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

/**
 * The first message (intro@t1). It uses the facts that bear on declined
 * work: independence, general repair (and the services named), and digital
 * inspections. Website-condition facts are recorded but not used: ReclaimBay
 * doesn't fix websites, so they aren't a reason to write.
 */
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
  const location = use("location");
  const independent = use("independent_shop");
  const repair = use("general_repair_services");
  const inspections = use("digital_inspections");

  const services = repair ? servicesFromExcerpt(repair.excerpt ?? "").slice(0, 3) : [];
  const where = location ? ` in ${[input.city, input.state].filter(Boolean).join(", ")}` : "";
  const opening = `I came across ${name}${where} while looking for ${independent ? "independent " : ""}auto repair shops.`;
  const work = repair
    ? services.length
      ? ` I saw that you handle ${list(services)}${inspections ? ", and that you offer digital inspections" : ""}.`
      : ` I saw that you do general repair work${inspections ? " and offer digital inspections" : ""}.`
    : inspections
      ? " I saw that you offer digital inspections."
      : "";

  const body = [
    `Hi ${name} team,`,
    "",
    `${opening}${work}`,
    "",
    "Work that customers decline or put off is easy to lose track of. ReclaimBay reads the declined or deferred work report from your shop management system and shows its total value, the highest-value jobs, and where that value is concentrated. The file is analyzed privately in your browser and never uploaded.",
    "",
    `If you'd like to see what's in yours, you can try it here: ${input.referralUrl}`,
    "",
    signOff(input),
  ].join("\n");

  return {
    template: INTRO_TEMPLATE,
    campaign: campaignOf(INTRO_TEMPLATE),
    subject: `Declined work at ${name}`,
    body,
    evidence: used,
  };
}

/** A follow-up (follow-up@t1) to a message that was sent and not answered. */
export function composeFollowUp(input: ComposeInput, original: { subject: string; sentAt: Date }): ComposedMessage {
  const facts = new Map(outreachFacts(input).map((f) => [f.key, f]));
  const used = ["business_name", "recipient"].map((k) => facts.get(k)!);
  const day = original.sentAt.toISOString().slice(0, 10);
  const body = [
    `Hi ${input.businessName} team,`,
    "",
    `Following up on my note from ${day} about declined work. If it would help to see the total value of the work your customers have declined or put off, ReclaimBay shows it from your declined-work report, analyzed privately in your browser: ${input.referralUrl}`,
    "",
    signOff(input),
  ].join("\n");
  return {
    template: FOLLOW_UP_TEMPLATE,
    campaign: campaignOf(FOLLOW_UP_TEMPLATE),
    subject: original.subject.startsWith("Re: ") ? original.subject : `Re: ${original.subject}`,
    body,
    evidence: used,
  };
}
