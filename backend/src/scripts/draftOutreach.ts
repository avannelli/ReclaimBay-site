/*
 * Prepares outreach drafts for named prospects. Never sends anything: there
 * is no sender in this version.
 *
 *   npm run outreach:draft -- --prospect <id> [--prospect <id> ...]           (dry run: shows the draft, stores nothing)
 *   npm run outreach:draft -- --prospect <id> [--prospect <id> ...] --apply   (stores the draft)
 *
 * Prospects must be named one by one; there is no "all" mode. Repeating it
 * is safe: a prospect with an open draft keeps that draft.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createOutreachDraft, previewOutreachDraft } from "../outreach/service.js";

const { values } = parseArgs({
  options: { apply: { type: "boolean", default: false }, prospect: { type: "string", multiple: true } },
});
const ids = values.prospect ?? [];
if (!ids.length) {
  console.error("Name at least one prospect: --prospect <id>");
  process.exit(1);
}
const apply = values.apply === true;

const config = loadConfig();
const db = createDb(config.databaseUrl);
const opts = { siteUrl: config.publicSiteUrl, sender: config.outreachSender };
try {
  console.log(`${apply ? "APPLIED" : "DRY RUN (nothing is stored; pass --apply to store the draft)"}: ${ids.length} prospect(s). Nothing is sent.`);
  for (const id of ids) {
    const preview = await previewOutreachDraft(db, id, opts);
    console.log(`\n${preview.businessName ?? id} (${id})`);
    if (preview.open) {
      console.log(`  Already has an open ${preview.open.status}: ${preview.open.id} "${preview.open.subject}". Nothing new is made.`);
      continue;
    }
    if (preview.errors.length || !preview.message) {
      console.log(`  Not eligible:\n${preview.errors.map((e) => `    - ${e}`).join("\n")}`);
      continue;
    }
    const m = preview.message;
    console.log(`  Template: ${m.template}   Campaign: ${m.campaign}`);
    console.log(`  Subject: ${m.subject}`);
    console.log(`  Body:\n${m.body.replace(/^/gm, "    | ")}`);
    console.log(`  Evidence (${m.evidence.length}):`);
    for (const f of m.evidence) console.log(`    - ${f.statement}${f.sourceUrl ? ` [${f.sourceUrl}]` : " [stored field]"}`);
    if (apply) {
      const { outreach, created } = await createOutreachDraft(db, id, opts);
      console.log(created ? `  Stored draft ${outreach.id}.` : `  An open message appeared meanwhile; kept ${outreach.id}.`);
    }
  }
} finally {
  await db.$disconnect();
}
