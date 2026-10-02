/*
 * Reads the Gmail outreach mailbox and records bounces, replies, and emailed
 * unsubscribes. Read-only on Gmail: it never sends, moves, or deletes mail.
 * Meant to run on a schedule, alongside outreach:send.
 *
 *   npm run outreach:inbox                    (dry run: what it would record)
 *   npm run outreach:inbox -- --apply [--days 7]
 *
 * Needs OUTREACH_PROVIDER=gmail and the Gmail configuration (see OUTREACH.md).
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { GmailClient, gmailConfigFromEnv } from "../outreach/gmail.js";
import { pollGmailInbox } from "../outreach/gmailInbox.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, days: { type: "string", default: "7" } } });
if (process.env.OUTREACH_PROVIDER?.trim() !== "gmail") {
  console.error("OUTREACH_PROVIDER isn't gmail: there is no mailbox to read.");
  process.exit(1);
}
const gmail = gmailConfigFromEnv(process.env);
if ("problem" in gmail) {
  console.error(gmail.problem);
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const apply = values.apply === true;
  const r = await pollGmailInbox(db, new GmailClient(gmail), { apply, lookbackDays: Math.max(1, Number.parseInt(values.days ?? "7", 10) || 7) });
  console.log(`${apply ? "APPLIED" : "DRY RUN (nothing is recorded; pass --apply)"}: ${r.checked} message(s) read from ${gmail.mailbox}.`);
  for (const i of r.items) {
    if (i.kind === "own") continue;
    console.log(`  ${i.kind.padEnd(14)} ${i.result.padEnd(14)} ${i.from} "${i.subject}"${i.outreachId ? ` -> ${i.outreachId}` : ""}`);
  }
} finally {
  await db.$disconnect();
}
