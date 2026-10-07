/*
 * The AI shadow job's session lock (pg_try_advisory_lock): one shadow run at
 * a time. The same pattern as the research worker's lock, kept here so the
 * AI module needn't import the research service (and, through it, anything
 * that can change a candidate or prospect).
 */
import { createDb } from "../db.js";

export const AI_SHADOW_LOCK = 51_120_002;

/** Null when another shadow run holds the lock. `release` unlocks and closes the connection. */
export async function acquireShadowLock(databaseUrl: string): Promise<{ release: () => Promise<void> } | null> {
  // One connection, never closed for being idle: closing it would drop the lock.
  const conn = createDb(databaseUrl, { max: 1, idleTimeoutMillis: 0 });
  try {
    const [row] = await conn.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${AI_SHADOW_LOCK}) AS locked`;
    if (!row?.locked) {
      await conn.$disconnect();
      return null;
    }
  } catch (err) {
    await conn.$disconnect();
    throw err;
  }
  return {
    release: async () => {
      try {
        await conn.$queryRaw`SELECT pg_advisory_unlock(${AI_SHADOW_LOCK})`;
      } finally {
        await conn.$disconnect();
      }
    },
  };
}
