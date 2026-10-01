/*
 * Automated research from the command line: a background job, never part
 * of a web request. Queues research and processes the queue, one website
 * at a time.
 *
 *   npm run discovery:research -- --candidate <id> [--candidate <id> ...]
 *   npm run discovery:research -- --limit 5 [--tier core] [--city Oxnard] [--status discovered]
 *   npm run discovery:research -- --process        (only process what is already queued)
 *
 * --limit picks candidates that have never been researched, newest first,
 * and is capped at 25 so a run stays a small, observable batch.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { listCandidates } from "../discovery/service.js";
import { enqueueResearch, processQueuedResearch } from "../research/service.js";

const MAX_CLI = 25;

const { values } = parseArgs({
  options: {
    candidate: { type: "string", multiple: true },
    limit: { type: "string" },
    tier: { type: "string" },
    city: { type: "string" },
    status: { type: "string" },
    process: { type: "boolean", default: false },
  },
});

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  let ids: string[] = values.candidate ?? [];
  if (!ids.length && values.limit) {
    const limit = Math.min(MAX_CLI, Math.max(1, Number(values.limit) || 1));
    const list = await listCandidates(db, { tier: values.tier, city: values.city, status: values.status, sort: "discovered" });
    ids = list.rows
      .filter((r) => !r.candidate.research.length && !["approved", "rejected", "duplicate"].includes(r.candidate.status))
      .slice(0, limit)
      .map((r) => r.candidate.id);
  }
  if (ids.length) {
    const q = await enqueueResearch(db, ids, "cli", MAX_CLI);
    console.log(`Queued ${q.queued.length} candidate(s).${q.skipped.length ? ` Skipped: ${q.skipped.map((s) => `${s.candidateId} (${s.reason})`).join(", ")}` : ""}`);
  } else if (!values.process) {
    console.error("Nothing to do: pass --candidate <id>, --limit <n>, or --process.");
    process.exitCode = 1;
  }
  const { reclaimed, processed } = await processQueuedResearch(db, { limit: MAX_CLI });
  if (reclaimed) console.log(`Marked ${reclaimed} interrupted run(s) as failed.`);
  for (const r of processed) {
    if (!r) continue;
    console.log(`  ${r.candidateId} ${r.status}: ${r.outcome ?? "-"} (${r.pagesFetched} page(s))${r.error ? ` ${r.error}` : ""}`);
  }
} finally {
  await db.$disconnect();
}
