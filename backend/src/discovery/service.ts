import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  ProspectError,
  generateReferralCode,
  insertProspect,
  parseEvidence,
  parseProspectInput,
  storedSignals,
  FIELD_LIMITS,
} from "../prospects.js";
import {
  isSignalKey,
  signalConsistencyErrors,
  type Qualification,
  type ScoreBand,
  type StoredSignalValue,
} from "../scoring.js";
import {
  candidateScoringInput,
  candidateToProspectInput,
  provenanceNote,
  researchGateErrors,
  scoreCandidate,
  type CandidateFacts,
} from "./approval.js";
import {
  APPROVABLE_FROM,
  CANDIDATE_STATUS_LABELS,
  candidateTransitionErrors,
  isCandidateStatus,
  isFrozen,
  type CandidateStatus,
} from "./candidateStatus.js";
import { classifyMatch, flagReason, type IncomingKeys, type MatchKeys, type Verdict } from "./dedupe.js";
import { cleanDiscovered, locationKey, normalizeDomain, normalizeName, phoneKey, type CleanedBusiness } from "./normalize.js";
import type { DiscoveredBusiness, DiscoveryProvider, ResearchFindings } from "./types.js";

/*
 * Candidate service. Discovery only ever creates candidates; the single way
 * to a Prospect is approveCandidate(), a human action that goes through the
 * same insert path, validators, and scoring as a prospect made by hand.
 * Existing prospects are read for duplicate checks and are never modified.
 */

type Tx = Prisma.TransactionClient;
type Raw = Record<string, unknown>;

const notFound = () => new ProspectError(["Candidate not found."], "not_found");
const frozenError = () =>
  new ProspectError(["This candidate is approved and is now a prospect; edit the prospect instead."], "conflict");

/** Upper bound on records accepted from one provider call. */
export const MAX_RESULTS_PER_RUN = 200;
const PROVIDER_TIMEOUT_MS = 30_000;
export const DEFAULT_BUSINESS_TYPE = "Independent automotive repair";

// ---------- match keys ----------

function keysOf(f: { businessName: string; website: string | null; city: string | null; state: string | null; phone: string | null }) {
  return {
    domainKey: normalizeDomain(f.website),
    nameKey: normalizeName(f.businessName),
    locationKey: locationKey(f.city, f.state),
    phoneKey: phoneKey(f.phone),
  };
}

/** Candidates first, then prospects, so candidate matches are preferred. */
async function loadMatchKeys(db: Db | Tx): Promise<MatchKeys[]> {
  const [candidates, prospects] = await Promise.all([
    db.discoveryCandidate.findMany({
      select: { id: true, provider: true, externalId: true, domainKey: true, nameKey: true, locationKey: true, phoneKey: true },
    }),
    db.prospect.findMany({ select: { id: true, businessName: true, website: true, city: true, state: true, phone: true } }),
  ]);
  return [
    ...candidates.map((c): MatchKeys => ({ ...c, kind: "candidate" })),
    ...prospects.map((p): MatchKeys => ({
      id: p.id,
      kind: "prospect",
      ...keysOf({ ...p, businessName: p.businessName ?? "" }),
    })),
  ];
}

// ---------- creating candidates ----------

interface NewCandidate {
  runId: string | null;
  provider: string;
  query: string | null;
  business: CleanedBusiness;
  email?: string | null;
  emailSourceUrl?: string | null;
  verdict: Verdict;
}

async function insertCandidate(db: Db | Tx, n: NewCandidate) {
  const b = n.business;
  const flagged = n.verdict.outcome === "REVIEW_REQUIRED";
  return db.discoveryCandidate.create({
    data: {
      runId: n.runId,
      businessName: b.businessName,
      website: b.website,
      city: b.city,
      state: b.state,
      postalCode: b.postalCode,
      country: b.country,
      phone: b.phone,
      phoneSourceUrl: b.phoneSourceUrl,
      email: n.email ?? null,
      emailSourceUrl: n.emailSourceUrl ?? null,
      ...keysOf({ ...b, phone: b.phone }),
      provider: n.provider,
      externalId: b.externalId,
      sourceUrl: b.sourceUrl,
      query: n.query,
      // Anything weakly matching waits for a human look.
      status: flagged ? "needs_review" : "discovered",
      possibleDuplicateCandidateId: n.verdict.possibleCandidate?.id ?? null,
      possibleDuplicateProspectId: n.verdict.possibleProspect?.id ?? null,
      duplicateReason: flagged ? flagReason(n.verdict) : null,
    },
  });
}

export interface IngestCounters {
  found: number;
  created: number;
  duplicates: number;
  flagged: number;
  invalid: number;
}

/**
 * Normalizes, deduplicates, and stores provider records as candidates.
 * Confident duplicates are skipped; weak matches are stored and flagged;
 * nothing existing is ever updated or merged.
 */
export async function ingestBusinesses(
  db: Db,
  ctx: { runId: string | null; provider: string; query: string | null },
  results: readonly DiscoveredBusiness[],
): Promise<IngestCounters> {
  const counters: IngestCounters = { found: results.length, created: 0, duplicates: 0, flagged: 0, invalid: 0 };
  const loaded = await loadMatchKeys(db);
  const candidates = loaded.filter((k) => k.kind === "candidate");
  const prospects = loaded.filter((k) => k.kind === "prospect");

  for (const raw of results) {
    const cleaned = cleanDiscovered(raw);
    if (!cleaned.ok) {
      counters.invalid++;
      continue;
    }
    const business = cleaned.value;
    const keys = keysOf(business);
    const incoming: IncomingKeys = { provider: ctx.provider, externalId: business.externalId, ...keys };
    // Candidates created earlier in this run count too. Candidates first.
    const verdict = classifyMatch(incoming, [...candidates, ...prospects]);
    if (verdict.outcome === "CONFIDENT_DUPLICATE") {
      counters.duplicates++;
      continue;
    }
    try {
      const created = await insertCandidate(db, { ...ctx, business, verdict });
      counters.created++;
      if (verdict.outcome === "REVIEW_REQUIRED") counters.flagged++;
      candidates.push({
        id: created.id,
        kind: "candidate",
        provider: ctx.provider,
        externalId: business.externalId,
        ...keys,
      });
    } catch (err) {
      // A concurrent run stored the same provider record first.
      if ((err as { code?: string }).code !== "P2002") throw err;
      counters.duplicates++;
    }
  }
  return counters;
}

// ---------- discovery runs ----------

export interface DiscoveryRunInput {
  provider: string;
  region: string;
  city?: string | null;
  businessType?: string | null;
}

const field = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function redact(message: string): string {
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("provider timed out")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs one provider for a target and stores the results as candidates. A
 * provider failure is recorded on the run (status failed), not thrown.
 */
export async function runDiscovery(db: Db, providers: ReadonlyMap<string, DiscoveryProvider>, raw: Raw) {
  const providerName = field(raw.provider, 40);
  const region = field(raw.region, FIELD_LIMITS.city);
  const city = field(raw.city, FIELD_LIMITS.city) || null;
  const businessType = field(raw.businessType, 100) || DEFAULT_BUSINESS_TYPE;

  const errors: string[] = [];
  const provider = providers.get(providerName);
  if (!provider) errors.push("Choose an available discovery provider.");
  if (!region) errors.push("Region is required, e.g. Ventura County, CA.");
  if (errors.length || !provider) throw new ProspectError(errors);

  const query = `${businessType} in ${city ? `${city}, ` : ""}${region}`.slice(0, 300);
  const run = await db.discoveryRun.create({ data: { provider: provider.name, region, city, businessType } });
  try {
    const results = (await withTimeout(provider.discover({ region, city, businessType }), PROVIDER_TIMEOUT_MS)).slice(
      0,
      MAX_RESULTS_PER_RUN,
    );
    const counters = await ingestBusinesses(db, { runId: run.id, provider: provider.name, query }, results);
    return db.discoveryRun.update({
      where: { id: run.id },
      data: { ...counters, status: "completed", finishedAt: new Date() },
    });
  } catch (err) {
    return db.discoveryRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        error: `Provider error: ${redact(err instanceof Error ? err.message : "unknown")}`,
        finishedAt: new Date(),
      },
    });
  }
}

/**
 * Adds one candidate by hand (provider "manual"), with the same validation,
 * normalization, and duplicate rules as a discovered one.
 */
export async function addManualCandidate(db: Db, raw: Raw) {
  const { input, errors } = parseProspectInput(raw);
  const f = input.fields;
  if (!f.businessName) errors.push("Business name is required.");
  if (errors.length) throw new ProspectError(errors);

  const business: CleanedBusiness = {
    businessName: f.businessName!,
    website: f.website,
    city: f.city,
    state: f.state,
    postalCode: f.postalCode,
    country: f.country,
    phone: f.phone,
    phoneSourceUrl: f.phoneSourceUrl,
    sourceUrl: null,
    externalId: null,
  };
  const verdict = classifyMatch(
    { provider: "manual", externalId: null, ...keysOf(business) },
    await loadMatchKeys(db),
  );
  if (verdict.outcome === "CONFIDENT_DUPLICATE") {
    const of = verdict.duplicateOf!;
    throw new ProspectError([`Already a ${of.kind} (${of.reason}); not added.`], "conflict");
  }
  return insertCandidate(db, {
    runId: null,
    provider: "manual",
    query: null,
    business,
    email: f.email,
    emailSourceUrl: f.emailSourceUrl,
    verdict,
  });
}

// ---------- editing research ----------

const candidateInclude = { signals: true, evidence: true } as const;
type CandidateWithResearch = Prisma.DiscoveryCandidateGetPayload<{ include: typeof candidateInclude }>;

/** Edits facts and signals with the prospect validators. Approved candidates are frozen. */
export async function updateCandidate(db: Db, id: string, raw: Raw) {
  const { input, errors } = parseProspectInput(raw);
  if (!input.fields.businessName) errors.push("Business name is required.");
  if (errors.length) throw new ProspectError(errors);
  const f = input.fields;
  const next = storedSignals(input.signals);
  const now = new Date();

  return db.$transaction(async (tx) => {
    const current = await tx.discoveryCandidate.findUnique({ where: { id }, include: candidateInclude });
    if (!current) throw notFound();
    if (isFrozen(current.status)) throw frozenError();

    // An edit can't leave a Researched candidate with an unsourced signal.
    if (current.status === "researched") {
      const gaps = researchGateErrors(
        Object.keys(next).map((key) => ({ key })),
        current.evidence,
      );
      if (gaps.length) {
        throw new ProspectError([...gaps, "Move the candidate out of Researched first, or keep every signal sourced."]);
      }
    }

    const existing = new Map(current.signals.map((s) => [s.key, s]));
    const removed = current.signals.filter((s) => isSignalKey(s.key) && next[s.key] !== s.value).map((s) => s.id);
    if (removed.length) await tx.candidateSignal.deleteMany({ where: { id: { in: removed } } });
    const added = Object.entries(next)
      .filter(([key, value]) => existing.get(key)?.value !== value)
      .map(([key, value]) => ({ candidateId: id, key, value: value!, observedAt: now }));
    if (added.length) await tx.candidateSignal.createMany({ data: added });

    return tx.discoveryCandidate.update({
      where: { id },
      data: { ...f, businessName: f.businessName!, ...keysOf({ ...f, businessName: f.businessName! }) },
    });
  });
}

// ---------- lifecycle ----------

export async function changeCandidateStatus(db: Db, id: string, toRaw: string, reasonRaw: string | null | undefined) {
  if (!isCandidateStatus(toRaw)) throw new ProspectError(["Unknown status."]);
  const to: CandidateStatus = toRaw;
  const reason = reasonRaw?.replace(/\s+/g, " ").trim() || null;
  if (reason && reason.length > FIELD_LIMITS.reason) {
    throw new ProspectError([`Reason is too long (max ${FIELD_LIMITS.reason}).`]);
  }

  return db.$transaction(async (tx) => {
    const current = await tx.discoveryCandidate.findUnique({ where: { id }, include: candidateInclude });
    if (!current) throw notFound();
    const errors = candidateTransitionErrors(
      current.status,
      to,
      { evidenceCount: current.evidence.length, unevidencedSignals: gatedSignals(current) },
      reason,
    );
    if (errors.length) throw new ProspectError(errors);

    const now = new Date();
    const closing = to === "rejected" || to === "duplicate";
    const { count } = await tx.discoveryCandidate.updateMany({
      where: { id, status: current.status },
      data: {
        status: to,
        statusChangedAt: now,
        ...(to === "researched" ? { researchedAt: now } : {}),
        ...(closing ? { decisionReason: reason, decidedAt: now } : {}),
        // Reopening clears the earlier decision.
        ...(to === "discovered" ? { decisionReason: null, decidedAt: null } : {}),
      },
    });
    if (count !== 1) throw new ProspectError(["The status changed meanwhile. Reload and try again."], "conflict");
    return { from: current.status, to };
  });
}

/** Recorded signals without evidence, for the transition rules. */
function gatedSignals(c: CandidateWithResearch): string[] {
  const covered = new Set(c.evidence.map((e) => e.signalKey));
  return c.signals.filter((s) => isSignalKey(s.key) && !covered.has(s.key)).map((s) => s.key);
}

async function loadEditable(tx: Db | Tx, id: string) {
  const c = await tx.discoveryCandidate.findUnique({ where: { id }, include: candidateInclude });
  if (!c) throw notFound();
  if (isFrozen(c.status)) throw frozenError();
  return c;
}

export async function addCandidateEvidence(db: Db, id: string, raw: Raw) {
  const { evidence, errors } = parseEvidence(raw);
  if (!evidence) throw new ProspectError(errors);
  await loadEditable(db, id);
  return db.candidateEvidence.create({ data: { candidateId: id, ...evidence } });
}

export async function deleteCandidateEvidence(db: Db, id: string, evidenceId: string) {
  await db.$transaction(async (tx) => {
    const c = await loadEditable(tx, id);
    if (!c.evidence.some((e) => e.id === evidenceId)) throw new ProspectError(["Evidence not found."], "not_found");
    if (c.status === "researched") {
      const remaining = c.evidence.filter((e) => e.id !== evidenceId);
      const gaps = researchGateErrors(c.signals, remaining);
      if (gaps.length) throw new ProspectError([...gaps, "Move the candidate out of Researched first."]);
    }
    await tx.candidateEvidence.delete({ where: { id: evidenceId } });
  });
}

export async function addCandidateNote(db: Db, id: string, bodyRaw: unknown) {
  const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";
  if (!body) throw new ProspectError(["Note can't be empty."]);
  if (body.length > FIELD_LIMITS.note) throw new ProspectError([`Note is too long (max ${FIELD_LIMITS.note}).`]);
  await loadEditable(db, id);
  return db.candidateNote.create({ data: { candidateId: id, body } });
}

// ---------- research provider findings ----------

/**
 * Applies findings from a ResearchProvider. Held to the same rules as a
 * human: unknown stays unknown, every yes/no needs evidence, contact needs a
 * source, and nothing overwrites a contact detail a person already entered.
 * On success the candidate is Researched, ready for a human decision.
 */
export async function applyResearchFindings(db: Db, id: string, findings: ResearchFindings, providerName: string) {
  const errors: string[] = [];
  const newSignals: Record<string, StoredSignalValue> = {};
  for (const [key, value] of Object.entries(findings.signals)) {
    if (value === undefined) continue;
    if (!isSignalKey(key)) errors.push(`Unknown signal "${key}".`);
    else if (value !== "yes" && value !== "no") errors.push(`Signal ${key}: value must be yes or no.`);
    else newSignals[key] = value;
  }
  const evidence = findings.evidence.map((e) => {
    const parsed = parseEvidence({ ...e });
    errors.push(...parsed.errors);
    return parsed.evidence;
  });
  if (errors.length) throw new ProspectError(errors);

  return db.$transaction(async (tx) => {
    const c = await loadEditable(tx, id);
    if (c.status === "rejected" || c.status === "duplicate") {
      throw new ProspectError([`Reopen this ${c.status} candidate before researching it.`]);
    }
    const good = evidence.filter((e): e is NonNullable<typeof e> => e !== null);
    const merged = new Map<string, StoredSignalValue>(c.signals.map((s) => [s.key, s.value]));
    for (const [key, value] of Object.entries(newSignals)) merged.set(key, value);
    const allEvidence = [...c.evidence, ...good];

    const contact = findings.contact ?? {};
    const facts: CandidateFacts = {
      ...c,
      phone: c.phone ?? contact.phone ?? null,
      phoneSourceUrl: c.phone ? c.phoneSourceUrl : (contact.phoneSourceUrl ?? null),
      email: c.email ?? contact.email ?? null,
      emailSourceUrl: c.email ? c.emailSourceUrl : (contact.emailSourceUrl ?? null),
      signals: [...merged].map(([key, value]) => ({ key, value })),
    };
    const problems = [
      ...researchGateErrors(facts.signals, allEvidence),
      ...candidateToProspectInput(facts).errors,
      ...signalConsistencyErrors(candidateScoringInput(facts)),
    ];
    if (problems.length) throw new ProspectError([...new Set(problems)]);

    const now = new Date();
    for (const [key, value] of Object.entries(newSignals)) {
      await tx.candidateSignal.upsert({
        where: { candidateId_key: { candidateId: id, key } },
        create: { candidateId: id, key, value, observedAt: now },
        update: { value, observedAt: now },
      });
    }
    if (good.length) await tx.candidateEvidence.createMany({ data: good.map((e) => ({ ...e, candidateId: id })) });
    await tx.candidateNote.create({
      data: {
        candidateId: id,
        body: `Research applied by ${providerName.slice(0, 40)}: ${Object.keys(newSignals).length} signal(s), ${good.length} evidence item(s).`,
      },
    });
    return tx.discoveryCandidate.update({
      where: { id },
      data: {
        phone: facts.phone,
        phoneSourceUrl: facts.phoneSourceUrl,
        email: facts.email,
        emailSourceUrl: facts.emailSourceUrl,
        phoneKey: phoneKey(facts.phone),
        status: "researched",
        statusChangedAt: now,
        researchedAt: now,
      },
    });
  });
}

// ---------- approval ----------

/**
 * The only path from candidate to Prospect, and always a human action.
 *
 * The Prospect is created through the existing insert path and validators
 * with status New: approval never sets Qualified or Ready to contact, so
 * those gates (qualification, contact source) still apply afterwards. Facts,
 * contact, signals, and evidence are copied; a note records provenance. The
 * candidate is kept, linked to the prospect, as the discovery record.
 */
export async function approveCandidate(db: Db, id: string) {
  return db.$transaction(async (tx) => {
    const c = await tx.discoveryCandidate.findUnique({ where: { id }, include: candidateInclude });
    if (!c) throw notFound();
    if (c.status === "approved" || c.prospectId) throw new ProspectError(["Already approved."], "conflict");

    const errors: string[] = [];
    if (!APPROVABLE_FROM.includes(c.status)) {
      errors.push(
        `Only Researched or Needs review candidates can be approved; this one is ${CANDIDATE_STATUS_LABELS[c.status]}.`,
      );
    }
    errors.push(...researchGateErrors(c.signals, c.evidence));
    const { input, errors: inputErrors } = candidateToProspectInput(c);
    errors.push(...inputErrors);

    // Existing prospects are authoritative: a confident match means this is a duplicate.
    const prospectKeys = (await loadMatchKeys(tx)).filter((k) => k.kind === "prospect");
    const verdict = classifyMatch(
      { provider: c.provider, externalId: c.externalId, domainKey: c.domainKey, nameKey: c.nameKey, locationKey: c.locationKey, phoneKey: c.phoneKey },
      prospectKeys,
    );
    if (verdict.duplicateOf) {
      errors.push(`A prospect with the same website domain already exists. Mark this candidate as a duplicate instead.`);
    }
    if (errors.length) throw new ProspectError([...new Set(errors)]);

    const now = new Date();
    // Claim first: two simultaneous approvals can't both proceed.
    const { count } = await tx.discoveryCandidate.updateMany({
      where: { id, status: { in: [...APPROVABLE_FROM] }, prospectId: null },
      data: { status: "approved", statusChangedAt: now, approvedAt: now, decidedAt: now },
    });
    if (count !== 1) throw new ProspectError(["The candidate changed meanwhile. Reload and try again."], "conflict");

    const prospect = await insertProspect(tx, input, generateReferralCode(), {
      observedAt: Object.fromEntries(c.signals.map((s) => [s.key, s.observedAt])),
      evidence: c.evidence.map((e) => ({
        signalKey: e.signalKey,
        sourceUrl: e.sourceUrl,
        excerpt: e.excerpt,
        createdAt: e.createdAt,
      })),
      notes: [
        provenanceNote({
          provider: c.provider,
          externalId: c.externalId,
          sourceUrl: c.sourceUrl,
          query: c.query,
          discoveredAt: c.discoveredAt,
          candidateId: c.id,
          runId: c.runId,
        }),
      ],
    });
    await tx.discoveryCandidate.update({ where: { id }, data: { prospectId: prospect.id } });
    return { prospect, candidateId: id };
  });
}

// ---------- reads ----------

export interface CandidateFilters {
  q?: string;
  status?: string;
  qualification?: string;
  band?: string;
  state?: string;
  city?: string;
  flagged?: string;
  provider?: string;
  /** Only candidates stored by this discovery run. */
  run?: string;
  sort?: string;
}

export const CANDIDATE_SORTS = { score: "Opportunity score", discovered: "Recently discovered", name: "Name" } as const;
type CandidateSort = keyof typeof CANDIDATE_SORTS;

export const CANDIDATE_LIST_LIMIT = 200;
const CANDIDATE_FETCH_CAP = 2000;

/**
 * Lists candidates. Qualification and score are never stored: they are
 * computed here by scoring.ts, so the list can't disagree with the detail
 * page or drift from the scoring rules.
 */
export async function listCandidates(db: Db, filters: CandidateFilters) {
  const and: Prisma.DiscoveryCandidateWhereInput[] = [];
  const q = filters.q?.trim().slice(0, 100);
  if (q) {
    const contains = { contains: q, mode: "insensitive" as const };
    and.push({ OR: [{ businessName: contains }, { website: contains }, { city: contains }, { phone: contains }] });
  }
  if (filters.status && isCandidateStatus(filters.status)) and.push({ status: filters.status });
  const state = filters.state?.trim();
  if (state) and.push({ state: { equals: state, mode: "insensitive" } });
  const city = filters.city?.trim();
  if (city) and.push({ city: { contains: city, mode: "insensitive" } });
  if (filters.provider?.trim()) and.push({ provider: filters.provider.trim() });
  if (filters.run) and.push({ runId: filters.run });
  if (filters.flagged === "1") {
    and.push({ OR: [{ possibleDuplicateCandidateId: { not: null } }, { possibleDuplicateProspectId: { not: null } }] });
  }

  const rows = await db.discoveryCandidate.findMany({
    where: and.length ? { AND: and } : {},
    include: { signals: true, _count: { select: { evidence: true } } },
    orderBy: { discoveredAt: "desc" },
    take: CANDIDATE_FETCH_CAP,
  });
  let scored = rows.map((candidate) => ({ candidate, result: scoreCandidate(candidate) }));

  const qualification = filters.qualification as Qualification | undefined;
  if (qualification) scored = scored.filter((r) => r.result.qualification === qualification);
  const band = filters.band as ScoreBand | undefined;
  if (band === "high" || band === "medium" || band === "low") scored = scored.filter((r) => r.result.band === band);

  const sort: CandidateSort = filters.sort && filters.sort in CANDIDATE_SORTS ? (filters.sort as CandidateSort) : "discovered";
  if (sort === "score") scored.sort((a, b) => b.result.score - a.result.score);
  if (sort === "name") scored.sort((a, b) => a.candidate.nameKey.localeCompare(b.candidate.nameKey));

  return { total: scored.length, sort, rows: scored.slice(0, CANDIDATE_LIST_LIMIT) };
}

export async function candidateStatusCounts(db: Db) {
  const grouped = await db.discoveryCandidate.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Partial<Record<CandidateStatus, number>> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  return counts;
}

export const recentRuns = (db: Db, take = 8) => db.discoveryRun.findMany({ orderBy: { createdAt: "desc" }, take });

export async function getCandidateDetail(db: Db, id: string) {
  const candidate = await db.discoveryCandidate.findUnique({
    where: { id },
    include: {
      signals: true,
      evidence: { orderBy: { createdAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" } },
      run: true,
      prospect: { select: { id: true, businessName: true, status: true } },
    },
  });
  if (!candidate) return null;
  const [dupCandidate, dupProspect] = await Promise.all([
    candidate.possibleDuplicateCandidateId
      ? db.discoveryCandidate.findUnique({
          where: { id: candidate.possibleDuplicateCandidateId },
          select: { id: true, businessName: true, status: true },
        })
      : null,
    candidate.possibleDuplicateProspectId
      ? db.prospect.findUnique({
          where: { id: candidate.possibleDuplicateProspectId },
          select: { id: true, businessName: true, status: true },
        })
      : null,
  ]);
  const result = scoreCandidate(candidate);
  const approvalBlockers = isFrozen(candidate.status)
    ? []
    : [
        ...(APPROVABLE_FROM.includes(candidate.status)
          ? []
          : [`Status is ${CANDIDATE_STATUS_LABELS[candidate.status]}; only Researched or Needs review can be approved.`]),
        ...researchGateErrors(candidate.signals, candidate.evidence),
      ];
  return { candidate, result, dupCandidate, dupProspect, approvalBlockers };
}

/** Form values for editing a candidate (same field names as the prospect form). */
export function candidateFormValues(c: CandidateWithResearch): Record<string, string> {
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
    values[key] = c[key] ?? "";
  }
  for (const s of c.signals) if (isSignalKey(s.key)) values[`signal_${s.key}`] = s.value;
  return values;
}
