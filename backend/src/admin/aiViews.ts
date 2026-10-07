/*
 * Read-only views of the AI shadow layer. Nothing here offers an action: a
 * shadow verdict is shown for evaluation, never as the candidate's decision.
 */
import { DECISION_LABELS, type CollisionDecision } from "../ai/collisionFitJudge.js";
import type { AiDecisionRow, AiEvaluation } from "../ai/records.js";
import { COLLISION_FIT_KIND } from "../ai/collisionFitJudge.js";
import { LABELS, MIN_SAMPLE, PREDICTIONS, type ClassifierMetrics, type CohortEvaluation, type Metrics, type Prediction, type Rate } from "../ai/evaluation.js";
import { HUMAN_LABELS, STRATUM_LABELS, type HumanLabel, type Stratum } from "../ai/goldSet.js";
import { appPage } from "./views.js";
import { MIN_COMPARE, crumbs, emptyState, esc, extLink, fmtDate, pageHead } from "./ui.js";

const decisionLabel = (d: string | null) => (d ? DECISION_LABELS[d as CollisionDecision] ?? d : "No decision");
const pct = (c: number | null) => (c === null ? "—" : `${Math.round(c * 100)}%`);
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const SHADOW_BANNER = '<p class="callout warn" style="margin-bottom:14px"><b>SHADOW ONLY.</b> No candidate state is affected: no candidate, prospect, qualification, or outreach record reads AI decisions or labels.</p>';
const SHADOW_TAG = '<span class="tag" style="border-color:var(--amber);color:var(--warn)">AI SHADOW · not a decision</span>';
const STATUS_TEXT: Record<string, string> = { valid: "PASS", invalid: "FAIL (unusable)", error: "ERROR (no usable answer)" };
const AGREEMENT_TEXT: Record<string, string> = { agree: "agrees", disagree: "disagrees", not_comparable: "not comparable" };

function decisionCard(r: AiDecisionRow): string {
  const evidence = Array.isArray(r.evidence) ? (r.evidence as { sourceUrl?: unknown; quote?: unknown }[]).filter((e) => typeof e?.quote === "string" && typeof e?.sourceUrl === "string") : [];
  const list = (title: string, items: string[]) => (items.length ? `<p class="small" style="margin:8px 0 2px"><b>${title}</b></p><ul class="small" style="margin:0">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  return `<div class="card" style="border-left:4px dashed var(--amber)">
<p style="margin:0 0 6px">${SHADOW_TAG} <span class="small muted">Recorded ${fmtDate(r.createdAt)}</span></p>
<dl class="kv">
  <dt>AI decision</dt><dd>${esc(decisionLabel(r.decision))}</dd>
  <dt>Confidence</dt><dd>${pct(r.confidence)}</dd>
  <dt>Validation</dt><dd>${esc(STATUS_TEXT[r.status] ?? r.status)}</dd>
  <dt>Mode</dt><dd>${esc(r.mode.toUpperCase())}</dd>
  <dt>Model</dt><dd><code>${esc(r.model)}</code></dd>
  <dt>Prompt</dt><dd><code>${esc(r.promptVersion)}</code></dd>
  <dt>Rules on the same pages</dt><dd>${esc(r.ruleDecision ?? "—")}${r.agreement ? ` <span class="small muted">(AI ${esc(AGREEMENT_TEXT[r.agreement] ?? r.agreement)})</span>` : ""}</dd>
  ${r.nextAction ? `<dt>AI suggests</dt><dd>${esc(r.nextAction.replace(/_/g, " "))} <span class="small muted">(a suggestion only; nothing is done)</span></dd>` : ""}
</dl>
${evidence.length ? `<p class="small" style="margin:8px 0 2px"><b>Evidence</b></p>${evidence.map((e) => `<blockquote>${esc(e.quote)}</blockquote><div class="small muted">Source: ${extLink(String(e.sourceUrl))}</div>`).join("")}` : ""}
${list("Reasons", strings(r.reasons))}
${list("Concerns", strings(r.concerns))}
${list("Why it failed validation", strings(r.validationErrors))}
${r.error ? `<p class="small" style="margin-top:8px"><b>Error:</b> ${esc(r.error)}</p>` : ""}
</div>`;
}

/** Shown wherever AI output would appear for a candidate still waiting for its blind gold-set label. */
export const BLINDED_TEXT = "Hidden until this candidate's blind gold-set label is saved, so the AI's answer can't influence it.";

/** The candidate page's AI shadow section: the newest decisions, read-only; hidden while a blind label is pending. */
export function aiShadowSection(rows: readonly AiDecisionRow[] | "blinded"): string {
  if (rows === "blinded") return `<p class="callout warn" style="margin:0"><b>AI shadow verdict hidden.</b> ${esc(BLINDED_TEXT)}</p>`;
  const intro = `<p class="callout warn" style="margin:0 0 10px"><b>AI shadow verdict: for evaluation only.</b> It is not this candidate's decision and changes nothing. Qualification, approval, and everything after them are decided by the rules and by people, as above.</p>`;
  if (!rows.length) return `${intro}<div class="card">${emptyState("No AI shadow decision recorded.", "The AI shadow job judges candidates the rules leave for a person to verify, when it is switched on.")}</div>`;
  return `${intro}${rows.map(decisionCard).join("")}<p class="small"><a href="/admin/ai">All AI shadow decisions &rarr;</a></p>`;
}

export const aiShadowSummary = (rows: readonly AiDecisionRow[] | "blinded") => {
  if (rows === "blinded") return "Hidden: blind label pending";
  const r = rows[0];
  return r ? `Shadow: ${esc(decisionLabel(r.decision))} · ${esc(STATUS_TEXT[r.status] ?? r.status)}` : "None recorded";
};

/** /admin/ai: the gold sets, and what the shadow layer recorded. AI output for a candidate awaiting its blind label is hidden. */
export function aiEvaluationPage(e: AiEvaluation, opts: { blinded?: ReadonlySet<string>; gold?: string; notice?: string } = {}): string {
  const blinded = opts.blinded ?? new Set<string>();
  const kv = (rows: [string, string][]) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const counts = (m: Record<string, number>, label: (k: string) => string) =>
    Object.keys(m).length ? kv(Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => [label(k), String(n)])) : '<p class="muted small">None yet.</p>';
  const unavailable = (why: string) => `<span class="muted">Unavailable: ${esc(why)}</span>`;
  const h = e.human;
  const humanBlock = h
    ? `${kv([
        ["Compared with a person's decision", String(h.compared)],
        ["Agree", String(h.agree)],
        ["Disagree", String(h.disagree)],
        ["Abstained (insufficient evidence)", String(h.abstained)],
        ["Agreement rate", h.compared - h.abstained >= MIN_COMPARE ? pct(h.agree / (h.compared - h.abstained)) : unavailable(`fewer than ${MIN_COMPARE} non-abstaining comparisons`)],
      ])}${h.disagreements.some((d) => !blinded.has(d.subjectId)) ? `<p class="small" style="margin-top:8px"><b>Disagreements to inspect</b></p><ul class="small">${h.disagreements.filter((d) => !blinded.has(d.subjectId)).map((d) => `<li><a href="/admin/discovery/candidates/${esc(d.subjectId)}#ai">${esc(d.subjectId.slice(0, 8))}</a>: AI ${esc(decisionLabel(d.decision))}, person ${esc(d.human === "collision_yes" ? "collision Yes" : "collision No")}</li>`).join("")}</ul>` : ""}`
    : `<p>${unavailable("no AI decision can be compared with a person's recorded collision/body decision yet. Accuracy is never inferred from the rules or from the AI's own confidence.")}</p>`;
  const body = `${pageHead({ title: "AI shadow", lede: "Collision/body fit decisions recorded by the AI shadow layer, and blind human gold sets to evaluate them. Nothing here changes a candidate, a prospect, or outreach." })}
${SHADOW_BANNER}${opts.notice ? `<p class="notice" role="status">${esc(opts.notice)}</p>` : ""}
${opts.gold ?? ""}
<h2 class="card-h" style="margin-top:18px">Recorded shadow decisions</h2>
<p class="small muted">All recorded decisions. The comparison with people below uses their existing, non-blind collision/body decisions; gold-set evaluation is per cohort above.${e.truncated ? ` Figures cover the newest ${e.rows} records.` : ""}</p>
${e.rows === 0 ? `<section class="card">${emptyState("No AI shadow decisions recorded.", "The shadow job runs only when it is armed (AI_SHADOW_ENABLED=1), configured, and given a daily budget.")}</section>` : `
<div class="grid-2">
<section class="card"><h2 class="card-h">Records</h2>${kv([
    ["Recorded decisions", String(e.rows)],
    ["Provider calls", String(e.calls)],
    ["Unchanged inputs reused (no call)", String(e.reused)],
    ["Candidates judged (latest valid)", String(e.judged)],
    ["Average confidence (valid)", e.averageConfidence === null ? unavailable("no valid decisions") : pct(e.averageConfidence)],
  ])}<h3 class="card-h" style="margin-top:12px">By validation</h3>${counts(e.byStatus, (k) => STATUS_TEXT[k] ?? k)}</section>
<section class="card"><h2 class="card-h">Decisions (latest valid per candidate)</h2>${counts(e.byDecision, decisionLabel)}
<h3 class="card-h" style="margin-top:12px">Against the rules on the same pages</h3>${kv([["Agree", String(e.rule.agree)], ["Disagree", String(e.rule.disagree)], ["Not comparable", String(e.rule.notComparable)]])}
<p class="small muted">The rules are the existing collision classifier. Agreement with them is not accuracy.</p></section>
</div>
<section class="card"><h2 class="card-h">Against people's existing decisions (not blind)</h2>${humanBlock}</section>
<div class="grid-2">
<section class="card"><h2 class="card-h">Validation failures</h2>${e.topValidationErrors.length ? `<ul class="small">${e.topValidationErrors.map((x) => `<li>${esc(x.error)} <span class="muted">(${x.count})</span></li>`).join("")}</ul>` : '<p class="muted small">None.</p>'}</section>
<section class="card"><h2 class="card-h">Cost and latency</h2>${kv([
    ["Estimated cost, all recorded", usd(e.costMicroUsd)],
    ["Estimated cost, last 24 hours", usd(e.costLast24hMicroUsd)],
    ["Average latency per call", e.averageLatencyMs === null ? unavailable("no provider calls") : `${(e.averageLatencyMs / 1000).toFixed(1)}s`],
  ])}<p class="small muted">Estimated from published per-token prices; failed calls are charged their worst case.</p></section>
</div>
<section class="card"><h2 class="card-h">Models and prompt versions</h2>${kv(e.versions.map((v) => [`${v.model} · ${v.promptVersion}`, String(v.count)]))}</section>
<section class="card"><h2 class="card-h">Recent records</h2><div class="scroll"><table class="tbl"><caption class="sr-only">Recent AI shadow records</caption><thead><tr><th scope="col">Candidate</th><th scope="col">Validation</th><th scope="col">AI decision</th><th scope="col">Confidence</th><th scope="col">Vs rules</th><th scope="col">Version</th><th scope="col">Recorded</th></tr></thead><tbody>${e.recent
    .map((r) =>
      blinded.has(r.subjectId)
        ? `<tr><td>${esc(r.subjectId.slice(0, 8))}</td><td colspan="5" class="muted">Hidden: blind gold-set label pending</td><td>${fmtDate(r.createdAt)}</td></tr>`
        : `<tr><td><a href="/admin/discovery/candidates/${esc(r.subjectId)}#ai">${esc(r.subjectId.slice(0, 8))}</a></td><td>${esc(STATUS_TEXT[r.status] ?? r.status)}</td><td>${esc(decisionLabel(r.decision))}</td><td>${pct(r.confidence)}</td><td>${esc(r.agreement ? AGREEMENT_TEXT[r.agreement] ?? r.agreement : "—")}</td><td><code>${esc(r.model)}</code> <code>${esc(r.promptVersion)}</code></td><td>${fmtDate(r.createdAt)}</td></tr>`,
    )
    .join("")}</tbody></table></div></section>`}`;
  return appPage("AI shadow · ReclaimBay admin", "discovery", body);
}

// ---------- gold-set evaluation (only labeled cases' AI output is ever shown) ----------

const fmtRate = (r: Rate) => (r.rate === null ? `<span class="muted">Unavailable (${r.num} of ${r.den}; needs ${MIN_SAMPLE})</span>` : `${pct(r.rate)} <span class="small muted">(${r.num} of ${r.den})</span>`);
const NOT_ENOUGH = '<span class="muted">Not enough labeled cases yet.</span>';
const LABEL_SHORT: Record<HumanLabel, string> = { collision_primary: "Collision", specialty_body: "Specialty", dealership_body_dept: "Dealership", not_collision: "Not collision", insufficient_evidence: "Can't tell / abstain" };

function versionLine(ev: CohortEvaluation): string {
  const v = ev.version;
  const others = ev.versions.filter((x) => !v || x.model !== v.model || x.promptVersion !== v.promptVersion);
  return `<dl class="kv">
  <dt>Decision kind</dt><dd><code>${esc(COLLISION_FIT_KIND)}</code></dd>
  <dt>AI model</dt><dd>${v ? `<code>${esc(v.model)}</code>` : '<span class="muted">No AI decisions for this gold set yet</span>'}</dd>
  <dt>AI prompt version</dt><dd>${v ? `<code>${esc(v.promptVersion)}</code>` : "—"}</dd>
  <dt>Gold set</dt><dd>${esc(ev.cohort.name)} · <code>${esc(ev.cohort.samplingVersion)}</code> · seed <code>${esc(ev.cohort.seed)}</code></dd>
  <dt>Gold label</dt><dd>The blind label (revision 1). Adjudications are counted separately.</dd>
</dl>${others.length ? `<p class="small">Other versions with decisions in this gold set (never mixed): ${others.map((o) => `<a href="/admin/ai/cohorts/${esc(ev.cohort.id)}?model=${encodeURIComponent(o.model)}&amp;prompt=${encodeURIComponent(o.promptVersion)}"><code>${esc(o.model)}</code> <code>${esc(o.promptVersion)}</code></a> (${o.decisions})`).join(", ")}</p>` : ""}`;
}

const PREDICTION_SHORT: Record<Prediction, string> = { ...LABEL_SHORT, no_answer: "No usable answer" };
const SCORER_TITLE: Record<ClassifierMetrics["scorer"], string> = { ai_vs_human: "AI vs human (blind gold labels)", rules_vs_human: "Rules vs human (same gold labels, same cases)" };

function classifierBlock(m: ClassifierMetrics, note: string): string {
  const title = SCORER_TITLE[m.scorer];
  if (!m.population) return `<section class="card"><h2 class="card-h">${esc(title)}</h2><p>${NOT_ENOUGH}</p><p class="small muted">${esc(note)}</p></section>`;
  const head = PREDICTIONS.map((l) => `<th scope="col">${esc(PREDICTION_SHORT[l])}</th>`).join("");
  const rows = LABELS.map((g) => `<tr><th scope="row">${esc(LABEL_SHORT[g])}</th>${PREDICTIONS.map((p) => `<td class="num">${m.confusion[g][p] || '<span class="muted">0</span>'}</td>`).join("")}</tr>`).join("");
  return `<section class="card"><h2 class="card-h">${esc(title)}</h2>
<dl class="kv">
  <dt>Cases scored</dt><dd>${m.population} <span class="small muted">(the evaluation population)</span></dd>
  <dt>Agreement</dt><dd>${fmtRate(m.agreement)} <span class="small muted">over all ${m.population} cases</span></dd>
  <dt>Collision primary precision</dt><dd>${fmtRate(m.primary.precision)} <span class="small muted">over its collision-primary calls on definite labels</span></dd>
  <dt>Collision primary recall</dt><dd>${fmtRate(m.primary.recall)} <span class="small muted">over every case a person labeled collision primary</span></dd>
  <dt>False positives / negatives</dt><dd>${m.primary.falsePositive} / ${m.primary.falseNegative} <span class="small muted">(${m.primary.missedWithoutAnswer} of the misses had no usable answer)</span></dd>
  <dt>Any body/collision fit: precision / recall</dt><dd>${fmtRate(m.fit.precision)} / ${fmtRate(m.fit.recall)}</dd>
  <dt>Abstained (insufficient evidence)</dt><dd>${fmtRate(m.abstention)}</dd>
  <dt>No usable answer</dt><dd>${fmtRate(m.noAnswer)}</dd>
</dl>
<div class="scroll" style="margin-top:10px"><table class="tbl"><caption class="small muted" style="text-align:left">Rows: blind human label. Columns: answer. Every case of the population appears once.</caption><thead><tr><th scope="col">Human / answer</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
<p class="small muted">${esc(note)}</p></section>`;
}

function stratumTable(m: Metrics): string {
  if (!m.byStratum.length) return "";
  const r = (x: Rate) => (x.rate === null ? '<span class="muted">Unavailable</span>' : `${pct(x.rate)} <span class="small muted">(${x.num}/${x.den})</span>`);
  const rows = m.byStratum
    .map((s) => `<tr><th scope="row">${esc(STRATUM_LABELS[s.stratum as Stratum] ?? s.stratum)}</th><td class="num">${s.cases}</td><td class="num">${s.labeled}</td><td class="num">${s.ai.valid}</td><td class="num">${s.ai.abstained}</td><td class="num">${s.ai.noAnswer}</td><td>${r(s.aiVsHuman.agreement)}</td><td>${r(s.aiVsHuman.primary.precision)}</td><td>${r(s.aiVsHuman.primary.recall)}</td><td>${r(s.rulesVsHuman.agreement)}</td><td>${r(s.rulesVsHuman.primary.precision)}</td><td>${r(s.rulesVsHuman.primary.recall)}</td></tr>`)
    .join("");
  return `<section class="card"><h2 class="card-h">Evaluation by stratum</h2>
<p class="small">Gold-set results reflect the intentionally stratified evaluation sample: each stratum's share of the gold set was chosen, not observed, so the overall figures above are not estimates for all candidates. Read them stratum by stratum.</p>
<div class="scroll"><table class="tbl"><caption class="sr-only">Evaluation by stratum</caption><thead><tr><th scope="col">Stratum</th><th scope="col" class="num">Cases</th><th scope="col" class="num">Labeled</th><th scope="col" class="num">AI valid</th><th scope="col" class="num">AI abstained</th><th scope="col" class="num">AI no usable answer</th><th scope="col">AI vs human agreement</th><th scope="col">AI precision</th><th scope="col">AI recall</th><th scope="col">Rules vs human agreement</th><th scope="col">Rules precision</th><th scope="col">Rules recall</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small muted">Precision and recall are for collision primary, with the same denominators as above. A rate needs ${MIN_SAMPLE} observations; below that it is unavailable.</p></section>`;
}

const versionQuery = (ev: CohortEvaluation) => (ev.version ? `?model=${encodeURIComponent(ev.version.model)}&amp;prompt=${encodeURIComponent(ev.version.promptVersion)}` : "");

/** One gold set against one AI version, on one common population. */
export function aiCohortEvaluationPage(ev: CohortEvaluation): string {
  const m = ev.metrics;
  const ifScored = (html: string) => (m.population ? html : NOT_ENOUGH);
  const o = m.aiOutcomes;
  const summary: [string, string][] = [
    ["Gold-set cases labeled", `${m.population} / ${m.cases}`],
    ["Evaluation population", m.population ? `${m.population} labeled cases. The AI and the rules are scored on exactly these, each case once; a case without a usable AI answer stays in.` : NOT_ENOUGH],
    ["AI answers on the population", `${o.valid} valid (${o.abstained} of them abstained), ${o.invalid} invalid, ${o.error} error, ${o.missing} no decision for this version`],
    ["Rules on the population", `${m.ruleOutcomes.verdict} verdicts, ${m.ruleOutcomes.abstained} abstained, ${m.ruleOutcomes.noVerdict} no verdict (never read for this version)`],
    ["Human labels", `${m.humanLabels.definite} definite, ${m.humanLabels.cantTell} can't tell`],
    ["Agreement (AI vs human)", ifScored(fmtRate(m.aiVsHuman.agreement))],
    ["Collision precision (AI)", ifScored(fmtRate(m.aiVsHuman.primary.precision))],
    ["Collision recall (AI)", ifScored(fmtRate(m.aiVsHuman.primary.recall))],
    ["Abstention (AI)", ifScored(fmtRate(m.aiVsHuman.abstention))],
    ["No usable answer (AI)", ifScored(fmtRate(m.aiVsHuman.noAnswer))],
    ["Invalid decisions", ifScored(fmtRate(m.invalid))],
    ["Invalid evidence or quotes", ifScored(fmtRate(m.invalidEvidence))],
    ["Average confidence (valid)", m.averageConfidence === null ? '<span class="muted">Unavailable</span>' : pct(m.averageConfidence)],
    ["Cost per decision", m.costPerDecisionMicroUsd === null ? '<span class="muted">Unavailable</span>' : usd(m.costPerDecisionMicroUsd)],
    ["Latency per decision", m.averageLatencyMs === null ? '<span class="muted">Unavailable</span>' : `${(m.averageLatencyMs / 1000).toFixed(1)}s`],
  ];
  const bands = `<section class="card"><h2 class="card-h">Confidence calibration</h2><div class="scroll"><table class="tbl"><thead><tr><th scope="col">AI confidence</th><th scope="col" class="num">Valid decisions on labeled cases</th><th scope="col">Accuracy against the blind label</th></tr></thead><tbody>${m.bands.map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${b.decisions}</td><td>${fmtRate(b.accuracy)}</td></tr>`).join("")}</tbody></table></div><p class="small muted">The model's confidence is not assumed to be calibrated: a band's accuracy appears only from ${MIN_SAMPLE} labeled cases. A confidence threshold can be trusted only where the bands above it are measured and accurate.</p></section>`;
  return appPage(
    `AI evaluation · ${ev.cohort.name} · ReclaimBay admin`,
    "discovery",
    `${crumbs([{ label: "AI shadow", href: "/admin/ai" }, { label: ev.cohort.name }])}
${pageHead({ title: `AI evaluation · ${ev.cohort.name}`, lede: "Blind human gold labels against the AI shadow decisions, and against the existing rules, on the same cases.", actions: `<a class="btn btn-secondary" href="/admin/ai/cohorts/${esc(ev.cohort.id)}/next">Label next case</a> <a class="btn btn-secondary" href="/admin/ai/cohorts/${esc(ev.cohort.id)}/disagreements${versionQuery(ev)}">Disagreements (${ev.disagreements.length})</a>` })}
${SHADOW_BANNER}
<section class="card">${versionLine(ev)}</section>
<section class="card"><h2 class="card-h">AI evaluation</h2>${m.population === 0 ? `<p>${NOT_ENOUGH}</p>` : ""}<dl class="kv">${summary.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
<p class="small muted">Denominators: agreement, abstention, no usable answer, invalid and invalid-evidence rates are over every labeled case; precision is over the collision-primary calls on cases a person labeled definitely; recall is over every case a person labeled collision primary, so a case the AI didn't answer counts as a miss. A person's “can't tell” counts in agreement (matched only by an abstention) but never in precision or recall.</p></section>
${classifierBlock(m.aiVsHuman, "Only the blind label is gold. A missing, failed, or invalid AI answer is “no usable answer”: never a positive call, always in the population.")}
${classifierBlock(m.rulesVsHuman, "The existing collision classifier's verdict on the same pages the AI read, recorded with the AI decision: a case the AI never read has no rule verdict either. The rules can't tell a specialty from a dealership department, so either counts as agreeing with either. Compare with the AI block above, case for case.")}
${stratumTable(m)}
<section class="card"><h2 class="card-h">AI vs rules</h2><dl class="kv"><dt>Agree</dt><dd>${m.aiVsRules.agree}</dd><dt>Disagree</dt><dd>${m.aiVsRules.disagree}</dd><dt>Not comparable</dt><dd>${m.aiVsRules.notComparable}</dd></dl><p class="small muted">Valid AI decisions on labeled cases. Agreement with the rules is not accuracy: only the blind human labels measure accuracy.</p></section>
${bands}
<section class="card"><h2 class="card-h">Adjudication</h2><dl class="kv"><dt>Cases adjudicated after review</dt><dd>${m.adjudicated.cases}</dd><dt>Changed from the blind label</dt><dd>${m.adjudicated.changedFromBlind}</dd></dl><p class="small muted">Adjudications are made after seeing the AI's answer, so they never replace the blind label in these metrics.</p></section>`,
  );
}

/** Every case where the blind label and the AI's valid decision differ. Labeled cases only. */
export function aiDisagreementsPage(ev: CohortEvaluation): string {
  const items = ev.disagreements
    .map(
      (d) => `<article class="card" style="border-left:4px dashed var(--amber)">
<p style="margin:0 0 6px"><a href="/admin/discovery/candidates/${esc(d.candidateId)}#ai">${esc(d.candidateId.slice(0, 8))}</a> · <a href="/admin/ai/cases/${esc(d.caseId)}">Review and adjudicate &rarr;</a></p>
<dl class="kv">
  <dt>Blind human label</dt><dd>${esc(HUMAN_LABELS[d.gold])}</dd>
  <dt>AI decision</dt><dd>${esc(decisionLabel(d.aiDecision))}${d.abstained ? ' <span class="small muted">(abstained)</span>' : ""}</dd>
  <dt>AI confidence</dt><dd>${pct(d.confidence)}</dd>
  <dt>Rules on the same pages</dt><dd>${esc(d.ruleDecision ?? "—")}</dd>
</dl>
${d.evidence.map((e) => `<blockquote>${esc(e.quote)}</blockquote><div class="small muted">Source: ${extLink(e.sourceUrl)}</div>`).join("")}
${d.reasons.length ? `<p class="small" style="margin:8px 0 2px"><b>AI reasons</b></p><ul class="small" style="margin:0">${d.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
${d.concerns.length ? `<p class="small" style="margin:8px 0 2px"><b>AI concerns</b></p><ul class="small" style="margin:0">${d.concerns.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
</article>`,
    )
    .join("");
  return appPage(
    `Disagreements · ${ev.cohort.name} · ReclaimBay admin`,
    "discovery",
    `${crumbs([{ label: "AI shadow", href: "/admin/ai" }, { label: ev.cohort.name, href: `/admin/ai/cohorts/${ev.cohort.id}` }, { label: "Disagreements" }])}
${pageHead({ title: `Disagreements · ${ev.cohort.name}`, lede: "Cases where the blind human label and the AI's valid decision differ. Shown only after the blind label is saved." })}
${SHADOW_BANNER}<section class="card">${versionLine(ev)}</section>
${items || `<section class="card">${emptyState("No disagreements among labeled cases.", "Only cases with a blind label appear here.")}</section>`}`,
  );
}

export interface CaseReview {
  caseId: string;
  candidateId: string;
  cohort: { id: string; name: string };
  businessName: string;
  labels: { revision: number; source: string; label: string; note: string | null }[];
}

/** One case after its blind label: the labels, the AI's decisions, and adjudication. */
export function aiCaseReviewPage(v: CaseReview, decisions: readonly AiDecisionRow[], adjudication: string): string {
  return appPage(
    `Case review · ${v.cohort.name} · ReclaimBay admin`,
    "discovery",
    `${crumbs([{ label: "AI shadow", href: "/admin/ai" }, { label: v.cohort.name, href: `/admin/ai/cohorts/${v.cohort.id}` }, { label: v.businessName }])}
${pageHead({ title: `Case review · ${v.businessName}`, lede: "After the blind label: the AI's answers, for review and adjudication." })}
${SHADOW_BANNER}
<section class="card"><h2 class="card-h">Human labels</h2><ul>${v.labels.map((l) => `<li>Revision ${l.revision} (${esc(l.source)}): <b>${esc(HUMAN_LABELS[l.label as HumanLabel] ?? l.label)}</b>${l.note ? ` · ${esc(l.note)}` : ""}</li>`).join("")}</ul><p class="small"><a href="/admin/discovery/candidates/${esc(v.candidateId)}">Open the candidate</a></p></section>
<h2 class="card-h">AI shadow decisions</h2>
${decisions.length ? decisions.map(decisionCard).join("") : `<div class="card">${emptyState("No AI shadow decision for this candidate yet.")}</div>`}
${adjudication}`,
  );
}
