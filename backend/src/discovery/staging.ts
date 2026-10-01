/*
 * Provider release -> staging -> discovery runs.
 *
 *   PROVIDER RELEASE (e.g. a monthly open-data release)
 *        -> runImport()            background job (CLI / scheduler), never a web request
 *        -> ProviderImport + ProviderPlace   minimized staged records
 *        -> createStagedProvider() a "background" DiscoveryProvider over one import
 *        -> queued DiscoveryRun -> processDiscoveryRun() -> normalize -> dedupe -> candidates
 *
 * Staging holds only the minimized business fields discovery needs (see the
 * ProviderPlace model). No raw payloads are kept, and older imports are
 * pruned so only recent releases remain.
 */
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { countySlug, isCountyName } from "./boundaries.js";
import { cleanCoordinates, cleanOperatingStatus } from "./normalize.js";
import type {
  CategoryTier,
  DiscoveredBusiness,
  DiscoveryProvider,
  DiscoveryTarget,
  ImportScope,
  ImportStats,
  ProviderImporter,
  StagedPlace,
} from "./types.js";

const clip = (v: string | null | undefined, max: number) => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
};

/** Import regions are ISO 3166-2 style, e.g. "US-CA". */
export const isScope = (s: string) => /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(s);

/**
 * The key an import is stored and pruned under: "US-CA" for a state,
 * "US-CA/ventura" for one county.
 */
export function scopeKey(scope: ImportScope): string {
  return scope.county ? `${scope.region}/${countySlug(scope.county)}` : scope.region;
}

/** "Ventura County, CA" for a county scope, "US-CA" for a state. */
const areaLabel = (scope: ImportScope) =>
  scope.county ? `${scope.county.trim()}, ${scope.region.split("-")[1] ?? ""}`.slice(0, 100) : scope.region;

/** An import still "running" after this long was interrupted (its process died). */
export const STALE_IMPORT_MS = 60 * 60 * 1000;

const redactError = (err: unknown) =>
  (err instanceof Error ? err.message : "unknown").replace(/(?:https?|s3):\/\/\S+/g, "[url]").slice(0, 300);

function minimize(p: StagedPlace, importId: string): Prisma.ProviderPlaceCreateManyInput | null {
  const externalId = clip(p.externalId, 200);
  const businessName = clip(p.businessName, 120);
  if (!externalId || !businessName) return null;
  const tier: CategoryTier | null = p.categoryTier === "core" || p.categoryTier === "adjacent" ? p.categoryTier : null;
  const confidence = typeof p.confidence === "number" && p.confidence >= 0 && p.confidence <= 1 ? p.confidence : null;
  return {
    importId,
    externalId,
    businessName,
    website: clip(p.website, 200),
    phone: clip(p.phone, 30),
    streetAddress: clip(p.streetAddress, 200),
    city: clip(p.city, 100),
    county: clip(p.county, 100),
    state: clip(p.state, 50)?.toUpperCase() ?? null,
    postalCode: clip(p.postalCode, 20),
    country: clip(p.country, 2)?.toUpperCase() ?? null,
    ...cleanCoordinates(p.latitude, p.longitude),
    category: clip(p.category, 100),
    categoryTier: tier,
    brand: clip(p.brand, 120),
    confidence,
    operatingStatus: cleanOperatingStatus(p.operatingStatus),
    sourceUrl: clip(p.sourceUrl, 500),
    sources: clip(p.sources, 200),
  };
}

export interface ImportResult {
  importId: string;
  /** "unchanged": this release was already imported for the scope; nothing was read. */
  status: "completed" | "failed" | "unchanged";
  release: string;
  scope: string;
  recordCount: number;
  skipped: number;
  error: string | null;
  stats: ImportStats;
}

/**
 * Marks imports that have been "running" for longer than STALE_IMPORT_MS
 * as failed (their process stopped without finishing), so their rows are
 * never read and are pruned.
 */
export async function failStaleImports(db: Db, provider: string, scope: string, now = new Date()) {
  const { count } = await db.providerImport.updateMany({
    where: { provider, scope, status: "running", startedAt: { lt: new Date(now.getTime() - STALE_IMPORT_MS) } },
    data: { status: "failed", error: "Interrupted: the import stopped before it finished.", finishedAt: now },
  });
  return count;
}

/**
 * Loads one provider release for a scope into staging, in batches. A failed
 * import is kept as failed (its rows are never read); a successful one
 * prunes older imports of the same provider and scope beyond `keep`.
 * Importing a release that already completed for the scope does nothing
 * unless `force` is set. Safe to rerun at any point.
 */
export async function runImport(
  db: Db,
  importer: ProviderImporter,
  release: string,
  scope: ImportScope,
  opts: { keep?: number; force?: boolean; onBatch?: (count: number) => void } = {},
): Promise<ImportResult> {
  if (!isScope(scope.region)) throw new Error(`Scope must look like US-CA, got "${scope.region}".`);
  if (scope.county && !isCountyName(scope.county)) throw new Error(`"${scope.county}" doesn't look like a county name.`);
  const refused = importer.checkScope?.(scope);
  if (refused) throw new Error(refused);
  const requested = clip(release, 64);
  if (!requested) throw new Error("Release is required.");
  const rel = clip(importer.resolveRelease ? await importer.resolveRelease(requested) : requested, 64)!;
  const key = scopeKey(scope);

  await failStaleImports(db, importer.provider, key);
  const done = await db.providerImport.findFirst({
    where: { provider: importer.provider, scope: key, release: rel, status: "completed" },
    orderBy: { startedAt: "desc" },
  });
  if (done && !opts.force) {
    return {
      importId: done.id,
      status: "unchanged",
      release: rel,
      scope: key,
      recordCount: done.recordCount,
      skipped: 0,
      error: null,
      stats: (done.stats as ImportStats | null) ?? {},
    };
  }

  const imp = await db.providerImport.create({
    data: { provider: importer.provider, release: rel, scope: key, area: areaLabel(scope) },
  });
  const stats: ImportStats = {};
  let recordCount = 0;
  let skipped = 0;
  try {
    for await (const batch of importer.fetch(rel, scope, stats)) {
      const rows = batch.map((p) => minimize(p, imp.id));
      const good = rows.filter((r): r is NonNullable<typeof r> => r !== null);
      skipped += rows.length - good.length;
      if (good.length) {
        const { count } = await db.providerPlace.createMany({ data: good, skipDuplicates: true });
        recordCount += count;
        skipped += good.length - count;
      }
      await db.providerImport.update({ where: { id: imp.id }, data: { recordCount, stats } });
      opts.onBatch?.(recordCount);
    }
    await db.providerImport.update({
      where: { id: imp.id },
      data: { status: "completed", recordCount, stats, finishedAt: new Date() },
    });
    await pruneImports(db, importer.provider, key, opts.keep ?? 2);
    return { importId: imp.id, status: "completed", release: rel, scope: key, recordCount, skipped, error: null, stats };
  } catch (err) {
    const error = redactError(err);
    await db.providerImport.update({ where: { id: imp.id }, data: { status: "failed", error, stats, finishedAt: new Date() } });
    await pruneImports(db, importer.provider, key, opts.keep ?? 2);
    return { importId: imp.id, status: "failed", release: rel, scope: key, recordCount, skipped, error, stats };
  }
}

/** Deletes staged rows of all but the `keep` newest completed imports (and of failed ones). */
export async function pruneImports(db: Db, provider: string, scope: string, keep = 2) {
  const completed = await db.providerImport.findMany({
    where: { provider, scope, status: "completed" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  const stale = completed.slice(keep).map((i) => i.id);
  const failed = await db.providerImport.findMany({ where: { provider, scope, status: "failed" }, select: { id: true } });
  const ids = [...stale, ...failed.map((i) => i.id)];
  if (!ids.length) return 0;
  const { count } = await db.providerPlace.deleteMany({ where: { importId: { in: ids } } });
  return count;
}

export function latestImport(db: Db, provider: string, scope: string | string[]) {
  return db.providerImport.findFirst({
    where: { provider, scope: Array.isArray(scope) ? { in: scope } : scope, status: "completed" },
    orderBy: { startedAt: "desc" },
  });
}

/** Recent imports of any provider, newest first (for the admin). */
export const recentImports = (db: Db, take = 6) =>
  db.providerImport.findMany({ orderBy: { startedAt: "desc" }, take, include: { _count: { select: { places: true } } } });

/**
 * "Ventura County, CA" -> { county: "Ventura County", state: "CA" };
 * "CA" -> { state: "CA" }. The state is required to pick an import scope.
 */
export function parseRegion(region: string): { county: string | null; state: string | null } {
  const parts = region.split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const state = /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : null;
  const county = state ? (parts.length > 1 ? parts.slice(0, -1).join(", ") : null) : parts.join(", ") || null;
  return { county, state };
}

export interface StagedProviderOptions {
  /** Provider name the candidates record, e.g. "overture". */
  name: string;
  label: string;
  /** The staged provider whose imports this reads (defaults to `name`). */
  importsFrom?: string;
  /** Records the provider rates below this are skipped (null keeps all). */
  minConfidence?: number | null;
  batchSize?: number;
}

/**
 * A background DiscoveryProvider over the latest completed import of a
 * provider for the target's state. Discovery filters (all recorded on the
 * run's query): county, city, category tiers, provider-closed places
 * excluded, and a minimum provider confidence.
 */
export function createStagedProvider(db: Db, opts: StagedProviderOptions): DiscoveryProvider {
  const source = opts.importsFrom ?? opts.name;
  const batchSize = opts.batchSize ?? 250;
  const minConfidence = opts.minConfidence === undefined ? 0.5 : opts.minConfidence;

  /**
   * The newest completed import covering the target: the county's own
   * import ("US-CA/ventura") or a statewide one ("US-CA").
   */
  async function importFor(target: DiscoveryTarget) {
    const { county, state } = parseRegion(target.region);
    if (!state) throw new Error("Region must end with a two-letter state, e.g. Ventura County, CA.");
    const scopes = county ? [`US-${state}/${countySlug(county)}`, `US-${state}`] : [`US-${state}`];
    const imp = await latestImport(db, source, scopes);
    if (!imp) throw new Error(`No completed ${opts.label} import for ${target.region}. Run the import first.`);
    return { imp, county, state };
  }

  return {
    name: opts.name,
    label: opts.label,
    mode: "background",
    async resolveImport(target: DiscoveryTarget) {
      const { imp } = await importFor(target);
      return { id: imp.id, release: imp.release };
    },
    async *discoverBatches(target: DiscoveryTarget): AsyncIterable<DiscoveredBusiness[]> {
      const { imp, county, state } = await importFor(target);
      // A county's own import holds only that county; a statewide one is filtered by name.
      const countyFilter = county && !imp.scope.includes("/") ? { county: { equals: county, mode: "insensitive" as const } } : {};
      const tiers = target.tiers?.length ? [...target.tiers] : (["core"] as CategoryTier[]);
      const where: Prisma.ProviderPlaceWhereInput = {
        importId: imp.id,
        state: { equals: state, mode: "insensitive" },
        categoryTier: { in: tiers },
        OR: [{ operatingStatus: null }, { operatingStatus: { not: "permanently_closed" } }],
        ...countyFilter,
        ...(target.city ? { city: { equals: target.city.trim(), mode: "insensitive" } } : {}),
        ...(minConfidence !== null ? { AND: [{ OR: [{ confidence: null }, { confidence: { gte: minConfidence } }] }] } : {}),
      };
      let cursor: string | undefined;
      for (;;) {
        const rows = await db.providerPlace.findMany({
          where,
          orderBy: { id: "asc" },
          take: batchSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (!rows.length) return;
        cursor = rows[rows.length - 1]!.id;
        yield rows.map(
          (r): DiscoveredBusiness => ({
            externalId: r.externalId,
            businessName: r.businessName,
            website: r.website,
            streetAddress: r.streetAddress,
            city: r.city,
            state: r.state,
            postalCode: r.postalCode,
            country: r.country,
            latitude: r.latitude,
            longitude: r.longitude,
            phone: r.phone,
            sourceUrl: r.sourceUrl,
            category: r.category,
            categoryTier: r.categoryTier,
            brand: r.brand,
            confidence: r.confidence,
            operatingStatus: r.operatingStatus,
            retrievedAt: r.retrievedAt,
            release: imp.release,
            sources: r.sources,
          }),
        );
        if (rows.length < batchSize) return;
      }
    },
  };
}
