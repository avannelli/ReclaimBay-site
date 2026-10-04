/*
 * Automatic outreach preparation: drafts a first message for every eligible
 * prospect. Never sends.
 *
 *   npm run outreach:prepare                              (dry run: reports, stores nothing)
 *   npm run outreach:prepare -- --apply [--limit 50]      (stores drafts)
 *   npm run outreach:prepare -- --apply --queue           (stores and queues them)
 *
 * Safe to repeat and to schedule: a prospect with an open or sent message is
 * skipped.
 */
import { parseArgs } from "node:util";
import { safeConsole as console, sanitizeCliError } from "../logging.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { prepareEligibleOutreach } from "../outreach/prepare.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    queue: { type: "boolean", default: false },
    limit: { type: "string", default: "50" },
  },
});
const apply = values.apply === true;
const limit = Math.max(1, Number.parseInt(values.limit ?? "50", 10) || 50);

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const r = await prepareEligibleOutreach(db, {
    draft: { siteUrl: config.publicSiteUrl, sender: config.outreachSender },
    compliance: config,
    apply,
    queue: apply && values.queue === true,
    limit,
  });
  console.log(`${apply ? "APPLIED" : "DRY RUN (nothing is stored; pass --apply)"}: ${r.checked} prospect(s) checked. Nothing is sent.`);
  console.log(`  ${apply ? "Drafted" : "Would draft"} (${r.drafted.length}):`);
  for (const d of r.drafted) console.log(`    ${d.businessName ?? d.prospectId}${d.outreachId ? ` -> ${d.outreachId}` : ""}`);
  if (r.queued.length) console.log(`  Queued: ${r.queued.length}`);
  for (const n of r.notQueued) console.log(`  Not queued ${n.outreachId}: ${n.reasons.join(" ")}`);
  console.log(`  Not eligible (${r.skipped.length}):`);
  for (const s of r.skipped) console.log(`    ${s.businessName ?? s.prospectId}: ${s.reasons.join(" ")}`);
} catch (err) {
  throw sanitizeCliError(err);
} finally {
  await db.$disconnect();
}
