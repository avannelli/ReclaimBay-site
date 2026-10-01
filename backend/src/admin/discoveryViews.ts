import type { candidateStatusCounts, getCandidateDetail, listCandidates, recentRuns } from "../discovery/service.js";
import type { recentImports } from "../discovery/staging.js";
import { OUTCOME_LABELS, type ResearchOutcome } from "../research/researcher.js";
import type { candidateResearch, researchQueue } from "../research/service.js";
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
import { TIER_LABELS } from "../discovery/categories.js";
import type { CategoryTier } from "../discovery/types.js";
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
type Imports = Awaited<ReturnType<typeof recentImports>>;
type ResearchView = Awaited<ReturnType<typeof candidateResearch>>;
type ResearchQueue = Awaited<ReturnType<typeof researchQueue>>;
type StatusCounts = Awaited<ReturnType<typeof candidateStatusCounts>>;

const SIGNAL_DEFS = SIGNALS as readonly SignalDefinition[];
/** Short labels so the sort menu fits its column. */
const SORT_LABELS: Record<string, string> = { score: "Score", discovered: "Newest", name: "Name" };

// ---------- automated research ----------

const outcomeLabel = (o: string | null) => (o && o in OUTCOME_LABELS ? OUTCOME_LABELS[o as ResearchOutcome] : (o ?? "—"));

/** The research state of a candidate in one tag. */
function researchTag(r: { status: string; outcome: string | null } | undefined): string {
  if (!r) return "";
  const label =
    r.status === "queued" || r.status === "running"
      ? "Research running"
      : r.status === "failed"
        ? "Research failed"
        : `Research: ${outcomeLabel(r.outcome)}`;
  const style = r.status === "failed" || r.outcome === "website_mismatch" ? ' style="border-color:var(--neg);color:var(--neg)"' : "";
  return `<div class="sub"><span class="tag"${style}>${esc(label)}</span></div>`;
}

const FACT_LABELS: Record<string, string> = {
  website: "Website",
  business_name: "Business name",
  address: "Address",
  phone: "Phone (on the website)",
  provider_phone: "Provider phone",
  email: "Email",
  services: "Services",
  performs_repair: "Performs repair",
  business_type: "Business type",
  operating_status: "Operating status",
};

/** Verification state, in words and shape as well as colour. */
const FACT_STATE: Record<string, string> = {
  verified: '<span class="obs obs-yes">Verified</span>',
  unverified: '<span class="tag" style="border-color:var(--amber);color:var(--warn)">Provider-reported · unverified</span>',
  uncertain: '<span class="obs obs-unknown">Uncertain</span>',
  not_found: '<span class="tag">Not found</span>',
};

const FACT_GROUPS: [string, string, string][] = [
  ["verified", "Verified", "Confirmed on the business's own website, with the page as the source."],
  ["unverified", "Provider-reported · unverified", "Reported by the discovery provider and not confirmed. Never used as contact."],
  ["uncertain", "Uncertain", "Sources disagree, or the evidence is too weak to decide. Check by hand."],
  ["not_found", "Not found", "Looked for and not found on the pages read."],
];

function researchSection(research: ResearchView | undefined, candidateId: string, canRun: boolean): string {
  const latest = research?.latest ?? null;
  const pending = research?.pending ?? null;
  const id = esc(candidateId);
  const status = pending
    ? `<span class="tag">${pending.status === "running" ? "Running" : "Queued"}</span> <span class="small muted">since ${fmtDate(pending.startedAt ?? pending.queuedAt)}. Refresh to see the results.</span>`
    : latest
      ? `${latest.status === "failed" ? '<span class="tag" style="border-color:var(--neg);color:var(--neg)">✕ Failed</span>' : '<span class="tag">Completed</span>'} <b>${esc(outcomeLabel(latest.outcome))}</b> <span class="small muted">· ${fmtDate(latest.finishedAt ?? latest.queuedAt)} · rules ${esc(latest.version)} · ${latest.pagesFetched} page${latest.pagesFetched === 1 ? "" : "s"} read</span>`
      : '<span class="small muted">Not researched yet.</span>';
  const button = canRun
    ? `<form method="post" action="/admin/discovery/candidates/${id}/research" class="inline-form"><button type="submit"${pending ? " disabled" : ""}>${latest ? "Run research again" : "Run research"}</button></form>`
    : "";
  const warnings = (Array.isArray(latest?.warnings) ? (latest.warnings as string[]) : []).map((w) => `<li>${esc(w)}</li>`).join("");
  const head = `<div class="card">
  <div class="row spread"><div>${status}</div>${button}</div>
  <p class="small muted" style="margin:8px 0 0">Reads the business's own website (at most 5 pages; robots.txt respected; nothing stored but the facts, a short quote, and the URL). A phone or email is verified only when it appears on a website confirmed as the business's own. Research never approves a candidate or contacts anyone.</p>
  ${latest?.error ? `<div class="callout warn" style="margin-top:10px">${esc(latest.error)}</div>` : ""}
  ${warnings ? `<div class="callout warn" style="margin-top:10px"><b>Check by hand</b><ul class="plain small" style="margin:4px 0 0">${warnings}</ul></div>` : ""}
</div>`;
  if (!latest) return head;

  const factItem = (f: ResearchView["runs"][number]["facts"][number]) => {
    const src = f.source?.finalUrl ?? f.source?.url ?? null;
    return `<li style="margin:0 0 10px"><b>${esc(FACT_LABELS[f.field] ?? f.field.replace(/_/g, " "))}</b> ${FACT_STATE[f.state] ?? ""}
<div>${f.value ? (f.field === "website" && /^https?:/.test(f.value) ? extLink(f.value) : esc(f.value)) : '<span class="muted">—</span>'}</div>
${f.excerpt ? `<div class="small">“${esc(f.excerpt)}”</div>` : ""}${src ? `<div class="src">source: ${extLink(src)}</div>` : ""}${f.note ? `<div class="small muted">${esc(f.note)}</div>` : ""}</li>`;
  };
  const groups = FACT_GROUPS.map(([state, title, hint]) => {
    const items = latest.facts.filter((f) => f.state === state);
    return `<div class="card"><div class="card-h">${esc(title)} (${items.length})</div><p class="small muted" style="margin:0 0 8px">${esc(hint)}</p>${
      items.length ? `<ul class="plain">${items.map(factItem).join("")}</ul>` : '<p class="small muted" style="margin:0">None.</p>'
    }</div>`;
  }).join("");

  const sources = latest.sources
    .map(
      (src) => `<tr><td>${extLink(src.url)}${src.finalUrl && src.finalUrl !== src.url ? `<div class="sub">→ ${esc(src.finalUrl)}</div>` : ""}</td>
<td data-label="Kind">${esc(src.kind.replace("_", " "))}</td>
<td data-label="Result">${src.ok ? '<span class="obs obs-yes">OK</span>' : '<span class="obs obs-no">Not used</span>'}${src.httpStatus ? ` <span class="small muted">HTTP ${src.httpStatus}</span>` : ""}${src.note ? `<div class="sub">${esc(src.note)}</div>` : ""}</td>
<td class="small hide-md" data-label="Fetched">${fmtDate(src.fetchedAt)}</td></tr>`,
    )
    .join("");
  const history = (research?.runs ?? [])
    .map(
      (r) => `<li>${fmtDate(r.queuedAt)} · ${esc(r.trigger)} · ${esc(r.status)}${r.outcome ? ` · ${esc(outcomeLabel(r.outcome))}` : ""}${r.error ? ` <span class="small muted">(${esc(r.error)})</span>` : ""}</li>`,
    )
    .join("");
  return `${head}
<div class="grid-2" style="margin-top:14px">${groups}</div>
<div class="scroll" style="margin-top:14px"><table class="tbl cards">
<caption class="sr-only">URLs requested by the latest research run</caption>
<thead><tr><th scope="col">Source URL</th><th scope="col">Kind</th><th scope="col">Result</th><th scope="col" class="hide-md">Fetched</th></tr></thead>
<tbody>${sources || `<tr><td colspan="4" class="muted">No URL was requested.</td></tr>`}</tbody>
</table></div>
<div class="card" style="margin-top:14px"><div class="card-h">Research history</div><ul class="plain small">${history}</ul></div>`;
}

/** What an import read and left out, from its stats (only counters that are present). */
const IMPORT_COUNTERS: [string, string][] = [
  ["read", "read"],
  ["outside_area", "outside the area"],
  ["excluded_automotive", "excluded automotive categories"],
  ["alternate_only", "repair only as an alternate category"],
  ["not_automotive", "not automotive"],
  ["no_category", "no category"],
  ["malformed", "malformed"],
  ["repeatedId", "repeated IDs"],
];

const importRow = (providerLabel: (name: string) => string) => (i: Imports[number]) => {
  const stats = (i.stats ?? {}) as Record<string, unknown>;
  const counts = IMPORT_COUNTERS.filter(([k]) => typeof stats[k] === "number" && (k === "read" || (stats[k] as number) > 0)).map(
    ([k, label]) => `${(stats[k] as number).toLocaleString("en-US")} ${label}`,
  );
  const status =
    i.status === "failed"
      ? `<span class="tag" style="border-color:var(--neg);color:var(--neg)">✕ Failed</span><div class="sub">${esc(i.error ?? "")}</div>`
      : i.status === "running"
        ? `<span class="tag">Running</span>`
        : `<span class="tag">Completed</span>${i.recordCount > 0 && i._count.places === 0 ? `<div class="sub">rows pruned (only the newest imports keep their rows)</div>` : ""}`;
  return `<tr>
  <td><b>${esc(i.area ?? i.scope)}</b><div class="sub">release ${esc(i.release)}</div></td>
  <td data-label="Provider">${esc(providerLabel(i.provider))}</td>
  <td class="num" data-label="Staged"><b>${i.recordCount.toLocaleString("en-US")}</b>${counts.length ? `<div class="sub">${esc(counts.join(" · "))}</div>` : ""}</td>
  <td data-label="Status">${status}</td>
  <td class="small hide-md" data-label="Started">${fmtDate(i.startedAt)}${i.finishedAt ? `<div class="sub">finished ${fmtDate(i.finishedAt)}</div>` : ""}</td>
</tr>`;
};

/** Provider category tier: a discovery filter, never a qualification verdict. */
function tierTag(tier: CategoryTier | null, inline = false): string {
  if (!tier) return "";
  const tag = `<span class="tag" title="Discovery filter only, not qualification">${esc(TIER_LABELS[tier])}</span>`;
  return inline ? ` ${tag}` : `<div class="sub">${tag}</div>`;
}

// ---------- overview ----------

export function discoveryPage(opts: {
  providers: { name: string; label: string; background?: boolean }[];
  list: ListResult;
  runs: Runs;
  runCount: number;
  imports: Imports;
  research?: ResearchQueue;
  statusCounts: StatusCounts;
  filters: Values;
  values?: Values;
  notice?: string;
  errors?: string[];
}): string {
  const { providers, list, runs, runCount, imports, statusCounts, filters: f, values = {} } = opts;
  const providerLabel = (name: string) => providers.find((p) => p.name === name)?.label ?? name;
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
    <div><label class="lbl" for="f-tiers">Categories</label><select id="f-tiers" name="tiers">${options([["core", "Core repair categories"], ["core,adjacent", "Core + adjacent categories"]], values.tiers)}</select></div>
  </div>
  <div class="row"><button type="submit">Run discovery</button><span class="small muted">Finds candidates for you to review. Nothing becomes a prospect on its own. Categories are a discovery filter, not qualification.${providers.some((p) => p.background) ? " Staged providers run in the background." : ""}</span></div>
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
  <td><a class="name" href="/admin/discovery/candidates/${esc(c.id)}">${esc(c.businessName)}</a>${c.website ? `<div class="sub">${extLink(c.website)}</div>` : ""}${tierTag(c.categoryTier)}${c.relatedCandidateId || c.relatedProspectId ? `<div class="sub"><span class="tag">Other location shares this website</span></div>` : ""}${c.providerStatus === "permanently_closed" ? `<div class="sub"><span class="tag" style="border-color:var(--neg);color:var(--neg)">Provider says closed</span></div>` : ""}${researchTag(c.research[0])}</td>
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
  <td class="hide-md" data-label="Provider">${esc(providerLabel(r.provider))}${r.import ? `<div class="sub">import: ${esc(r.import.area ?? r.import.scope)}</div>` : ""}</td>
  <td class="small" data-label="Created">${fmtDate(r.createdAt)}</td>
  <td class="num" data-label="New candidates"><b>${r.created}</b><div class="sub">${r.found} found · ${r.duplicates} skipped · ${r.flagged} flagged${r.invalid ? ` · ${r.invalid} unusable` : ""}</div></td>
  <td data-label="Status">${r.status === "failed" ? `<span class="tag" style="border-color:var(--neg);color:var(--neg)">✕ Failed</span><div class="sub">${esc(r.error ?? "")}</div>` : r.status === "running" ? `<span class="tag">Running</span>` : r.status === "queued" ? `<span class="tag">Queued</span>` : `<span class="tag">Completed</span>`}${r.providerRelease ? `<div class="sub">release ${esc(r.providerRelease)}</div>` : ""}${r.tiers.length ? `<div class="sub">${esc(r.tiers.join(" + "))}</div>` : ""}</td>
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
    <div><label class="lbl" for="f-ctier">Category tier</label><select id="f-ctier" name="tier">${options([["", "Any"], ["core", "Core"], ["adjacent", "Adjacent"]], f.tier)}</select></div>
    <div><label class="lbl" for="f-csort">Sort by</label><select id="f-csort" name="sort">${options(Object.keys(CANDIDATE_SORTS).map((k): [string, string] => [k, SORT_LABELS[k] ?? k]), list.sort)}</select></div>
    <div class="filter-actions"><button type="submit">Apply filters</button><a class="btn btn-secondary" href="/admin/discovery">Reset</a></div>
  </div>
  ${f.run ? `<input type="hidden" name="run" value="${esc(f.run)}">` : ""}
</form>
<form method="post" action="/admin/discovery/research" class="card row spread" style="margin-bottom:12px">
  ${(["q", "status", "qualification", "band", "state", "city", "flagged", "tier", "provider", "sort", "run"] as const)
    .map((k) => (f[k] ? `<input type="hidden" name="${k}" value="${esc(f[k])}">` : ""))
    .join("")}
  <span class="small"><b>Automated research</b>${opts.research ? ` · ${opts.research.queued} queued · ${opts.research.running} running · ${opts.research.completed} completed · ${opts.research.failed} failed` : ""}<br><span class="muted">Reads each business's own website and records verified facts with sources. Use filters to choose, then research up to 10 not-yet-researched candidates from this view.</span></span>
  <button type="submit" class="btn-secondary">Research up to 10 in this view</button>
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
<p class="small muted" style="margin-top:8px">Skipped records were confident duplicates of a stored candidate or prospect (the same provider record, or the same business at the same place). Flagged records were possible duplicates, kept for you to review. Other locations of a business are kept and linked.</p>`
    : `<div class="card">${emptyState("No discovery runs yet.", providers.length ? "Use “New discovery run” to search a region for candidate businesses." : "When a provider is configured, runs will appear here. You can add candidates by hand meanwhile.")}</div>`,
)}

${section(
  "imports",
  "Provider imports",
  imports.length
    ? `<div class="scroll"><table class="tbl cards">
<caption class="sr-only">Recent provider imports</caption>
<thead><tr><th scope="col">Area</th><th scope="col">Provider</th><th scope="col" class="num">Staged</th><th scope="col">Status</th><th scope="col" class="hide-md">Started</th></tr></thead>
<tbody>${imports.map(importRow(providerLabel)).join("")}</tbody>
</table></div>
<p class="small muted" style="margin-top:8px">Imports run in the background (<code>npm run discovery:import</code>) and stage a provider release for runs to read. Nothing here creates candidates or prospects.</p>`
    : `<div class="card">${emptyState("No provider imports yet.", "Imports are run in the background with npm run discovery:import; see DISCOVERY.md.")}</div>`,
)}`,
  );
}

// ---------- add / edit form ----------

export function candidateFormPage(
  opts: { mode: "new" } | { mode: "edit"; id: string; name: string; providerPhone?: string | null },
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
${editing && opts.providerPhone ? `<div class="callout warn" style="margin-bottom:14px">The provider reported <b>${esc(opts.providerPhone)}</b> (unverified). Enter it as the business phone only after you find it on the business's own website, and give that page as its source.</div>` : ""}
<form method="post" action="${action}" class="stack" novalidate>
  ${businessSections(values, fe)}
  ${editing ? signalSections(values, fe) : ""}
  <div class="form-foot"><button type="submit" class="btn-primary-lg">${editing ? "Save research" : "Add candidate"}</button><a class="btn btn-secondary btn-primary-lg" href="${back}">Cancel</a></div>
</form>`,
  );
}

// ---------- detail ----------

const RESEARCH_PATH: CandidateStatus[] = ["discovered", "researching", "researched", "approved"];

export function candidateDetailPage(opts: { detail: Detail; research?: ResearchView; notice?: string; errors?: string[]; values?: Values }): string {
  const { detail, values = {} } = opts;
  const { candidate: c, result, dupCandidate, dupProspect, relCandidate, relProspect, approvalBlockers } = detail;
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
      const byResearch = c.signals.find((x) => x.key === s.key)?.origin === "research";
      const source =
        s.derived && s.state === "yes"
          ? `<span class="small muted">Derived from the stored website or public contact.</span>`
          : n
            ? `<a href="#evidence">${n} evidence item${n === 1 ? "" : "s"}</a>`
            : `<span class="tag" style="border-color:var(--amber);color:var(--warn)">! No evidence yet</span>`;
      return `<tr><td><b>${esc(s.label)}</b><div class="sub">${def.requiredCriterion ? '<span class="kind req">Required criterion</span>' : '<span class="kind">Opportunity signal</span>'}</div></td>
<td data-label="Observed">${obsBadge(s.state)}${byResearch ? '<div class="sub"><span class="tag">Set by research</span></div>' : ""}</td><td class="num" data-label="Points"><span class="score-cell"><b>${s.points}</b><span class="of">/${s.weight}</span></span></td><td data-label="Source">${source}</td></tr>`;
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
  <div class="row spread"><span><span class="kind">Signal</span> <b>${esc(signalLabel(e.signalKey))}</b>${e.origin === "research" ? ' <span class="tag">Automated research</span>' : ""}</span>${
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
    : `<div class="card"><b>No duplicate flags</b><p class="small muted" style="margin:6px 0 0">When this candidate was stored, nothing matched an existing candidate or prospect on provider ID, website and location, phone, or name and location.</p></div>`;
  const relItems = [
    relCandidate && `<li>Candidate <a href="/admin/discovery/candidates/${esc(relCandidate.id)}">${esc(relCandidate.businessName)}</a>${relCandidate.city ? ` in ${esc(relCandidate.city)}` : ""}</li>`,
    relProspect && `<li>Prospect <a href="/admin/prospects/${esc(relProspect.id)}">${esc(relProspect.businessName ?? "Unnamed")}</a>${relProspect.city ? ` in ${esc(relProspect.city)}` : ""}</li>`,
  ].filter(Boolean);
  const relCard = relItems.length
    ? `<div class="card" style="margin-top:12px"><b>Other location of the same business or chain</b>
<p class="small" style="margin:6px 0">${esc(c.relationReason ?? "Shares this website")}. This is a separate location, so it was kept. It may mean a multi-location business or a chain; check ownership during research. It is not evidence either way on its own.</p>
<ul class="plain small">${relItems.join("")}</ul></div>`
    : "";

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

${section("research", "Automated research", researchSection(opts.research, c.id, !["approved", "rejected", "duplicate"].includes(c.status)))}

${section("duplicates", "Duplicate assessment", dupCard + relCard)}

${section(
  "know",
  "What we know",
  `<div class="grid-2">
  <div class="card"><div class="card-h">Identity</div><dl class="kv">
    ${fact("Website", c.website ? `${extLink(c.website)}${c.provider !== "manual" ? `<div class="src">Reported by ${esc(c.provider)}, unverified. Research confirms whether it is the business&#39;s own site.</div>` : ""}` : none)}
    ${fact("Street", c.streetAddress ? esc(c.streetAddress) : none)}
    ${fact("Location", place ? esc(place) : none)}
    ${c.latitude !== null && c.longitude !== null ? fact("Position", `<span class="small">${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}</span>`) : ""}
    ${fact("Phone", c.phone ? `${esc(c.phone)} <span class="tag">Verified business contact</span>` : none, c.phone ? c.phoneSourceUrl : null)}
    ${c.providerPhone ? fact("Provider phone", `${esc(c.providerPhone)} <span class="tag" style="border-color:var(--amber);color:var(--warn)">Unverified</span><div class="src">Reported by ${esc(c.provider)}. Not used for contact until research finds it on the business's own website.</div>`) : ""}
    ${fact("Email", c.email ? esc(c.email) : none, c.email ? c.emailSourceUrl : null)}
  </dl></div>
  <div class="card"><div class="card-h">Discovery provenance</div><dl class="kv">
    ${fact("Provider", esc(c.provider === "overture" ? "Overture Maps Places" : c.provider))}
    ${c.externalId ? fact(c.provider === "overture" ? "GERS ID" : "Provider ID", `${esc(c.externalId)}${c.provider === "overture" ? `<div class="src">Overture's stable place ID. It identifies the place; it says nothing about ownership or fit.</div>` : ""}`) : ""}
    ${fact("Source", c.sourceUrl ? extLink(c.sourceUrl) : none)}
    ${fact("Search", c.query ? esc(c.query) : none)}
    ${fact("Discovered", fmtDate(c.discoveredAt))}
    ${c.run ? fact("Run", esc([c.run.city, c.run.region].filter(Boolean).join(", "))) : ""}
    ${c.providerRelease ? fact("Release", esc(c.providerRelease)) : ""}
    ${c.providerCategory || c.categoryTier ? fact("Category", `${esc(c.providerCategory ?? "—")}${tierTag(c.categoryTier, true)}`) : ""}
    ${c.providerBrand ? fact("Brand", `${esc(c.providerBrand)}<div class="src">As the provider reports it. A brand suggests a chain; missing brand data proves nothing.</div>`) : ""}
    ${c.providerConfidence !== null ? fact("Confidence", `${Math.round(c.providerConfidence * 100)}% <span class="small muted">provider's own score</span>`) : ""}
    ${c.providerStatus ? fact("Operating", `${esc(c.providerStatus.replace(/_/g, " "))} <span class="small muted">per provider, unverified</span>`) : ""}
    ${c.providerRetrievedAt ? fact("Retrieved", fmtDate(c.providerRetrievedAt)) : ""}
    ${c.providerSources ? fact("Upstream sources", `${esc(c.providerSources)}${c.provider === "overture" ? `<div class="src">Data: Overture Maps Foundation, overturemaps.org</div>` : ""}`) : ""}
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
