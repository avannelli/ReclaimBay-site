/*
 * Blind labeling for AI evaluation. These views show a person only the
 * evidence a collision/body fit verifier legitimately uses, and nothing
 * derived from AI: this file never imports AI decisions (a test enforces it).
 * They also never show the case's stratum, the candidate's status, its
 * qualification, signal values, decision reasons, or a person's earlier
 * evidence: the label must be the labeler's own reading of the evidence.
 */
import { HUMAN_LABELS, STRATUM_LABELS, type HumanLabel, type LabelingView, type Stratum, type cohortProgress } from "../ai/goldSet.js";
import { appPage } from "./views.js";
import { crumbs, emptyState, esc, extLink, fmtDate, notice, pageHead } from "./ui.js";

const answerList = (name: string, checked?: string) =>
  `<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="lbl">Does this business itself perform automotive collision or body repair?</legend>${(Object.entries(HUMAN_LABELS) as [HumanLabel, string][])
    .map(([v, text]) => `<label class="check" style="display:flex;gap:8px;align-items:flex-start;margin:4px 0"><input type="radio" name="${name}" value="${v}" required${checked === v ? " checked" : ""}> <span>${esc(text)}</span></label>`)
    .join("")}</fieldset>`;

/** One case, blind: the business and the research evidence, and the answer. */
export function blindLabelPage(v: LabelingView, opts: { errors?: string[]; notice?: string; reviewHref?: string } = {}): string {
  const blind = v.labeled.find((l) => l.revision === 1);
  const evidence = v.excerpts.length
    ? v.excerpts.map((e) => `<blockquote>${esc(e.excerpt)}</blockquote><div class="small muted" style="margin:-4px 0 10px">Source: ${extLink(e.sourceUrl)}</div>`).join("")
    : emptyState("Research recorded no excerpts for this business.", "Open its website and the pages research read, below, and decide from what they say.");
  const errors = opts.errors?.length ? `<div class="callout warn" role="alert" style="margin-bottom:12px"><b>Not saved.</b> ${opts.errors.map(esc).join(" ")}</div>` : "";
  const answered = blind
    ? `<section class="card"><h2 class="card-h">Your blind label</h2><p><b>${esc(HUMAN_LABELS[blind.label] ?? blind.label)}</b> <span class="small muted">${fmtDate(blind.createdAt)}</span></p>${blind.note ? `<p class="small">${esc(blind.note)}</p>` : ""}
${v.labeled.filter((l) => l.revision > 1).map((l) => `<p class="small">Adjudicated (revision ${l.revision}): <b>${esc(HUMAN_LABELS[l.label] ?? l.label)}</b> · ${esc(l.note ?? "")} <span class="muted">${fmtDate(l.createdAt)}</span></p>`).join("")}
<p class="small muted">The blind label is the gold label and never changes. ${opts.reviewHref ? `<a href="${esc(opts.reviewHref)}">Review this case with the AI's answer &rarr;</a>` : ""}</p>
<p><a class="btn btn-secondary" href="/admin/ai/cohorts/${esc(v.cohort.id)}/next">Next case to label &rarr;</a></p></section>`
    : `<form class="card stack" method="post" action="/admin/ai/label/${esc(v.caseId)}" novalidate>
${answerList("label")}
<div class="field"><label for="f-note">Note (optional)</label><textarea id="f-note" name="note" maxlength="500"></textarea></div>
<div class="field"><label for="f-by">Your name (optional)</label><input id="f-by" name="labeledBy" maxlength="80"></div>
<div><button type="submit">Save blind label</button></div>
<p class="small muted" style="margin:0">Decide from the evidence alone. Once saved, the blind label can't be changed; a later correction is recorded separately as an adjudication.</p>
</form>`;
  return appPage(
    `Blind label · ${v.cohort.name} · ReclaimBay admin`,
    "discovery",
    `${crumbs([{ label: "AI shadow", href: "/admin/ai" }, { label: v.cohort.name }, { label: `Case ${v.position} of ${v.total}` }])}
${pageHead({ title: v.business.name, lede: `Blind label · case ${v.position} of ${v.total} in ${v.cohort.name}` })}
${notice(opts.notice)}${errors}
<p class="callout warn" style="margin-bottom:14px"><b>Blind labeling.</b> No AI answer, rule verdict, or earlier decision is shown here. Judge only whether the business itself performs automotive collision or body repair.</p>
<div class="grid-2">
<section class="card"><h2 class="card-h">The business</h2><dl class="kv">
  <dt>Name</dt><dd>${esc(v.business.name)}</dd>
  <dt>Website</dt><dd>${v.business.website ? extLink(v.business.website) : '<span class="muted">None</span>'}${v.websiteConfirmed ? ' <span class="small muted">(research confirmed it is this business\'s own site)</span>' : ""}</dd>
  <dt>Address</dt><dd>${esc([v.business.street, v.business.place].filter(Boolean).join(", ") || "—")}</dd>
</dl>
${v.pagesRead.length ? `<h3 class="card-h" style="margin-top:12px">Pages research read</h3><ul class="small">${v.pagesRead.map((p) => `<li>${extLink(p.url)}${p.ok ? "" : ` <span class="muted">(not read${p.status ? `: HTTP ${p.status}` : ""})</span>`}</li>`).join("")}</ul>` : ""}
${v.warnings.length ? `<h3 class="card-h" style="margin-top:12px">Research warnings</h3><ul class="small">${v.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
</section>
<section class="card"><h2 class="card-h">Excerpts research quoted</h2>${evidence}</section>
</div>
${answered}`,
  );
}

/** After the blind label: an adjudication form (a reason is required). Shown only on the post-label review page. */
export function adjudicationForm(caseId: string, errors?: string[]): string {
  return `<form class="card stack" method="post" action="/admin/ai/label/${esc(caseId)}/adjudicate" novalidate>
<h2 class="card-h">Adjudicate (after review)</h2>
${errors?.length ? `<div class="callout warn" role="alert"><b>Not saved.</b> ${errors.map(esc).join(" ")}</div>` : ""}
<p class="small muted" style="margin:0">Recorded as a new revision with its reason. It is not blind, so it never replaces the blind label in the metrics; it is counted separately.</p>
${answerList("label")}
<div class="field"><label for="f-anote">Reason (required)</label><textarea id="f-anote" name="note" maxlength="500" required></textarea></div>
<div class="field"><label for="f-aby">Your name (optional)</label><input id="f-aby" name="labeledBy" maxlength="80"></div>
<div><button type="submit">Record adjudication</button></div>
</form>`;
}

/** The gold-set area of /admin/ai: cohorts, progress, and creating one. No AI output. */
export function cohortSection(cohorts: Awaited<ReturnType<typeof cohortProgress>>, errors?: string[]): string {
  const rows = cohorts
    .map((c) => {
      const strata = Object.entries((c.strata ?? {}) as Record<string, { quota: number; available: number; chosen: number }>)
        .map(([s, v]) => `${esc(STRATUM_LABELS[s as Stratum] ?? s)}: ${v.chosen}${v.chosen < v.quota ? ` <span class="muted">(quota ${v.quota}, ${v.available} available)</span>` : ""}`)
        .join("<br>");
      return `<tr><td><b>${esc(c.name)}</b><div class="sub"><code>${esc(c.samplingVersion)}</code> · seed <code>${esc(c.seed)}</code> · ${fmtDate(c.createdAt)}</div><details class="small"><summary>Strata</summary>${strata}</details></td><td>${c.labeled} / ${c.total}</td><td><a class="btn btn-secondary" href="/admin/ai/cohorts/${esc(c.id)}/next">Label</a> <a class="btn btn-secondary" href="/admin/ai/cohorts/${esc(c.id)}">Evaluate</a></td></tr>`;
    })
    .join("");
  return `<section class="card"><h2 class="card-h">Gold sets (blind human labels)</h2>
${cohorts.length ? `<div class="scroll"><table class="tbl"><caption class="sr-only">Gold-set cohorts</caption><thead><tr><th scope="col">Cohort</th><th scope="col">Blind labels</th><th scope="col">Open</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted small">No gold set yet. Not enough labeled cases to evaluate anything.</p>`}
<form class="stack" method="post" action="/admin/ai/cohorts" novalidate style="margin-top:12px">
<h3 class="card-h">Create a gold set</h3>
${errors?.length ? `<div class="callout warn" role="alert"><b>Not created.</b> ${errors.map(esc).join(" ")}</div>` : ""}
<p class="small muted" style="margin:0">A stratified sample of about 150 candidates with a research-verified website: mostly ones the rules leave for a person, plus dealership/specialty, automatically approved and rejected, and some a person already decided. It is chosen from candidate and research state only, never from AI output, and the same seed always picks the same cases. It is frozen once created.</p>
<div class="field"><label for="f-cname">Name</label><input id="f-cname" name="name" maxlength="80" required></div>
<div class="field"><label for="f-seed">Seed</label><input id="f-seed" name="seed" maxlength="80" required></div>
<div><button type="submit">Create gold set</button></div>
</form></section>`;
}
