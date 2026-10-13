import { AUTOMATION_BATCH_LIMIT, executable, type discoveryAutomationPreview } from "../discovery/automation.js";
import { appPage } from "./views.js";
import { esc, pageHead } from "./ui.js";

export function discoveryAutomationPage(preview: Awaited<ReturnType<typeof discoveryAutomationPreview>>, enabled: boolean, results?: readonly { id: string; applied: boolean; reason: string }[]) {
  const actionable = preview.rows.filter(r => executable(r.assessment));
  const batch = actionable.slice(0, AUTOMATION_BATCH_LIMIT);
  const result = results ? `<div class="callout"><b>${results.filter(r => r.applied).length} actions applied; ${results.filter(r => !r.applied).length} skipped.</b><ul>${results.map(r => `<li><a href="/admin/discovery/candidates/${esc(r.id)}">Candidate</a>: ${esc(r.reason)}</li>`).join("")}</ul></div>` : "";
  const sources = (r: typeof preview.rows[number]) => r.sources.filter(s => /^https?:\/\//.test(s.sourceUrl)).map(s => `<a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a>: ${esc(s.excerpt)}`).join("<br>");
  const rows = preview.rows.filter(r => r.assessment.action !== "handled").map(r => `<tr><td><a href="/admin/discovery/candidates/${esc(r.id)}">${esc(r.name)}</a></td><td>${esc(r.assessment.action.replaceAll("_", " "))}</td><td>${esc(r.assessment.reason)}${r.sources.length ? `<p class="small">${sources(r)}</p>` : ""}</td><td>${r.assessment.code === "missing_website" || r.assessment.code === "identity" ? `<a href="/admin/discovery/candidates/${esc(r.id)}/edit">Correct website / add evidence</a>` : ""}</td></tr>`).join("");
  const form = batch.length ? `<form method="post" action="/admin/discovery/automation">
    <input type="hidden" name="recovery" value="${preview.recovery ? "1" : "0"}">
    <p>Review the next ${batch.length} safe actions. Research outcomes will be evaluated after sources are read. Qualified candidates wait for your approval.</p>
    <ul>${batch.map(r => `<li>${esc(r.name)} — ${esc(r.assessment.reason)}<input type="hidden" name="candidate_${esc(r.id)}" value="${esc(r.token)}"></li>`).join("")}</ul>
    <button type="submit">Process these ${batch.length} Discovery actions</button></form>` : "<p>No safe actions are waiting. Resolve the evidence requests below.</p>";
  return appPage("Discovery automation", "discovery", `${pageHead({ title: "Discovery automation", lede: "Research and qualification stop at Ready to approve." })}
    <p><a href="/admin/discovery">Back to Discovery</a></p>${result}
    <div class="card"><p>Scheduled automation: <b>${enabled ? "enabled" : "off"}</b>. ${preview.counts.wait ?? 0} processing; ${preview.actionable} safe actions waiting; ${preview.counts.human ?? 0} need evidence or a decision; ${preview.counts.ready ?? 0} ready for approval; ${preview.counts.protected ?? 0} protected active records.</p>
    ${form}</div>
    <p><a href="/admin/discovery/automation${preview.recovery ? "" : "?recovery=1"}">${preview.recovery ? "Exclude recovery attempts" : "Preview one bounded recovery attempt for exhausted transient failures"}</a></p>
    <div class="scroll"><table class="tbl"><caption>Discovery actions and remaining evidence requests</caption><thead><tr><th>Business</th><th>Next action</th><th>Reason</th><th>Resolve</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}
