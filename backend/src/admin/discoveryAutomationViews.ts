import { AUTOMATION_BATCH_LIMIT, executable, protectionSummary, type discoveryAutomationPreview } from "../discovery/automation.js";
import { appPage } from "./views.js";
import { esc, pageHead } from "./ui.js";

export function discoveryAutomationPage(preview: Awaited<ReturnType<typeof discoveryAutomationPreview>>, enabled: boolean, results?: readonly { id: string; applied: boolean; reason: string }[]) {
  const actionable = preview.rows.filter(r => executable(r.assessment));
  const batch = actionable.slice(0, AUTOMATION_BATCH_LIMIT);
  const shield = protectionSummary(preview.rows);
  const protectedMark = (r: typeof preview.rows[number]) => r.protection.protected ? " (protected identity: a person decides)" : "";
  const result = results ? `<div class="callout"><b>${results.filter(r => r.applied).length} actions applied; ${results.filter(r => !r.applied).length} skipped.</b><ul>${results.map(r => `<li><a href="/admin/discovery/candidates/${esc(r.id)}">Candidate</a>: ${esc(r.reason)}</li>`).join("")}</ul></div>` : "";
  const sources = (r: typeof preview.rows[number]) => r.sources.filter(s => /^https?:\/\//.test(s.sourceUrl)).map(s => `<a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a>: ${esc(s.excerpt)}`).join("<br>");
  const commercial = (r: typeof preview.rows[number]) => {
    const a = r.assessment.acquisition;
    return a ? `<p class="small">Technical: ${esc(a.technicalQualification)}. Commercial: ${esc(a.commercial.disposition)} (${esc(a.commercial.confidence)} confidence). Account: ${esc(a.account?.code ?? "unassessed")}.</p>
      <ul>${a.commercial.findings.map(f => `<li>${esc(f.code)}: ${esc(f.reason)}${f.evidence.map(e => /^https?:\/\//.test(e.sourceUrl) ? ` <a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener noreferrer">Evidence</a>` : "").join("")}</li>`).join("")}</ul>` : "";
  };
  const rows = preview.rows.filter(r => r.assessment.action !== "handled").map(r => `<tr><td><a href="/admin/discovery/candidates/${esc(r.id)}">${esc(r.name)}</a></td><td>${esc(r.assessment.action.replaceAll("_", " ") + protectedMark(r))}</td><td>${esc(r.assessment.reason)}${commercial(r)}${r.sources.length ? `<p class="small">${sources(r)}</p>` : ""}</td><td>${r.assessment.code === "missing_website" || r.assessment.code === "identity" ? `<a href="/admin/discovery/candidates/${esc(r.id)}/edit">Correct website / add evidence</a>` : r.assessment.action === "link_duplicate" ? `<a href="/admin/discovery/candidates/${esc(r.id)}">Review duplicate</a>` : ""}</td></tr>`).join("");
  const form = batch.length ? `<form method="post" action="/admin/discovery/automation">
    <input type="hidden" name="recovery" value="${preview.recovery ? "1" : "0"}">
    <p>Review the next ${batch.length} safe actions. Research outcomes will be evaluated after sources are read. Qualified candidates wait for your approval.</p>
    <ul>${batch.map(r => `<li>${esc(r.name + protectedMark(r))} — ${esc(r.assessment.reason)}<input type="hidden" name="candidate_${esc(r.id)}" value="${esc(r.token)}"></li>`).join("")}</ul>
    <button type="submit">Process these ${batch.length} Discovery actions</button></form>` : "<p>No safe actions are waiting. Resolve the evidence requests below.</p>";
  return appPage("Discovery automation", "discovery", `${pageHead({ title: "Discovery automation", lede: "Research and qualification stop at Ready to approve." })}
    <p><a href="/admin/discovery">Back to Discovery</a></p>${result}
    <div class="card"><p>Scheduled automation: <b>${enabled ? "enabled" : "off"}</b>. ${preview.counts.wait ?? 0} processing; ${preview.actionable} safe actions waiting; ${preview.counts.human ?? 0} need evidence or a decision; ${preview.counts.ready ?? 0} ready for approval.</p>
    <p>Protected identities (linked to a prospect, outreach message, suppression or opt-out): <b>${shield.total}</b>, ${shield.outreachConnected} connected to outreach. Of these, ${shield.handled} already handled (approved, rejected or duplicate; no automation action); ${shield.awaitingReview} active and held for review in their existing record; ${shield.duplicateLinks} confident duplicate ${shield.duplicateLinks === 1 ? "match" : "matches"} of an existing prospect, waiting for a person to mark the duplicate on the candidate page${shield.processing ? `; ${shield.processing} with research in progress` : ""}. Automation never processes a protected identity.</p>
    ${form}</div>
    <p><a href="/admin/discovery/automation${preview.recovery ? "" : "?recovery=1"}">${preview.recovery ? "Exclude recovery attempts" : "Preview one bounded recovery attempt for exhausted transient failures"}</a></p>
    <div class="scroll"><table class="tbl"><caption>Discovery actions and remaining evidence requests</caption><thead><tr><th>Business</th><th>Next action</th><th>Reason</th><th>Resolve</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}
