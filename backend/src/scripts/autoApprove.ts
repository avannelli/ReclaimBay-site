/*
 * The re-decision pass over existing researched candidates: a background
 * job, never part of a web request. New research applies the same rules by
 * itself after each completed run; this is for candidates researched before,
 * or to see what the rules would do, without researching again.
 *
 *   npm run discovery:auto-approve                          (dry run: nothing changes)
 *   npm run discovery:auto-approve -- --apply               (applies guarded Discovery decisions)
 *   npm run discovery:auto-approve -- --candidate <id> [--candidate <id> ...] [--apply]
 *
 * Compatibility command: discovery@d1 may add source-linked qualification,
 * audited category corrections, canonical duplicate annotations or sourced
 * rejection. It creates no prospects and queues no research or outreach.
 * Use discovery:automation for a full preview and fingerprinted selection.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { AUTO_APPROVAL_LABELS } from "../discovery/autoApproval.js";
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
  const rejectable = results.filter((r) => r.assessment.decision === "reject");
  console.log(
    `${apply ? "APPLIED" : "DRY RUN (nothing changes)"}: ${results.length} candidate(s) checked by Discovery automation. Prospect creation requires human approval.`,
  );
  console.log(
    apply
      ? `  ${rejected.length} rejected; no prospects created. See discovery:automation for full action previews.`
      : `  ${rejectable.length} would be rejected; no prospects would be created. See discovery:automation for qualification and research actions.`,
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
