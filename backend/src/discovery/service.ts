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
import { MatchIndex, flagReason, relationReason, type IncomingKeys, type MatchKeys, type Verdict } from "./dedupe.js";
import {
  cleanDiscovered,
  isOnBusinessSite,
  locationKey,
  normalizeDomain,
  normalizeName,
  phoneKey,
  streetKey,
  type CleanedBusiness,
} from "./normalize.js";
import {
  CATEGORY_TIERS,
  type CategoryTier,
  type DiscoveredBusiness,
  type DiscoveryProvider,
  type DiscoveryTarget,
  type ResearchFindings,
} from "./types.js";

/*
 * Candidate service. Discovery only ever creates candidates; the single way
 * to a Prospect is approveCandidate(), a human action that goes through the
 * same insert path, validators, and scoring as a prospect made by hand.
 * Existing prospects are read for duplicate checks and are never modified.
 *
 * Phones: a provider-reported phone is stored as `providerPhone`
 * (unverified). Only a person or a research provider citing a page on the
 * business's own website sets the verified `phone`, which is the only phone
 * scoring, the Ready-to-contact gate, and approval ever read.
 */

type Tx = Prisma.TransactionClient;
type Raw = Record<string, unknown>;

const notFound = () => new ProspectError(["Candidate not found."], "not_found");
const frozenError = () =>
  new ProspectError(["This candidate is approved and is now a prospect; edit the prospect instead."], "conflict");

/** Upper bound on records accepted from one synchronous provider call. */
export const MAX_RESULTS_PER_RUN = 200;
const PROVIDER_TIMEOUT_MS = 30_000;
export const DEFAULT_BUSINESS_TYPE = "Independent automotive repair";
/** Tiers a run uses when none are chosen. */
export const DEFAULT_TIERS: readonly CategoryTier[] = ["core"];

// ---------- match keys ----------

interface KeySource {
  businessName: string;
  website: string | null;
  city: string | null;
  state: string | null;
  phone?: string | null;
  providerPhone?: string | null;
  streetAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** Stored match keys (columns on the candidate). */
function storedKeysOf(f: KeySource) {
  return {
    domainKey: normalizeDomain(f.website),
    nameKey: normalizeName(f.businessName),
    locationKey: locationKey(f.city, f.state),
    // The verified phone wins; an unverified provider phone still helps find duplicates.
    phoneKey: phoneKey(f.phone) ?? phoneKey(f.providerPhone),
  };
}

/** Stored keys plus the location evidence dedupe compares. */
function matchKeysOf(f: KeySource) {
  return {
    ...storedKeysOf(f),
    streetKey: streetKey(f.streetAddress),
    latitude: f.latitude ?? null,
    longitude: f.longitude ?? null,
  };
}

/** Candidates first, then prospects, so candidate matches are preferred. */
async function loadMatchIndex(db: Db | Tx, opts: { prospectsOnly?: boolean } = {}): Promise<MatchIndex> {
  const [candidates, prospects] = await Promise.all([
    opts.prospectsOnly
      ? []
      : db.discoveryCandidate.findMany({
          select: {
            id: true,
            provider: true,
            externalId: true,
            domainKey: true,
            nameKey: true,
            locationKey: true,
            phoneKey: true,
            streetAddress: true,
            latitude: true,
            longitude: true,
          },
        }),
    db.prospect.findMany({ select: { id: true, businessName: true, website: true, city: true, state: true, phone: true } }),
  ]);
  return new MatchIndex([
    ...candidates.map(
      ({ streetAddress, ...c }): MatchKeys => ({ ...c, kind: "candidate", streetKey: streetKey(streetAddress) }),
    ),
    ...prospects.map((p): MatchKeys => ({
      id: p.id,
      kind: "prospect",
      ...matchKeysOf({ ...p, businessName: p.businessName ?? "" }),
    })),
  ]);
}

// ---------- creating candidates ----------

interface NewCandidate {
  runId: string | null;
  provider: string;
  query: string | null;
  release?: string | null;
  business: CleanedBusiness;
  /** Verified contact: only from a person (manual add), never from a provider. */
  verified?: { phone: string | null; phoneSourceUrl: string | null; email: string | null; emailSourceUrl: string | null };
  verdict: Verdict;
}

async function insertCandidate(db: Db | Tx, n: NewCandidate) {
  const b = n.business;
  const v = n.verdict;
  const flagged = v.outcome === "REVIEW_REQUIRED";
  const related = v.relatedCandidate || v.relatedProspect;
  return db.discoveryCandidate.create({
    data: {
      runId: n.runId,
      businessName: b.businessName,
      website: b.website,
      streetAddress: b.streetAddress,
      latitude: b.latitude,
      longitude: b.longitude,
      city: b.city,
      state: b.state,
      postalCode: b.postalCode,
      country: b.country,
      phone: n.verified?.phone ?? null,
      phoneSourceUrl: n.verified?.phoneSourceUrl ?? null,
      email: n.verified?.email ?? null,
      emailSourceUrl: n.verified?.emailSourceUrl ?? null,
      providerPhone: b.providerPhone,
      ...storedKeysOf({ ...b, phone: n.verified?.phone ?? null }),
      provider: n.provider,
      externalId: b.externalId,
      sourceUrl: b.sourceUrl,
      query: n.query,
      providerRelease: b.release ?? n.release ?? null,
      providerCategory: b.category,
      categoryTier: b.categoryTier,
      providerBrand: b.brand,
      providerConfidence: b.confidence,
      providerStatus: b.operatingStatus,
      providerRetrievedAt: b.retrievedAt,
      providerSources: b.sources,
      // Anything weakly matching waits for a human look.
      status: flagged ? "needs_review" : "discovered",
      possibleDuplicateCandidateId: v.possibleCandidate?.id ?? null,
      possibleDuplicateProspectId: v.possibleProspect?.id ?? null,
      duplicateReason: flagged ? flagReason(v) : null,
      relatedCandidateId: v.relatedCandidate?.id ?? null,
      relatedProspectId: v.relatedProspect?.id ?? null,
      relationReason: related ? relationReason(v) : null,
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

export interface IngestContext {
  runId: string | null;
  provider: string;
  query: string | null;
  release?: string | null;
}

/**
 * Normalizes, deduplicates, and stores provider records as candidates.
 * Confident duplicates are skipped; weak matches are stored and flagged;
 * other locations of the same business are stored and linked; nothing
 * existing is ever updated or merged. Pass `index` to reuse one match index
 * across batches of a large run.
 */
export async function ingestBusinesses(
  db: Db,
  ctx: IngestContext,
  results: readonly DiscoveredBusiness[],
  index?: MatchIndex,
): Promise<IngestCounters> {
  const counters: IngestCounters = { found: results.length, created: 0, duplicates: 0, flagged: 0, invalid: 0 };
  const idx = index ?? (await loadMatchIndex(db));

  for (const raw of results) {
    const cleaned = cleanDiscovered(raw);
    if (!cleaned.ok) {
      counters.invalid++;
      continue;
    }
    const business = cleaned.value;
    const keys = matchKeysOf(business);
    const incoming: IncomingKeys = { provider: ctx.provider, externalId: business.externalId, ...keys };
    // Candidates created earlier in this run count too.
    const verdict = idx.classify(incoming);
    if (verdict.outcome === "CONFIDENT_DUPLICATE") {
      counters.duplicates++;
      continue;
    }
    try {
      const created = await insertCandidate(db, { ...ctx, business, verdict });
      counters.created++;
      if (verdict.outcome === "REVIEW_REQUIRED") counters.flagged++;
      idx.add({ id: created.id, kind: "candidate", provider: ctx.provider, externalId: business.externalId, ...keys });
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
  /** "core" or "core,adjacent". */
  tiers?: string | null;
}

const field = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** "core", "core,adjacent", or an array of tiers; anything else is ignored. */
export function parseTiers(v: unknown): CategoryTier[] {
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const tiers = CATEGORY_TIERS.filter((t) => parts.some((p) => typeof p === "string" && p.trim() === t));
  return tiers.length ? tiers : [...DEFAULT_TIERS];
}

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

function parseRunInput(providers: ReadonlyMap<string, DiscoveryProvider>, raw: Raw) {
  const providerName = field(raw.provider, 40);
  const region = field(raw.region, FIELD_LIMITS.city);
  const city = field(raw.city, FIELD_LIMITS.city) || null;
  const businessType = field(raw.businessType, 100) || DEFAULT_BUSINESS_TYPE;
  const tiers = parseTiers(raw.tiers);

  const errors: string[] = [];
  const provider = providers.get(providerName);
  if (!provider) errors.push("Choose an available discovery provider.");
  if (!region) errors.push("Region is required, e.g. Ventura County, CA.");
  if (errors.length || !provider) throw new ProspectError(errors);
  const target: DiscoveryTarget = { region, city, businessType, tiers };
  const query = `${businessType} in ${city ? `${city}, ` : ""}${region}`.slice(0, 300);
  return { provider, target, query };
}

const isBackground = (p: DiscoveryProvider) => p.mode === "background";

/**
 * Runs a small synchronous provider for a target and stores the results as
 * candidates. Background providers are queued instead (see queueDiscoveryRun).
 * A provider failure is recorded on the run (status failed), not thrown.
 */
export async function runDiscovery(db: Db, providers: ReadonlyMap<string, DiscoveryProvider>, raw: Raw) {
  const { provider, target, query } = parseRunInput(providers, raw);
  if (isBackground(provider) || !provider.discover) {
    return queueDiscoveryRun(db, providers, raw);
  }
  const run = await db.discoveryRun.create({
    data: {
      provider: provider.name,
      region: target.region,
      city: target.city,
      businessType: target.businessType,
      tiers: [...(target.tiers ?? [])],
      startedAt: new Date(),
    },
  });
  try {
    const results = (await withTimeout(provider.discover(target), PROVIDER_TIMEOUT_MS)).slice(0, MAX_RESULTS_PER_RUN);
    const counters = await ingestBusinesses(db, { runId: run.id, provider: provider.name, query }, results);
    return db.discoveryRun.update({
      where: { id: run.id },
      data: { ...counters, status: "completed", finishedAt: new Date() },
    });
  } catch (err) {
    return failRun(db, run.id, err);
  }
}

function failRun(db: Db, runId: string, err: unknown) {
  return db.discoveryRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      error: `Provider error: ${redact(err instanceof Error ? err.message : "unknown")}`,
      finishedAt: new Date(),
    },
  });
}

/**
 * Creates a queued run for a background provider. The request returns at
 * once; processDiscoveryRun (in-process, or the discovery:process script)
 * does the work in batches. Nothing large is ever processed in a request.
 */
export async function queueDiscoveryRun(db: Db, providers: ReadonlyMap<string, DiscoveryProvider>, raw: Raw) {
  const { provider, target } = parseRunInput(providers, raw);
  if (!provider.discoverBatches) throw new ProspectError(["This provider can't run in the background."]);
  return db.discoveryRun.create({
    data: {
      provider: provider.name,
      region: target.region,
      city: target.city,
      businessType: target.businessType,
      tiers: [...(target.tiers ?? [])],
      status: "queued",
    },
  });
}

export interface ProcessOptions {
  /** Called after every batch, e.g. for logging. */
  onBatch?: (counters: IngestCounters) => void;
}

/**
 * Processes one queued run: claims it (so two workers can't both run it),
 * reads the provider in batches, and ingests each batch with one shared
 * match index. Progress and a heartbeat are saved after every batch.
 * Returns null when the run wasn't queued (already claimed or finished).
 * Re-processing is safe: provider IDs and dedupe make ingest idempotent.
 */
export async function processDiscoveryRun(
  db: Db,
  providers: ReadonlyMap<string, DiscoveryProvider>,
  runId: string,
  opts: ProcessOptions = {},
) {
  const now = new Date();
  const { count } = await db.discoveryRun.updateMany({
    where: { id: runId, status: "queued" },
    data: { status: "running", startedAt: now, heartbeatAt: now, found: 0, created: 0, duplicates: 0, flagged: 0, invalid: 0, error: null },
  });
  if (count !== 1) return null;
  const run = await db.discoveryRun.findUniqueOrThrow({ where: { id: runId } });

  try {
    const provider = providers.get(run.provider);
    if (!provider?.discoverBatches) throw new Error(`provider ${run.provider} is not available for background runs`);
    const target: DiscoveryTarget = {
      region: run.region,
      city: run.city,
      businessType: run.businessType,
      tiers: run.tiers.length ? run.tiers : [...DEFAULT_TIERS],
    };
    const query = `${run.businessType} in ${run.city ? `${run.city}, ` : ""}${run.region}`.slice(0, 300);
    // Record which staged import (and so which release) this run reads, before reading it.
    if (provider.resolveImport) {
      const imp = await provider.resolveImport(target);
      await db.discoveryRun.update({ where: { id: runId }, data: { importId: imp.id, providerRelease: imp.release } });
      run.providerRelease = imp.release;
    }
    const index = await loadMatchIndex(db);
    const totals: IngestCounters = { found: 0, created: 0, duplicates: 0, flagged: 0, invalid: 0 };

    for await (const batch of provider.discoverBatches(target)) {
      const release = batch.find((b) => b.release)?.release ?? null;
      const c = await ingestBusinesses(db, { runId, provider: provider.name, query, release }, batch, index);
      for (const k of Object.keys(totals) as (keyof IngestCounters)[]) totals[k] += c[k];
      await db.discoveryRun.update({
        where: { id: runId },
        data: { ...totals, heartbeatAt: new Date(), ...(release && !run.providerRelease ? { providerRelease: release } : {}) },
      });
      opts.onBatch?.(totals);
    }
    return db.discoveryRun.update({ where: { id: runId }, data: { ...totals, status: "completed", finishedAt: new Date() } });
  } catch (err) {
    return failRun(db, runId, err);
  }
}

/** A running run whose worker hasn't reported for this long is reclaimed. */
export const STALE_RUN_MS = 10 * 60 * 1000;

/**
 * Worker entry point: requeues runs whose worker died (stale heartbeat),
 * then processes queued runs oldest first, one at a time.
 */
export async function processQueuedRuns(
  db: Db,
  providers: ReadonlyMap<string, DiscoveryProvider>,
  opts: ProcessOptions & { staleAfterMs?: number; limit?: number } = {},
) {
  const staleBefore = new Date(Date.now() - (opts.staleAfterMs ?? STALE_RUN_MS));
  const reclaimed = await db.discoveryRun.updateMany({
    where: { status: "running", heartbeatAt: { lt: staleBefore } },
    data: { status: "queued", error: "Reclaimed after the previous worker stopped responding." },
  });
  const queued = await db.discoveryRun.findMany({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 10,
    select: { id: true },
  });
  const processed = [];
  for (const { id } of queued) {
    const run = await processDiscoveryRun(db, providers, id, opts);
    if (run) processed.push(run);
  }
  return { reclaimed: reclaimed.count, processed };
}

/**
 * Adds one candidate by hand (provider "manual"), with the same validation,
 * normalization, and duplicate rules as a discovered one. A phone a person
 * enters here, with the page where it is listed, is verified contact.
 */
export async function addManualCandidate(db: Db, raw: Raw) {
  const { input, errors } = parseProspectInput(raw);
  const f = input.fields;
  if (!f.businessName) errors.push("Business name is required.");
  if (errors.length) throw new ProspectError(errors);

  const business: CleanedBusiness = {
    businessName: f.businessName!,
    website: f.website,
    streetAddress: null,
    city: f.city,
    state: f.state,
    postalCode: f.postalCode,
    country: f.country,
    latitude: null,
    longitude: null,
    providerPhone: null,
    sourceUrl: null,
    externalId: null,
    category: null,
    categoryTier: null,
    brand: null,
    confidence: null,
    operatingStatus: null,
    retrievedAt: null,
    release: null,
    sources: null,
  };
  const verdict = (await loadMatchIndex(db)).classify({
    provider: "manual",
    externalId: null,
    ...matchKeysOf({ ...business, phone: f.phone }),
  });
  if (verdict.outcome === "CONFIDENT_DUPLICATE") {
    const of = verdict.duplicateOf!;
    throw new ProspectError([`Already a ${of.kind} (${of.reason}); not added.`], "conflict");
  }
  return insertCandidate(db, {
    runId: null,
    provider: "manual",
    query: null,
    business,
    verified: { phone: f.phone, phoneSourceUrl: f.phoneSourceUrl, email: f.email, emailSourceUrl: f.emailSourceUrl },
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

    // Provider facts (street, position, provider phone) are kept as discovered.
    return tx.discoveryCandidate.update({
      where: { id },
      data: {
        ...f,
        businessName: f.businessName!,
        ...storedKeysOf({ ...f, businessName: f.businessName!, providerPhone: current.providerPhone }),
        // A different website is no longer the one research verified.
        ...((f.website ?? null) !== current.website ? { websiteVerifiedAt: null } : {}),
      },
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
    // Automated research may only verify contact from the business's own site.
    // A missing source is reported by the normal contact validation below.
    const offSite = [
      contact.phone && contact.phoneSourceUrl && !c.phone && !isOnBusinessSite(contact.phoneSourceUrl, c.website) && "a phone",
      contact.email && contact.emailSourceUrl && !c.email && !isOnBusinessSite(contact.emailSourceUrl, c.website) && "an email",
    ].filter(Boolean);
    if (offSite.length) {
      throw new ProspectError([
        `Research can only verify ${offSite.join(" or ")} found on the business's own website${c.website ? "" : " (none is stored)"}.`,
      ]);
    }
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
        phoneKey: phoneKey(facts.phone) ?? phoneKey(c.providerPhone),
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
    const verdict = (await loadMatchIndex(tx, { prospectsOnly: true })).classify({
      provider: c.provider,
      externalId: c.externalId,
      ...matchKeysOf(c),
    });
    if (verdict.duplicateOf) {
      errors.push(
        `An existing prospect matches this candidate (${verdict.duplicateOf.reason}). Mark this candidate as a duplicate instead.`,
      );
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
          release: c.providerRelease,
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
  tier?: string;
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
    and.push({
      OR: [{ businessName: contains }, { website: contains }, { city: contains }, { phone: contains }, { providerPhone: contains }],
    });
  }
  if (filters.status && isCandidateStatus(filters.status)) and.push({ status: filters.status });
  const state = filters.state?.trim();
  if (state) and.push({ state: { equals: state, mode: "insensitive" } });
  const city = filters.city?.trim();
  if (city) and.push({ city: { contains: city, mode: "insensitive" } });
  if (filters.provider?.trim()) and.push({ provider: filters.provider.trim() });
  if (filters.run) and.push({ runId: filters.run });
  if (filters.tier === "core" || filters.tier === "adjacent") and.push({ categoryTier: filters.tier });
  if (filters.flagged === "1") {
    and.push({ OR: [{ possibleDuplicateCandidateId: { not: null } }, { possibleDuplicateProspectId: { not: null } }] });
  }

  const rows = await db.discoveryCandidate.findMany({
    where: and.length ? { AND: and } : {},
    include: {
      signals: true,
      _count: { select: { evidence: true } },
      research: { orderBy: { queuedAt: "desc" }, take: 1, select: { status: true, outcome: true } },
    },
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

export const recentRuns = (db: Db, take = 8) =>
  db.discoveryRun.findMany({
    orderBy: { createdAt: "desc" },
    take,
    include: { import: { select: { area: true, scope: true, release: true } } },
  });

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
  const [dupCandidate, dupProspect, relCandidate, relProspect] = await Promise.all([
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
    candidate.relatedCandidateId
      ? db.discoveryCandidate.findUnique({
          where: { id: candidate.relatedCandidateId },
          select: { id: true, businessName: true, status: true, city: true },
        })
      : null,
    candidate.relatedProspectId
      ? db.prospect.findUnique({
          where: { id: candidate.relatedProspectId },
          select: { id: true, businessName: true, status: true, city: true },
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
  return { candidate, result, dupCandidate, dupProspect, relCandidate, relProspect, approvalBlockers };
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
