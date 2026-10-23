import { RECENT_DAYS } from "./analyze";
import type { Opportunity } from "./types";

/**
 * Turns declined line items into follow-ups: one per customer and vehicle,
 * because a shop calls a customer about a car, not about a line item.
 *
 * Grouping is deliberately conservative and deterministic (input order):
 * - lines combine only when the customer name matches exactly (case and
 *   spacing aside) AND either the vehicle matches exactly, or there is no
 *   vehicle on either line and the phone or email matches;
 * - a line with a vehicle never combines with one without, so the same name
 *   on different (or unknown) vehicles stays separate;
 * - two different phone numbers or two different emails never combine;
 * - a line that could join more than one group joins none (ambiguous);
 * - a line without a customer name always stays on its own.
 * Nothing is inferred beyond the uploaded fields.
 */

/** "Call first" uses the report's recent window; "Next" runs to one year. */
export const NEXT_MAX_DAYS = 365;

export type FollowUpTier = "call_first" | "next" | "review";

export const TIER_ORDER: FollowUpTier[] = ["call_first", "next", "review"];

export const TIER_LABEL: Record<FollowUpTier, string> = {
  call_first: "Call first",
  next: "Next",
  review: "Review",
};

export interface FollowUp {
  /** Stable within one analysis: the first line's id. */
  id: number;
  customer?: string;
  vehicle?: string;
  phone?: string;
  email?: string;
  /** Declined lines in this follow-up, largest first. */
  items: Opportunity[];
  total: number;
  /** Days since the most recent decline among its dated lines. */
  latestAgeDays?: number;
  latestDate?: Date;
  reachable: boolean;
  tier: FollowUpTier;
}

export interface TierSummary {
  tier: FollowUpTier;
  count: number;
  value: number;
}

export interface FollowUpPlan {
  /** "customer" when the export names customers; otherwise every line stands alone. */
  basis: "customer" | "line";
  followUps: FollowUp[];
  tiers: Record<FollowUpTier, TierSummary>;
  /** Phone or email present anywhere in the export. */
  hasContactFields: boolean;
  /** Any usable decline date in the export; tiers use recency only when true. */
  hasDates: boolean;
  /** Follow-ups that combine more than one declined line. */
  combinedFollowUps: number;
  /** Lines without a customer name (kept on their own). */
  unnamedLines: number;
  contact: {
    phone: { count: number; value: number };
    emailOnly: { count: number; value: number };
    none: { count: number; value: number };
  };
}

/** The rule as customers read it, shared by the browser report, PDF and CSV. */
export const GROUPING_RULE =
  "Declined lines are combined only when the customer name and vehicle match exactly, or, with no vehicle listed, when the customer name and the phone or email match. Different phone numbers or emails are never combined; a line that could belong to more than one customer, or has no customer name, stays on its own.";

export function tierRule(hasDates: boolean): string {
  return hasDates
    ? `Call first: a phone or email is on file and the most recent decline is within ${RECENT_DAYS} days. Next: reachable, declined ${RECENT_DAYS + 1}–${NEXT_MAX_DAYS} days ago. Review: older, undated or without contact details. Within each group, follow-ups are ordered by combined declined value. This is a sorting rule, not a prediction.`
    : "No usable dates were found, so groups use contact details only. Call first: a phone or email is on file. Review: no contact details. Within each group, follow-ups are ordered by combined declined value. This is a sorting rule, not a prediction.";
}

const norm = (s?: string) => s?.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() || "";
const normEmail = (s?: string) => s?.trim().toLowerCase() || "";
/** Digits only, ignoring a leading US country code; short values compare as text. */
const normPhone = (s?: string) => {
  const digits = (s ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 7 ? digits : norm(s);
};

interface Cluster {
  name: string;
  vehicle: string;
  phone: string;
  email: string;
  items: Opportunity[];
}

const compatible = (c: Cluster, phone: string, email: string) => {
  if (phone && c.phone && phone !== c.phone) return false;
  if (email && c.email && email !== c.email) return false;
  // A vehicle match corroborates the name; without one, contact must match.
  if (c.vehicle) return true;
  return Boolean((phone && phone === c.phone) || (email && email === c.email));
};

const tierOf = (reachable: boolean, age: number | undefined, hasDates: boolean): FollowUpTier => {
  if (!reachable) return "review";
  if (!hasDates) return "call_first";
  if (age === undefined) return "review";
  if (age <= RECENT_DAYS) return "call_first";
  return age <= NEXT_MAX_DAYS ? "next" : "review";
};

export function buildFollowUps(opportunities: Opportunity[]): FollowUpPlan {
  const hasDates = opportunities.some((o) => o.ageDays !== undefined);
  const hasContactFields = opportunities.some((o) => o.phone || o.email);
  const basis = opportunities.some((o) => norm(o.customer)) ? "customer" : "line";

  const clusters: Cluster[] = [];
  const byKey = new Map<string, Cluster[]>();
  let unnamedLines = 0;
  for (const o of [...opportunities].sort((a, b) => a.id - b.id)) {
    const name = norm(o.customer),
      vehicle = norm(o.vehicle),
      phone = o.phone ? normPhone(o.phone) : "",
      email = normEmail(o.email);
    if (!name) {
      unnamedLines++;
      clusters.push({ name, vehicle, phone, email, items: [o] });
      continue;
    }
    const key = `${name}|${vehicle}`;
    const bucket = byKey.get(key) ?? [];
    // A line that could belong to two different groups is ambiguous: keep it separate.
    const matches = bucket.filter((c) => compatible(c, phone, email));
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match) {
      match.items.push(o);
      match.phone ||= phone;
      match.email ||= email;
    } else {
      const created = { name, vehicle, phone, email, items: [o] };
      bucket.push(created);
      byKey.set(key, bucket);
      clusters.push(created);
    }
  }

  const followUps: FollowUp[] = clusters.map((c) => {
    const items = [...c.items].sort((a, b) => b.amount - a.amount || a.id - b.id);
    const dated = items.filter((o) => o.ageDays !== undefined);
    const latest = dated.reduce<Opportunity | undefined>(
      (best, o) => (!best || o.ageDays! < best.ageDays! ? o : best),
      undefined,
    );
    // Show the first value the export gave, so displayed contact details are real cells.
    const first = (pick: (o: Opportunity) => string | undefined) =>
      [...c.items].sort((a, b) => a.id - b.id).map(pick).find(Boolean);
    const phone = first((o) => o.phone),
      email = first((o) => o.email);
    const reachable = Boolean(phone || email);
    return {
      id: Math.min(...c.items.map((o) => o.id)),
      customer: first((o) => o.customer),
      vehicle: first((o) => o.vehicle),
      phone,
      email,
      items,
      total: items.reduce((s, o) => s + o.amount, 0),
      latestAgeDays: latest?.ageDays,
      latestDate: latest?.date,
      reachable,
      tier: tierOf(reachable, latest?.ageDays, hasDates),
    };
  });

  followUps.sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
      b.total - a.total ||
      (a.latestAgeDays ?? Infinity) - (b.latestAgeDays ?? Infinity) ||
      a.id - b.id,
  );

  const tiers = Object.fromEntries(
    TIER_ORDER.map((tier) => {
      const inTier = followUps.filter((f) => f.tier === tier);
      return [tier, { tier, count: inTier.length, value: inTier.reduce((s, f) => s + f.total, 0) }];
    }),
  ) as Record<FollowUpTier, TierSummary>;

  const sumOf = (list: FollowUp[]) => ({ count: list.length, value: list.reduce((s, f) => s + f.total, 0) });
  return {
    basis,
    followUps,
    tiers,
    hasContactFields,
    hasDates,
    combinedFollowUps: followUps.filter((f) => f.items.length > 1).length,
    unnamedLines,
    contact: {
      phone: sumOf(followUps.filter((f) => f.phone)),
      emailOnly: sumOf(followUps.filter((f) => !f.phone && f.email)),
      none: sumOf(followUps.filter((f) => !f.reachable)),
    },
  };
}
