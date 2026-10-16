import type { CalibrationResult, CalibrationRow } from "./calibration.js";

/** A Markdown report of a calibration result. Pure: the same result always renders the same text. */
export function calibrationMarkdown(result: CalibrationResult, title = "Readiness calibration"): string {
  const s = result.summary;
  const n = (k: string, from: Record<string, number>) => from[k] ?? 0;
  const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const pct = (x: number) => (s.candidates ? `${Math.round((100 * x) / s.candidates)}%` : "0%");
  const flagged = result.rows.filter((r) => r.reviewFlags.length);
  const line = (r: CalibrationRow) =>
    `| ${cell(r.name)} | ${r.run ? `${r.run.version} ${r.run.outcome ?? r.run.status}` : "none"} | ${r.current.action}/${r.current.code} | ${r.projection.outcome.replaceAll("_", " ")} | ${r.projection.service.strength}${r.projection.service.counted.length ? ` (${r.projection.service.counted.join(", ")})` : ""} | ${r.projection.commercial.disposition}/${r.projection.commercial.confidence} | ${r.projection.identity.replaceAll("_", " ")} | ${r.projection.ownership.replaceAll("_", " ")} | ${cell([...r.relationships.blocking, ...r.relationships.multiLocationPeers.map((p) => `peer ${p}`), r.relationships.account !== "single_identity" ? `account ${r.relationships.account}` : ""].filter(Boolean).join("; ") || "none")} |`;
  return [
    `# ${title}`,
    "",
    `- Source: ${result.source}`,
    `- Rules: research ${result.researchVersion}, ${result.automationRules}, ${result.rules}; as of ${result.asOf}; read-only: ${result.readOnly}`,
    "",
    "## Data completeness",
    ...result.completeness.map((c) => `- ${c}`),
    ...(result.assumptions.length ? ["", "## Assumptions", ...result.assumptions.map((a) => `- ${a}`)] : []),
    "",
    "## Summary",
    "",
    `**${s.leaveReady} of ${s.candidates} (${pct(s.leaveReady)}) leave Ready when these rules are deployed.**`,
    "",
    "| Requested category | Now (current rules on stored data) | Projected after one re-read (historical quotes; not sufficient on their own) |",
    "|---|---|---|",
    `| Previously Ready and still eligible | ${n("still_ready", s.immediate)} | ${n("likely_ready_after_reread", s.projected)} likely |`,
    `| Likely restored by the re-read (service hold contradicted by a strict historical label) | — | ${n("likely_restored_by_reread", s.projected)} |`,
    `| Newly held for commercial review | ${n("commercial_review", s.immediate)} | ${n("likely_commercial_review", s.projected)} |`,
    `| Held for missing R16 evidence | ${n("evidence_hold", s.immediate)} | ${n("likely_service_evidence_hold", s.projected)} |`,
    `| Held for identity, ownership or account ambiguity | ${n("identity_ownership_account_hold", s.immediate) + n("duplicate_hold", s.immediate)} | ${n("likely_identity_hold", s.projected) + n("likely_ownership_hold", s.projected) + n("likely_account_or_duplicate_hold", s.projected)} |`,
    `| Requiring fresh research | ${n("fresh_research", s.immediate)} | — |`,
    `| Protected identities | ${n("protected", s.immediate)} | — |`,
    `| Confirmed negative evidence | — | ${n("confirmed_negative", s.projected)} |`,
    `| Potentially incorrect holds/exclusions (flagged for a person) | — | ${s.reviewFlags} |`,
    "",
    `Missing evidence only: ${s.negativeVersusMissing.missingEvidenceOnly}. Confirmed negative evidence: ${s.negativeVersusMissing.confirmedNegative}.`,
    "",
    "## Research workload and loops",
    "",
    `- Re-reads queued by the current rules: ${s.workload.immediateResearch} (${s.workload.adminBatchesOf25} human-authorized Admin batch${s.workload.adminBatchesOf25 === 1 ? "" : "es"} of 25).`,
    `- Simulated research loops after a verified or blocked re-read: ${s.workload.researchLoops}.`,
    `- Re-reads with no automatic retry if that one attempt fails transiently (retry budget counts historical runs): ${s.workload.noAutomaticRetryAfterOneFailure}.`,
    "",
    "## Candidates",
    "",
    "| Candidate | Latest verified run | Current decision | Projected | Service (historical quotes) | Commercial | Identity | Ownership | Relationships |",
    "|---|---|---|---|---|---|---|---|---|",
    ...result.rows.map(line),
    "",
    "## Flagged for a person (possible incorrect holds or exclusions)",
    "",
    ...(flagged.length ? flagged.flatMap((r) => [`- **${cell(r.name)}** (${r.id.slice(0, 8)})`, ...r.reviewFlags.map((f) => `  - ${f}`)]) : ["- None."]),
    "",
    "## What restores eligibility",
    "",
    ...result.rows.flatMap((r) => [`- **${cell(r.name)}** (${r.id.slice(0, 8)}): ${r.restore.join(" ") || "Nothing: it is Ready."}`, ...(r.projection.missingEvidence.length ? [`  - Missing under ${result.researchVersion}: ${r.projection.missingEvidence.join("; ")}`] : [])]),
    "",
  ].join("\n");
}
