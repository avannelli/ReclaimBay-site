/*
 * The re-decision pass over existing researched candidates: a background
 * job, never part of a web request. New research applies the same rules by
 * itself after each completed run; this is for candidates researched before,
 * or to see what the rules would do, without researching again.
 *
 *   npm run discovery:auto-approve                          (dry run: nothing changes)
 *   npm run discovery:auto-approve -- --apply               (approves and rejects as the rules decide)
 *   npm run discovery:auto-approve -- --candidate <id> [--candidate <id> ...] [--apply]
 *
 * It approves only clean, high-confidence leads (approval@a1) and rejects
 * only candidates research showed with sources can never qualify
 * (rejection@r1), as discovery/autoApproval.ts defines; everything else is
 * reported with the reason it waits for a person. It never researches, never
 * changes research, categories, or scores, never overrides a person, and
 * never sends anything. Repeating it is safe.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { AUTO_APPROVAL_LABELS, AUTO_APPROVAL_RULES, AUTO_REJECTION_RULES } from "../discovery/autoApproval.js";
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
  const rejected = results.filter((r) => r.rejected);
  const eligible = results.filter((r) => r.assessment.decision === "approve");
  const rejectable = results.filter((r) => r.assessment.decision === "reject");
  console.log(
    `${apply ? "APPLIED" : "DRY RUN (nothing changes; pass --apply to approve and reject)"}: ${results.length} candidate(s) checked against ${AUTO_APPROVAL_RULES} and ${AUTO_REJECTION_RULES}.`,
  );
  console.log(
    apply
      ? `  ${approved.length} approved and ${rejected.length} rejected automatically.`
      : `  ${eligible.length} would be approved and ${rejectable.length} rejected automatically.`,
  );
  for (const decision of ["approve", "reject", "review", "blocked", "approved"] as const) {
    const list = results.filter((r) => (apply && (r.prospectId || r.rejected) ? "decided_now" : r.assessment.decision) === decision);
    if (!list.length) continue;
    console.log(`\n${AUTO_APPROVAL_LABELS[decision]} (${list.length}):`);
    for (const r of list) console.log(`  ${r.businessName}: ${r.assessment.reasons.join(" ")}${r.assessment.noted.length ? ` [noted: ${r.assessment.noted.join("; ")}]` : ""}`);
  }
  if (approved.length) {
    console.log(`\nApproved now (${approved.length}):`);
    for (const r of approved) console.log(`  ${r.businessName} -> prospect ${r.prospectId}`);
  }
  if (rejected.length) {
    console.log(`\nRejected now (${rejected.length}):`);
    for (const r of rejected) console.log(`  ${r.businessName}: ${r.assessment.reasons.join(" ")}`);
  }
} finally {
  await db.$disconnect();
}
