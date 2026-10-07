/*
 * Integration test setup. Tests run against TEST_DATABASE_URL, which is
 * migrated and then TRUNCATED, so it must be a disposable local database on
 * a real PostgreSQL server:
 *
 *   createdb reclaimbay_test             # a throwaway database, never reclaimbay_dev
 *   TEST_DATABASE_URL=postgresql://<user>:<password>@localhost:5432/reclaimbay_test npm run test:integration
 *
 * The full suite needs a real PostgreSQL server. Prisma's local emulator
 * (`npx prisma dev`) is not enough: all of its connections share one
 * database session, so the automatic research worker-lock tests
 * (research.autorun.test.ts), which need genuinely separate sessions, fail
 * there. They check for this first (assertSeparateSessions) and say so.
 *
 * Without TEST_DATABASE_URL every integration test is skipped.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "../../src/db.js";
import { addEvidence } from "../../src/prospects.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || "";
export const skipReason = TEST_DATABASE_URL ? false : "TEST_DATABASE_URL is not set";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertDisposable(url: string) {
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.ALLOW_REMOTE_TEST_DB !== "1") {
    throw new Error(`Refusing to truncate non-local database host "${host}". Set ALLOW_REMOTE_TEST_DB=1 to override.`);
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === url) {
    throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL: the tests truncate every table.");
  }
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) {
    throw new Error("Integration tests refuse to run in production / on Railway.");
  }
}

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let migrated = false;

/** Migrated, empty database. */
export async function freshDb(): Promise<Db> {
  assertDisposable(TEST_DATABASE_URL);
  if (!migrated) {
    const prisma = path.join(backendRoot, "node_modules", "prisma", "build", "index.js");
    execFileSync(process.execPath, [prisma, "migrate", "deploy"], {
      cwd: backendRoot,
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: "pipe",
    });
    migrated = true;
  }
  const db = createDb(TEST_DATABASE_URL);
  await truncate(db);
  return db;
}

/** An advisory-lock key used only by assertSeparateSessions, never by the application. */
const SESSION_PROBE_LOCK = 51_120_999;

/**
 * Fails unless TEST_DATABASE_URL gives each connection its own PostgreSQL
 * session: a lock one connection holds must be refused to another. The
 * worker-lock tests depend on exactly that; Prisma's emulator shares one
 * session between connections and would make them fail confusingly. Both
 * probe connections are always closed.
 */
export async function assertSeparateSessions(url = TEST_DATABASE_URL) {
  const a = createDb(url, { max: 1 });
  const b = createDb(url, { max: 1 });
  try {
    const take = async (conn: Db) => (await conn.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${SESSION_PROBE_LOCK}) AS locked`)[0]?.locked === true;
    const first = await take(a);
    const second = await take(b);
    if (first) await a.$queryRaw`SELECT pg_advisory_unlock(${SESSION_PROBE_LOCK})`;
    if (second) await b.$queryRaw`SELECT pg_advisory_unlock(${SESSION_PROBE_LOCK})`;
    if (!first || second) {
      throw new Error(
        "TEST_DATABASE_URL does not provide separate PostgreSQL sessions: a lock held by one connection was not refused to another. " +
          "The worker-lock tests need a real PostgreSQL server; Prisma's local emulator (npx prisma dev) is not sufficient. " +
          "See test/integration/helpers.ts.",
      );
    }
  } finally {
    await Promise.allSettled([a.$disconnect(), b.$disconnect()]);
  }
}

export async function truncate(db: Db) {
  await db.$executeRawUnsafe(
    `TRUNCATE "AiLabel", "AiEvalCase", "AiEvalCohort", "AiDecision", "EmailedUnsubscribeReview", "Invitation", "OutreachControlChange", "EmailSuppression", "OutreachEvent", "Outreach", "ResearchFact", "ResearchSource", "CandidateResearch", "ProviderPlace", "ProviderImport", "CandidateEvidence", "CandidateNote", "CandidateSignal", "DiscoveryCandidate", "DiscoveryRun", "ProspectEvidence", "ProspectNote", "ProspectStatusChange", "ProspectSignal", "ProductEvent", "AnalyticsSession", "Prospect" CASCADE`,
  );
}

export const WEBSITE = "https://smithauto.example.com";

/** Explicit collision provenance for synthetic prospects used by unrelated workflow tests. */
export async function addFixtureCollisionEvidence(db: Db, p: { id: string }) {
  const prospect = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true } });
  if (!prospect.signals.some(s => s.key === "collision_repair_services" && s.value === "yes")) return;
  await addEvidence(db, p.id, { signalKey: "collision_repair_services", sourceUrl: prospect.website ?? prospect.emailSourceUrl ?? prospect.phoneSourceUrl ?? WEBSITE, excerpt: `${prospect.businessName}: We offer automotive collision repair.` });
}

/** A complete, valid create/edit form for a prospect that can reach ready_to_contact. */
export function readyForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    businessName: "Smith Auto",
    website: WEBSITE,
    city: "Springfield",
    state: "il",
    postalCode: "62701",
    phone: "(555) 010-0100",
    phoneSourceUrl: `${WEBSITE}/contact`,
    signal_independent_shop: "yes",
    signal_general_repair_services: "yes",
    signal_collision_repair_services: "yes",
    signal_multiple_bays_or_staff: "unknown",
    signal_digital_inspections: "yes",
    signal_no_online_booking: "no",
    ...overrides,
  };
}
