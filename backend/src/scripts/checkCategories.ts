/*
 * Category check backfill: runs the cheap NAME-stage category check over
 * existing candidates. A background job, never part of a web request.
 *
 *   npm run discovery:check-categories              (dry run: shows what would change)
 *   npm run discovery:check-categories -- --apply   (writes the changes)
 *
 * It only ever writes the category fields (backfillCategoryCheck in
 * discovery/service.ts). It never changes a status, research history,
 * signals, evidence, or scores, never creates a prospect, and never touches
 * a person's decision, a verdict from the business's own website, or an
 * approved candidate. Unchanged records are not rewritten, so a second run
 * changes nothing.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { CATEGORY_VERDICTS } from "@avannelli/aos/categories";
import { backfillCategoryCheck } from "../discovery/service.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
const apply = values.apply === true;

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const r = await backfillCategoryCheck(db, { apply });
  console.log(`${apply ? "APPLIED" : "DRY RUN (nothing written; pass --apply to write)"}: ${r.checked} candidate(s) checked by name.`);
  console.log(`  ${r.changes.length} ${apply ? "updated" : "would change"}; unchanged records are not rewritten.`);
  console.log(`  Left alone: ${r.skipped.manual} set by a person, ${r.skipped.website} decided by the business's website, ${r.skipped.approved} approved.`);
  console.log(`  Verdicts: ${CATEGORY_VERDICTS.map((v) => `${v} ${r.verdicts[v]}`).join(", ")}.`);
  for (const verdict of ["wrong_category", "unclear"] as const) {
    const list = r.changes.filter((x) => x.to === verdict);
    if (!list.length) continue;
    console.log(`\n${verdict} (${list.length}):`);
    for (const x of list) console.log(`  ${x.name}${x.city ? ` (${x.city})` : ""}: ${x.reason}${x.from ? ` [was ${x.from}]` : ""}`);
  }
  const back = r.changes.filter((x) => x.to === "in_target" && x.from && x.from !== "in_target");
  if (back.length) {
    console.log(`\nin_target from another verdict (${back.length}):`);
    for (const x of back) console.log(`  ${x.name}: ${x.reason} [was ${x.from}]`);
  }
} finally {
  await db.$disconnect();
}
