/*
 * Automatic supply replenishment.
 *
 * When eligible supply (autonomous-eligible candidates plus businesses this module added that are still
 * waiting for research) falls below the configured threshold, one batch: pick the next area in the
 * rotation, source its unscreened provider records, prescreen them within strict request budgets, and
 * add the accepted ones to Discovery through the existing run pipeline. Scheduled research then researches
 * them like any other candidate. Nothing here creates prospects, drafts, campaigns or messages, or touches
 * sending controls.
 *
 * Controls, all fail-closed:
 * - acts only when REPLENISHMENT_ENABLED=1 on the service AND the persisted control is enabled and not
 *   paused (both default OFF); every control change is appended to ReplenishmentControlChange;
 * - batch, per-business and rolling-24-hour request and byte budgets, reserved durably before each
 *   business is screened; a cooldown and a daily batch count;
 * - a provider record is screened once, ever (ScreeningEntry is unique on provider and ID);
 * - a batch resumes across runs (screening is idempotent per entry); an interrupted intake, an invalid
 *   stored configuration or any unexpected error pauses the control with its reason for a person;
 * - a dry run makes the same reads and screens but writes nothing to the database.
 */
import type { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { autonomousCandidates } from "../discovery/autonomous.js";
import { createOvertureImporter } from "../discovery/overture.js";
import { protectionIndex } from "../discovery/protection.js";
import { processDiscoveryRun, runDiscovery } from "../discovery/service.js";
import type { DiscoveredBusiness, DiscoveryProvider, ProviderImporter, StagedPlace } from "../discovery/types.js";
import { normalizeDomain } from "../discovery/normalize.js";
import { needsSupply, ReplenishmentStop, resolveConfig, safeReason, type Area, type ReplenishmentConfig } from "./policy.js";
import { screenBusiness, type ScreenDeps, type ScreenOutcome } from "./screen.js";
import { knownBusiness, remember, selectFromSource, sourceContext, type SourceResult } from "./source.js";

const CONTROL_ID = "default";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A screening chunk needs at least this much time left; otherwise the batch resumes on the next run. */
const MIN_CHUNK_MS = 60_000;
const OPEN_STATUSES = ["screening", "ready", "intake"];
const json = (v: unknown) => v as Prisma.InputJsonValue;

export type ControlAction = "enable" | "disable" | "pause" | "resume" | "configure";

export interface ControlState {
  enabled: boolean;
  paused: boolean;
  pauseReason: string | null;
  config: ReplenishmentConfig | null;
  /** Why the stored configuration was refused, if it was. */
  configError: string | null;
  storedConfig: unknown;
}

export async function readControl(db: Db | Prisma.TransactionClient): Promise<ControlState> {
  const row = await db.replenishmentControl.findUnique({ where: { id: CONTROL_ID } });
  let config: ReplenishmentConfig | null = null;
  let configError: string | null = null;
  try {
    config = resolveConfig(row?.config ?? null);
  } catch (e) {
    configError = safeReason(e);
  }
  return { enabled: row?.enabled ?? false, paused: !!row?.pausedAt, pauseReason: row?.pauseReason ?? null, config, configError, storedConfig: row?.config ?? null };
}

/**
 * One control change and its audit row, together. A configuration is validated before it is stored;
 * configuring {} returns to the defaults.
 */
export async function changeControl(db: Db, action: ControlAction, reasonRaw: unknown, config?: unknown) {
  const reason = typeof reasonRaw === "string" ? reasonRaw.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  if (!reason) throw new Error("A reason is required for every replenishment control change.");
  if (action === "configure" && (config === null || config === undefined)) throw new Error("A configuration object is required ({} for the defaults).");
  if (action === "configure") resolveConfig(config);
  return db.$transaction(async (tx) => {
    const current = await tx.replenishmentControl.upsert({ where: { id: CONTROL_ID }, create: { id: CONTROL_ID, enabled: false }, update: {} });
    const data: Prisma.ReplenishmentControlUpdateInput =
      action === "enable" ? { enabled: true }
      : action === "disable" ? { enabled: false }
      : action === "pause" ? { pausedAt: current.pausedAt ?? new Date(), pauseReason: reason }
      : action === "resume" ? { pausedAt: null, pauseReason: null }
      : { config: json(config) };
    const next = await tx.replenishmentControl.update({ where: { id: CONTROL_ID }, data });
    await tx.replenishmentControlChange.create({
      data: { controlId: CONTROL_ID, action, reason, enabled: next.enabled, paused: !!next.pausedAt, config: action === "configure" ? json(config ?? null) : undefined },
    });
    return next;
  });
}

/** Pauses on its own, keeping the first reason; replenishment stays stopped until a person resumes it. */
async function autoPause(db: Db, reason: string) {
  await db.$transaction(async (tx) => {
    const current = await tx.replenishmentControl.upsert({ where: { id: CONTROL_ID }, create: { id: CONTROL_ID, enabled: false }, update: {} });
    if (current.pausedAt) return;
    const next = await tx.replenishmentControl.update({ where: { id: CONTROL_ID }, data: { pausedAt: new Date(), pauseReason: reason } });
    await tx.replenishmentControlChange.create({ data: { controlId: CONTROL_ID, action: "auto_pause", reason, enabled: next.enabled, paused: true } });
  });
}

export interface Supply {
  eligible: number;
  pendingResearch: number;
  total: number;
}

/** Autonomous-eligible candidates, plus candidates this module added that research has not finished. */
export async function supplySnapshot(db: Db, now: Date): Promise<Supply> {
  const eligible = (await autonomousCandidates(db, now)).length;
  const pendingResearch = await db.screeningEntry.count({ where: { status: "ingested", candidate: { status: { in: ["discovered", "researching"] } } } });
  return { eligible, pendingResearch, total: eligible + pendingResearch };
}

/** The next area: one never sourced first (in rotation order), then the least recently sourced, skipping areas exhausted for this release. */
export function chooseArea(areas: readonly Area[], history: readonly { area: string; createdAt: Date; release: string; areaExhausted: boolean }[], release: string): Area | null {
  const latest = new Map<string, { createdAt: Date; release: string; areaExhausted: boolean }>();
  for (const h of history) {
    const prev = latest.get(h.area);
    if (!prev || prev.createdAt < h.createdAt) latest.set(h.area, h);
  }
  const open = areas.filter((a) => {
    const l = latest.get(a.key);
    return !(l && l.release === release && l.areaExhausted);
  });
  const never = open.find((a) => !latest.has(a.key));
  if (never) return never;
  return [...open].sort((a, b) => latest.get(a.key)!.createdAt.getTime() - latest.get(b.key)!.createdAt.getTime())[0] ?? null;
}

export interface ReplenishmentDeps {
  importer?: ProviderImporter;
  screen?: ScreenDeps;
  now?: () => number;
}

export interface RunOptions {
  /** REPLENISHMENT_ENABLED on this service. */
  armed: boolean;
  /** Reads, sources and screens, but writes nothing to the database. */
  dryRun?: boolean;
  /** Dry run only: source this area instead of the next in the rotation. */
  area?: string;
  /** Dry run only: screen at most this many businesses. */
  limit?: number;
  shouldStop?: () => boolean;
  /** Epoch milliseconds: no screening chunk starts with less than a minute left. */
  deadline?: number;
  deps?: ReplenishmentDeps;
}

export type Outcome =
  | "disabled" | "paused" | "config_invalid" | "not_needed" | "cooldown" | "daily_limit" | "no_area"
  | "exhausted" | "screening" | "deferred" | "completed" | "stopped" | "failed";

export interface ReplenishmentReport {
  outcome: Outcome;
  dryRun: boolean;
  reason?: string;
  supply?: Supply;
  area?: string;
  release?: string;
  batchId?: string;
  source?: Pick<SourceResult, "read" | "skipped" | "exhausted"> & { selected: number };
  screened: number;
  accepted: number;
  rejected: number;
  errors: number;
  skippedBudget: number;
  ingested: number;
  duplicates: number;
  fetches: number;
  bytes: number;
  rejections: Record<string, number>;
  /** Created candidate IDs (live) or, for a dry run, what would be added. */
  candidates: string[];
  wouldAdd?: { businessName: string; city: string | null; domain: string | null; emailDomain: string | null }[];
}

const emptyReport = (dryRun: boolean): ReplenishmentReport => ({
  outcome: "completed", dryRun, screened: 0, accepted: 0, rejected: 0, errors: 0, skippedBudget: 0, ingested: 0, duplicates: 0, fetches: 0, bytes: 0, rejections: {}, candidates: [],
});

/** Emails that must keep a business out at prescreen: suppressions, opt-outs, and every known candidate, prospect and recipient email. */
async function blockedEmails(db: Db): Promise<Set<string>> {
  const index = await protectionIndex(db);
  const emails = [
    ...index.suppressions.map((s) => s.email), ...index.optOuts.map((o) => o.senderEmail), ...index.messages.map((m) => m.recipientEmail),
    ...index.prospects.map((p) => p.email), ...index.candidates.map((c) => c.email),
  ];
  return new Set(emails.map((e) => e?.trim().toLowerCase()).filter((e): e is string => !!e));
}

interface Ledger {
  /** Reserves one business's full cap, or false when a batch or daily budget would be exceeded. */
  reserve(entryId: string): Promise<boolean>;
  settle(entryId: string, outcome: ScreenOutcome): Promise<void>;
}

/** Live: durable reservations on the batch row, under a row lock. */
function dbLedger(db: Db, batchId: string, config: ReplenishmentConfig, clock: () => number): Ledger {
  const { perBusinessFetches: cf, perBusinessBytes: cb } = config.limits;
  return {
    async reserve(entryId) {
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ReplenishmentBatch" WHERE id = ${batchId}::uuid FOR UPDATE`;
        const b = await tx.replenishmentBatch.findUniqueOrThrow({ where: { id: batchId } });
        const day = await tx.replenishmentBatch.aggregate({ where: { createdAt: { gte: new Date(clock() - DAY_MS) } }, _sum: { fetches: true, reservedFetches: true } });
        const dayUsed = (day._sum.fetches ?? 0) + (day._sum.reservedFetches ?? 0);
        if (b.fetches + b.reservedFetches + cf > config.limits.fetches || b.bytes + b.reservedBytes + cb > config.limits.bytes || dayUsed + cf > config.limits.fetchesPerDay) return false;
        const claimed = await tx.screeningEntry.updateMany({ where: { id: entryId, batchId, status: "pending" }, data: { status: "screening" } });
        if (!claimed.count) return false;
        await tx.replenishmentBatch.update({ where: { id: batchId }, data: { reservedFetches: { increment: cf }, reservedBytes: { increment: cb } } });
        return true;
      });
    },
    async settle(entryId, o) {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ReplenishmentBatch" WHERE id = ${batchId}::uuid FOR UPDATE`;
        await tx.screeningEntry.update({
          where: { id: entryId },
          data: { status: o.status, reasons: json(o.reasons), evidence: json(o.evidence), publishedEmail: o.email, fetches: o.fetches, bytes: o.bytes, screenedAt: new Date(clock()) },
        });
        await tx.replenishmentBatch.update({
          where: { id: batchId },
          data: {
            reservedFetches: { decrement: cf }, reservedBytes: { decrement: cb }, fetches: { increment: o.fetches }, bytes: { increment: o.bytes }, screened: { increment: 1 },
            accepted: { increment: o.status === "accepted" ? 1 : 0 }, rejected: { increment: o.status === "rejected" ? 1 : 0 }, errors: { increment: o.status === "error" ? 1 : 0 },
          },
        });
      });
    },
  };
}

/** Dry run: the same budgets, kept in memory. */
function memoryLedger(config: ReplenishmentConfig, dayUsedAtStart: number): Ledger & { used: { fetches: number; bytes: number } } {
  const used = { fetches: 0, bytes: 0 };
  let reserved = { fetches: 0, bytes: 0 };
  const { perBusinessFetches: cf, perBusinessBytes: cb } = config.limits;
  return {
    used,
    async reserve() {
      if (used.fetches + reserved.fetches + cf > config.limits.fetches || used.bytes + reserved.bytes + cb > config.limits.bytes || dayUsedAtStart + used.fetches + reserved.fetches + cf > config.limits.fetchesPerDay) return false;
      reserved = { fetches: reserved.fetches + cf, bytes: reserved.bytes + cb };
      return true;
    },
    async settle(_id, o) {
      reserved = { fetches: reserved.fetches - cf, bytes: reserved.bytes - cb };
      used.fetches += o.fetches;
      used.bytes += o.bytes;
    },
  };
}

/** Provider batches for one area's county. */
function countyRecords(importer: ProviderImporter, release: string, area: Area) {
  const scope = { region: `US-${area.state}`, county: area.county };
  const refused = importer.checkScope?.(scope);
  if (refused) throw new Error(refused);
  return importer.fetch(release, scope);
}

export async function runReplenishment(db: Db, opts: RunOptions): Promise<ReplenishmentReport> {
  const dryRun = Boolean(opts.dryRun);
  const report = emptyReport(dryRun);
  const clock = opts.deps?.now ?? Date.now;
  const importer = opts.deps?.importer ?? createOvertureImporter();
  const control = await readControl(db);
  if (control.configError || !control.config) return { ...report, outcome: "config_invalid", reason: control.configError ?? "No configuration." };
  const config = control.config;
  if (!dryRun) {
    if (!opts.armed) return { ...report, outcome: "disabled", reason: "REPLENISHMENT_ENABLED is not 1 on this service." };
    if (!control.enabled) return { ...report, outcome: "disabled", reason: "The replenishment control is off." };
    if (control.paused) return { ...report, outcome: "paused", reason: control.pauseReason ?? "Paused." };
  }
  let batchId: string | null = null;
  /** Requests already used in the rolling 24 hours (the dry run's in-memory ledger starts from it). */
  let dayFetches = 0;
  try {
    const now = new Date(clock());
    const open = dryRun ? null : await db.replenishmentBatch.findFirst({ where: { status: { in: OPEN_STATUSES } }, orderBy: { createdAt: "asc" } });
    let area: Area | undefined;
    let pending: { id: string; business: StagedPlace }[] = [];
    if (open) {
      // Resume. An intake that was interrupted may have half-created a run: a person reviews it.
      if (open.status === "intake") throw new IntakeInterrupted(`Batch ${open.id} was interrupted during intake; review its Discovery run before resuming.`);
      batchId = open.id;
      Object.assign(report, { area: open.area, release: open.release, batchId });
      // A business interrupted mid-screen keeps its whole reservation charged and is not retried.
      await db.$transaction(async (tx) => {
        const stuck = await tx.screeningEntry.findMany({ where: { batchId: open.id, status: "screening" }, select: { id: true } });
        if (!stuck.length) return;
        await tx.screeningEntry.updateMany({ where: { id: { in: stuck.map((s) => s.id) } }, data: { status: "error", reasons: json(["interrupted"]), screenedAt: now } });
        const n = stuck.length;
        await tx.replenishmentBatch.update({
          where: { id: open.id },
          data: {
            reservedFetches: { decrement: n * config.limits.perBusinessFetches }, reservedBytes: { decrement: n * config.limits.perBusinessBytes },
            fetches: { increment: n * config.limits.perBusinessFetches }, bytes: { increment: n * config.limits.perBusinessBytes }, screened: { increment: n }, errors: { increment: n },
          },
        });
      });
      if (open.status === "screening") {
        pending = (await db.screeningEntry.findMany({ where: { batchId: open.id, status: "pending" }, orderBy: { createdAt: "asc" }, select: { id: true, business: true } }))
          .map((e) => ({ id: e.id, business: e.business as unknown as StagedPlace }));
      }
    } else {
      report.supply = await supplySnapshot(db, now);
      if (!dryRun && !needsSupply(report.supply.total, config)) return { ...report, outcome: "not_needed", reason: `Supply ${report.supply.total} is at or above ${config.lowSupply}.` };
      const recent = await db.replenishmentBatch.findMany({
        where: { createdAt: { gte: new Date(clock() - DAY_MS) }, status: { not: "imported" } }, select: { createdAt: true, status: true, fetches: true, reservedFetches: true }, orderBy: { createdAt: "desc" },
      });
      dayFetches = recent.reduce((n, b) => n + b.fetches + b.reservedFetches, 0);
      if (!dryRun) {
        // An area found exhausted only read the provider: the rotation moves on without waiting.
        const last = recent.find((b) => b.status !== "exhausted");
        if (last && clock() - last.createdAt.getTime() < config.limits.cooldownMinutes * 60_000) return { ...report, outcome: "cooldown", reason: `The last batch started less than ${config.limits.cooldownMinutes} minutes ago.` };
        if (recent.length >= config.limits.batchesPerDay) return { ...report, outcome: "daily_limit", reason: `${recent.length} batches in the last 24 hours (limit ${config.limits.batchesPerDay}).` };
        if (dayFetches + config.limits.perBusinessFetches > config.limits.fetchesPerDay) return { ...report, outcome: "daily_limit", reason: "The rolling 24-hour request budget is used up." };
      }
      const release = await (importer.resolveRelease?.(config.release) ?? Promise.resolve(config.release));
      const history = (await db.replenishmentBatch.findMany({ select: { area: true, createdAt: true, release: true, report: true } }))
        .map((b) => ({ area: b.area, createdAt: b.createdAt, release: b.release, areaExhausted: Boolean((b.report as { areaExhausted?: boolean } | null)?.areaExhausted) }));
      area = opts.area && dryRun ? config.areas.find((a) => a.key === opts.area) : chooseArea(config.areas, history, release) ?? undefined;
      if (!area) return { ...report, outcome: "no_area", reason: opts.area ? `No configured area ${opts.area}.` : `Every area is exhausted for release ${release}.` };
      Object.assign(report, { area: area.key, release });

      const [candidates, prospects, screened] = await Promise.all([
        db.discoveryCandidate.findMany({ select: { id: true, provider: true, externalId: true, businessName: true, website: true, city: true, state: true, phone: true, providerPhone: true, streetAddress: true, latitude: true, longitude: true } }),
        db.prospect.findMany({ select: { id: true, businessName: true, website: true, city: true, state: true, phone: true } }),
        db.screeningEntry.findMany({ where: { provider: config.provider }, select: { externalId: true } }),
      ]);
      const ctx = sourceContext(config.provider, { candidates, prospects, screenedIds: screened.map((s) => s.externalId) });
      const businesses = dryRun && opts.limit ? Math.min(opts.limit, config.limits.businesses) : config.limits.businesses;
      const sourced = await selectFromSource(countyRecords(importer, release, area), area, ctx, { businesses, sourceRows: config.limits.sourceRows });
      report.source = { read: sourced.read, skipped: sourced.skipped, exhausted: sourced.exhausted, selected: sourced.selected.length };
      const retrievedAt = now.toISOString();
      const records = sourced.selected.map((p) => ({ ...p, release, retrievedAt }));
      const areaExhausted = sourced.exhausted && records.length < businesses;
      if (!records.length) {
        if (!dryRun) {
          await db.replenishmentBatch.create({
            data: { status: "exhausted", area: area.key, provider: config.provider, release, trigger: json(report.supply), limits: json(config.limits), sourceRead: sourced.read, finishedAt: now, report: json({ areaExhausted: true, source: report.source }) },
          });
        }
        return { ...report, outcome: "exhausted", reason: `No unscreened businesses left in ${area.key} for release ${release}.` };
      }
      if (dryRun) {
        pending = records.map((r) => ({ id: r.externalId, business: r }));
      } else {
        const batch = await db.$transaction(async (tx) => {
          const b = await tx.replenishmentBatch.create({
            data: {
              status: "screening", area: area!.key, provider: config.provider, release, trigger: json(report.supply), limits: json(config.limits),
              sourceRead: sourced.read, sourceSelected: records.length, report: json({ areaExhausted, source: report.source }),
            },
          });
          await tx.screeningEntry.createMany({
            data: records.map((r) => ({ batchId: b.id, provider: config.provider, externalId: r.externalId, status: "pending", business: json(r) })),
            skipDuplicates: true,
          });
          return b;
        });
        batchId = batch.id;
        report.batchId = batch.id;
        pending = (await db.screeningEntry.findMany({ where: { batchId: batch.id, status: "pending" }, orderBy: { createdAt: "asc" }, select: { id: true, business: true } }))
          .map((e) => ({ id: e.id, business: e.business as unknown as StagedPlace }));
      }
    }

    // Screening, in chunks, within the batch and daily budgets and the run's deadline.
    const rules = { blockedEmails: await blockedEmails(db), requirePublishedEmail: config.requirePublishedEmail };
    const caps = { fetches: config.limits.perBusinessFetches, bytes: config.limits.perBusinessBytes, pages: config.limits.pagesPerBusiness };
    const ledger = dryRun ? memoryLedger(config, dayFetches) : dbLedger(db, batchId!, config, clock);
    const accepted: { id: string; business: StagedPlace; email: string | null }[] = [];
    let budgetLeft = true;
    let timeLeft = true;
    for (let i = 0; i < pending.length && budgetLeft; i += config.limits.concurrency) {
      if (opts.shouldStop?.() || (opts.deadline && opts.deadline - clock() < MIN_CHUNK_MS)) {
        timeLeft = false;
        break;
      }
      const chunk = pending.slice(i, i + config.limits.concurrency);
      const results = await Promise.all(chunk.map(async (e) => {
        if (!(await ledger.reserve(e.id))) return null;
        const outcome = await screenBusiness(e.business, rules, caps, opts.deps?.screen);
        await ledger.settle(e.id, outcome);
        return { e, outcome };
      }));
      for (const r of results) {
        if (!r) {
          budgetLeft = false;
          continue;
        }
        report.screened++;
        report.fetches += r.outcome.fetches;
        report.bytes += r.outcome.bytes;
        if (r.outcome.status === "accepted") {
          report.accepted++;
          accepted.push({ id: r.e.id, business: r.e.business, email: r.outcome.email });
        } else {
          if (r.outcome.status === "rejected") report.rejected++;
          else report.errors++;
          for (const reason of r.outcome.reasons) report.rejections[reason] = (report.rejections[reason] ?? 0) + 1;
        }
      }
    }
    if (!budgetLeft && !dryRun) {
      // The batch's or the day's budget is spent: the rest of this batch is never screened.
      const left = await db.screeningEntry.updateMany({ where: { batchId: batchId!, status: "pending" }, data: { status: "budget", reasons: json(["budget_exhausted"]) } });
      await db.replenishmentBatch.update({ where: { id: batchId! }, data: { skippedBudget: { increment: left.count } } });
      report.skippedBudget = left.count;
    } else if (!budgetLeft) {
      report.skippedBudget = pending.length - report.screened;
    }
    if (!timeLeft) {
      if (!dryRun) return { ...report, outcome: "screening", reason: "Out of time for this run; screening resumes on the next run." };
      report.skippedBudget = pending.length - report.screened;
    }

    if (dryRun) {
      report.wouldAdd = accepted.map((a) => ({ businessName: a.business.businessName, city: a.business.city ?? null, domain: normalizeDomain(a.business.website), emailDomain: a.email?.split("@")[1] ?? null }));
      return { ...report, outcome: "completed" };
    }
    await db.replenishmentBatch.updateMany({ where: { id: batchId!, status: "screening" }, data: { status: "ready" } });
    return await intake(db, batchId!, config, opts, report);
  } catch (e) {
    if (e instanceof ReplenishmentStop) return { ...report, outcome: "stopped", reason: safeReason(e) };
    const reason = safeReason(e);
    if (!dryRun) {
      if (batchId && !(e instanceof IntakeInterrupted)) {
        await db.replenishmentBatch.updateMany({ where: { id: batchId, status: { in: OPEN_STATUSES } }, data: { status: "failed", reason, finishedAt: new Date(clock()) } });
      }
      await autoPause(db, `Automatic pause: ${reason}`.slice(0, 500));
    }
    return { ...report, outcome: "failed", reason };
  }
}

class IntakeInterrupted extends Error {}

/** Adds the accepted businesses to Discovery through the existing run pipeline (which deduplicates again). */
async function intake(db: Db, batchId: string, config: ReplenishmentConfig, opts: RunOptions, report: ReplenishmentReport): Promise<ReplenishmentReport> {
  const clock = opts.deps?.now ?? Date.now;
  const control = await readControl(db);
  if (!opts.armed || !control.enabled || control.paused) return { ...report, outcome: "deferred", reason: "Replenishment was switched off before intake; the batch waits." };
  if (await db.discoveryRun.count({ where: { status: { in: ["queued", "running"] } } })) return { ...report, outcome: "deferred", reason: "Another Discovery run is active; intake waits for the next run." };
  const batch = await db.replenishmentBatch.findUniqueOrThrow({ where: { id: batchId } });
  const accepted = await db.screeningEntry.findMany({ where: { batchId, status: "accepted" }, orderBy: { createdAt: "asc" } });
  // Recheck against what exists now: a person may have added one of these businesses since sourcing.
  const [candidates, prospects] = await Promise.all([
    db.discoveryCandidate.findMany({ select: { id: true, provider: true, externalId: true, businessName: true, website: true, city: true, state: true, phone: true, providerPhone: true, streetAddress: true, latitude: true, longitude: true } }),
    db.prospect.findMany({ select: { id: true, businessName: true, website: true, city: true, state: true, phone: true } }),
  ]);
  const ctx = sourceContext(batch.provider, { candidates, prospects, screenedIds: [] });
  const area = config.areas.find((a) => a.key === batch.area);
  const unique: { entryId: string; place: StagedPlace; business: DiscoveredBusiness }[] = [];
  const duplicateIds: string[] = [];
  for (const e of accepted) {
    const p = e.business as unknown as StagedPlace & { release: string; retrievedAt: string };
    if (knownBusiness(p, ctx)) {
      duplicateIds.push(e.id);
      continue;
    }
    unique.push({ entryId: e.id, place: p, business: { ...p, retrievedAt: new Date(p.retrievedAt) } });
    remember(p, ctx);
  }
  await db.replenishmentBatch.update({ where: { id: batchId }, data: { status: "intake" } });
  let created: { id: string; externalId: string | null }[] = [];
  if (unique.length) {
    const provider: DiscoveryProvider = { name: batch.provider, label: "Overture Maps Places", mode: "background", async *discoverBatches() { yield unique.map((u) => u.business); } };
    const providers = new Map([[batch.provider, provider]]);
    const first = unique[0]!.place;
    const queued = await runDiscovery(db, providers, {
      provider: batch.provider, region: `${first.county ?? area?.county ?? ""}, ${first.state ?? area?.state ?? ""}`, city: null,
      businessType: `Automotive repair — replenishment ${batchId.slice(0, 8)}`, tiers: ["core"],
    });
    await db.replenishmentBatch.update({ where: { id: batchId }, data: { runId: queued.id } });
    await processDiscoveryRun(db, providers, queued.id);
    created = await db.discoveryCandidate.findMany({ where: { runId: queued.id }, select: { id: true, externalId: true } });
  }
  const byExternal = new Map(created.map((c) => [c.externalId, c.id]));
  await db.$transaction(async (tx) => {
    for (const u of unique) {
      const candidateId = byExternal.get((u.business as DiscoveredBusiness).externalId ?? "");
      if (candidateId) await tx.screeningEntry.update({ where: { id: u.entryId }, data: { status: "ingested", candidateId } });
      else duplicateIds.push(u.entryId);
    }
    if (duplicateIds.length) await tx.screeningEntry.updateMany({ where: { id: { in: duplicateIds } }, data: { status: "duplicate" } });
    await tx.replenishmentBatch.update({
      where: { id: batchId },
      data: { status: "completed", ingested: created.length, duplicates: duplicateIds.length, finishedAt: new Date(clock()) },
    });
  });
  return { ...report, outcome: "completed", ingested: created.length, duplicates: duplicateIds.length, candidates: created.map((c) => c.id) };
}

/** One line, counts only (never an email address). */
export function replenishmentSummary(r: ReplenishmentReport): string {
  const head = `Replenishment${r.dryRun ? " (dry run)" : ""}: ${r.outcome.replace("_", " ")}`;
  if (["disabled", "paused", "config_invalid", "not_needed", "cooldown", "daily_limit", "no_area"].includes(r.outcome)) return `${head}; ${r.reason ?? ""}`.trim();
  const supply = r.supply ? ` supply ${r.supply.eligible} eligible + ${r.supply.pendingResearch} in research;` : "";
  return `${head};${supply} area ${r.area ?? "-"} (${r.release ?? "-"}); sourced ${r.source?.selected ?? 0} of ${r.source?.read ?? 0} read; ` +
    `screened ${r.screened} (${r.accepted} accepted, ${r.rejected} rejected, ${r.errors} errors, ${r.skippedBudget} over budget); ` +
    `ingested ${r.ingested}, duplicates ${r.duplicates}; ${r.fetches} requests, ${Math.round(r.bytes / 1000)} kB${r.reason ? `; ${r.reason}` : ""}.`;
}

export interface PriorScreening {
  /** e.g. "targeted-outreach-03": recorded on the batch. */
  label: string;
  area: string;
  release: string;
  entries: { business: StagedPlace; status: "rejected" | "error"; reasons: string[] }[];
}

/**
 * Records decisions a person's earlier prescreen already made (Targeted Outreach 03 screened 100 West
 * San Fernando Valley businesses by these same rules) so replenishment never screens those records again.
 * One batch, marked imported. Only rejections and errors: the accepted ones are already
 * candidates, which sourcing skips. Idempotent: records already present are left as they are. The batch
 * is "imported": it never counts toward the cooldown or the daily batch and request limits.
 */
export async function recordPriorScreening(db: Db, prior: PriorScreening, reasonRaw: unknown) {
  const reason = typeof reasonRaw === "string" ? reasonRaw.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  if (!reason) throw new Error("A reason is required to record a prior screening.");
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(prior.area) || !/^[a-z0-9-]{1,60}$/.test(prior.label)) throw new Error("A valid area key and label are required.");
  if (!prior.entries.length || prior.entries.length > 500) throw new Error("Between 1 and 500 prior screenings are required.");
  for (const e of prior.entries) {
    if (!e.business?.externalId || !e.business.businessName || !["rejected", "error"].includes(e.status) || !Array.isArray(e.reasons) || !e.reasons.length) {
      throw new Error("Each prior screening needs a provider record and a rejection or error with its reasons.");
    }
  }
  return db.$transaction(async (tx) => {
    const batch = await tx.replenishmentBatch.create({
      data: {
        status: "imported", area: prior.area, provider: "overture", release: prior.release, trigger: json({ imported: prior.label, reason }), limits: json({}),
        sourceSelected: prior.entries.length, screened: prior.entries.length, rejected: prior.entries.filter((e) => e.status === "rejected").length,
        errors: prior.entries.filter((e) => e.status === "error").length, finishedAt: new Date(), report: json({ imported: prior.label, areaExhausted: false }),
      },
    });
    const created = await tx.screeningEntry.createMany({
      data: prior.entries.map((e) => ({
        batchId: batch.id, provider: "overture", externalId: e.business.externalId, status: e.status, business: json(e.business),
        reasons: json(e.reasons.slice(0, 10).map((r) => String(r).slice(0, 80))), evidence: json({ imported: prior.label }), screenedAt: new Date(),
      })),
      skipDuplicates: true,
    });
    return { batchId: batch.id, recorded: created.count, alreadyPresent: prior.entries.length - created.count };
  });
}

/** Read-only: the control, supply and recent batches, for the CLI and operators. */
export async function replenishmentStatus(db: Db, now = new Date()) {
  const control = await readControl(db);
  const supply = await supplySnapshot(db, now);
  const batches = await db.replenishmentBatch.findMany({
    orderBy: { createdAt: "desc" }, take: 10,
    select: { id: true, status: true, area: true, release: true, sourceSelected: true, screened: true, accepted: true, rejected: true, errors: true, skippedBudget: true, ingested: true, duplicates: true, fetches: true, bytes: true, reason: true, createdAt: true, finishedAt: true },
  });
  const changes = await db.replenishmentControlChange.findMany({ orderBy: { createdAt: "desc" }, take: 10, select: { action: true, reason: true, enabled: true, paused: true, createdAt: true } });
  return {
    control: { enabled: control.enabled, paused: control.paused, pauseReason: control.pauseReason, configError: control.configError, custom: control.storedConfig !== null },
    lowSupply: control.config?.lowSupply ?? null, needed: control.config ? needsSupply(supply.total, control.config) : null, supply, batches, changes,
  };
}
