/*
 * Reads the Gmail outreach mailbox and records bounces, replies, and emailed
 * unsubscribes. Read-only on Gmail: it never sends, moves, or deletes mail.
 * Meant to run on a schedule, alongside outreach:send.
 *
 *   npm run outreach:inbox                    (dry run: what it would record)
 *   npm run outreach:inbox -- --apply [--days 7]
 *
 * Needs OUTREACH_PROVIDER=gmail and an authorized mailbox (see OUTREACH.md).
 * Fails closed if the authorization was revoked: nothing is recorded.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { GmailClient } from "../outreach/gmail.js";
import { gmailCredentialsFromConfig } from "../outreach/gmailAuth.js";
import { pollGmailInbox } from "../outreach/gmailInbox.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, days: { type: "string", default: "7" } } });
const config = loadConfig();
if (config.outreachProvider !== "gmail") {
  console.error("OUTREACH_PROVIDER isn't gmail: there is no mailbox to read.");
  process.exit(1);
}
// The same credential layer the sender uses.
const gmail = gmailCredentialsFromConfig(config);
if ("problem" in gmail) {
  console.error(gmail.problem);
  process.exit(1);
}

const db = createDb(config.databaseUrl);
try {
  const apply = values.apply === true;
  const r = await pollGmailInbox(db, new GmailClient(gmail), { apply, lookbackDays: Math.max(1, Number.parseInt(values.days ?? "7", 10) || 7) });
  console.log(`${apply ? "APPLIED" : "DRY RUN (nothing is recorded; pass --apply)"}: ${r.checked} message(s) read from ${gmail.account}'s mailbox.`);
  for (const i of r.items) {
    if (i.kind === "own") continue;
    console.log(`  ${i.kind.padEnd(14)} ${i.result.padEnd(14)} ${i.from} "${i.subject}"${i.outreachId ? ` -> ${i.outreachId}` : ""}`);
  }
} finally {
  await db.$disconnect();
}
