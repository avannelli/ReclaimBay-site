/*
 * Integration test setup. Tests run against TEST_DATABASE_URL, which is
 * migrated and then TRUNCATED, so it must be a disposable local database:
 *
 *   npx prisma dev                      # prints a postgres:// URL
 *   TEST_DATABASE_URL=<that url> npm run test:integration
 *
 * Without TEST_DATABASE_URL every integration test is skipped.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "../../src/db.js";

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

export async function truncate(db: Db) {
  await db.$executeRawUnsafe(
    `TRUNCATE "OutreachControlChange", "EmailSuppression", "OutreachEvent", "Outreach", "ResearchFact", "ResearchSource", "CandidateResearch", "ProviderPlace", "ProviderImport", "CandidateEvidence", "CandidateNote", "CandidateSignal", "DiscoveryCandidate", "DiscoveryRun", "ProspectEvidence", "ProspectNote", "ProspectStatusChange", "ProspectSignal", "ProductEvent", "AnalyticsSession", "Prospect" CASCADE`,
  );
}

export const WEBSITE = "https://smithauto.example.com";

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
    signal_multiple_bays_or_staff: "unknown",
    signal_digital_inspections: "yes",
    signal_no_online_booking: "no",
    ...overrides,
  };
}
