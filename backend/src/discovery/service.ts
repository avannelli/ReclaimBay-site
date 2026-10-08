import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { fitBasis, fitConflict } from "../research/repairFit.js";
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
  researchedErrors,
  type CandidateStatus,
} from "./candidateStatus.js";
import { duplicateState, isDuplicateAnswer, isFlagged, matchReasons, type DuplicateAnswer } from "./duplicateReview.js";
import { ACTIVE_LANES, LANES, nextStep, type Lane, type NextStep } from "./workQueue.js";
import { AUTO_APPROVAL_RULES, AUTO_REJECTED_PREFIX, REOPENED_PREFIX, assessAutoApproval, isAutoApproved, type AutoApprovalAssessment, type LatestResearch } from "./autoApproval.js";
import { nameCategory } from "./categories.js";
import {
  CATEGORY_VERDICT_LABELS,
  automatedMayReplace,
  isCategoryVerdict,
  type CategoryResult,
  type CategoryVerdict,
} from "@avannelli/aos/categories";
import { categoryFields, isOutsideTarget } from "./categoryCheck.js";
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
export const DEFAULT_BUSINESS_TYPE = "Automotive repair";
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
  // The category check annotates the candidate; it never stops it being stored.
  const category = nameCategory({ businessName: b.businessName, category: b.category, categoryTier: b.categoryTier });
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
      // Anything weakly matching waits for a human look; the hold is the duplicate check's.
      status: flagged ? "needs_review" : "discovered",
      duplicateHold: flagged,
      possibleDuplicateCandidateId: v.possibleCandidate?.id ?? null,
      possibleDuplicateProspectId: v.possibleProspect?.id ?? null,
      duplicateReason: flagged ? flagReason(v) : null,
      relatedCandidateId: v.relatedCandidate?.id ?? null,
      relatedProspectId: v.relatedProspect?.id ?? null,
      relationReason: related ? relationReason(v) : null,
      ...categoryFields(category, new Date()),
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

/** Candidate before run/child rows: shared lock order for edits and research. */
export const lockCandidate = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT id FROM "DiscoveryCandidate" WHERE id = ${id}::uuid FOR UPDATE`;

/** Edits facts and signals with the prospect validators. Approved candidates are frozen. */
export async function updateCandidate(db: Db, id: string, raw: Raw) {
  const { input, errors } = parseProspectInput(raw);
  if (!input.fields.businessName) errors.push("Business name is required.");
  if (errors.length) throw new ProspectError(errors);
  const f = input.fields;
  const next = storedSignals(input.signals);
  const now = new Date();

  return db.$transaction(async (tx) => {
    await lockCandidate(tx, id);
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

    // A new name gets a new name check, unless a person or the website decided.
    const renamed = f.businessName !== current.businessName;
    const category = renamed ? nameCategory({ businessName: f.businessName!, category: current.providerCategory, categoryTier: current.categoryTier }) : null;
    const recheck =
      category && automatedMayReplace({ verdict: current.categoryVerdict, source: current.categorySource }, category) ? categoryFields(category, now) : {};

    // Provider facts (street, position, provider phone) are kept as discovered.
    return tx.discoveryCandidate.update({
      where: { id },
      data: {
        ...f,
        researchRevision: { increment: 1 },
        businessName: f.businessName!,
        ...storedKeysOf({ ...f, businessName: f.businessName!, providerPhone: current.providerPhone }),
        // A different website is no longer the one research verified.
        ...((f.website ?? null) !== current.website ? { websiteVerifiedAt: null } : {}),
        ...recheck,
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
    await lockCandidate(tx, id);
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
        researchRevision: { increment: 1 },
        statusChangedAt: now,
        // From here on the status is a person's: a later duplicate answer won't lift it.
        duplicateHold: false,
        ...(to === "researched" ? { researchedAt: now } : {}),
        ...(closing ? { decisionReason: reason, decidedAt: now } : {}),
        // Reopening clears the earlier decision.
        ...(to === "discovered" ? { decisionReason: null, decidedAt: null } : {}),
      },
    });
    if (count !== 1) throw new ProspectError(["The status changed meanwhile. Reload and try again."], "conflict");
    if (current.status === "rejected" && to === "discovered") {
      // From now on only a person rejects it (rejection@r1 reads this note).
      const was = current.decisionReason ? ` It had been rejected: ${current.decisionReason}` : "";
      await tx.candidateNote.create({ data: { candidateId: id, body: `${REOPENED_PREFIX}.${was}`.slice(0, 2000) } });
    }
    return { from: current.status, to };
  });
}

/**
 * A person's answer to a possible-duplicate flag (rules in duplicateReview.ts).
 * Detection is unchanged and the flag is kept; this records the decision, with
 * a note, and moves the candidate only as the answer requires:
 *
 *   not_duplicate  lifts the duplicate hold: a candidate waiting in the Needs
 *                  review the duplicate check placed (duplicateHold) returns to
 *                  Researched when its evidence allows, otherwise to Discovered
 *                  so research can run. A hold a person set stays: `kept` says so
 *   duplicate      the existing move to Duplicate, with the match as the reason
 *   unresolved     records that a person looked; nothing else changes
 */
export async function resolveDuplicate(db: Db, id: string, answerRaw: string) {
  if (!isDuplicateAnswer(answerRaw)) throw new ProspectError(["Choose a duplicate decision."]);
  const answer: DuplicateAnswer = answerRaw;

  return db.$transaction(async (tx) => {
    await lockCandidate(tx, id);
    const c = await tx.discoveryCandidate.findUnique({ where: { id }, include: candidateInclude });
    if (!c) throw notFound();
    if (isFrozen(c.status)) throw frozenError();
    if (!isFlagged(c)) throw new ProspectError(["This candidate has no possible-duplicate flag to resolve."]);

    const [matchCandidate, matchProspect] = await Promise.all([
      c.possibleDuplicateCandidateId
        ? tx.discoveryCandidate.findUnique({ where: { id: c.possibleDuplicateCandidateId }, select: { businessName: true } })
        : null,
      c.possibleDuplicateProspectId ? tx.prospect.findUnique({ where: { id: c.possibleDuplicateProspectId }, select: { businessName: true } }) : null,
    ]);
    const matchName = matchCandidate?.businessName ?? matchProspect?.businessName ?? "the flagged record";
    const why = matchReasons(c.duplicateReason).map((r) => r.text.toLowerCase()).join("; ") || "possible match";
    const now = new Date();

    let to: CandidateStatus = c.status;
    let note: string;
    if (answer === "duplicate") {
      to = "duplicate";
      const reason = `Duplicate of ${matchName} (${why}).`.slice(0, FIELD_LIMITS.reason);
      const errors = candidateTransitionErrors(c.status, to, { evidenceCount: c.evidence.length, unevidencedSignals: gatedSignals(c) }, reason);
      if (errors.length) throw new ProspectError(errors);
      const { count } = await tx.discoveryCandidate.updateMany({
        where: { id, status: c.status },
        data: { researchRevision: { increment: 1 }, status: to, statusChangedAt: now, decisionReason: reason, decidedAt: now, duplicateDecision: null, duplicateDecidedAt: now, duplicateHold: false },
      });
      if (count !== 1) throw new ProspectError(["The candidate changed meanwhile. Reload and try again."], "conflict");
      note = `Marked a duplicate of ${matchName} by a person (${why}).`;
    } else {
      if (c.status === "duplicate") throw new ProspectError(["This candidate is already marked a duplicate. Reopen it first."]);
      // Only the duplicate check's own hold is lifted; research decides between Researched and Discovered as always.
      const lift = answer === "not_duplicate" && c.status === "needs_review" && c.duplicateHold;
      if (lift) to = researchedErrors({ evidenceCount: c.evidence.length, unevidencedSignals: gatedSignals(c) }).length ? "discovered" : "researched";
      const { count } = await tx.discoveryCandidate.updateMany({
        where: { id, status: c.status, duplicateHold: c.duplicateHold },
        data: {
          duplicateDecision: answer,
          researchRevision: { increment: 1 },
          duplicateDecidedAt: now,
          ...(answer === "not_duplicate" ? { duplicateHold: false } : {}),
          ...(lift ? { status: to, statusChangedAt: now, ...(to === "researched" && !c.researchedAt ? { researchedAt: now } : {}) } : {}),
        },
      });
      if (count !== 1) throw new ProspectError(["The candidate changed meanwhile. Reload and try again."], "conflict");
      note =
        answer === "not_duplicate"
          ? `Not a duplicate of ${matchName}: a person checked the possible match (${why}).${c.status === "needs_review" && !lift ? " It stays in Needs review, where a person put it." : ""}`
          : `Possible duplicate of ${matchName} (${why}) left unresolved by a person.`;
    }
    await tx.candidateNote.create({ data: { candidateId: id, body: note.slice(0, FIELD_LIMITS.note) } });
    // A person's own hold that the answer deliberately left in place.
    const kept = answer === "not_duplicate" && to === "needs_review";
    return { answer, from: c.status, to, kept, businessName: c.businessName, matchName };
  });
}

// ---------- category check (not qualification, not a status) ----------

/** Why the category check stops approval (empty when it doesn't). */
export function categoryApprovalErrors(c: { categoryVerdict: string | null; categoryReason: string | null }): string[] {
  if (!isOutsideTarget(c)) return [];
  const why = c.categoryReason ? ` (${c.categoryReason.replace(/\.$/, "")})` : "";
  return [`The category check says this business is outside the target category${why}. Reject it, or override the category check if it is a target business.`];
}

/** What a person may choose: a verdict, or "automatic" to hand the decision back to the rules. */
export const CATEGORY_OVERRIDES = ["in_target", "wrong_category", "unclear", "automatic"] as const;

/**
 * A person's category decision. Needs a reason, is stored as "manual" so no
 * automated check replaces it, and never changes the candidate's status.
 * "automatic" clears the decision and re-runs the name check.
 */
export async function setCandidateCategory(db: Db, id: string, verdictRaw: string, reasonRaw: string | null | undefined) {
  const reason = reasonRaw?.replace(/\s+/g, " ").trim() || "";
  const errors: string[] = [];
  if (!(CATEGORY_OVERRIDES as readonly string[]).includes(verdictRaw)) errors.push("Choose a category decision.");
  if (!reason) errors.push("A category decision needs a reason.");
  if (reason.length > 280) errors.push("Category reason is too long (max 280).");
  if (errors.length) throw new ProspectError(errors);

  return db.$transaction(async (tx) => {
    await lockCandidate(tx, id);
    const c = await tx.discoveryCandidate.findUnique({ where: { id } });
    if (!c) throw notFound();
    if (isFrozen(c.status)) throw frozenError();
    const now = new Date();
    const next: CategoryResult =
      verdictRaw === "automatic"
        ? nameCategory({ businessName: c.businessName, category: c.providerCategory, categoryTier: c.categoryTier })
        : { verdict: verdictRaw as CategoryResult["verdict"], source: "manual", reason, sourceUrl: null, rules: "" };
    await tx.discoveryCandidate.update({ where: { id }, data: { ...categoryFields(next, now), researchRevision: { increment: 1 } } });
    const body =
      verdictRaw === "automatic"
        ? `Category check handed back to the rules: ${CATEGORY_VERDICT_LABELS[next.verdict]} (${next.reason}) Reason: ${reason}`
        : `Category check set by a person to ${CATEGORY_VERDICT_LABELS[next.verdict]}. Reason: ${reason}`;
    await tx.candidateNote.create({ data: { candidateId: id, body: body.slice(0, 2000) } });
    return next;
  });
}

export interface CategoryBackfill {
  checked: number;
  /** Records whose name-stage result differs from what is stored (written only with apply). */
  changes: { id: string; name: string; city: string | null; from: CategoryVerdict | null; to: CategoryVerdict; reason: string }[];
  skipped: { manual: number; website: number; approved: number };
  /** Every candidate's verdict after the backfill (or after it would run). */
  verdicts: Record<CategoryVerdict, number>;
}

/**
 * The name-stage category check over existing candidates (the backfill).
 * Writes only the category fields and only when `apply`; never a status,
 * research history, signals, evidence, or scores. Leaves a person's decision,
 * a verdict from the business's own website, and approved candidates alone,
 * and doesn't rewrite a record whose result is unchanged.
 */
export async function backfillCategoryCheck(db: Db, opts: { apply: boolean }): Promise<CategoryBackfill> {
  const out: CategoryBackfill = {
    checked: 0,
    changes: [],
    skipped: { manual: 0, website: 0, approved: 0 },
    verdicts: { in_target: 0, wrong_category: 0, unclear: 0 },
  };
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.discoveryCandidate.findMany({
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        businessName: true,
        city: true,
        status: true,
        providerCategory: true,
        categoryTier: true,
        categoryVerdict: true,
        categorySource: true,
        categoryReason: true,
        categoryRules: true,
      },
    });
    if (!rows.length) return out;
    cursor = rows.at(-1)!.id;
    for (const c of rows) {
      out.checked++;
      const next = nameCategory({ businessName: c.businessName, category: c.providerCategory, categoryTier: c.categoryTier });
      const keep = c.status === "approved" || !automatedMayReplace({ verdict: c.categoryVerdict, source: c.categorySource }, next);
      if (keep) {
        if (c.status === "approved") out.skipped.approved++;
        else if (c.categorySource === "manual") out.skipped.manual++;
        else out.skipped.website++;
        if (c.categoryVerdict) out.verdicts[c.categoryVerdict]++;
        continue;
      }
      out.verdicts[next.verdict]++;
      const unchanged =
        c.categoryVerdict === next.verdict && c.categorySource === next.source && c.categoryReason === next.reason && c.categoryRules === next.rules;
      if (unchanged) continue;
      out.changes.push({ id: c.id, name: c.businessName, city: c.city, from: c.categoryVerdict, to: next.verdict, reason: next.reason });
      if (opts.apply) await db.discoveryCandidate.update({ where: { id: c.id }, data: { ...categoryFields(next, new Date()), researchRevision: { increment: 1 } } });
    }
  }
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
  return db.$transaction(async (tx) => {
    await lockCandidate(tx, id);
    await loadEditable(tx, id);
    await tx.discoveryCandidate.update({ where: { id }, data: { researchRevision: { increment: 1 } } });
    return tx.candidateEvidence.create({ data: { candidateId: id, ...evidence } });
  });
}

export async function deleteCandidateEvidence(db: Db, id: string, evidenceId: string) {
  await db.$transaction(async (tx) => {
    await lockCandidate(tx, id);
    const c = await loadEditable(tx, id);
    if (!c.evidence.some((e) => e.id === evidenceId)) throw new ProspectError(["Evidence not found."], "not_found");
    if (c.status === "researched") {
      const remaining = c.evidence.filter((e) => e.id !== evidenceId);
      const gaps = researchGateErrors(c.signals, remaining);
      if (gaps.length) throw new ProspectError([...gaps, "Move the candidate out of Researched first."]);
    }
    await tx.discoveryCandidate.update({ where: { id }, data: { researchRevision: { increment: 1 } } });
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
    await lockCandidate(tx, id);
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
        researchRevision: { increment: 1 },
        phoneSourceUrl: facts.phoneSourceUrl,
        email: facts.email,
        emailSourceUrl: facts.emailSourceUrl,
        phoneKey: phoneKey(facts.phone) ?? phoneKey(c.providerPhone),
        status: "researched",
        statusChangedAt: now,
        duplicateHold: false,
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
/**
 * Approves a candidate: creates the Prospect. A person's approval (the
 * default) or, with `automatic`, the automatic-approval rule, re-checked
 * here inside the same transaction so nothing can change in between, and
 * claimed only from Researched (never from a person's Needs review).
 */
export async function approveCandidate(db: Db, id: string, opts: { automatic?: boolean } = {}) {
  return db.$transaction(async (tx) => {
    await lockCandidate(tx, id);
    const c = await tx.discoveryCandidate.findUnique({ where: { id }, include: candidateInclude });
    if (!c) throw notFound();
    if (c.status === "approved" || c.prospectId) throw new ProspectError(["Already approved."], "conflict");
    let automatic: AutoApprovalAssessment | null = null;
    if (opts.automatic) {
      automatic = assessAutoApproval(await decisionFacts(tx, c));
      if (automatic.decision !== "approve") throw new ProspectError(automatic.reasons, "conflict");
    }

    const errors: string[] = [];
    if (!APPROVABLE_FROM.includes(c.status)) {
      errors.push(
        `Only Researched or Needs review candidates can be approved; this one is ${CANDIDATE_STATUS_LABELS[c.status]}.`,
      );
    }
    errors.push(...researchGateErrors(c.signals, c.evidence));
    errors.push(...categoryApprovalErrors(c));
    const lastResearch = await tx.candidateResearch.findFirst({ where: { candidateId: c.id, status: "completed" }, orderBy: { queuedAt: "desc" }, select: { warnings: true } });
    const conflict = fitConflict(lastResearch?.warnings, fitBasis(c.signals));
    if (conflict) errors.push(`Resolve contradictory ${conflict} evidence before approving this business.`);
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
      where: { id, status: { in: automatic ? ["researched"] : [...APPROVABLE_FROM] }, prospectId: null },
      data: {
        status: "approved",
        researchRevision: { increment: 1 },
        statusChangedAt: now,
        approvedAt: now,
        decidedAt: now,
        // An automatic approval records why; a person's approval has no reason, as before.
        ...(automatic ? { decisionReason: automatic.approvalNote!.slice(0, 500) } : {}),
      },
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
        provenanceNote(
          {
            provider: c.provider,
            externalId: c.externalId,
            sourceUrl: c.sourceUrl,
            query: c.query,
            discoveredAt: c.discoveredAt,
            candidateId: c.id,
            runId: c.runId,
            release: c.providerRelease,
          },
          automatic ? { automatic: AUTO_APPROVAL_RULES } : {},
        ),
        ...(automatic ? [automatic.approvalNote!] : []),
      ],
    });
    await tx.discoveryCandidate.update({ where: { id }, data: { prospectId: prospect.id } });
    if (automatic) await tx.candidateNote.create({ data: { candidateId: id, body: automatic.approvalNote!.slice(0, 2000) } });
    return { prospect, candidateId: id };
  });
}

// ---------- automatic approval (rules in autoApproval.ts) ----------

/** The candidate's most recent research run, as the automatic-approval rule reads it. */
async function latestResearch(db: Db | Tx, candidateId: string): Promise<LatestResearch | null> {
  const run = await db.candidateResearch.findFirst({
    where: { candidateId },
    orderBy: { queuedAt: "desc" },
    include: { facts: { where: { field: "business_type" }, take: 1 } },
  });
  return run ? asLatestResearch(run) : null;
}

const asLatestResearch = (run: { status: string; outcome: string | null; version: string; warnings: unknown; facts: { value: string | null; note: string | null }[] }): LatestResearch => {
  const type = run.facts[0];
  return { status: run.status, outcome: run.outcome, version: run.version, warnings: run.warnings, businessType: type ? { value: type.value, note: type.note } : null };
};

/** Everything the automatic rules read about a candidate: its record, its latest run, and whether a person reopened it. */
async function decisionFacts(db: Db | Tx, c: CandidateWithResearch) {
  const reopened = await db.candidateNote.count({ where: { candidateId: c.id, body: { startsWith: REOPENED_PREFIX } } });
  return { ...c, latestRun: await latestResearch(db, c.id), reopenedByPerson: reopened > 0 };
}

/** What the automatic rules say about a candidate now (read-only). */
export async function assessCandidateApproval(db: Db, id: string): Promise<AutoApprovalAssessment | null> {
  const c = await db.discoveryCandidate.findUnique({ where: { id }, include: candidateInclude });
  return c ? assessAutoApproval(await decisionFacts(db, c)) : null;
}

export interface AutoApprovalOutcome {
  candidateId: string;
  businessName: string;
  assessment: AutoApprovalAssessment;
  /** Set when this call created the prospect. */
  prospectId?: string;
  /** True when this call rejected the candidate. */
  rejected?: boolean;
}

/**
 * Rejects the candidate if, and only if, rejection@r1 says so, re-checked
 * inside the transaction. Claimed only from Researched, so nothing a person
 * did (a hold, an approval, their own rejection) is ever overwritten, and a
 * repeat changes nothing: the reason and its note are written once, by the
 * call that moved it.
 */
export async function autoRejectCandidate(db: Db, id: string): Promise<AutoApprovalOutcome | null> {
  return db.$transaction(async (tx) => {
    await lockCandidate(tx, id);
    const c = await tx.discoveryCandidate.findUnique({ where: { id }, include: candidateInclude });
    if (!c) return null;
    const assessment = assessAutoApproval(await decisionFacts(tx, c));
    if (assessment.decision !== "reject") return { candidateId: id, businessName: c.businessName, assessment };
    const now = new Date();
    const { count } = await tx.discoveryCandidate.updateMany({
      where: { id, status: "researched", prospectId: null },
      data: { researchRevision: { increment: 1 }, status: "rejected", statusChangedAt: now, decidedAt: now, decisionReason: assessment.approvalNote!.slice(0, 500) },
    });
    if (count !== 1) return { candidateId: id, businessName: c.businessName, assessment };
    await tx.candidateNote.create({ data: { candidateId: id, body: assessment.approvalNote! } });
    return { candidateId: id, businessName: c.businessName, assessment, rejected: true };
  });
}

/**
 * The automatic decision for one candidate: approve (approval@a1), reject
 * (rejection@r1), or leave it for review. Run after every completed research
 * run, and by the re-decision pass. Safe to repeat.
 */
export async function autoDecideCandidate(db: Db, id: string): Promise<AutoApprovalOutcome | null> {
  const assessment = await assessCandidateApproval(db, id);
  if (!assessment) return null;
  if (assessment.decision === "reject") return autoRejectCandidate(db, id);
  return autoApproveCandidate(db, id);
}

/**
 * Approves the candidate if, and only if, the automatic-approval rule says
 * so. Never throws for a candidate that doesn't qualify: it reports why it
 * was held. Safe to repeat: an approved candidate is never approved twice.
 */
export async function autoApproveCandidate(db: Db, id: string): Promise<AutoApprovalOutcome | null> {
  const c = await db.discoveryCandidate.findUnique({ where: { id }, select: { businessName: true } });
  if (!c) return null;
  const assessment = (await assessCandidateApproval(db, id))!;
  if (assessment.decision !== "approve") return { candidateId: id, businessName: c.businessName, assessment };
  try {
    const { prospect } = await approveCandidate(db, id, { automatic: true });
    return { candidateId: id, businessName: c.businessName, assessment, prospectId: prospect.id };
  } catch (err) {
    if (!(err instanceof ProspectError)) throw err;
    // Something an approval checks changed, or an existing prospect matches: a person decides.
    return { candidateId: id, businessName: c.businessName, assessment: { ...assessment, decision: "review", reasons: err.messages, approvalNote: null } };
  }
}

/**
 * The re-decision pass: the automatic rules over researched candidates (or
 * the given ones), without researching again. A dry run reports what would
 * happen; `apply` approves and rejects the ones the rules decide. Idempotent:
 * an approved or rejected candidate is no longer Researched, so it is left
 * as it is.
 */
export async function runAutoApproval(db: Db, opts: { apply: boolean; candidateIds?: readonly string[] }): Promise<AutoApprovalOutcome[]> {
  const rows = await db.discoveryCandidate.findMany({
    where: opts.candidateIds ? { id: { in: [...opts.candidateIds] } } : { status: "researched" },
    select: { id: true },
    orderBy: { discoveredAt: "asc" },
  });
  const out: AutoApprovalOutcome[] = [];
  for (const { id } of rows) {
    const r = opts.apply ? await autoDecideCandidate(db, id) : await (async () => {
      const c = await db.discoveryCandidate.findUniqueOrThrow({ where: { id }, select: { businessName: true } });
      return { candidateId: id, businessName: c.businessName, assessment: (await assessCandidateApproval(db, id))! };
    })();
    if (r) out.push(r);
  }
  return out;
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
  /** Category check verdict. */
  category?: string;
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
  const { scored, sort, notRanked } = await scoredCandidates(db, filters);
  return { total: scored.length, sort, notRanked, rows: scored.slice(0, CANDIDATE_LIST_LIMIT) };
}

/** Every candidate matching the filters, scored and sorted (up to the fetch cap). */
async function scoredCandidates(db: Db, filters: CandidateFilters) {
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
  if (filters.category && isCategoryVerdict(filters.category)) and.push({ categoryVerdict: filters.category });
  if (filters.flagged === "1") {
    // Flags a person hasn't settled: a resolved "not a duplicate" no longer needs review.
    and.push({ OR: [{ possibleDuplicateCandidateId: { not: null } }, { possibleDuplicateProspectId: { not: null } }] });
    and.push({ OR: [{ duplicateDecision: null }, { duplicateDecision: "unresolved" }] });
  }

  const rows = await db.discoveryCandidate.findMany({
    where: and.length ? { AND: and } : {},
    include: {
      signals: true,
      // Which signals have evidence: the queue applies the same approval gate as the candidate page.
      evidence: { select: { signalKey: true, sourceUrl: true, excerpt: true } },
      _count: { select: { evidence: true } },
      research: { orderBy: { queuedAt: "desc" }, take: 1, select: { status: true, outcome: true } },
    },
    // The id breaks ties, so the queue order (and Previous / Next) is the same on every load.
    orderBy: [{ discoveredAt: "desc" }, { id: "asc" }],
    take: CANDIDATE_FETCH_CAP,
  });
  // Outside the target category: not scored, not qualified, not ranked.
  let scored = rows.map((candidate) => ({ candidate, result: scoreCandidate(candidate), outsideTarget: isOutsideTarget(candidate) }));

  const qualification = filters.qualification as Qualification | undefined;
  if (qualification) scored = scored.filter((r) => !r.outsideTarget && r.result.qualification === qualification);
  const band = filters.band as ScoreBand | undefined;
  if (band === "high" || band === "medium" || band === "low") scored = scored.filter((r) => !r.outsideTarget && r.result.band === band);

  const sort: CandidateSort = filters.sort && filters.sort in CANDIDATE_SORTS ? (filters.sort as CandidateSort) : "discovered";
  let notRanked = 0;
  if (sort === "score") {
    notRanked = scored.filter((r) => r.outsideTarget).length;
    scored = scored.filter((r) => !r.outsideTarget).sort((a, b) => b.result.score - a.result.score);
  }
  if (sort === "name") scored.sort((a, b) => a.candidate.nameKey.localeCompare(b.candidate.nameKey));

  return { scored, sort, notRanked };
}

/** Why a candidate can't be approved now: the same reasons the candidate page shows. */
export function approvalBlockersOf(c: {
  status: CandidateStatus;
  signals: readonly { key: string }[];
  evidence: readonly { signalKey: string; sourceUrl?: string; excerpt?: string }[];
  categoryVerdict: string | null;
  categoryReason: string | null;
}): string[] {
  if (isFrozen(c.status)) return [];
  return [
    ...(APPROVABLE_FROM.includes(c.status) ? [] : [`Status is ${CANDIDATE_STATUS_LABELS[c.status]}; only Researched or Needs review can be approved.`]),
    ...researchGateErrors(c.signals, c.evidence),
    ...categoryApprovalErrors(c),
  ];
}

/** Queue views: a lane, possible duplicates only, or the handled kinds. */
export const QUEUE_VIEWS = ["all", "decision", "duplicates", "ready", "verify", "research", "disregarded", "completed"] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];
export const isQueueView = (v: unknown): v is QueueView => (QUEUE_VIEWS as readonly unknown[]).includes(v);

type ScoredCandidate = Awaited<ReturnType<typeof scoredCandidates>>["scored"][number];
/** `held`: for Ready to approve, why automatic approval didn't approve it (reviewQueue fills it in). */
export type QueueItem = ScoredCandidate & { step: NextStep; held?: string | null };

/**
 * What the automation has decided, for the Discovery summary: approved
 * (automatically, or by a person), the exception queue a person reviews,
 * rejected or closed (automatically, or by a person), research running,
 * and not yet researched (or research failed, to run again).
 */
export interface AutomationSummary {
  approved: number;
  autoApproved: number;
  review: number;
  rejected: number;
  autoRejected: number;
  researching: number;
  notResearched: number;
}

const inView = (view: QueueView, s: NextStep) =>
  view === "all" ||
  (view === "duplicates" ? s.kind === "duplicate" : view === "disregarded" ? s.kind === "disregarded" || s.kind === "duplicate_closed" : view === "completed" ? s.kind === "approved" : s.lane === view);

/** The work queue step for a scored candidate (rules in workQueue.ts). */
function stepOf(r: ScoredCandidate): NextStep {
  const c = r.candidate;
  const latest = c.research[0] ?? null;
  const pending = latest?.status === "queued" || latest?.status === "running";
  return nextStep({
    status: c.status,
    duplicate: duplicateState(c),
    outsideTarget: r.outsideTarget,
    categoryVerdict: c.categoryVerdict,
    providerStatus: c.providerStatus,
    qualification: r.result.qualification,
    unverifiedCriteria: r.result.unverifiedCriteria,
    disqualifiedBy: r.result.disqualifiedBy,
    approvalBlockers: approvalBlockersOf(c),
    research: { pending, latest: pending ? null : latest },
  });
}

/**
 * The Discovery work queue: every candidate matching the filters, with its next
 * step, counted per lane, and the requested view in queue order (active lanes
 * in LANES order, then handled; the chosen sort within each lane). Only the
 * first CANDIDATE_LIST_LIMIT items are returned for display.
 */
export async function reviewQueue(db: Db, filters: CandidateFilters, view: QueueView = "all") {
  const { ordered, ...rest } = await orderedQueue(db, filters, view);
  const items = ordered.slice(0, CANDIDATE_LIST_LIMIT);
  // Ready to approve means a person approves it: say why the automatic rule held it. One query for the shown items.
  const ready = items.filter((i) => i.step.kind === "ready");
  if (ready.length) {
    const runs = await db.candidateResearch.findMany({
      where: { candidateId: { in: ready.map((i) => i.candidate.id) } },
      orderBy: { queuedAt: "desc" },
      include: { facts: { where: { field: "business_type" }, take: 1 } },
    });
    const latest = new Map<string, LatestResearch>();
    for (const r of runs) if (!latest.has(r.candidateId)) latest.set(r.candidateId, asLatestResearch(r));
    for (const i of ready) {
      const a = assessAutoApproval({ ...i.candidate, latestRun: latest.get(i.candidate.id) ?? null });
      i.held = a.decision === "review" ? (a.reasons[0] ?? null) : a.decision === "approve" ? "It meets every condition; the next automatic pass will approve it." : null;
    }
  }
  return { ...rest, items };
}

/** The whole queue for a view in queue order, uncapped: the display limit applies only in reviewQueue. */
async function orderedQueue(db: Db, filters: CandidateFilters, view: QueueView) {
  const { scored, sort, notRanked } = await scoredCandidates(db, filters);
  const items: QueueItem[] = scored.map((r) => ({ ...r, step: stepOf(r) }));
  const counts = Object.fromEntries(LANES.map((l) => [l, 0])) as Record<Lane, number>;
  let duplicates = 0;
  let disregarded = 0;
  let completed = 0;
  const automation: AutomationSummary = { approved: 0, autoApproved: 0, review: 0, rejected: 0, autoRejected: 0, researching: 0, notResearched: 0 };
  for (const i of items) {
    counts[i.step.lane]++;
    if (i.step.kind === "duplicate") duplicates++;
    if (i.step.kind === "disregarded" || i.step.kind === "duplicate_closed") disregarded++;
    if (i.step.kind === "approved") completed++;
    const kind = i.step.kind;
    if (kind === "approved") {
      automation.approved++;
      if (isAutoApproved(i.candidate)) automation.autoApproved++;
    } else if (kind === "disregarded" || kind === "duplicate_closed") {
      automation.rejected++;
      if (i.candidate.decisionReason?.startsWith(AUTO_REJECTED_PREFIX)) automation.autoRejected++;
    } else if (kind === "research_running") automation.researching++;
    else if (kind === "not_researched" || kind === "research_failed") automation.notResearched++;
    else automation.review++;
  }
  const active = ACTIVE_LANES.reduce((n, l) => n + counts[l], 0);
  // A stable sort keeps the chosen order inside each lane.
  const ordered = items.filter((i) => inView(view, i.step)).sort((a, b) => LANES.indexOf(a.step.lane) - LANES.indexOf(b.step.lane));
  return {
    view,
    sort,
    notRanked,
    total: ordered.length,
    counts: { ...counts, duplicates, disregarded, completed, active, all: items.length },
    automation,
    ordered,
  };
}

/**
 * Where a candidate sits in the active queue (default order): the previous and
 * next items needing attention, and how many there are. A candidate no longer
 * in the queue (just approved or disregarded) gets the first remaining item as
 * its next one. Uses the whole queue, not the displayed first page, so a
 * candidate past the display limit still has its true place and neighbours.
 */
export async function queuePosition(db: Db, id: string) {
  const { ordered } = await orderedQueue(db, {}, "all");
  const active = ordered.filter((i) => i.step.lane !== "handled");
  const at = active.findIndex((i) => i.candidate.id === id);
  const pick = (i: QueueItem | undefined) => (i ? { id: i.candidate.id, businessName: i.candidate.businessName } : null);
  return {
    remaining: active.length - (at === -1 ? 0 : 1),
    index: at === -1 ? null : at + 1,
    total: active.length,
    previous: at > 0 ? pick(active[at - 1]) : null,
    next: pick(at === -1 ? active[0] : active[at + 1]),
  };
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
    // The identity fields a person compares side by side with this candidate.
    candidate.possibleDuplicateCandidateId
      ? db.discoveryCandidate.findUnique({
          where: { id: candidate.possibleDuplicateCandidateId },
          select: {
            id: true,
            businessName: true,
            status: true,
            streetAddress: true,
            city: true,
            state: true,
            website: true,
            phone: true,
            providerPhone: true,
            latitude: true,
            longitude: true,
          },
        })
      : null,
    candidate.possibleDuplicateProspectId
      ? db.prospect.findUnique({
          where: { id: candidate.possibleDuplicateProspectId },
          select: { id: true, businessName: true, status: true, city: true, state: true, website: true, phone: true },
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
  const approvalBlockers = approvalBlockersOf(candidate);
  const autoApproval = assessAutoApproval(await decisionFacts(db, candidate));
  return { candidate, result, outsideTarget: isOutsideTarget(candidate), autoApproval, dupCandidate, dupProspect, relCandidate, relProspect, approvalBlockers };
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
