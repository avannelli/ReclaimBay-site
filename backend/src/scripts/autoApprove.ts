/*
 * Automatic approval over existing researched candidates: a background job,
 * never part of a web request. New research applies the same rule by itself
 * after each completed run; this is for candidates researched before, or to
 * see what the rule would do.
 *
 *   npm run discovery:auto-approve                          (dry run: nothing changes)
 *   npm run discovery:auto-approve -- --apply               (approves the eligible ones)
 *   npm run discovery:auto-approve -- --candidate <id> [--candidate <id> ...] [--apply]
 *
 * It only approves candidates the rule (discovery/autoApproval.ts) says are
 * clean, high-confidence leads; everything else is reported with the reason
 * it waits for a person. It never researches, never changes research,
 * categories, or scores, and never sends anything. Repeating it is safe.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { AUTO_APPROVAL_LABELS, AUTO_APPROVAL_RULES } from "../discovery/autoApproval.js";
import { runAutoApproval } from "../discovery/service.js";

const { values } = parseArgs({
  options: { apply: { type: "boolean", default: false }, candidate: { type: "string", multiple: true } },
});
const apply = values.apply === true;

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const results = await runAutoApproval(db, { apply, candidateIds: values.candidate });
  const approved = results.filter((r) => r.prospectId);
  const eligible = results.filter((r) => r.assessment.decision === "approve");
  console.log(`${apply ? "APPLIED" : "DRY RUN (nothing changes; pass --apply to approve)"}: ${results.length} candidate(s) checked against ${AUTO_APPROVAL_RULES}.`);
  console.log(apply ? `  ${approved.length} approved automatically.` : `  ${eligible.length} would be approved automatically.`);
  for (const decision of ["approve", "review", "blocked", "approved"] as const) {
    const list = results.filter((r) => (apply && r.prospectId ? "approved_now" : r.assessment.decision) === decision);
    if (!list.length) continue;
    console.log(`\n${AUTO_APPROVAL_LABELS[decision]} (${list.length}):`);
    for (const r of list) console.log(`  ${r.businessName}: ${r.assessment.reasons.join(" ")}${r.assessment.noted.length ? ` [noted: ${r.assessment.noted.join("; ")}]` : ""}`);
  }
  if (approved.length) {
    console.log(`\nApproved now (${approved.length}):`);
    for (const r of approved) console.log(`  ${r.businessName} -> prospect ${r.prospectId}`);
  }
} finally {
  await db.$disconnect();
}
