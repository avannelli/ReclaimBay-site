/*
 * Processes queued background discovery runs once, then exits. Suitable for
 * a scheduler. Also reclaims runs whose worker stopped responding.
 *
 *   npm run discovery:process
 */
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { discoveryProviders } from "../discovery/providers.js";
import { processQueuedRuns } from "../discovery/service.js";

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const { reclaimed, processed } = await processQueuedRuns(db, discoveryProviders(config, db));
  console.log(`Reclaimed ${reclaimed} stale run(s); processed ${processed.length} run(s).`);
  for (const r of processed) {
    console.log(`  ${r.id} ${r.status}: ${r.created} new, ${r.duplicates} skipped, ${r.flagged} flagged${r.error ? ` (${r.error})` : ""}`);
  }
} finally {
  await db.$disconnect();
}
