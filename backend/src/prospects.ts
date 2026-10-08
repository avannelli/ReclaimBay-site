import { randomInt } from "node:crypto";
import type { Db } from "./db.js";
import type { Prisma } from "./generated/prisma/client.js";
import { OUTREACH_CLOSED } from "./outreach/lifecycle.js";
import { cancelOpenOutreach, lockSendGate, suppressEmail } from "./outreach/records.js";
import { INTERNAL_TEST_IDENTITY, internalTestIdentity, isInternalTestEmail, isInternalTestName } from "./internalTest.js";
import { STATUS_LABELS, isStatus, statusRequirementErrors, transitionErrors, type Status } from "./prospectStatus.js";
import { validateQualificationEvidence } from "@avannelli/aos/qualification";
import { reclaimBayQualificationPolicy } from "./policies/reclaimbay/qualification.js";
import {
  BAND_THRESHOLDS,
  REQUIRED_CRITERIA,
  establishedBy,
  SCORING_VERSION,
  SIGNAL_KEYS,
  hasPublicContact,
  isSignalKey,
  scoreProspect,
  signalConsistencyErrors,
  type Qualification,
  type ScoreBand,
  type ScoringInput,
  type SignalKey,
  type SignalState,
  type StoredSignalValue,
} from "./scoring.js";

/*
 * Prospect service: validation, CRUD, status changes, and score caching.
 * Every write that touches a scoring input recomputes the cached score in
 * the same transaction, so `score` never disagrees with scoring.ts for the
 * version it records.
 *
 * Only public business information is accepted. There is deliberately no
 * field for owner names, personal contact details, or anything from a
 * customer's report, and no way to delete a prospect (archive instead), so
 * a do_not_contact record can't be lost and later re-added.
 */

// ---------- referral codes ----------

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 12;

/** Opaque, unguessable code; never derived from the business name. */
export function generateReferralCode(): string {
  let id = "";
  for (let i = 0; i < CODE_LENGTH; i++) id += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `rb_${id}`;
}

export function referralUrl(siteUrl: string, code: string, campaign?: string | null): string {
  const url = new URL(siteUrl);
  url.searchParams.set("ref", code);
  if (campaign) url.searchParams.set("campaign", campaign);
  return url.toString();
}

// ---------- errors ----------

export class ProspectError extends Error {
  constructor(
    readonly messages: string[],
    readonly kind: "invalid" | "not_found" | "conflict" = "invalid",
  ) {
    super(messages.join(" "));
  }
}

const notFound = () => new ProspectError(["Prospect not found."], "not_found");

// ---------- input parsing ----------

export interface ProspectFields {
  businessName: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  phoneSourceUrl: string | null;
  email: string | null;
  emailSourceUrl: string | null;
}

export interface ProspectInput {
  fields: ProspectFields;
  /** Every signal, including unknowns. */
  signals: Record<SignalKey, SignalState>;
}

export const FIELD_LIMITS = {
  businessName: 120,
  website: 200,
  city: 100,
  state: 50,
  postalCode: 20,
  phone: 30,
  email: 254,
  sourceUrl: 500,
  note: 2000,
  excerpt: 280,
  reason: 500,
} as const;

export const signalFieldName = (key: SignalKey) => `signal_${key}`;

type Raw = Record<string, unknown>;

const text = (raw: Raw, name: string): string | null => {
  const v = raw[name];
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

/** Normalizes an http(s) URL, adding https:// when no scheme is given. */
export function normalizeUrl(value: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9().\-\s]+((x|ext\.?)\s*\d{1,6})?$/i;

/** Whether a string is shaped like a phone number (the same rule everywhere). */
export function isPhoneNumber(phone: string): boolean {
  const digits = phone.replace(/\D/g, "").length;
  return PHONE_RE.test(phone) && digits >= 7 && digits <= 21;
}

/**
 * Parses a create/edit form into a prospect input. Blank fields become null;
 * signals missing from the form are unknown.
 */
export function parseProspectInput(raw: Raw): { input: ProspectInput; errors: string[] } {
  const errors: string[] = [];
  const limit = (label: string, v: string | null, max: number) => {
    if (v && v.length > max) errors.push(`${label} is too long (max ${max}).`);
    return v;
  };
  const url = (label: string, v: string | null) => {
    if (!v) return null;
    const normalized = normalizeUrl(v);
    if (!normalized) errors.push(`${label} must be a valid http(s) URL.`);
    else if (normalized.length > FIELD_LIMITS.sourceUrl) errors.push(`${label} is too long (max ${FIELD_LIMITS.sourceUrl}).`);
    return normalized ?? v;
  };

  const website = url("Website", limit("Website", text(raw, "website"), FIELD_LIMITS.website));
  let state = limit("State", text(raw, "state"), FIELD_LIMITS.state);
  if (state && /^[a-z]{2}$/i.test(state)) state = state.toUpperCase();

  const postalCode = limit("Postal code", text(raw, "postalCode"), FIELD_LIMITS.postalCode);
  if (postalCode && !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(postalCode)) errors.push("Postal code has invalid characters.");

  const country = (text(raw, "country") ?? "US").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) errors.push("Country must be a 2-letter code, e.g. US.");

  const phone = limit("Phone", text(raw, "phone"), FIELD_LIMITS.phone);
  if (phone && !isPhoneNumber(phone)) errors.push("Phone must be a phone number, e.g. (555) 010-0100.");
  const phoneSourceUrl = url("Phone source URL", text(raw, "phoneSourceUrl"));
  if (phone && !phoneSourceUrl) errors.push("Phone needs the public URL where it is listed.");
  if (!phone && phoneSourceUrl) errors.push("Phone source URL is set without a phone number.");

  const emailRaw = limit("Email", text(raw, "email"), FIELD_LIMITS.email);
  const email = emailRaw?.toLowerCase() ?? null;
  if (email && !EMAIL_RE.test(email)) errors.push("Email must be an email address.");
  const emailSourceUrl = url("Email source URL", text(raw, "emailSourceUrl"));
  if (email && !emailSourceUrl) errors.push("Email needs the public URL where it is listed.");
  if (!email && emailSourceUrl) errors.push("Email source URL is set without an email address.");
  // The internal test's controlled identity belongs to it alone (internalTest.ts).
  if (isInternalTestEmail(email)) errors.push(`${INTERNAL_TEST_IDENTITY.email} is ReclaimBay's internal-test mailbox; only the internal outreach test uses it.`);

  const signals = {} as Record<SignalKey, SignalState>;
  for (const key of SIGNAL_KEYS) {
    const v = text(raw, signalFieldName(key)) ?? "unknown";
    if (v !== "yes" && v !== "no" && v !== "unknown") errors.push(`Invalid value for signal ${key}.`);
    signals[key] = v === "yes" || v === "no" ? v : "unknown";
  }

  const businessName = limit("Business name", text(raw, "businessName"), FIELD_LIMITS.businessName);
  if (isInternalTestName(businessName)) errors.push(`"${INTERNAL_TEST_IDENTITY.businessName}" is the internal outreach test's name; a business can't use it.`);

  const input: ProspectInput = {
    fields: {
      businessName,
      website,
      city: limit("City", text(raw, "city"), FIELD_LIMITS.city),
      state,
      postalCode,
      country,
      phone,
      phoneSourceUrl,
      email,
      emailSourceUrl,
    },
    signals,
  };
  errors.push(...signalConsistencyErrors(scoringInputOf(input)));
  return { input, errors };
}

/** Recorded (yes/no) observations only; unknown is the absence of a row. */
export function storedSignals(signals: Partial<Record<string, SignalState>>): Partial<Record<SignalKey, StoredSignalValue>> {
  const out: Partial<Record<SignalKey, StoredSignalValue>> = {};
  for (const [key, v] of Object.entries(signals)) {
    if (isSignalKey(key) && (v === "yes" || v === "no")) out[key] = v;
  }
  return out;
}

export function scoringInputOf(input: ProspectInput): ScoringInput {
  return { ...input.fields, signals: storedSignals(input.signals) };
}

type ProspectWithSignals = Prisma.ProspectGetPayload<{ include: { signals: true } }>;

/** Scoring input from a stored prospect. */
export function scoringInputFromRecord(p: ProspectWithSignals): ScoringInput {
  const signals: Partial<Record<string, StoredSignalValue>> = {};
  for (const s of p.signals) signals[s.key] = s.value;
  return { ...p, signals };
}

function statusContext(input: ScoringInput) {
  return {
    hasPublicContact: hasPublicContact(input),
    qualification: scoreProspect(input).qualification,
  };
}

const scoreData = (input: ScoringInput, now: Date) => ({
  score: scoreProspect(input).score,
  scoreVersion: SCORING_VERSION,
  scoredAt: now,
});

/** Evidence is required at the existing qualification/readiness write boundary, not on New records. */
async function statusEvidenceErrors(
  tx: Tx, prospectId: string, status: Status,
  input: ScoringInput & { businessName: string | null; website: string | null },
  evidence: readonly { signalKey: string; sourceUrl: string; excerpt: string }[],
): Promise<string[]> {
  if ((status !== "qualified" && status !== "ready_to_contact") || scoreProspect(input).qualification !== "meets_criteria") return [];
  const candidate = await tx.discoveryCandidate.findUnique({ where: { prospectId }, select: { research: { where: { status: "completed" }, orderBy: { queuedAt: "desc" }, take: 1, select: { warnings: true } } } });
  return validateQualificationEvidence(reclaimBayQualificationPolicy, {
    ...input, evidence, researchWarnings: candidate?.research[0]?.warnings,
  }).errors;
}

// ---------- writes ----------

/** Anything that can run queries: the client or a transaction. */
type Tx = Prisma.TransactionClient;

export interface ProspectDetails {
  /** When each recorded signal was observed; defaults to now. */
  observedAt?: Partial<Record<string, Date>>;
  evidence?: { signalKey: string; sourceUrl: string; excerpt: string; createdAt?: Date }[];
  notes?: string[];
  /** Only createInternalTestProspect sets this. */
  internalTest?: boolean;
}

/**
 * Inserts a validated prospect with its signals, evidence, notes, cached
 * score, and "Created" history row. Always starts as `new`: nothing here can
 * place a prospect in a later status. Runs inside the caller's transaction.
 */
export async function insertProspect(tx: Tx, input: ProspectInput, referralCode: string, details: ProspectDetails = {}) {
  const now = new Date();
  const prospect = await tx.prospect.create({
    data: {
      ...input.fields,
      referralCode,
      status: "new",
      statusChangedAt: now,
      internalTest: details.internalTest === true,
      ...scoreData(scoringInputOf(input), now),
    },
  });
  const rows = Object.entries(storedSignals(input.signals)).map(([key, value]) => ({
    prospectId: prospect.id,
    key,
    value: value!,
    observedAt: details.observedAt?.[key] ?? now,
  }));
  if (rows.length) await tx.prospectSignal.createMany({ data: rows });
  if (details.evidence?.length) {
    await tx.prospectEvidence.createMany({ data: details.evidence.map((e) => ({ ...e, prospectId: prospect.id })) });
  }
  if (details.notes?.length) {
    await tx.prospectNote.createMany({ data: details.notes.map((body) => ({ prospectId: prospect.id, body })) });
  }
  await tx.prospectStatusChange.create({
    data: { prospectId: prospect.id, fromStatus: null, toStatus: "new", reason: details.internalTest ? "Created as an internal outreach test" : "Created", createdAt: now },
  });
  return prospect;
}

export async function createProspect(db: Db, raw: Raw) {
  const { input, errors } = parseProspectInput(raw);
  if (errors.length) throw new ProspectError(errors);
  return insertWithFreshCode(db, input);
}

/** The note an internal test prospect carries from creation. Stored once: earlier notes keep their wording. */
export const INTERNAL_TEST_NOTE =
  `Internal outreach test: ReclaimBay's own controlled identity, not a business. Its recipient, ${INTERNAL_TEST_IDENTITY.email}, is a mailbox ReclaimBay controls, documented at ${INTERNAL_TEST_IDENTITY.emailSourceUrl}. Business qualification doesn't apply; every sending check does. It is left out of the outreach funnel, the analytics summary, and prospect intent.`;

/** Why an internal test can't be edited or given evidence. */
const INTERNAL_TEST_FIXED = "An internal outreach test isn't a business: its controlled identity is fixed, and it carries no business details or evidence.";

/** Form fields an internal test never carries: anything submitted must be blank or its controlled identity. */
const INTERNAL_TEST_FIELDS: Record<string, string> = {
  businessName: "Business name",
  website: "Website",
  city: "City",
  state: "State",
  postalCode: "Postal code",
  phone: "Phone",
  phoneSourceUrl: "Phone source URL",
  email: "Email",
  emailSourceUrl: "Email source URL",
};

/** Why this submission can't create the internal test (empty when it can). */
export function internalTestFormErrors(raw: Raw): string[] {
  const errors: string[] = [];
  const fixed: Record<string, string> = INTERNAL_TEST_IDENTITY;
  for (const [name, label] of Object.entries(INTERNAL_TEST_FIELDS)) {
    const v = text(raw, name);
    if (v === null || (name in fixed && v.toLowerCase() === fixed[name]!.toLowerCase())) continue;
    errors.push(
      name in fixed
        ? `${label} of an internal test is always ${fixed[name]}; it can't be ${v}.`
        : `An internal test isn't a business: it has no ${label[0]!.toLowerCase()}${label.slice(1)}.`,
    );
  }
  if (SIGNAL_KEYS.some((k) => (text(raw, signalFieldName(k)) ?? "unknown") !== "unknown")) {
    errors.push("An internal test isn't a business: it records no business signals.");
  }
  if (raw.confirmInternalTest !== "yes") {
    errors.push("Confirm that this is ReclaimBay's own internal outreach test identity, not a business.");
  }
  return errors;
}

/**
 * Creates the internal outreach test: the only way a prospect is ever marked
 * internalTest, and only with the explicit confirmation from its own admin
 * form. It always carries exactly the controlled identity (internalTest.ts):
 * its name, ReclaimBay's own test mailbox, and the public page documenting
 * that mailbox; no business details, signals, or evidence. There is one: it
 * is refused while any record uses the mailbox. Business qualification
 * doesn't apply to it; drafting, queueing, and sending check everything else
 * exactly as for any prospect. The mark is never changed afterwards: no
 * edit, status change, or import reads or writes it.
 */
export async function createInternalTestProspect(db: Db, raw: Raw) {
  const errors = internalTestFormErrors(raw);
  if (errors.length) throw new ProspectError(errors);
  const input: ProspectInput = {
    fields: { ...INTERNAL_TEST_IDENTITY, website: null, city: null, state: null, postalCode: null, country: "US", phone: null, phoneSourceUrl: null },
    signals: Object.fromEntries(SIGNAL_KEYS.map((k) => [k, "unknown"])) as Record<SignalKey, SignalState>,
  };
  return withFreshCode((code) =>
    db.$transaction(async (tx) => {
      await lockSendGate(tx);
      // One internal test: its mailbox is on no other record.
      const existing = await tx.prospect.findFirst({ where: { email: { equals: INTERNAL_TEST_IDENTITY.email, mode: "insensitive" } }, select: { id: true } });
      if (existing) throw new ProspectError([`The internal outreach test already exists: ${INTERNAL_TEST_IDENTITY.email} is on another record.`], "conflict");
      return insertProspect(tx, input, code, { internalTest: true, notes: [INTERNAL_TEST_NOTE] });
    }),
  );
}

function insertWithFreshCode(db: Db, input: ProspectInput, details: ProspectDetails = {}) {
  return withFreshCode((code) => db.$transaction((tx) => insertProspect(tx, input, code, details)));
}

/** Runs an insert with a new referral code. A code collision is astronomically unlikely, but retry rather than fail. */
async function withFreshCode<T>(insert: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(generateReferralCode());
    } catch (err) {
      const target = (err as { meta?: { target?: unknown } }).meta?.target;
      const isCodeClash = (err as { code?: string }).code === "P2002" && String(target ?? "").includes("referralCode");
      if (!isCodeClash || attempt >= 2) throw err;
    }
  }
}

export async function updateProspect(db: Db, id: string, raw: Raw) {
  const { input, errors } = parseProspectInput(raw);
  if (errors.length) throw new ProspectError(errors);
  const scoring = scoringInputOf(input);
  const now = new Date();

  // Under the send gate: an edit (the email, the signals behind qualification) can stop a queued send.
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const current = await tx.prospect.findUnique({ where: { id }, include: { signals: true, evidence: true } });
    if (!current) throw notFound();
    if (current.internalTest) throw new ProspectError([INTERNAL_TEST_FIXED]);

    // An edit can't leave the prospect in a status whose requirements fail.
    const blocked = statusRequirementErrors(current.status, {
      businessName: input.fields.businessName,
      ...statusContext(scoring),
    });
    blocked.push(...await statusEvidenceErrors(tx, id, current.status, { ...scoring, ...input.fields }, current.evidence));
    if (blocked.length) {
      throw new ProspectError([
        ...blocked,
        `Move the prospect out of ${STATUS_LABELS[current.status]} first, or keep the required details.`,
      ]);
    }

    // Keep observedAt for unchanged observations; replace changed ones.
    // Rows for signals retired by a newer scoring version are left alone.
    const next = storedSignals(input.signals);
    const existing = new Map(current.signals.map((s) => [s.key, s]));
    const removed = current.signals
      .filter((s) => isSignalKey(s.key) && next[s.key] !== s.value)
      .map((s) => s.id);
    if (removed.length) await tx.prospectSignal.deleteMany({ where: { id: { in: removed } } });
    const added = Object.entries(next)
      .filter(([key, value]) => existing.get(key)?.value !== value)
      .map(([key, value]) => ({ prospectId: id, key, value: value!, observedAt: now }));
    if (added.length) await tx.prospectSignal.createMany({ data: added });

    return tx.prospect.update({ where: { id }, data: { ...input.fields, ...scoreData(scoring, now) } });
  });
}

export async function changeStatus(db: Db, id: string, toRaw: string, reasonRaw: string | null | undefined) {
  if (!isStatus(toRaw)) throw new ProspectError(["Unknown status."]);
  const to: Status = toRaw;
  const reason = reasonRaw?.replace(/\s+/g, " ").trim() || null;
  if (reason && reason.length > FIELD_LIMITS.reason) {
    throw new ProspectError([`Reason is too long (max ${FIELD_LIMITS.reason}).`]);
  }

  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    return changeStatusInTx(tx, id, to, reason);
  });
}

/**
 * One validated status change inside the caller's transaction, with its
 * history row. Entering a status that ends outreach cancels any open
 * outreach message, so a draft can't outlive a Do not contact. Do not
 * contact also suppresses the business email, so no other prospect record
 * sharing that address can be emailed either.
 */
export async function changeStatusInTx(tx: Tx, id: string, to: Status, reason: string | null, now = new Date()) {
  const current = await tx.prospect.findUnique({ where: { id }, include: { signals: true, evidence: true } });
  if (!current) throw notFound();
  const from = current.status;
  const input = scoringInputFromRecord(current);
  const errors = transitionErrors(from, to, { businessName: current.businessName, ...statusContext(input), internalTestIdentity: internalTestIdentity(current) }, reason);
  errors.push(...await statusEvidenceErrors(tx, id, to, { ...input, businessName: current.businessName, website: current.website }, current.evidence));
  if (errors.length) throw new ProspectError(errors);

  // Compare-and-set: fails if the status changed since it was read.
  const { count } = await tx.prospect.updateMany({
    where: { id, status: from },
    data: { status: to, statusChangedAt: now },
  });
  if (count !== 1) throw new ProspectError(["The status changed meanwhile. Reload and try again."], "conflict");
  await tx.prospectStatusChange.create({ data: { prospectId: id, fromStatus: from, toStatus: to, reason, createdAt: now } });
  if (OUTREACH_CLOSED.includes(to)) await cancelOpenOutreach(tx, id, `The prospect moved to ${STATUS_LABELS[to]}.`, now);
  if (to === "do_not_contact" && current.email) {
    await suppressEmail(tx, current.email, "unsubscribed", `${current.businessName ?? "The business"} is Do not contact${reason ? `: ${reason}` : "."}`, null, now);
  }
  return { from, to };
}

export async function addNote(db: Db, prospectId: string, bodyRaw: unknown) {
  const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";
  if (!body) throw new ProspectError(["Note can't be empty."]);
  if (body.length > FIELD_LIMITS.note) throw new ProspectError([`Note is too long (max ${FIELD_LIMITS.note}).`]);
  await requireProspect(db, prospectId);
  return db.prospectNote.create({ data: { prospectId, body } });
}

export interface EvidenceInput {
  signalKey: SignalKey;
  sourceUrl: string;
  excerpt: string;
}

/** Validates an evidence item: a known signal, a public URL, a short excerpt. */
export function parseEvidence(raw: Raw): { evidence: EvidenceInput | null; errors: string[] } {
  const errors: string[] = [];
  const signalKey = text(raw, "signalKey") ?? "";
  if (!isSignalKey(signalKey)) errors.push("Choose the signal this evidence supports.");
  const urlRaw = text(raw, "sourceUrl");
  const sourceUrl = urlRaw ? normalizeUrl(urlRaw) : null;
  if (!sourceUrl) errors.push("Source URL must be a valid public http(s) URL.");
  else if (sourceUrl.length > FIELD_LIMITS.sourceUrl) errors.push(`Source URL is too long (max ${FIELD_LIMITS.sourceUrl}).`);
  const excerpt = text(raw, "excerpt");
  if (!excerpt) errors.push("Excerpt can't be empty.");
  else if (excerpt.length > FIELD_LIMITS.excerpt) {
    errors.push(`Excerpt is ${excerpt.length} characters; keep it to a short quote of at most ${FIELD_LIMITS.excerpt}.`);
  }
  if (errors.length) return { evidence: null, errors };
  return { evidence: { signalKey: signalKey as SignalKey, sourceUrl: sourceUrl!, excerpt: excerpt! }, errors };
}

export async function addEvidence(db: Db, prospectId: string, raw: Raw) {
  const { evidence, errors } = parseEvidence(raw);
  if (!evidence) throw new ProspectError(errors);
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const current = await tx.prospect.findUnique({ where: { id: prospectId }, include: { signals: true, evidence: true } });
    if (!current) throw notFound();
    if (current.internalTest) throw new ProspectError([INTERNAL_TEST_FIXED]);
    const blocked = await statusEvidenceErrors(tx, prospectId, current.status, { ...scoringInputFromRecord(current), businessName: current.businessName, website: current.website }, [...current.evidence, evidence]);
    if (blocked.length) throw new ProspectError([...blocked, `Move the prospect out of ${STATUS_LABELS[current.status]} first, or keep the supporting evidence.`]);
    return tx.prospectEvidence.create({ data: { prospectId, ...evidence } });
  });
}

export async function deleteEvidence(db: Db, prospectId: string, evidenceId: string) {
  await db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const current = await tx.prospect.findUnique({ where: { id: prospectId }, include: { signals: true, evidence: true } });
    if (!current?.evidence.some(e => e.id === evidenceId)) throw new ProspectError(["Evidence not found."], "not_found");
    const blocked = await statusEvidenceErrors(tx, prospectId, current.status, { ...scoringInputFromRecord(current), businessName: current.businessName, website: current.website }, current.evidence.filter(e => e.id !== evidenceId));
    if (blocked.length) throw new ProspectError([...blocked, `Move the prospect out of ${STATUS_LABELS[current.status]} first, or keep the supporting evidence.`]);
    await tx.prospectEvidence.deleteMany({ where: { id: evidenceId, prospectId } });
  });
}

async function requireProspect(db: Db, id: string) {
  const found = await db.prospect.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw notFound();
}

/**
 * Recomputes cached scores. By default only rows scored by another
 * SCORING_VERSION (or never scored); `all` rescans every row.
 */
export async function rescoreProspects(db: Db, { all = false } = {}) {
  const where: Prisma.ProspectWhereInput = all
    ? {}
    : { OR: [{ scoreVersion: null }, { scoreVersion: { not: SCORING_VERSION } }] };
  let updated = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.prospect.findMany({
      where,
      include: { signals: true },
      orderBy: { id: "asc" },
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;
    const now = new Date();
    for (const p of batch) {
      await db.prospect.update({ where: { id: p.id }, data: scoreData(scoringInputFromRecord(p), now) });
      updated++;
    }
    cursor = batch[batch.length - 1]!.id;
  }
  return updated;
}

// ---------- reads ----------

export const SORTS = {
  score: "Score",
  updated: "Recently updated",
  created: "Recently added",
  name: "Name",
} as const;
export type Sort = keyof typeof SORTS;

export interface ProspectFilters {
  q?: string;
  status?: string;
  qualification?: string;
  band?: string;
  state?: string;
  city?: string;
  sort?: string;
}

export const LIST_LIMIT = 200;


export async function listProspects(db: Db, filters: ProspectFilters) {
  const and: Prisma.ProspectWhereInput[] = [];
  const q = filters.q?.trim().slice(0, 100);
  if (q) {
    const contains = { contains: q, mode: "insensitive" as const };
    and.push({
      OR: [
        { businessName: contains },
        { website: contains },
        { city: contains },
        { email: contains },
        { phone: contains },
        { referralCode: contains },
      ],
    });
  }
  if (filters.status && isStatus(filters.status)) and.push({ status: filters.status });
  const state = filters.state?.trim();
  if (state) and.push({ state: { equals: state, mode: "insensitive" } });
  const city = filters.city?.trim();
  if (city) and.push({ city: { contains: city, mode: "insensitive" } });

  // Qualification and band are independent filters, mirroring scoring.ts: a criterion
  // is Yes when recorded Yes, or when a signal that establishes it (collision/body for
  // automotive repair) is Yes and it isn't recorded No; No only when recorded No with
  // nothing establishing it. Both together contradict each other: unverified.
  const recorded = (key: string, value: "yes" | "no"): Prisma.ProspectWhereInput => ({ signals: { some: { key, value } } });
  const established = (key: string): Prisma.ProspectWhereInput => ({ signals: { some: { key: { in: establishedBy(key) }, value: "yes" } } });
  const failsCriterion: Prisma.ProspectWhereInput = {
    OR: REQUIRED_CRITERIA.map((key) => ({ AND: [recorded(key, "no"), { NOT: established(key) }] })),
  };
  const meetsAll: Prisma.ProspectWhereInput = {
    AND: REQUIRED_CRITERIA.map((key) => ({ OR: [recorded(key, "yes"), { AND: [established(key), { NOT: recorded(key, "no") }] }] })),
  };
  const qualification = filters.qualification as Qualification | undefined;
  if (qualification === "disqualified") and.push(failsCriterion);
  if (qualification === "meets_criteria") and.push(meetsAll);
  if (qualification === "unverified") and.push({ NOT: failsCriterion }, { NOT: meetsAll });

  const band = filters.band as ScoreBand | undefined;
  const { high, medium } = BAND_THRESHOLDS;
  if (band === "high") and.push({ score: { gte: high } });
  if (band === "medium") and.push({ score: { gte: medium, lt: high } });
  if (band === "low") and.push({ score: { lt: medium } });

  const sort: Sort = filters.sort && filters.sort in SORTS ? (filters.sort as Sort) : "score";
  const orderBy: Prisma.ProspectOrderByWithRelationInput[] =
    sort === "updated"
      ? [{ updatedAt: "desc" }]
      : sort === "created"
        ? [{ createdAt: "desc" }]
        : sort === "name"
          ? [{ businessName: { sort: "asc", nulls: "last" } }]
          : [{ score: "desc" }, { updatedAt: "desc" }];

  const where = and.length ? { AND: and } : {};
  const [rows, total] = await Promise.all([
    db.prospect.findMany({ where, include: { signals: true }, orderBy, take: LIST_LIMIT }),
    db.prospect.count({ where }),
  ]);
  return {
    total,
    sort,
    rows: rows.map((p) => {
      const result = scoreProspect(scoringInputFromRecord(p));
      return { prospect: p, result, stale: p.scoreVersion !== SCORING_VERSION || p.score !== result.score };
    }),
  };
}

export async function getProspectDetail(db: Db, id: string) {
  const prospect = await db.prospect.findUnique({
    where: { id },
    include: {
      signals: true,
      evidence: { orderBy: { createdAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" } },
      statusChanges: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!prospect) return null;
  const [sessions, eventCounts] = await Promise.all([
    db.analyticsSession.count({ where: { prospectId: id } }),
    db.productEvent.groupBy({
      by: ["eventType", "isSample"],
      where: { prospectId: id },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
  ]);
  const result = scoreProspect(scoringInputFromRecord(prospect));
  const lastActivity = eventCounts.reduce<Date | null>(
    (latest, e) => (e._max.createdAt && (!latest || e._max.createdAt > latest) ? e._max.createdAt : latest),
    null,
  );
  return {
    prospect,
    result,
    stale: prospect.scoreVersion !== SCORING_VERSION || prospect.score !== result.score,
    activity: {
      sessions,
      lastActivity,
      counts: eventCounts.map((e) => ({ eventType: e.eventType, isSample: e.isSample, count: e._count._all })),
    },
  };
}

/** The form values for editing a stored prospect. */
export function formValuesOf(p: ProspectWithSignals): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of [
    "businessName",
    "website",
    "city",
    "state",
    "postalCode",
    "country",
    "phone",
    "phoneSourceUrl",
    "email",
    "emailSourceUrl",
  ] as const) {
    values[key] = p[key] ?? "";
  }
  for (const s of p.signals) if (isSignalKey(s.key)) values[signalFieldName(s.key)] = s.value;
  return values;
}
