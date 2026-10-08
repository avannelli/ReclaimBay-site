/** ReclaimBay-owned qualification definitions and observation semantics.
 * Behavior changes require a version bump and an explicit cache-refresh decision.
 * This extraction preserves v3 and never initiates a rescore.
 */
import type { Qualification, ScoreBand, ScoringPolicy, SignalState, StoredSignalValue } from "../../qualification/policy.js";

export const POLICY_ID = "reclaimbay.qualification";
export const SCORING_VERSION = "v3";

export interface SignalDefinition {
  key: string;
  label: string;
  weight: number;
  /** The question being answered, phrased as an observation. */
  question: string;
  yes: string;
  no: string;
  unknown: string;
  rationale: string;
  /**
   * "observation": set by the admin from public sources.
   * "derived": "yes" comes automatically from stored fields; the admin may
   * only record "no" (searched, found nothing) while those fields are empty.
   */
  kind: "observation" | "derived";
  /** Can only be observed on the shop's own website. */
  requiresWebsite?: boolean;
  /** Required business criterion: "no" disqualifies, all "yes" qualifies. */
  requiredCriterion?: boolean;
  /**
   * A "yes" here is also a "yes" for that required criterion (collision/body
   * repair is automotive repair). Never the reverse, and never from "no".
   */
  establishes?: string;
}

export const SIGNALS = [
  {
    key: "independent_shop",
    label: "Independent shop",
    weight: 15,
    kind: "observation",
    question: "Is the shop independent of franchises, dealerships, and large chains?",
    yes: "The website and primary business listing show no franchise brand (e.g. Midas, Meineke, Firestone, Jiffy Lube, Pep Boys, Christian Brothers), it is not a new-car dealership's service department, and the same business name operates 5 or fewer locations.",
    no: "It is a franchise location, a dealership service department, or part of a brand operating more than 5 locations.",
    unknown: "Ownership or brand affiliation has not been checked, or public sources conflict.",
    rationale:
      "Prioritization only: independent ownership may simplify purchasing. Chains and dealerships are not disqualified by ownership.",
  },
  {
    key: "general_repair_services",
    label: "Offers general repair",
    weight: 10,
    kind: "observation",
    question: "Does the shop advertise general mechanical repair or maintenance?",
    yes: "The website or primary listing names at least 2 of: brakes, suspension/steering, engine diagnostics, scheduled maintenance/oil service, A/C, electrical, transmission, cooling system, exhaust.",
    no: "Every advertised service is a non-mechanical specialty only: collision/body, glass, tint, detailing, audio, towing, or tires only.",
    unknown: "No services list was found or checked.",
    rationale:
      "Historical mechanical-service observation (two service words anywhere on the site). Prioritization only: it never establishes or disqualifies product fit, and is never converted into verified automotive repair.",
  },
  {
    key: "automotive_repair_services",
    label: "Verified automotive repair",
    weight: 20,
    kind: "observation",
    requiredCriterion: true,
    question: "Does this verified business actually perform automotive repair or service work?",
    yes: "Verified business identity and a public source with an excerpt explicitly advertising automotive repair/service work by this business: general or mechanical repair, collision/body, engine, transmission/drivetrain, brakes, diagnostics, electrical, diesel, suspension/steering, A/C, exhaust or similar. A verified collision/body Yes also counts. No unresolved contradictory evidence. Dealership service departments, fleet operations, and maintenance-only or cosmetic-only specialty businesses require a person to verify and record Yes.",
    no: "Positive sourced evidence explicitly says this business does not perform automotive repair (e.g. \"we do not perform repairs\", test-only inspection). Tire sales, glass, detailing, washing, towing, sales, parts, accessories or inspection work alone never establishes a Yes.",
    unknown: "Identity or repair services are unverified, evidence is missing, contradictory, third-party or generic, or a dealership/fleet/specialty case needs human verification. A name, provider category or opportunity score never decides it.",
    rationale: "The sole required product-fit signal: ReclaimBay serves businesses whose repair/service work produces declined, deferred or unsold work. Collision/body repair is one valid segment, not a requirement. A high opportunity score cannot replace repair evidence, and a low score cannot disqualify verified fit.",
  },
  {
    key: "collision_repair_services",
    label: "Verified collision/body repair",
    weight: 0,
    kind: "observation",
    establishes: "automotive_repair_services",
    question: "Does this verified business actually perform automotive collision/body repair?",
    yes: "Verified business identity and a public source with an excerpt explicitly advertising automotive collision, accident, auto body, panel/body or structural repair; no unresolved contradictory evidence. Dealership departments and specialty-only dent/paint businesses require human verification.",
    no: "Positive sourced evidence explicitly says this business does not perform collision/body repair. This only describes the segment: a business without collision/body repair can still qualify through verified automotive repair.",
    unknown: "Identity or collision/body services are unverified, evidence is missing, contradictory, third-party or generic, or a possible dealership/specialty case needs human verification.",
    rationale: "Segment observation, not a requirement and not a ranking factor (weight 0). A verified Yes also counts as verified automotive repair, so collision/body shops qualify exactly as before. No never disqualifies.",
  },
  {
    key: "multiple_bays_or_staff",
    label: "3+ bays or technicians",
    weight: 15,
    kind: "observation",
    question: "Does a public source show at least 3 service bays or 3 technicians?",
    yes: "A public source states or shows 3 or more service bays, or names/counts 3 or more technicians (e.g. a team page, or \"our 4 ASE-certified technicians\").",
    no: "A public source states 1 or 2 bays, or describes a single-mechanic operation.",
    unknown: "No public source gives a bay or technician count.",
    rationale:
      "More bays means more inspections and more declined work, so a larger potential recovery. Weighted below fit signals because small shops can still benefit.",
  },
  {
    key: "digital_inspections",
    label: "Mentions digital inspections",
    weight: 10,
    kind: "observation",
    requiresWebsite: true,
    question: "Does the shop's website mention digital vehicle inspections?",
    yes: "The website mentions digital or photo/video vehicle inspections, inspection reports sent by text or email, or names a DVI product.",
    no: "The homepage and services page(s) were reviewed and contain no such mention.",
    unknown: "No website, or the website was not reviewed.",
    rationale:
      "Digital inspections produce itemized recommendations, most of which are declined, and indicate shop-management software that can export them: exactly ReclaimBay's input.",
  },
  {
    key: "public_business_contact",
    label: "Public business contact",
    weight: 10,
    kind: "derived",
    question: "Is a business phone number or email publicly listed?",
    yes: "Automatic: a business phone or email is stored together with the public URL where it was found.",
    no: "The website and primary business listing were searched and list neither a phone number nor an email address.",
    unknown: "Not searched yet, and no contact detail is stored.",
    rationale:
      "A shop that can be reached through its published channels is actionable. Weighted modestly because it says nothing about fit.",
  },
  {
    key: "has_website",
    label: "Has a website",
    weight: 5,
    kind: "derived",
    question: "Does the shop have its own website?",
    yes: "Automatic: a website URL is stored.",
    no: "A web search for the business name and city found no website of its own (a directory or social listing does not count).",
    unknown: "Not searched yet, and no website is stored.",
    rationale:
      "Low weight. A website makes the shop researchable and shows some investment in marketing, but many good prospects have a thin web presence.",
  },
  {
    key: "no_online_booking",
    label: "No online booking",
    weight: 5,
    kind: "observation",
    requiresWebsite: true,
    question: "Does the website lack online appointment scheduling?",
    yes: "The website was reviewed and has no online scheduling form, widget, or booking link. A general contact form or \"call to schedule\" counts as no online booking.",
    no: "The website offers an appointment request form, scheduling widget, or booking link.",
    unknown: "No website, or the website was not reviewed.",
    rationale:
      "Weak proxy for less automated customer follow-up, which leaves more declined work unrecovered. Low weight because booking tools say little about follow-up.",
  },
  {
    key: "website_not_https",
    label: "Website not on HTTPS",
    weight: 5,
    kind: "observation",
    requiresWebsite: true,
    question: "Does the website fail to load over HTTPS with a valid certificate?",
    yes: "Opening https://<domain> fails, redirects to http://, or shows a browser certificate warning.",
    no: "The site loads over https:// with no certificate warning.",
    unknown: "No website, or not checked.",
    rationale:
      "An objective marker of a website that is not actively maintained, suggesting room for better tools. Low weight: an observation, not a judgment of the shop.",
  },
  {
    key: "website_no_recent_date",
    label: "No recent date on website",
    weight: 5,
    kind: "observation",
    requiresWebsite: true,
    question: "Is every date visible on the website at least 2 calendar years old?",
    yes: "The newest date anywhere on the site (copyright year, post, news item, \"last updated\") is 2 or more calendar years before the observation date.",
    no: "The site shows a date in the current or previous calendar year.",
    unknown: "No website, not checked, or the site shows no dates at all.",
    rationale:
      "An objective marker of an unmaintained website, used instead of a subjective \"looks dated\". Low weight for the same reason as HTTPS.",
  },
] as const satisfies readonly SignalDefinition[];

export type SignalKey = (typeof SIGNALS)[number]["key"];

export const SIGNAL_KEYS: readonly SignalKey[] = SIGNALS.map((s) => s.key);
const BY_KEY = new Map<string, SignalDefinition>(SIGNALS.map((s) => [s.key, s]));

export const isSignalKey = (key: string): key is SignalKey => BY_KEY.has(key);
export const signalDefinition = (key: SignalKey): SignalDefinition => BY_KEY.get(key)!;

export const MAX_SCORE = SIGNALS.reduce((sum, s) => sum + s.weight, 0);

/** Minimum score for each band; anything lower is "low". */
export const BAND_THRESHOLDS = { high: 60, medium: 35 } as const;

export const BAND_LABELS: Record<ScoreBand, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const QUALIFICATION_LABELS: Record<Qualification, string> = {
  meets_criteria: "Meets criteria",
  unverified: "Unverified",
  disqualified: "Disqualified",
};

export const REQUIRED_CRITERIA: readonly SignalKey[] = (SIGNALS as readonly SignalDefinition[])
  .filter((s) => s.requiredCriterion)
  .map((s) => s.key as SignalKey);

/** The product-fit criterion: does the business perform automotive repair/service? */
export const FIT_CRITERION: SignalKey = "automotive_repair_services";

/** The signals whose "yes" also establishes `key`, e.g. collision/body repair for automotive repair. */
export const establishedBy = (key: string): SignalKey[] =>
  (SIGNALS as readonly SignalDefinition[]).filter((s) => s.establishes === key).map((s) => s.key as SignalKey);

/** Every signal whose "yes" can establish product fit: the criterion itself first. */
export const FIT_SIGNALS: readonly SignalKey[] = [FIT_CRITERION, ...establishedBy(FIT_CRITERION)];

/** The stored facts scoring reads. Nothing else influences the score. */
export interface ScoringInput {
  /** Recorded observations; keys outside SIGNALS are ignored. */
  signals: Partial<Record<string, StoredSignalValue>>;
  website?: string | null;
  phone?: string | null;
  phoneSourceUrl?: string | null;
  email?: string | null;
  emailSourceUrl?: string | null;
}

const present = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";

export const hasPublicContact = (input: ScoringInput) =>
  (present(input.phone) && present(input.phoneSourceUrl)) ||
  (present(input.email) && present(input.emailSourceUrl));

/** The effective state of every signal, with derived rules applied. */
export function resolveSignals(input: ScoringInput): Record<SignalKey, SignalState> {
  const out = {} as Record<SignalKey, SignalState>;
  const hasWebsite = present(input.website);
  for (const def of SIGNALS as readonly SignalDefinition[]) {
    const key = def.key as SignalKey;
    const stored = input.signals[key];
    const recorded: SignalState = stored === "yes" || stored === "no" ? stored : "unknown";
    if (key === "has_website") {
      out[key] = hasWebsite ? "yes" : recorded === "no" ? "no" : "unknown";
    } else if (key === "public_business_contact") {
      out[key] = hasPublicContact(input) ? "yes" : recorded === "no" ? "no" : "unknown";
    } else if (def.requiresWebsite && !hasWebsite) {
      out[key] = "unknown";
    } else {
      out[key] = recorded;
    }
  }
  // A "yes" on an establishing signal (collision/body repair) is a "yes" for its
  // criterion; against a recorded "no" the two contradict, so it stays unknown.
  for (const def of SIGNALS as readonly SignalDefinition[]) {
    const key = def.key as SignalKey;
    const by = establishedBy(key);
    if (!by.length || out[key] === "yes" || !by.some((k) => out[k] === "yes")) continue;
    out[key] = out[key] === "no" ? "unknown" : "yes";
  }
  return out;
}

function reasonFor(def: SignalDefinition, state: SignalState, input: ScoringInput): string {
  const recorded = input.signals[def.key];
  const by = establishedBy(def.key).filter((k) => input.signals[k] === "yes").map((k) => signalDefinition(k).label);
  if (by.length && state === "yes" && recorded !== "yes") return `${by.join(" and ")} is Yes, and that is automotive repair.`;
  if (by.length && state === "unknown" && recorded === "no") return `Recorded No, but ${by.join(" and ")} is Yes. Resolve the contradiction.`;
  if (def.key === "has_website" && state === "yes") return "Website URL is stored.";
  if (def.key === "public_business_contact" && state === "yes") {
    const via = [
      present(input.phone) && present(input.phoneSourceUrl) && "phone",
      present(input.email) && present(input.emailSourceUrl) && "email",
    ].filter(Boolean);
    return `Public business ${via.join(" and ")} stored with source.`;
  }
  if (state === "unknown" && def.requiresWebsite && !present(input.website)) {
    return "No website stored, so this can't be observed.";
  }
  if (state === "yes") return def.yes;
  if (state === "no") return def.no;
  return def.unknown;
}

/**
 * Checks recorded observations against the stored fields, so a record never
 * contradicts itself. Returns one message per problem (empty when valid).
 */
export function signalConsistencyErrors(input: ScoringInput): string[] {
  const errors: string[] = [];
  const hasWebsite = present(input.website);
  for (const [key, value] of Object.entries(input.signals)) {
    if (value === undefined) continue;
    if (!isSignalKey(key)) {
      errors.push(`Unknown signal "${key}".`);
      continue;
    }
    const def = signalDefinition(key);
    if (value !== "yes" && value !== "no") {
      errors.push(`${def.label}: value must be yes or no.`);
    } else if (def.kind === "derived" && value === "yes") {
      errors.push(`${def.label}: "yes" is set automatically from the stored fields and can't be recorded by hand.`);
    } else if (key === "has_website" && hasWebsite) {
      errors.push(`${def.label}: recorded as "no" but a website is stored. Set it to unknown or remove the website.`);
    } else if (key === "public_business_contact" && hasPublicContact(input)) {
      errors.push(`${def.label}: recorded as "no" but a public phone or email is stored. Set it to unknown.`);
    } else if (def.requiresWebsite && !hasWebsite) {
      errors.push(`${def.label}: can only be observed on a website. Add the website or set it to unknown.`);
    } else if (def.establishes && value === "yes" && input.signals[def.establishes] === "no") {
      const target = signalDefinition(def.establishes as SignalKey).label;
      errors.push(`${target}: recorded as "no" but ${def.label} is "yes", which is automotive repair. Resolve the contradiction.`);
    }
  }
  return errors;
}


export const reclaimBayScoringPolicy = {
  policyId: POLICY_ID,
  version: SCORING_VERSION,
  signals: SIGNALS,
  bandThresholds: BAND_THRESHOLDS,
  bandLabels: BAND_LABELS,
  qualificationLabels: QUALIFICATION_LABELS,
  resolveSignals,
  explainSignal: (key, state, input) => reasonFor(signalDefinition(key), state, input),
  consistencyErrors: signalConsistencyErrors,
} satisfies ScoringPolicy<ScoringInput, SignalKey>;
