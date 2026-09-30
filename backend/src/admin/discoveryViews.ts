import type { candidateStatusCounts, getCandidateDetail, listCandidates, recentRuns } from "../discovery/service.js";
import { CANDIDATE_SORTS, DEFAULT_BUSINESS_TYPE } from "../discovery/service.js";
import {
  CANDIDATE_REASON_REQUIRED,
  CANDIDATE_STATUSES,
  CANDIDATE_STATUS_LABELS,
  CANDIDATE_STATUS_MEANINGS,
  CANDIDATE_TRANSITIONS,
  type CandidateStatus,
} from "../discovery/candidateStatus.js";
import { FIELD_LIMITS } from "../prospects.js";
import { MAX_SCORE, QUALIFICATION_LABELS, SIGNALS, type SignalDefinition } from "../scoring.js";
import { businessSections, criteriaNames, qualificationDetail, signalSections } from "./prospectViews.js";
import { appPage } from "./views.js";
import {
  bandBadge,
  candidateBadge,
  crumbs,
  emptyState,
  errorSummary,
  esc,
  extLink,
  fieldErrors,
  fmtDate,
  fmtDay,
  notice,
  obsBadge,
  options,
  pageHead,
  qualificationBadge,
  section,
  signalLabel,
  stepper,
} from "./ui.js";

/* Admin pages for discovery. Server-rendered, no scripts, all values escaped. */

type Values = Record<string, string | undefined>;
type ListResult = Awaited<ReturnType<typeof listCandidates>>;
type Detail = NonNullable<Awaited<ReturnType<typeof getCandidateDetail>>>;
type Runs = Awaited<ReturnType<typeof recentRuns>>;
type StatusCounts = Awaited<ReturnType<typeof candidateStatusCounts>>;

const SIGNAL_DEFS = SIGNALS as readonly SignalDefinition[];
/** Short labels so the sort menu fits its column. */
const SORT_LABELS: Record<string, string> = { score: "Score", discovered: "Newest", name: "Name" };

// ---------- overview ----------

export function discoveryPage(opts: {
  providers: { name: string; label: string }[];
  list: ListResult;
  runs: Runs;
  runCount: number;
  statusCounts: StatusCounts;
  filters: Values;
  values?: Values;
  notice?: string;
  errors?: string[];
}): string {
  const { providers, list, runs, runCount, statusCounts, filters: f, values = {} } = opts;
  const fe = fieldErrors(opts.errors);
  const totalCandidates = Object.values(statusCounts).reduce((n, v) => n + (v ?? 0), 0);
  const review = statusCounts.needs_review ?? 0;
  const anyFilter = Boolean(f.q || f.status || f.qualification || f.band || f.state || f.city || f.flagged || f.run);

  const runCard = `<section class="card" id="new-run" aria-labelledby="new-run-h">
  <h2 class="card-h" id="new-run-h">New discovery run</h2>
  ${
    providers.length
      ? `<form method="post" action="/admin/discovery/runs" class="filters" novalidate>
  <div class="filter-row" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
    <div><label class="lbl" for="f-provider">Provider</label><select id="f-provider" name="provider">${options(providers.map((p): [string, string] => [p.name, p.label]), values.provider)}</select></div>
    <div><label class="lbl" for="f-region">Region</label><input id="f-region" type="text" name="region" value="${esc(values.region)}" placeholder="Ventura County, CA" maxlength="${FIELD_LIMITS.city}" required></div>
    <div><label class="lbl" for="f-rcity">City <span class="muted" style="font-weight:400">(optional)</span></label><input id="f-rcity" type="text" name="city" value="${esc(values.city)}" placeholder="Thousand Oaks" maxlength="${FIELD_LIMITS.city}"></div>
    <div><label class="lbl" for="f-btype">Business type</label><input id="f-btype" type="text" name="businessType" value="${esc(values.businessType ?? DEFAULT_BUSINESS_TYPE)}" maxlength="100"></div>
  </div>
  <div class="row"><button type="submit">Run discovery</button><span class="small muted">Finds candidates for you to review. Nothing becomes a prospect on its own.</span></div>
</form>`
      : `<p class="small" style="margin:0">No discovery provider is configured on this server, so there is nothing to run yet. You can still add candidates by hand. See <code>backend/DISCOVERY.md</code> for what a provider needs.</p>`
  }
</section>`;

  const tiles = `<div class="kpis" style="margin-top:14px">
  <div class="kpi"><div class="k-label">Discovery runs</div><div class="k-value">${runCount}</div><div class="k-hint">${runs.length ? "most recent below" : "none yet"}</div></div>
  <div class="kpi"><div class="k-label">Candidates</div><div class="k-value">${totalCandidates}</div><div class="k-hint">not prospects until approved</div></div>
  <a class="kpi attn-item" href="/admin/discovery?status=needs_review" style="display:block;text-decoration:none;color:inherit${review ? ";border-color:var(--amber)" : ""}"><div class="k-label">Needs review</div><div class="k-value">${review}</div><div class="k-hint">${review ? "waiting for your decision" : "nothing waiting"}</div></a>
</div>`;

  const chips = [
    `<a class="chip" href="/admin/discovery"${!f.status && !f.run ? ' aria-current="true"' : ""}>All <span class="n">${totalCandidates}</span></a>`,
    ...CANDIDATE_STATUSES.map((s) => {
      const on = f.status === s;
      return `<a class="chip${s === "needs_review" && (statusCounts[s] ?? 0) > 0 ? " attn" : ""}" href="/admin/discovery?status=${s}"${on ? ' aria-current="true"' : ""}>${esc(CANDIDATE_STATUS_LABELS[s])} <span class="n">${statusCounts[s] ?? 0}</span></a>`;
    }),
  ].join("");

  const rows = list.rows
    .map(({ candidate: c, result }) => {
      const loc = [c.city, c.state].filter(Boolean).join(", ");
      const flagged = c.possibleDuplicateCandidateId || c.possibleDuplicateProspectId;
      return `<tr${c.status === "needs_review" ? ' class="attn"' : ""}>
  <td><a class="name" href="/admin/discovery/candidates/${esc(c.id)}">${esc(c.businessName)}</a>${c.website ? `<div class="sub">${extLink(c.website)}</div>` : ""}</td>
  <td class="hide-md" data-label="Location">${loc ? esc(loc) : '<span class="muted">—</span>'}</td>
  <td data-label="Research status">${candidateBadge(c.status)}</td>
  <td data-label="Qualification">${qualificationBadge(result.qualification)}</td>
  <td class="num" data-label="Opportunity score"><span class="score-cell"><b>${result.score}</b><span class="of">/${MAX_SCORE}</span></span><div class="sub">${result.known}/${result.total} known · ${c._count.evidence} evidence</div></td>
  <td class="hide-md" data-label="Duplicate check">${flagged ? `<span class="tag" style="border-color:var(--amber);color:var(--warn)">! Possible duplicate</span><div class="sub">${esc(c.duplicateReason ?? "")}</div>` : '<span class="muted">No flags</span>'}</td>
  <td class="hide-lg small muted" data-label="Discovered">${fmtDay(c.discoveredAt)}<div class="sub">${esc(c.provider)}</div></td>
  <td data-label=""><a class="btn btn-secondary" href="/admin/discovery/candidates/${esc(c.id)}" style="min-height:30px;padding:3px 10px">${c.status === "needs_review" || c.status === "discovered" ? "Review" : "Open"}</a></td>
</tr>`;
    })
    .join("\n");

  const emptyCandidates =
    totalCandidates === 0
      ? emptyState("No candidates to review.", providers.length ? "Start a discovery run above, or add a business by hand." : "Add a business by hand to start researching.", `<a class="btn" href="/admin/discovery/candidates/new">Add candidate</a>`)
      : emptyState("No candidates match these filters.", "Try clearing a filter or changing your search.", `<a class="btn btn-secondary" href="/admin/discovery">Clear filters</a>`);

  const runRows = runs
    .map(
      (r) => `<tr>
  <td><b>${esc([r.city, r.region].filter(Boolean).join(", "))}</b><div class="sub">${esc(r.businessType)}</div></td>
  <td class="hide-md" data-label="Provider">${esc(r.provider)}</td>
  <td class="small" data-label="Created">${fmtDate(r.createdAt)}</td>
  <td class="num" data-label="New candidates"><b>${r.created}</b><div class="sub">${r.found} found · ${r.duplicates} skipped · ${r.flagged} flagged${r.invalid ? ` · ${r.invalid} unusable` : ""}</div></td>
  <td data-label="Status">${r.status === "failed" ? `<span class="tag" style="border-color:var(--neg);color:var(--neg)">✕ Failed</span><div class="sub">${esc(r.error ?? "")}</div>` : r.status === "running" ? `<span class="tag">Running</span>` : `<span class="tag">Completed</span>`}</td>
  <td data-label="">${r.status === "completed" ? `<a href="/admin/discovery?run=${esc(r.id)}">Open candidates</a>` : '<span class="muted">—</span>'}</td>
</tr>`,
    )
    .join("");

  const shown = list.rows.length < list.total ? `Showing the first ${list.rows.length} of ${list.total}` : `${list.total} candidate${list.total === 1 ? "" : "s"}`;

  return appPage(
    "Discovery · ReclaimBay admin",
    "discovery",
    `${pageHead({
      title: "Discovery",
      lede: "Find and review businesses before they enter the prospect pipeline. Candidates are not prospects until you approve them.",
      actions: `<a class="btn" href="#new-run">New discovery run</a><a class="btn btn-secondary" href="/admin/discovery/candidates/new">Add candidate</a>`,
    })}
${notice(opts.notice)}${errorSummary(opts.errors, fe, "Not done")}
${runCard}
${tiles}

${section(
  "candidates",
  "Candidates",
  `<nav class="chips" aria-label="Filter by research status">${chips}</nav>
${f.run ? `<div class="callout" style="margin-bottom:12px">Showing candidates from one discovery run. <a href="/admin/discovery">Show all</a></div>` : ""}
<form class="card filters" method="get" action="/admin/discovery" role="search" aria-label="Search and filter candidates">
  <div><label class="sr-only" for="f-q">Search candidates</label><input class="search" id="f-q" type="search" name="q" value="${esc(f.q)}" placeholder="Search name, website, city, or phone" maxlength="100"></div>
  <div class="filter-row">
    <div><label class="lbl" for="f-cstatus">Research status</label><select id="f-cstatus" name="status">${options([["", "Any"], ...CANDIDATE_STATUSES.map((s): [string, string] => [s, CANDIDATE_STATUS_LABELS[s]])], f.status)}</select></div>
    <div><label class="lbl" for="f-cqual">Qualification</label><select id="f-cqual" name="qualification">${options([["", "Any"], ...Object.entries(QUALIFICATION_LABELS)], f.qualification)}</select></div>
    <div><label class="lbl" for="f-cband">Score band</label><select id="f-cband" name="band">${options([["", "Any"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]], f.band)}</select></div>
    <div><label class="lbl" for="f-cstate">State</label><input id="f-cstate" type="text" name="state" value="${esc(f.state)}" maxlength="50"></div>
    <div><label class="lbl" for="f-ccity">City</label><input id="f-ccity" type="text" name="city" value="${esc(f.city)}" maxlength="100"></div>
    <div><label class="lbl" for="f-cflag">Duplicate flag</label><select id="f-cflag" name="flagged">${options([["", "Any"], ["1", "Possible duplicate"]], f.flagged)}</select></div>
    <div><label class="lbl" for="f-csort">Sort by</label><select id="f-csort" name="sort">${options(Object.keys(CANDIDATE_SORTS).map((k): [string, string] => [k, SORT_LABELS[k] ?? k]), list.sort)}</select></div>
    <div class="filter-actions"><button type="submit">Apply filters</button><a class="btn btn-secondary" href="/admin/discovery">Reset</a></div>
  </div>
  ${f.run ? `<input type="hidden" name="run" value="${esc(f.run)}">` : ""}
</form>
<div class="result-line"><span><b>${esc(shown)}</b>${anyFilter ? " match" : ""}</span><span><b>Qualification</b> (${esc(criteriaNames)}) and the <b>opportunity score</b> (ranking only) are worked out from recorded signals and are independent.</span></div>
${
  list.rows.length
    ? `<div class="scroll"><table class="tbl cards">
<caption class="sr-only">Discovery candidates</caption>
<thead><tr><th scope="col">Candidate</th><th scope="col" class="hide-md">Location</th><th scope="col">Research status</th><th scope="col">Qualification</th><th scope="col" class="num">Opportunity score</th><th scope="col" class="hide-md">Duplicate check</th><th scope="col" class="hide-lg">Discovered</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`
    : `<div class="card">${emptyCandidates}</div>`
}`,
)}

${section(
  "runs",
  "Discovery runs",
  runs.length
    ? `<div class="scroll"><table class="tbl cards">
<caption class="sr-only">Recent discovery runs</caption>
<thead><tr><th scope="col">Target</th><th scope="col" class="hide-md">Provider</th><th scope="col">Created</th><th scope="col" class="num">New candidates</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
<tbody>${runRows}</tbody>
</table></div>
<p class="small muted" style="margin-top:8px">Skipped records matched a stored candidate or prospect by provider ID or website domain. Flagged records matched only by name and city, or phone, so they were kept for you to review.</p>`
    : `<div class="card">${emptyState("No discovery runs yet.", providers.length ? "Use “New discovery run” to search a region for candidate businesses." : "When a provider is configured, runs will appear here. You can add candidates by hand meanwhile.")}</div>`,
)}`,
  );
}

// ---------- add / edit form ----------

export function candidateFormPage(
  opts: { mode: "new" } | { mode: "edit"; id: string; name: string },
  values: Values,
  errors?: string[],
): string {
  const editing = opts.mode === "edit";
  const action = editing ? `/admin/discovery/candidates/${esc(opts.id)}` : "/admin/discovery/candidates";
  const back = editing ? action : "/admin/discovery";
  const title = editing ? `Research ${opts.name}` : "Add candidate";
  const fe = fieldErrors(errors);
  return appPage(
    `${title} · ReclaimBay admin`,
    "discovery",
    `${crumbs([{ label: "Discovery", href: "/admin/discovery" }, ...(editing ? [{ label: opts.name, href: action }, { label: "Research" }] : [{ label: "Add candidate" }])])}
${pageHead({ title, lede: editing ? "Record only what a public source shows, then add evidence for each recorded signal." : "Adds one business by hand. It is checked against existing candidates and prospects, and is not a prospect until you approve it." })}
${errorSummary(errors, fe)}
<form method="post" action="${action}" class="stack" novalidate>
  ${businessSections(values, fe)}
  ${editing ? signalSections(values, fe) : ""}
  <div class="form-foot"><button type="submit" class="btn-primary-lg">${editing ? "Save research" : "Add candidate"}</button><a class="btn btn-secondary btn-primary-lg" href="${back}">Cancel</a></div>
</form>`,
  );
}

// ---------- detail ----------

const RESEARCH_PATH: CandidateStatus[] = ["discovered", "researching", "researched", "approved"];

export function candidateDetailPage(opts: { detail: Detail; notice?: string; errors?: string[]; values?: Values }): string {
  const { detail, values = {} } = opts;
  const { candidate: c, result, dupCandidate, dupProspect, approvalBlockers } = detail;
  const id = esc(c.id);
  const fe = fieldErrors(opts.errors);
  const none = '<span class="muted">—</span>';
  const frozen = c.status === "approved";

  const evidenceCount = new Map<string, number>();
  for (const e of c.evidence) evidenceCount.set(e.signalKey, (evidenceCount.get(e.signalKey) ?? 0) + 1);

  // ----- what we know -----
  const known = result.breakdown.filter((s) => s.state !== "unknown");
  const knownRows = known
    .map((s) => {
      const def = SIGNAL_DEFS.find((d) => d.key === s.key)!;
      const n = evidenceCount.get(s.key) ?? 0;
      const source =
        s.derived && s.state === "yes"
          ? `<span class="small muted">Derived from the stored website or public contact.</span>`
          : n
            ? `<a href="#evidence">${n} evidence item${n === 1 ? "" : "s"}</a>`
            : `<span class="tag" style="border-color:var(--amber);color:var(--warn)">! No evidence yet</span>`;
      return `<tr><td><b>${esc(s.label)}</b><div class="sub">${def.requiredCriterion ? '<span class="kind req">Required criterion</span>' : '<span class="kind">Opportunity signal</span>'}</div></td>
<td data-label="Observed">${obsBadge(s.state)}</td><td class="num" data-label="Points"><span class="score-cell"><b>${s.points}</b><span class="of">/${s.weight}</span></span></td><td data-label="Source">${source}</td></tr>`;
    })
    .join("");

  const place = [c.city, c.state, c.postalCode].filter(Boolean).join(", ");
  const fact = (label: string, value: string, src?: string | null) =>
    `<dt>${esc(label)}</dt><dd>${value}${src ? `<div class="src">listed at ${extLink(src)}</div>` : ""}</dd>`;

  // ----- what we don't know -----
  const unknown = result.breakdown.filter((s) => s.state === "unknown");
  const unknownItems = unknown
    .map((s) => {
      const def = SIGNAL_DEFS.find((d) => d.key === s.key)!;
      return `<li><b>${esc(s.label)}</b> ${obsBadge("unknown")} <span class="small muted">${s.weight} pts</span> ${def.requiredCriterion ? '<span class="kind req">Required criterion</span>' : ""}
<div class="small muted">${esc(s.reason)}</div></li>`;
    })
    .join("");
  const missingPoints = unknown.reduce((n, s) => n + s.weight, 0);

  // ----- where each fact came from -----
  const sources = new Map<string, string[]>();
  const addSource = (url: string | null | undefined, what: string) => {
    if (url) sources.set(url, [...(sources.get(url) ?? []), what]);
  };
  addSource(c.sourceUrl, `discovery record (${c.provider})`);
  addSource(c.phoneSourceUrl, "phone number");
  addSource(c.emailSourceUrl, "email address");
  for (const e of c.evidence) addSource(e.sourceUrl, signalLabel(e.signalKey));
  const sourceRows = [...sources]
    .map(([url, what]) => `<li>${extLink(url)}<div class="small muted">${esc([...new Set(what)].join(", "))}</div></li>`)
    .join("");

  // ----- evidence notebook -----
  const evidenceCards = c.evidence.length
    ? c.evidence
        .map(
          (e) => `<article class="ev">
  <div class="row spread"><span><span class="kind">Signal</span> <b>${esc(signalLabel(e.signalKey))}</b></span>${
    frozen
      ? ""
      : `<form method="post" action="/admin/discovery/candidates/${id}/evidence/${esc(e.id)}/delete" class="inline-form"><button class="link" type="submit" aria-label="Remove evidence for ${esc(signalLabel(e.signalKey))}">Remove</button></form>`
  }</div>
  <blockquote>${esc(e.excerpt)}</blockquote>
  <div class="meta"><span>Source: ${extLink(e.sourceUrl)}</span><span>${fmtDate(e.createdAt)}</span></div>
</article>`,
        )
        .join("")
    : `<div class="card">${emptyState("No evidence recorded yet.", "Add a short public excerpt and its source URL for each signal you record.")}</div>`;

  const fieldErr = (name: string) => (fe.byField.get(name) ?? []).map((e) => `<div class="ferr">${esc(e)}</div>`).join("");

  // ----- duplicate assessment -----
  const dupItems = [
    dupCandidate && `<li>Candidate <a href="/admin/discovery/candidates/${esc(dupCandidate.id)}">${esc(dupCandidate.businessName)}</a> (${esc(CANDIDATE_STATUS_LABELS[dupCandidate.status])})</li>`,
    dupProspect && `<li>Prospect <a href="/admin/prospects/${esc(dupProspect.id)}">${esc(dupProspect.businessName ?? "Unnamed")}</a> (${esc(dupProspect.status)})</li>`,
  ].filter(Boolean);
  const dupCard = dupItems.length
    ? `<div class="card" style="border-left:4px solid var(--amber)"><b>! Possible duplicate</b>
<p class="small" style="margin:6px 0">Matched only on: ${esc(c.duplicateReason ?? "partial overlap")}. That is not enough to skip it automatically, so it needs your decision. If it is the same business, mark it a duplicate.</p>
<ul class="plain small">${dupItems.join("")}</ul></div>`
    : `<div class="card"><b>No duplicate flags</b><p class="small muted" style="margin:6px 0 0">When this candidate was stored, nothing matched an existing candidate or prospect on provider ID, website domain, name and city, or phone.</p></div>`;

  // ----- research state + actions -----
  const allowed = CANDIDATE_TRANSITIONS[c.status];
  const statusErrs = fe.byField.get("status") ?? [];
  const statusForm = allowed.length
    ? `<form method="post" action="/admin/discovery/candidates/${id}/status" class="row" style="align-items:flex-end" novalidate>
  <div style="min-width:180px"><label class="lbl" for="f-cstatus2">Move to</label><select id="f-cstatus2" name="status"${statusErrs.length ? ' aria-invalid="true"' : ""}>${options(allowed.map((s): [string, string] => [s, CANDIDATE_STATUS_LABELS[s]]), values.status)}</select></div>
  <div style="flex:1;min-width:240px"><label class="lbl" for="f-creason">Reason <span class="muted" style="font-weight:400">(required for ${CANDIDATE_REASON_REQUIRED.map((s) => CANDIDATE_STATUS_LABELS[s]).join(" and ")})</span></label><input id="f-creason" type="text" name="reason" value="${esc(values.reason)}" maxlength="${FIELD_LIMITS.reason}"></div>
  <button type="submit">Change status</button>
</form>${statusErrs.map((e) => `<div class="ferr">${esc(e)}</div>`).join("")}
<p class="small muted" style="margin-top:10px">Researched needs at least one evidence item, and every yes/no signal needs its own. Rejecting or marking a duplicate keeps the record but can never create a prospect. Approval is separate, below.</p>`
    : `<p class="small">${frozen ? "Approved: this candidate is now a prospect." : ""}</p>`;

  const approveCard = frozen
    ? `<div class="card" style="border-left:4px solid var(--pos)"><b>✓ Approved</b> ${c.approvedAt ? `<span class="small muted">${fmtDate(c.approvedAt)}</span>` : ""}
<p class="small" style="margin:6px 0 0">${c.prospect ? `Prospect: <a href="/admin/prospects/${esc(c.prospect.id)}">${esc(c.prospect.businessName ?? "Unnamed")}</a> (${esc(c.prospect.status)}). Edit it there. This record is kept as its discovery history.` : "Linked prospect unavailable."}</p></div>`
    : approvalBlockers.length
      ? `<div class="card"><b>Approve candidate → create prospect</b><p class="small" style="margin:6px 0">Not ready to approve yet:</p><ul class="plain small">${approvalBlockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>`
      : `<div class="card" style="border-left:4px solid var(--accent)"><b>Approve candidate → create prospect</b>
<p class="small" style="margin:6px 0 10px">Approval adds this business to the prospect pipeline. It does not automatically qualify the business or mark it ready to contact. It starts as <b>New</b>, and those steps still follow the qualification rules (currently <b>${esc(QUALIFICATION_LABELS[result.qualification])}</b>).</p>
<form method="post" action="/admin/discovery/candidates/${id}/approve"><button type="submit" class="btn-primary-lg">Approve and create prospect</button></form></div>`;

  return appPage(
    `${c.businessName} · Discovery · ReclaimBay admin`,
    "discovery",
    `${crumbs([{ label: "Discovery", href: "/admin/discovery" }, { label: c.businessName }])}
${notice(opts.notice)}${errorSummary(opts.errors, fe, "Not done")}
${pageHead({
  title: c.businessName,
  badges: `${candidateBadge(c.status)}<span class="muted">${esc(place || "Location not recorded")}</span><span class="tag">Candidate, not a prospect${frozen ? " (approved)" : ""}</span>`,
  lede: esc(CANDIDATE_STATUS_MEANINGS[c.status]),
  actions: frozen ? "" : `<a class="btn" href="/admin/discovery/candidates/${id}/edit">Edit research</a>`,
})}

<div class="grid-2">
  <div class="card verdict v-${result.qualification}">
    <div class="v-label">Qualification</div>
    <div class="v-sub">Required criteria: ${esc(criteriaNames)}</div>
    <div class="v-big">${qualificationBadge(result.qualification, "q-big")}</div>
    <div class="small">${qualificationDetail(result)}</div>
  </div>
  <div class="card verdict v-score">
    <div class="v-label">Opportunity score</div>
    <div class="v-sub">Opportunity score · ranking only, not a verdict</div>
    <div class="v-big"><span><span class="big">${result.score}</span><span class="muted">/${MAX_SCORE}</span> ${bandBadge(result.band)}</span></div>
    <div class="small">${result.known} of ${result.total} signals known. A high score does not mean the business is qualified.</div>
  </div>
</div>

${section("duplicates", "Duplicate assessment", dupCard)}

${section(
  "know",
  "What we know",
  `<div class="grid-2">
  <div class="card"><div class="card-h">Identity</div><dl class="kv">
    ${fact("Website", c.website ? extLink(c.website) : none)}
    ${fact("Location", place ? esc(place) : none)}
    ${fact("Phone", c.phone ? esc(c.phone) : none, c.phone ? c.phoneSourceUrl : null)}
    ${fact("Email", c.email ? esc(c.email) : none, c.email ? c.emailSourceUrl : null)}
  </dl></div>
  <div class="card"><div class="card-h">Discovery provenance</div><dl class="kv">
    ${fact("Provider", esc(c.provider))}
    ${c.externalId ? fact("Provider ID", esc(c.externalId)) : ""}
    ${fact("Source", c.sourceUrl ? extLink(c.sourceUrl) : none)}
    ${fact("Search", c.query ? esc(c.query) : none)}
    ${fact("Discovered", fmtDate(c.discoveredAt))}
    ${c.run ? fact("Run", esc([c.run.city, c.run.region].filter(Boolean).join(", "))) : ""}
  </dl></div>
</div>
<div class="scroll" style="margin-top:14px"><table class="tbl cards">
<caption class="sr-only">Signals recorded for this candidate</caption>
<thead><tr><th scope="col">Signal</th><th scope="col">Observed</th><th scope="col" class="num">Points</th><th scope="col">Source</th></tr></thead>
<tbody>${knownRows || `<tr><td colspan="4" class="muted">No signals recorded yet.</td></tr>`}</tbody>
</table></div>`,
)}

${section(
  "dont-know",
  "What we don't know",
  `<div class="card">
  <p class="small" style="margin-top:0">${unknown.length} of ${result.total} signals are unknown (${missingPoints} points not yet established). Unknown adds nothing to the score and is never counted against the business.</p>
  <ul class="plain">${unknownItems || `<li class="muted">Nothing unknown.</li>`}</ul>
</div>`,
)}

${section(
  "evidence",
  "Evidence",
  `${evidenceCards}
<div class="card" style="margin-top:14px"><div class="card-h">Where each fact came from</div>${sourceRows ? `<ul class="plain">${sourceRows}</ul>` : `<p class="small muted" style="margin:0">No sources recorded yet.</p>`}</div>
${
  frozen
    ? ""
    : `<form method="post" action="/admin/discovery/candidates/${id}/evidence" class="card stack" style="margin-top:14px" novalidate>
  <div class="card-h" style="margin:0">Add evidence</div>
  <div class="fields">
    <div class="field"><label for="f-signalKey">Supports signal</label><select id="f-signalKey" name="signalKey"${fe.byField.has("signalKey") ? ' aria-invalid="true"' : ""}>${options([["", "Choose…"], ...SIGNAL_DEFS.map((d): [string, string] => [d.key, d.label])], values.signalKey)}</select>${fieldErr("signalKey")}</div>
    <div class="field"><label for="f-sourceUrl">Public source URL</label><input id="f-sourceUrl" type="text" name="sourceUrl" value="${esc(values.sourceUrl)}" maxlength="${FIELD_LIMITS.sourceUrl}"${fe.byField.has("sourceUrl") ? ' aria-invalid="true"' : ""}>${fieldErr("sourceUrl")}</div>
  </div>
  <div class="field"><label for="f-excerpt">Short excerpt</label><textarea id="f-excerpt" name="excerpt" maxlength="${FIELD_LIMITS.excerpt}"${fe.byField.has("excerpt") ? ' aria-invalid="true"' : ""}>${esc(values.excerpt)}</textarea><div class="hint">Up to ${FIELD_LIMITS.excerpt} characters: a short quote, not a copied page.</div>${fieldErr("excerpt")}</div>
  <div><button type="submit">Add evidence</button></div>
</form>`
}`,
)}

${section(
  "state",
  "Research state",
  `<div class="card">${stepper(RESEARCH_PATH, CANDIDATE_STATUS_LABELS, RESEARCH_PATH.includes(c.status) ? c.status : "")}
<p style="margin:0 0 10px">${candidateBadge(c.status)} <span class="small muted">${esc(CANDIDATE_STATUS_MEANINGS[c.status])}</span></p>
${statusForm}
${c.decisionReason ? `<p class="small" style="margin-top:10px">Decision: ${esc(c.decisionReason)}${c.decidedAt ? ` <span class="muted">(${fmtDate(c.decidedAt)})</span>` : ""}</p>` : ""}${c.researchedAt ? `<p class="small muted" style="margin-top:6px">Researched ${fmtDate(c.researchedAt)}</p>` : ""}</div>`,
)}

${section("approval", "Approval", approveCard)}

${section(
  "notes",
  "Research notes",
  `<div class="card">
  ${
    frozen
      ? ""
      : `<form method="post" action="/admin/discovery/candidates/${id}/notes" class="stack" novalidate>
    <div class="field"><label for="f-body">Add a note</label><textarea id="f-body" name="body" maxlength="${FIELD_LIMITS.note}"${fe.byField.has("body") ? ' aria-invalid="true"' : ""}>${esc(values.body)}</textarea><div class="hint">Business facts only; no personal details. Notes can't be edited or removed.</div>${fieldErr("body")}</div>
    <div><button type="submit">Add note</button></div>
  </form>`
  }
  <div style="margin-top:${frozen ? 0 : 14}px">${c.notes.map((n) => `<div class="note"><div class="when">${fmtDate(n.createdAt)}</div><div class="body">${esc(n.body)}</div></div>`).join("") || emptyState("No research notes yet.")}</div>
</div>`,
)}`,
  );
}
