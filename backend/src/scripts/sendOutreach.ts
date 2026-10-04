/*
 * The outreach dispatcher: sends queued messages. Meant to run on a schedule.
 *
 *   npm run outreach:send                       (dry run: what would be sent, and what blocks sending)
 *   npm run outreach:send -- --apply [--limit 20]
 *
 * It sends nothing unless OUTREACH_SENDING_ENABLED=1, the global switch is on
 * (admin, Outreach), an email provider is configured, and the sender identity
 * is complete; each is re-checked before every message. The provider is
 * OUTREACH_PROVIDER (gmail); unset, it always stops at that check.
 */
import { parseArgs } from "node:util";
import { createContentLogger } from "../logging.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { dispatchQueued, stuckMessages } from "../outreach/dispatch.js";
import { senderFromConfig } from "../outreach/sender.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, limit: { type: "string", default: "20" } } });
const apply = values.apply === true;
const limit = Math.max(1, Number.parseInt(values.limit ?? "20", 10) || 20);

const config = loadConfig();
const db = createDb(config.databaseUrl);
const sender = senderFromConfig(config);
const content = createContentLogger();
const console = content.console;
try {
  const r = await dispatchQueued(db, { config, sender, limit, dryRun: !apply, observeMessage: content.remember });
  console.log(`${apply ? "APPLIED" : "DRY RUN (nothing is sent; pass --apply)"} with sender "${sender.name}".`);
  if (r.blockers.length) {
    console.log("Sending is blocked:");
    for (const b of r.blockers) console.log(`  - ${b}`);
  }
  if (r.stoppedBecause) console.log(`Stopped: ${r.stoppedBecause}`);
  if (r.wouldSend.length) console.log(`Would send: ${r.wouldSend.join(", ")}`);
  for (const s of r.sent) console.log(`Sent ${s.outreachId} (${s.providerMessageId})`);
  for (const f of r.failed) console.log(`Failed ${f.outreachId}: ${f.reason}`);
  for (const u of r.uncertain) console.log(`Outcome unknown ${u.outreachId}: ${u.reason}`);
  for (const u of r.unavailable) console.log(`Not sent, provider unavailable ${u.outreachId}: ${u.reason}`);
  for (const c of r.cancelled) console.log(`${apply ? "Cancelled" : "Would cancel"} ${c.outreachId}: ${c.reasons.join(" ")}`);
  const stuck = await stuckMessages(db);
  if (stuck.length) console.log(`Send outcome unknown, waiting for a person: ${stuck.map((s) => s.id).join(", ")}`);
} catch (err) {
  throw content.error(err);
} finally {
  await db.$disconnect();
}
