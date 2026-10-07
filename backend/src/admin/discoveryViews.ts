import type { AiDecisionRow } from "../ai/records.js";
import { aiShadowSection, aiShadowSummary } from "./aiViews.js";
import type { getCandidateDetail, queuePosition, recentRuns, reviewQueue, QueueItem, QueueView } from "../discovery/service.js";
import { ACTION_LABELS, ACTIVE_LANES, LANE_HINTS, LANE_LABELS, STEP_GLYPHS, STEP_LABELS, STEP_TONE, stepReason, type Lane } from "../discovery/workQueue.js";
import type { recentImports } from "../discovery/staging.js";
import { OUTCOME_LABELS, type ResearchOutcome } from "../research/researcher.js";
import type { automaticResearchStatus, candidateResearch, researchQueue } from "../research/service.js";
import { CANDIDATE_SORTS, DEFAULT_BUSINESS_TYPE } from "../discovery/service.js";
import { AUTO_APPROVAL_LABELS, AUTO_APPROVAL_RULES, isAutoApproved } from "../discovery/autoApproval.js";
import { CATEGORY_RULES } from "../discovery/categories.js";
import { CATEGORY_SOURCE_LABELS, CATEGORY_VERDICTS, CATEGORY_VERDICT_LABELS, type CategorySource, type CategoryVerdict } from "../discovery/categoryCheck.js";
import {
  CANDIDATE_REASON_REQUIRED,
  CANDIDATE_STATUSES,
  CANDIDATE_STATUS_LABELS,
  CANDIDATE_STATUS_MEANINGS,
  CANDIDATE_TRANSITIONS,
  type CandidateStatus,
} from "../discovery/candidateStatus.js";
import { distanceMeters } from "../discovery/dedupe.js";
import { DUPLICATE_STATE_LABELS, duplicatePending, duplicateState, matchReasons } from "../discovery/duplicateReview.js";
import { FIELD_LIMITS } from "../prospects.js";
import { MAX_SCORE, QUALIFICATION_LABELS, REQUIRED_CRITERIA, SIGNALS, type Qualification, type SignalDefinition, type SignalState } from "../scoring.js";
import { TIER_LABELS } from "../discovery/categories.js";
import type { CategoryTier } from "../discovery/types.js";
import { businessSections, criteriaNames, signalSections } from "./prospectViews.js";
import { appPage } from "./views.js";
import {
  candidateBadge,
  crumbs,
  emptyState,
  errorSummary,
  esc,
  extLink,
  fieldErrors,
  fmtDate,
  fmtDay,
  obsBadge,
  options,
  pageHead,
  signalLabel,
  stepper,
} from "./ui.js";

/* Admin pages for discovery. Server-rendered, no scripts, all values escaped. */

type Values = Record<string, string | undefined>;
type Queue = Awaited<ReturnType<typeof reviewQueue>>;
type Position = Awaited<ReturnType<typeof queuePosition>>;
type Detail = NonNullable<Awaited<ReturnType<typeof getCandidateDetail>>>;
type Runs = Awaited<ReturnType<typeof recentRuns>>;
type Imports = Awaited<ReturnType<typeof recentImports>>;
type ResearchView = Awaited<ReturnType<typeof candidateResearch>>;
type ResearchQueue = Awaited<ReturnType<typeof researchQueue>>;
type AutoResearchStatus = Awaited<ReturnType<typeof automaticResearchStatus>>;

const SIGNAL_DEFS = SIGNALS as readonly SignalDefinition[];
/** Short labels so the sort menu fits its column. */
const SORT_LABELS: Record<string, string> = { score: "Score", discovered: "Newest", name: "Name" };

// ---------- automated research ----------

const outcomeLabel = (o: string | null) => (o && o in OUTCOME_LABELS ? OUTCOME_LABELS[o as ResearchOutcome] : (o ?? "—"));

/** The research state of a candidate in one tag. */
function researchTag(r: { status: string; outcome: string | null } | undefined): string {
  if (!r) return "";
  const label =
    r.status === "queued"
      ? "Research queued"
      : r.status === "running"
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
  business_category: "Category check (website)",
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

// ---------- category check (not qualification) ----------

const CATEGORY_STYLE: Record<CategoryVerdict, string> = {
  in_target: "border-color:var(--pos);color:var(--pos)",
  wrong_category: "border-color:var(--neg);color:var(--neg)",
  unclear: "border-color:var(--amber);color:var(--warn)",
};
const CATEGORY_MARK: Record<CategoryVerdict, string> = { in_target: "✓", wrong_category: "✕", unclear: "?" };

/** The category check in one tag: words and a mark, not colour alone. */
function categoryTag(verdict: string | null, source?: string | null): string {
  if (!verdict) return `<span class="tag" title="Category check: not run yet">Category not checked</span>`;
  const v = verdict as CategoryVerdict;
  const by = source === "manual" ? " · set by a person" : "";
  return `<span class="tag" style="${CATEGORY_STYLE[v]}" title="Category check, not qualification">${CATEGORY_MARK[v]} ${esc(CATEGORY_VERDICT_LABELS[v])}${by}</span>`;
}

const NOT_SCORED = "Not scored: outside the target category";

// ---------- the work queue ----------

/** Quick views, in the order a person works through them. */
const VIEW_CHIPS: [QueueView, string][] = [
  ["all", "All"],
  ["decision", "Needs decision"],
  ["duplicates", "Possible duplicates"],
  ["ready", "Ready to approve"],
  ["verify", "Needs verification"],
  ["research", "Needs research"],
  ["disregarded", "Disregarded"],
  ["completed", "Completed"],
];

const LANE_TONE: Record<Lane, "warn" | "pos" | "info" | "quiet"> = { decision: "warn", ready: "pos", verify: "warn", research: "info", handled: "quiet" };
const LANE_GLYPH: Record<Lane, string> = { decision: "⚠", ready: "✓", verify: "?", research: "◔", handled: "—" };

const QUAL_SHORT: Record<Qualification, [Tone, string, string]> = {
  meets_criteria: ["pos", "✓", "Qualified"],
  unverified: ["warn", "⚠", "Needs verification"],
  disqualified: ["neg", "✕", "Does not qualify"],
};

/** The one primary action of a queue row, sized by what it does. */
function queueAction(item: QueueItem, view: QueueView): string {
  const c = item.candidate;
  const id = esc(c.id);
  const href = `/admin/discovery/candidates/${id}`;
  const back = `<input type="hidden" name="from" value="queue">${view === "all" ? "" : `<input type="hidden" name="view" value="${esc(view)}">`}`;
  const label = ACTION_LABELS[item.step.action];
  // The business name for screen readers, so every row's button is distinguishable.
  const named = (verb: string) => `${verb}<span class="sr-only">: ${esc(c.businessName)}</span>`;
  switch (item.step.action) {
    case "approve":
      return `<form method="post" action="${href}/approve" class="inline-form">${back}<button type="submit" class="btn-go">✓ ${named(label)}</button></form>`;
    case "run_research":
      return `<form method="post" action="${href}/research" class="inline-form">${back}<button type="submit">▶ ${named(label)}</button></form>`;
    case "review_duplicate":
      return `<a class="btn" href="${href}#dup-h">${named(label)}</a>`;
    case "verify":
      return `<a class="btn" href="${href}/edit${item.step.criterion ? `#sig-${esc(item.step.criterion)}` : ""}">${named(label)}</a>`;
    case "disregard":
      return `<a class="btn btn-danger" href="${href}?act=disregard#dec-h">${named(label)}</a>`;
    case "review":
      return `<a class="btn" href="${href}">${named(label)}</a>`;
    case "wait":
      return `<span class="q-wait">◔ ${esc(label)}</span>`;
    case "open":
      return `<a class="btn btn-ghost" href="${href}">${named(label)}</a>`;
  }
}

/**
 * What the automation decided, above the lanes: most businesses are approved
 * or rejected by the rules (approval@a1, rejection@r1), so Review is the
 * exception a person handles.
 */
function automationSummary(a: Queue["automation"]): string {
  const item = (label: string, n: number, sub?: string) => `<div><dt>${esc(label)}${sub ? ` <span style="font-weight:400">${esc(sub)}</span>` : ""}</dt><dd>${n}</dd></div>`;
  return `<section aria-label="What the automation decided" style="margin-bottom:16px"><dl class="metrics">
${item("Auto-approved", a.autoApproved, a.approved > a.autoApproved ? `(+${a.approved - a.autoApproved} by a person)` : undefined)}
${item("Review", a.review, "a person decides")}
${item("Rejected", a.rejected, a.autoRejected ? `(${a.autoRejected} automatically)` : undefined)}
${item("Researching", a.researching)}
${item("Not researched", a.notResearched)}
</dl></section>`;
}

/** The automatic research worker's state, from the runs it queued; amber when candidates wait but it hasn't run within the hour. */
function autoResearchLine(a: AutoResearchStatus): string {
  const line = `<b>Automatic research:</b> last run ${a.lastRunAt ? fmtDate(a.lastRunAt) : "never"} · ${a.researched24h} researched, ${a.failed24h} failed in the last 24 hours · waiting: ${a.waitingFresh} new, ${a.waitingRetries} to retry`;
  return a.stale
    ? `<section aria-label="Automatic research" class="callout warn" style="margin-bottom:16px">${line}<div class="small">Candidates are waiting, but automatic research hasn't run in the last hour. Check the scheduled research service.</div></section>`
    : `<section aria-label="Automatic research" class="small muted" style="margin:-8px 0 16px">${line}</section>`;
}

function queueRow(item: QueueItem, view: QueueView): string {
  const { candidate: c, result, outsideTarget, step } = item;
  const tone = STEP_TONE[step.kind];
  // City and state are provider or user text: escaped like everything else (extLink escapes the website).
  const where = [esc([c.city, c.state].filter(Boolean).join(", ")), c.website ? extLink(c.website) : ""].filter(Boolean).join(" · ");
  const [qt, qg, ql] = QUAL_SHORT[result.qualification];
  // Before research, unknown criteria are expected: say so quietly instead of warning on every row.
  const qualification = outsideTarget
    ? verdict("quiet", "—", "Not assessed", "sub")
    : step.lane === "research" && result.qualification === "unverified"
      ? verdict("quiet", "?", "Not checked yet", "sub")
      : verdict(qt, qg, ql, "sub");
  const why = stepReason(step, {
    duplicateReasonText: matchReasons(c.duplicateReason).map((r) => r.text).join("; ") || null,
    categoryReason: c.categoryReason,
    unverifiedCriteria: result.unverifiedCriteria,
    disqualifiedBy: result.disqualifiedBy,
    latestOutcome: c.research[0]?.outcome ?? null,
    decisionReason: c.decisionReason,
    automatic: isAutoApproved(c),
  });
  // Ready to approve: a person approves it because the automatic rule held it. Say why.
  const reason = step.kind === "ready" && item.held ? `Automatic approval held it: ${item.held.replace(/\.$/, "")}.` : why;
  // Recorded research and evidence remain distinct from qualification and ranking.
  const latest = c.research[0];
  const meta = [
    outsideTarget ? `<span>${NOT_SCORED}</span>` : `<span>Opportunity ${result.score}/${MAX_SCORE} <span class="muted">(ranking only)</span></span>`,
    `<a href="/admin/discovery/candidates/${esc(c.id)}#evidence">${c._count.evidence} evidence record${c._count.evidence === 1 ? "" : "s"}</a>`,
    latest
      ? `<a class="q-research-link" href="/admin/discovery/candidates/${esc(c.id)}#research">${researchTag(latest).replace('<div class="sub">', "").replace(/<\/div>$/, "")}</a>`
      : '<span class="muted">Not researched yet</span>',
    c.categoryTier && c.categoryTier !== "core" ? tierTag(c.categoryTier, true).trim() : "",
    c.relatedCandidateId || c.relatedProspectId ? '<span class="tag">Other location shares this website</span>' : "",
    c.status === "approved" ? `<span class="tag">${isAutoApproved(c) ? "Approved automatically" : "Approved by a person"}</span>` : "",
  ].filter(Boolean);
  return `<li class="q-row t-${tone}" id="c-${esc(c.id)}">
  <div class="q-id"><h3 class="q-name"><a href="/admin/discovery/candidates/${esc(c.id)}">${esc(c.businessName)}</a></h3>${where ? `<div class="q-where">${where}</div>` : ""}</div>
  <div class="q-state">${verdict(tone, STEP_GLYPHS[step.kind], STEP_LABELS[step.kind])}<p class="q-why">${esc(reason)}</p></div>
  <div class="q-qual"><span class="q-k">Qualification</span>${qualification}</div>
  <div class="q-act">${queueAction(item, view)}</div>
  <div class="q-meta">${meta.join('<span class="q-dot" aria-hidden="true">·</span>')}</div>
</li>`;
}

export function discoveryPage(opts: {
  providers: { name: string; label: string; background?: boolean }[];
  queue: Queue;
  runs: Runs;
  runCount: number;
  imports: Imports;
  research?: ResearchQueue;
  autoResearch?: AutoResearchStatus;
  filters: Values;
  values?: Values;
  notice?: string;
  noticeLink?: { href: string; label: string };
  errors?: string[];
}): string {
  const { providers, queue, runs, runCount, imports, filters: f, values = {} } = opts;
  const { counts, view, automation } = queue;
  const providerLabel = (name: string) => providers.find((p) => p.name === name)?.label ?? name;
  const fe = fieldErrors(opts.errors);
  const advanced = Boolean(f.status || f.qualification || f.band || f.state || f.city || f.flagged || f.tier || f.category || f.provider || (f.sort && f.sort !== "discovered"));
  const anyFilter = Boolean(f.q || f.run || advanced);
  // Filters carried by every queue link, so switching views keeps the search.
  const keep = (["q", "status", "qualification", "band", "state", "city", "flagged", "tier", "category", "provider", "sort", "run"] as const)
    .filter((k) => f[k])
    .map((k) => `${k}=${encodeURIComponent(f[k]!)}`);
  const viewHref = (v: QueueView) => {
    const qs = [...(v === "all" ? [] : [`view=${v}`]), ...keep].join("&");
    return `/admin/discovery${qs ? `?${qs}` : ""}`;
  };

  const lede =
    counts.all === 0 && !anyFilter
      ? "Find businesses, check them, and decide which become prospects."
      : counts.active
        ? `<b>${counts.active} ${counts.active === 1 ? "business needs" : "businesses need"} your attention</b>${anyFilter ? " in this search" : ""}. Start with decisions, then approvals.`
        : `<b>Nothing needs your attention${anyFilter ? " in this search" : ""}.</b> Every candidate here has been handled.`;

  // Every active lane is also a queue view.
  const tile = (lane: Exclude<Lane, "handled">) => {
    const n = counts[lane];
    const on = view === lane;
    return `<a class="q-tile t-${LANE_TONE[lane]}${n === 0 ? " zero" : ""}" href="${viewHref(lane)}"${on ? ' aria-current="true"' : ""}>
  <span class="q-tile-n">${n}</span><span class="q-tile-l"><span aria-hidden="true">${LANE_GLYPH[lane]}</span> ${esc(LANE_LABELS[lane])}</span><span class="q-tile-h">${esc(LANE_HINTS[lane])}</span></a>`;
  };
  const viewCount: Record<QueueView, number> = {
    all: counts.all,
    decision: counts.decision,
    duplicates: counts.duplicates,
    ready: counts.ready,
    verify: counts.verify,
    research: counts.research,
    disregarded: counts.disregarded,
    completed: counts.completed,
  };
  const chips = VIEW_CHIPS.map(
    ([v, l]) =>
      `<a class="chip${v === "duplicates" && viewCount[v] ? " attn" : ""}" href="${viewHref(v)}"${view === v ? ' aria-current="true"' : ""}>${esc(l)} <span class="n">${viewCount[v]}</span></a>`,
  ).join("");

  const rows = (items: readonly QueueItem[]) => `<ol class="q-list">${items.map((i) => queueRow(i, view)).join("")}</ol>`;
  const groups =
    view === "all"
      ? [
          ...ACTIVE_LANES.map((lane) => {
            const items = queue.items.filter((i) => i.step.lane === lane);
            if (!items.length) return "";
            return `<section class="q-group" aria-labelledby="lane-${lane}-h"><h2 class="q-group-h" id="lane-${lane}-h"><span aria-hidden="true">${LANE_GLYPH[lane]}</span> ${esc(LANE_LABELS[lane])} <span class="q-count">${counts[lane]}</span></h2><p class="q-hint">${esc(LANE_HINTS[lane])}</p>${rows(items)}</section>`;
          }),
          (() => {
            const handled = queue.items.filter((i) => i.step.lane === "handled");
            return handled.length
              ? `<details class="disc q-handled" id="handled"><summary><h2 id="handled-h">Handled</h2><span class="disc-sum">${counts.handled} approved, disregarded, or duplicate</span></summary><div class="disc-body">${rows(handled)}</div></details>`
              : "";
          })(),
        ].join("")
      : queue.items.length
        ? rows(queue.items)
        : "";

  const emptyQueue =
    counts.all === 0 && !anyFilter
      ? emptyState("No candidates to review.", providers.length ? "Find new businesses below, or add one by hand." : "Add a business by hand to start researching.", `<a class="btn" href="/admin/discovery/candidates/new">Add candidate</a>`)
      : anyFilter && queue.total === 0 && counts.all === 0
        ? emptyState("No candidates match these filters.", "Try clearing a filter or changing your search.", `<a class="btn btn-secondary" href="/admin/discovery">Clear filters</a>`)
        : view !== "all"
          ? emptyState(`Nothing in “${VIEW_CHIPS.find(([v]) => v === view)![1]}”.`, view === "decision" || view === "duplicates" ? "No decisions are waiting." : "Nothing here right now.", `<a class="btn btn-secondary" href="${viewHref("all")}">Show the whole queue</a>`)
          : emptyState("Nothing needs your attention.", "Every candidate has been handled.");

  const shown =
    queue.items.length < queue.total ? `Showing the first ${queue.items.length} of ${queue.total}` : `${queue.total} candidate${queue.total === 1 ? "" : "s"}`;

  const research = opts.research;
  const batch =
    (view === "all" || view === "research") && counts.research > 0
      ? `<form method="post" action="/admin/discovery/research" class="q-batch">
  ${(["q", "status", "qualification", "band", "state", "city", "flagged", "tier", "category", "provider", "sort", "run"] as const)
    .map((k) => (f[k] ? `<input type="hidden" name="${k}" value="${esc(f[k])}">` : ""))
    .join("")}${view === "all" ? "" : `<input type="hidden" name="view" value="${esc(view)}">`}
  <div><b>${counts.research} waiting for research.</b> <span class="muted">Automated research reads each business's own website and records verified facts with sources${research ? ` · ${research.queued} queued · ${research.running} running · ${research.completed} completed · ${research.failed} failed` : ""}.</span></div>
  <button type="submit" class="btn-secondary">Research up to 10</button>
</form>`
      : "";

  const runCard = `${
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
  }`;

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
  const lastRun = runs[0];
  const runErrors = ["provider", "region", "city", "businessType"].some((k) => values[k] !== undefined) || Boolean(opts.errors?.length);

  const noticeHtml = opts.notice
    ? `<p class="notice" role="status">✓ ${esc(opts.notice)}${opts.noticeLink ? ` <a href="${esc(opts.noticeLink.href)}">${esc(opts.noticeLink.label)}</a>` : ""}</p>`
    : "";

  return appPage(
    "Discovery · ReclaimBay admin",
    "discovery",
    `<div class="page-head q-head">
  <div><h1>Discovery</h1><p class="lede">${lede}</p></div>
  <div class="actions"><a class="btn btn-secondary" href="#find">Find new businesses</a><a class="btn btn-ghost" href="/admin/discovery/candidates/new">Add candidate</a></div>
</div>
${noticeHtml}${errorSummary(opts.errors, fe, "Not done")}
<section class="q-tiles" aria-label="What needs attention">${(["decision", "ready", "verify", "research"] as const).map(tile).join("")}</section>
${opts.autoResearch?.stale ? autoResearchLine(opts.autoResearch) : ""}
<details class="workspace-context"><summary>Automation &amp; research activity</summary>${automationSummary(automation)}${opts.autoResearch && !opts.autoResearch.stale ? autoResearchLine(opts.autoResearch) : ""}<a href="/admin/research">Inspect research runs &rarr;</a></details>

<section class="q-queue" id="candidates" aria-labelledby="queue-h">
  <h2 class="sr-only" id="queue-h">Review queue</h2>
  <nav class="chips q-chips" aria-label="Queue views">${chips}</nav>
  <form class="q-search" method="get" action="/admin/discovery" role="search" aria-label="Search and filter candidates">
    ${view === "all" ? "" : `<input type="hidden" name="view" value="${esc(view)}">`}${f.run ? `<input type="hidden" name="run" value="${esc(f.run)}">` : ""}
    <div class="q-search-row"><label class="sr-only" for="f-q">Search candidates</label><input class="search" id="f-q" type="search" name="q" value="${esc(f.q)}" placeholder="Search name, website, city, or phone" maxlength="100"><button type="submit" class="btn-secondary">Search</button>${anyFilter ? `<a class="btn btn-ghost" href="${view === "all" ? "/admin/discovery" : `/admin/discovery?view=${view}`}">Clear</a>` : ""}</div>
    <details class="q-more"${advanced ? " open" : ""}><summary>More filters${advanced ? " (in use)" : ""}</summary>
    <div class="filter-row">
      <div><label class="lbl" for="f-cstatus">Research status</label><select id="f-cstatus" name="status">${options([["", "Any"], ...CANDIDATE_STATUSES.map((s): [string, string] => [s, CANDIDATE_STATUS_LABELS[s]])], f.status)}</select></div>
      <div><label class="lbl" for="f-cqual">Qualification</label><select id="f-cqual" name="qualification">${options([["", "Any"], ...Object.entries(QUALIFICATION_LABELS)], f.qualification)}</select></div>
      <div><label class="lbl" for="f-cband">Score band</label><select id="f-cband" name="band">${options([["", "Any"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]], f.band)}</select></div>
      <div><label class="lbl" for="f-cstate">State</label><input id="f-cstate" type="text" name="state" value="${esc(f.state)}" maxlength="50"></div>
      <div><label class="lbl" for="f-ccity">City</label><input id="f-ccity" type="text" name="city" value="${esc(f.city)}" maxlength="100"></div>
      <div><label class="lbl" for="f-cflag">Duplicate flag</label><select id="f-cflag" name="flagged">${options([["", "Any"], ["1", "Possible duplicate"]], f.flagged)}</select></div>
      <div><label class="lbl" for="f-ctier">Category tier</label><select id="f-ctier" name="tier">${options([["", "Any"], ["core", "Core"], ["adjacent", "Adjacent"]], f.tier)}</select></div>
      <div><label class="lbl" for="f-ccat">Category check</label><select id="f-ccat" name="category">${options([["", "Any"], ...CATEGORY_VERDICTS.map((v): [string, string] => [v, CATEGORY_VERDICT_LABELS[v]])], f.category)}</select></div>
      <div><label class="lbl" for="f-csort">Order within each group</label><select id="f-csort" name="sort">${options(Object.keys(CANDIDATE_SORTS).map((k): [string, string] => [k, SORT_LABELS[k] ?? k]), queue.sort)}</select></div>
      <div class="filter-actions"><button type="submit">Apply filters</button><a class="btn btn-ghost" href="/admin/discovery">Reset</a></div>
    </div></details>
  </form>
  ${f.run ? `<div class="callout" style="margin-bottom:12px">Showing candidates from one discovery run. <a href="/admin/discovery">Show all</a></div>` : ""}
  ${batch}
  <div class="result-line"><span><b>${esc(shown)}</b>${anyFilter ? " match" : ""}${queue.notRanked ? ` · ${queue.notRanked} outside the target category not ranked (<a href="/admin/discovery?category=wrong_category">show them</a>)` : ""}</span><span>Qualification needs ${esc(criteriaNames)}. Opportunity score — ranking only, not a verdict.</span></div>
  ${groups || `<div class="card">${emptyQueue}</div>`}
</section>

<h2 class="rv-more" id="find-h">Finding businesses</h2>
${disclosure("find", "Find new businesses", lastRun ? `last run ${esc(fmtDay(lastRun.createdAt))}` : "no runs yet", `<section class="card" id="new-run" aria-label="New discovery run">${runCard}</section>`, runErrors || (counts.all === 0 && !anyFilter))}
${disclosure(
  "runs",
  "Discovery runs",
  `${runCount} run${runCount === 1 ? "" : "s"}`,
  runs.length
    ? `<div class="scroll"><table class="tbl cards">
<caption class="sr-only">Recent discovery runs</caption>
<thead><tr><th scope="col">Target</th><th scope="col" class="hide-md">Provider</th><th scope="col">Created</th><th scope="col" class="num">New candidates</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
<tbody>${runRows}</tbody>
</table></div>
<p class="small muted" style="margin-top:8px">Skipped records were confident duplicates of a stored candidate or prospect (the same provider record, or the same business at the same place). Flagged records were possible duplicates, kept for you to review. Other locations of a business are kept and linked.</p>`
    : `<div class="card">${emptyState("No discovery runs yet.", providers.length ? "Use “Find new businesses” to search a region for candidate businesses." : "When a provider is configured, runs will appear here. You can add candidates by hand meanwhile.")}</div>`,
)}
${disclosure(
  "imports",
  "Provider imports",
  `${imports.length} recent`,
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

/** The category check card: what it says, why, from where, and a person's override. */
function categoryCard(
  c: Detail["candidate"],
  frozen: boolean,
  values: Values,
  verdictErrs: string[],
  reasonErrs: string[],
): string {
  const v = c.categoryVerdict as CategoryVerdict | null;
  const source = c.categorySource as CategorySource | null;
  const border = v === "wrong_category" ? "var(--neg)" : v === "unclear" ? "var(--amber)" : v === "in_target" ? "var(--pos)" : "var(--line-2)";
  const provenance = v
    ? `From the ${esc(CATEGORY_SOURCE_LABELS[source ?? "name"])}${c.categorySourceUrl ? ` (${extLink(c.categorySourceUrl)})` : ""}${c.categoryRules ? ` · rules ${esc(c.categoryRules)}` : ""}${c.categoryCheckedAt ? ` · ${fmtDate(c.categoryCheckedAt)}` : ""}. ${
        source === "manual"
          ? "<b>A person's decision</b>: automated checks won't change it."
          : "<b>Automated</b>: a person can override it below."
      }`
    : "The category check hasn't run for this candidate yet. It runs when a candidate is added, when its website is researched, and in the backfill.";
  const errs = [...verdictErrs, ...reasonErrs].map((e) => `<div class="ferr">${esc(e)}</div>`).join("");
  const form = frozen
    ? ""
    : `<form method="post" action="/admin/discovery/candidates/${esc(c.id)}/category" class="row" style="align-items:flex-end;margin-top:12px" novalidate>
  <div style="min-width:220px"><label class="lbl" for="f-categoryVerdict">Override the category check</label><select id="f-categoryVerdict" name="categoryVerdict"${verdictErrs.length ? ' aria-invalid="true"' : ""}>${options(
    [["", "Choose…"], ...CATEGORY_VERDICTS.map((x): [string, string] => [x, CATEGORY_VERDICT_LABELS[x]]), ["automatic", "Hand back to the automated check"]],
    values.categoryVerdict,
  )}</select></div>
  <div style="flex:1;min-width:240px"><label class="lbl" for="f-categoryReason">Reason <span class="muted" style="font-weight:400">(required)</span></label><input id="f-categoryReason" type="text" name="categoryReason" value="${esc(values.categoryReason)}" maxlength="280"${reasonErrs.length ? ' aria-invalid="true"' : ""}></div>
  <button type="submit" class="btn-secondary">Save category decision</button>
</form>${errs}`;
  return `<section class="card" style="border-left:4px solid ${border}" aria-labelledby="category-card-h">
  <div class="row spread"><b id="category-card-h">Category check</b>${categoryTag(v, source)}</div>
  <p class="small muted" style="margin:4px 0 8px">Is this the kind of business ${esc(CATEGORY_RULES.target)} covers? This is <b>not qualification</b> and not a status: it never rejects or deletes anything. A business outside the target category can't be approved and isn't ranked by score.</p>
  ${v ? `<p style="margin:0 0 6px">${esc(c.categoryReason ?? "")}</p>` : ""}
  <div class="small muted">${provenance}</div>
  ${form}
</section>`;
}

// ---------- the review page: identity → duplicate → qualification → decision ----------

type Tone = "pos" | "warn" | "neg" | "info" | "quiet";

/** A verdict: glyph, words, and tone together, so colour is never the only signal. */
const verdict = (tone: Tone, glyph: string, text: string, size: "lg" | "sub" | "" = "") =>
  `<span class="vd vd-${tone}${size ? ` ${size}` : ""}"><span aria-hidden="true">${glyph}</span>${esc(text)}</span>`;

const QUALIFICATION_RESULT: Record<Qualification, [Tone, string, string]> = {
  meets_criteria: ["pos", "✓", "Qualified"],
  unverified: ["warn", "⚠", "Needs verification"],
  disqualified: ["neg", "✕", "Does not qualify"],
};

const ANSWER: Record<SignalState, [Tone, string, string]> = {
  yes: ["pos", "✓", "Yes"],
  no: ["neg", "✕", "No"],
  unknown: ["warn", "⚠", "Unknown"],
};

/** Approval blockers in plain words; anything unrecognised is shown as written. */
function plainBlocker(b: string): string {
  if (/^Status is Discovered/.test(b)) return "It hasn't been researched yet.";
  if (/^Status is Researching/.test(b)) return "Research hasn't finished.";
  if (/^Researched requires at least one evidence item/.test(b)) return "No evidence with a public source has been recorded yet.";
  const unsourced = /^Every recorded signal needs evidence\. Add evidence, or set to Unknown: (.+)\.$/.exec(b);
  if (unsourced) return `These answers have no source yet: ${unsourced[1]!.split(", ").map(signalLabel).join(", ")}.`;
  return b;
}

// ----- comparing a candidate with its possible match -----

interface Side {
  title: string;
  href: string | null;
  name: string;
  street: string | null;
  place: string | null;
  phone: string | null;
  phoneVerified: boolean;
  website: string | null;
  point: { latitude: number; longitude: number } | null;
}

const norm = {
  name: (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, ""),
  street: (v: string) => v.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim(),
  place: (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim(),
  phone: (v: string) => v.replace(/\D/g, "").slice(-10),
  website: (v: string) => v.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, ""),
};

const pointOf = (lat: number | null | undefined, lon: number | null | undefined) =>
  typeof lat === "number" && typeof lon === "number" ? { latitude: lat, longitude: lon } : null;

function comparison(sides: Side[]): string {
  const [self, ...matches] = sides;
  const row = (label: string, value: (s: Side) => string | null, render: (s: Side) => string, key: (v: string) => string) => {
    const mine = value(self!);
    const cells = sides
      .map((s, i) => {
        const v = value(s);
        if (!v) return `<td class="none"><span class="muted">—</span></td>`;
        if (i === 0 || !mine) return `<td>${render(s)}</td>`;
        const same = key(v) === key(mine);
        return same
          ? `<td class="same">${render(s)} <span class="eq">= same</span></td>`
          : `<td class="diff">${render(s)} <span class="ne">≠ differs</span></td>`;
      })
      .join("");
    return `<tr><th scope="row">${esc(label)}</th>${cells}</tr>`;
  };
  const distance = matches
    .map((m) => (self!.point && m.point ? `${Math.round(distanceMeters(self!.point, m.point)).toLocaleString("en-US")} m apart` : null))
    .filter(Boolean);
  return `<div class="cmp-wrap"><table class="cmp">
<caption class="sr-only">This business compared with its possible match</caption>
<thead><tr><th scope="col"><span class="sr-only">Field</span></th>${sides
    .map((s) => `<th scope="col">${esc(s.title)}${s.href ? ` <a class="small" href="${esc(s.href)}">Open</a>` : ""}</th>`)
    .join("")}</tr></thead>
<tbody>
${row("Name", (s) => s.name, (s) => `<b>${esc(s.name)}</b>`, norm.name)}
${row("Address", (s) => s.street, (s) => esc(s.street), norm.street)}
${row("City", (s) => s.place, (s) => esc(s.place), norm.place)}
${row("Phone", (s) => s.phone, (s) => `${esc(s.phone)}${s.phoneVerified ? "" : ' <span class="small muted">(provider, unverified)</span>'}`, norm.phone)}
${row("Website", (s) => s.website, (s) => extLink(s.website!), norm.website)}
</tbody></table></div>${distance.length ? `<p class="small muted" style="margin:8px 0 0">Distance: ${esc(distance.join("; "))}.</p>` : ""}`;
}

function duplicatePanel(d: Detail): string {
  const c = d.candidate;
  const state = duplicateState(c);
  if (state === "none") return "";
  const id = esc(c.id);
  const matchName = d.dupCandidate?.businessName ?? d.dupProspect?.businessName ?? "the flagged record";
  if (state === "not_duplicate") {
    return `<section class="rv-card rv-dup-done" aria-labelledby="dupd-h"><div class="row spread">
  <div><h2 class="rv-h" id="dupd-h">Duplicate check</h2><p style="margin-top:4px">${verdict("pos", "✓", "Not a duplicate")} <span class="small muted">Checked against ${esc(matchName)}${c.duplicateDecidedAt ? ` · ${fmtDate(c.duplicateDecidedAt)}` : ""}</span></p></div>
  <form method="post" action="/admin/discovery/candidates/${id}/duplicate" class="inline-form"><button type="submit" name="decision" value="duplicate" class="btn-ghost">↔ Mark duplicate instead</button></form>
</div></section>`;
  }
  if (state === "duplicate") return "";

  const reasons = matchReasons(c.duplicateReason);
  const self: Side = {
    title: "This business",
    href: null,
    name: c.businessName,
    street: c.streetAddress,
    place: [c.city, c.state].filter(Boolean).join(", ") || null,
    phone: c.phone ?? c.providerPhone,
    phoneVerified: Boolean(c.phone),
    website: c.website,
    point: pointOf(c.latitude, c.longitude),
  };
  const sides: Side[] = [self];
  if (d.dupCandidate) {
    const m = d.dupCandidate;
    sides.push({
      title: "Possible match",
      href: `/admin/discovery/candidates/${m.id}`,
      name: m.businessName,
      street: m.streetAddress,
      place: [m.city, m.state].filter(Boolean).join(", ") || null,
      phone: m.phone ?? m.providerPhone,
      phoneVerified: Boolean(m.phone),
      website: m.website,
      point: pointOf(m.latitude, m.longitude),
    });
  }
  if (d.dupProspect) {
    const m = d.dupProspect;
    sides.push({
      title: d.dupCandidate ? "Possible match (prospect)" : "Possible match: an existing prospect",
      href: `/admin/prospects/${m.id}`,
      name: m.businessName ?? "Unnamed prospect",
      street: null,
      place: [m.city, m.state].filter(Boolean).join(", ") || null,
      phone: m.phone,
      phoneVerified: Boolean(m.phone),
      website: m.website,
      point: null,
    });
  }
  return `<section class="rv-card rv-dup" aria-labelledby="dup-h">
  <div class="rv-dup-head">
    <h2 id="dup-h">${verdict("warn", "⚠", "Possible duplicate", "lg")}</h2>
    <div class="rv-reason"><span class="rv-k">Why it was flagged</span>${reasons.map((r) => `<b>${esc(r.text)}</b>${r.kind === "prospect" && d.dupCandidate ? ' <span class="small muted">(with the prospect)</span>' : ""}`).join("<br>") || "<b>Partial overlap</b>"}</div>
  </div>
  <p class="small muted" style="margin:6px 0 0">A possible match is not a confirmed duplicate: the evidence wasn't strong enough to skip it automatically. Compare the two and decide.${state === "unresolved" ? ` <b>Left unresolved${c.duplicateDecidedAt ? ` ${fmtDate(c.duplicateDecidedAt)}` : ""}.</b>` : ""}</p>
  ${comparison(sides)}
  <form method="post" action="/admin/discovery/candidates/${id}/duplicate" class="rv-actions">
    <button type="submit" name="decision" value="not_duplicate" class="btn-go">✓ Not a duplicate</button>
    <button type="submit" name="decision" value="duplicate" class="btn-danger">↔ Mark duplicate</button>
    ${state === "possible" ? '<button type="submit" name="decision" value="unresolved" class="btn-ghost">? Leave unresolved</button>' : ""}
  </form>
  <p class="small muted" style="margin:8px 0 0"><b>Not a duplicate</b> lifts the review hold. <b>Mark duplicate</b> closes this record as the same business as ${esc(matchName)}; it never becomes a prospect. <b>Leave unresolved</b> keeps the warning for later.</p>
</section>`;
}

function qualificationCard(d: Detail): string {
  const { candidate: c, result, outsideTarget } = d;
  if (outsideTarget) {
    return `<section class="rv-card t-quiet" aria-labelledby="qual-h">
  <h2 class="rv-h" id="qual-h">Qualification</h2><p class="rv-q">Does it meet the required criteria?</p>
  <div class="rv-result">${verdict("quiet", "—", "Not assessed", "lg")}</div>
  <p class="rv-why">Qualification applies only to businesses in the target category. Override the <a href="#category">category check</a> if this is one.</p>
</section>`;
  }
  const crit = result.breakdown
    .filter((s) => (REQUIRED_CRITERIA as readonly string[]).includes(s.key))
    .map((s) => {
      const [tone, glyph, word] = ANSWER[s.state];
      const ev = c.evidence.find((e) => e.signalKey === s.key);
      const support = ev
        ? `“${esc(ev.excerpt.length > 140 ? `${ev.excerpt.slice(0, 137)}…` : ev.excerpt)}” <span class="src">${extLink(ev.sourceUrl)}</span>`
        : s.state === "unknown"
          ? esc(s.reason)
          : "No evidence recorded.";
      return `<li><span class="cname">${esc(s.label)}</span>${verdict(tone, glyph, word)}<span class="cev">${support}</span></li>`;
    })
    .join("");
  const [tone, glyph, label] = QUALIFICATION_RESULT[result.qualification];
  const names = (keys: readonly string[]) => keys.map(signalLabel).join(" and ");
  const why =
    result.qualification === "meets_criteria"
      ? "Both required criteria are confirmed."
      : result.qualification === "unverified"
        ? `${names(result.unverifiedCriteria)} ${result.unverifiedCriteria.length === 1 ? "hasn't" : "haven't"} been verified yet.`
        : `${names(result.disqualifiedBy)} ${result.disqualifiedBy.length === 1 ? "is" : "are"} No.`;
  return `<section class="rv-card t-${tone}" aria-labelledby="qual-h">
  <h2 class="rv-h" id="qual-h">Qualification</h2><p class="rv-q">Required criteria: ${esc(criteriaNames)}</p>
  <ul class="crit">${crit}</ul>
  <div class="rv-result">${verdict(tone, glyph, label, "lg")}</div>
  <p class="rv-why">${esc(why)}</p>
</section>`;
}

function decisionCard(d: Detail, research: ResearchView | undefined, values: Values, statusErrs: string[]): string {
  const { candidate: c, result, outsideTarget, approvalBlockers } = d;
  const id = esc(c.id);
  const statusForm = (to: string, intent: string, label: string, cls: string) =>
    `<form method="post" action="/admin/discovery/candidates/${id}/status" class="inline-form"><input type="hidden" name="status" value="${to}"><input type="hidden" name="intent" value="${intent}"><button type="submit" class="${cls}">${label}</button></form>`;
  const canKeep = CANDIDATE_TRANSITIONS[c.status].includes("needs_review");
  // Keep for review is never the main action: it's the quiet way to come back later.
  const keep = canKeep ? statusForm("needs_review", "keep", "→ Keep for review", "btn-ghost") : "";
  /** Disregard: filled red only when it is the action this state calls for. */
  const disregard = (prefill: string, primary = false) =>
    CANDIDATE_TRANSITIONS[c.status].includes("rejected")
      ? `<details class="rv-disregard"${values.intent === "disregard" ? " open" : ""}><summary class="btn ${primary ? "btn-stop" : "btn-danger"}">× Disregard…</summary>
  <form method="post" action="/admin/discovery/candidates/${id}/status" class="rv-reason-form" novalidate>
    <input type="hidden" name="status" value="rejected"><input type="hidden" name="intent" value="disregard">
    <label class="lbl" for="f-dreason">Why? <span class="muted" style="font-weight:400">(kept on the record)</span></label>
    <div class="row"><input id="f-dreason" type="text" name="reason" value="${esc(values.intent === "disregard" ? (values.reason ?? prefill) : prefill)}" maxlength="${FIELD_LIMITS.reason}"${values.intent === "disregard" && statusErrs.length ? ' aria-invalid="true"' : ""} style="flex:1;min-width:200px">
    <button type="submit" class="btn-stop">Disregard</button></div>
    ${values.intent === "disregard" ? statusErrs.map((e) => `<div class="ferr">${esc(e)}</div>`).join("") : ""}
  </form></details>`
      : "";
  const card = (tone: Tone, question: string, head: string, body: string, actions: string) =>
    `<section class="rv-card rv-decision t-${tone}" aria-labelledby="dec-h">
  <h2 class="rv-h" id="dec-h">Decision</h2><p class="rv-q">${esc(question)}</p>
  <div class="rv-result">${head}</div>
  ${body}
  ${actions ? `<div class="rv-actions">${actions}</div>` : ""}
</section>`;

  if (c.status === "approved") {
    const auto = isAutoApproved(c);
    return card(
      "pos",
      "This business is in the prospect pipeline.",
      verdict("pos", "✓", auto ? "Approved automatically" : "Approved by a person", "lg"),
      `<p class="rv-why">${c.approvedAt ? `${fmtDate(c.approvedAt)}. ` : ""}${auto ? esc(c.decisionReason ?? "") : "Edit it on its prospect page; this record stays as its discovery history."}</p>`,
      c.prospect ? `<a class="btn btn-go" href="/admin/prospects/${esc(c.prospect.id)}">Open prospect: ${esc(c.prospect.businessName ?? "Unnamed")}</a>` : '<span class="small muted">Linked prospect unavailable.</span>',
    );
  }
  if (c.status === "duplicate" || c.status === "rejected") {
    return card(
      "neg",
      "This record is closed and will not become a prospect.",
      c.status === "duplicate" ? verdict("neg", "↔", "Duplicate", "lg") : verdict("neg", "✕", "Disregarded", "lg"),
      c.decisionReason ? `<p class="rv-why">${esc(c.decisionReason)}${c.decidedAt ? ` <span class="muted">(${fmtDate(c.decidedAt)})</span>` : ""}</p>` : "",
      statusForm("discovered", "reopen", "↺ Reopen for review", "btn-ghost"),
    );
  }
  if (duplicatePending(c)) {
    return card(
      "warn",
      "Is this a separate business?",
      verdict("warn", "⚠", "Resolve the possible duplicate first", "lg"),
      `<p class="rv-why">Approval comes after the duplicate question. Use <b>Not a duplicate</b> or <b>Mark duplicate</b> above.</p>`,
      disregard("Not a business to pursue."),
    );
  }
  if (outsideTarget) {
    return card(
      "neg",
      "What should happen to this business?",
      verdict("neg", "✕", "Outside the target category", "lg"),
      `<p class="rv-why">${esc(c.categoryReason ?? "The category check says this isn't the kind of business ReclaimBay serves.")} It can't be approved unless a person overrides the <a href="#category">category check</a>.</p>`,
      disregard(`Outside the target category${c.categoryReason ? `: ${c.categoryReason.replace(/\.$/, "")}` : ""}.`, true),
    );
  }
  if (result.qualification === "disqualified") {
    const no = result.disqualifiedBy.map(signalLabel).join(" and ");
    return card(
      "neg",
      "What should happen to this business?",
      verdict("neg", "✕", "Does not qualify", "lg"),
      `<p class="rv-why">${esc(no)} ${result.disqualifiedBy.length === 1 ? "is" : "are"} No, so it doesn't meet the required criteria.</p>`,
      `${disregard(`Does not qualify: ${no} is No.`, true)}${keep}`,
    );
  }
  const researchable = !research?.pending;
  const runResearch = (label: string, cls: string) =>
    researchable ? `<form method="post" action="/admin/discovery/candidates/${id}/research" class="inline-form"><button type="submit" class="${cls}">${label}</button></form>` : "";
  if (approvalBlockers.length) {
    return card(
      "warn",
      "Is this ready to approve?",
      verdict("warn", "⚠", "Can't approve yet", "lg"),
      `<ul class="rv-blockers">${approvalBlockers.map((b) => `<li>${esc(plainBlocker(b))}</li>`).join("")}</ul>${research?.pending ? '<p class="rv-why">Research is running; refresh in a few seconds.</p>' : ""}`,
      `${runResearch(research?.latest ? "↻ Run research again" : "▶ Run research", "btn-go")}${keep}${disregard("Not a business to pursue.")}`,
    );
  }
  const approve = (label: string, cls: string) =>
    `<form method="post" action="/admin/discovery/candidates/${id}/approve" class="inline-form"><button type="submit" class="${cls}">${label}</button></form>`;
  const approvalNote = `<p class="small muted" style="margin:10px 0 0">Approval adds this business to the prospect pipeline. It does not automatically qualify the business or mark it ready to contact.</p>`;
  if (result.qualification === "unverified") {
    const missing = result.unverifiedCriteria.map(signalLabel).join(" and ");
    const first = result.unverifiedCriteria[0]!;
    // The useful next step is to settle the missing criterion; approving without it stays possible, but secondary.
    return card(
      "warn",
      "Is this ready to approve?",
      verdict("warn", "⚠", "Verify before approving", "lg"),
      `<p class="rv-why">${esc(missing)} ${result.unverifiedCriteria.length === 1 ? "hasn't" : "haven't"} been verified. You can still approve it; it enters as New and can't be marked Qualified until the required collision criterion is Yes.</p>`,
      `<a class="btn" href="/admin/discovery/candidates/${id}/edit#sig-${esc(first)}">Verify ${esc(signalLabel(first))}</a>${approve("Approve anyway", "btn-secondary")}${keep}${disregard("Not a business to pursue.")}`,
    );
  }
  return card(
    "pos",
    "Ready to add to prospects?",
    verdict("pos", "✓", "Ready to approve", "lg"),
    `${approvalNote}`,
    `${approve("✓ Approve as prospect", "btn-go")}${keep}${disregard("Not a business to pursue.")}`,
  );
}

/** A secondary section, collapsed unless it is relevant now. */
const disclosure = (id: string, title: string, summary: string, body: string, open = false) =>
  `<details class="disc" id="${esc(id)}"${open ? " open" : ""}><summary><h2 id="${esc(id)}-h">${esc(title)}</h2>${summary ? `<span class="disc-sum">${summary}</span>` : ""}</summary><div class="disc-body">${body}</div></details>`;

export function candidateDetailPage(opts: {
  detail: Detail;
  research?: ResearchView;
  notice?: string;
  /** The notice confirms a review decision: offer the way back to the queue. */
  decided?: boolean;
  /** Where this candidate sits in the queue, for Previous / Next. */
  position?: Position;
  errors?: string[];
  values?: Values;
  /** Recorded AI shadow decisions, newest first: shown read-only, never as the decision. */
  aiShadow?: readonly AiDecisionRow[] | "blinded";
}): string {
  const { detail, values = {}, research, position } = opts;
  const { candidate: c, result, outsideTarget, relCandidate, relProspect } = detail;
  const id = esc(c.id);
  const fe = fieldErrors(opts.errors);
  const none = '<span class="muted">—</span>';
  const frozen = c.status === "approved";

  // ----- identity -----
  const place = [c.city, c.state, c.postalCode].filter(Boolean).join(", ");
  const websiteLine = c.website
    ? `${extLink(c.website)} ${c.websiteVerifiedAt ? verdict("pos", "✓", "Verified site", "sub") : verdict("warn", "⚠", "Unverified", "sub")}`
    : `<span class="muted">No website</span>`;
  const phoneLine = c.phone
    ? `${esc(c.phone)} ${verdict("pos", "✓", "Verified", "sub")}`
    : c.providerPhone
      ? `${esc(c.providerPhone)} ${verdict("warn", "⚠", "Provider-reported", "sub")}`
      : `<span class="muted">No phone</span>`;
  const issues: { tone: Tone; glyph: string; html: string }[] = [];
  if (c.providerStatus === "permanently_closed") issues.push({ tone: "neg", glyph: "✕", html: "The provider reports this business as permanently closed." });
  if (outsideTarget) issues.push({ tone: "neg", glyph: "✕", html: `Outside the target category${c.categoryReason ? `: ${esc(c.categoryReason.replace(/\.$/, ""))}` : ""}.` });
  else if (c.categoryVerdict === "unclear") issues.push({ tone: "warn", glyph: "⚠", html: `Category unclear${c.categoryReason ? `: ${esc(c.categoryReason.replace(/\.$/, ""))}` : ""}.` });
  if (c.website && !c.websiteVerifiedAt) {
    issues.push({
      tone: "warn",
      glyph: "⚠",
      html: research?.latest?.outcome === "website_mismatch" ? "Research found that this website doesn't belong to this business." : "The website isn't confirmed as the business's own yet.",
    });
  }
  const related = [
    relCandidate && `<a href="/admin/discovery/candidates/${esc(relCandidate.id)}">${esc(relCandidate.businessName)}</a>${relCandidate.city ? ` in ${esc(relCandidate.city)}` : ""}`,
    relProspect && `<a href="/admin/prospects/${esc(relProspect.id)}">${esc(relProspect.businessName ?? "Unnamed")}</a> (prospect)${relProspect.city ? ` in ${esc(relProspect.city)}` : ""}`,
  ].filter(Boolean);
  if (related.length) issues.push({ tone: "info", glyph: "ℹ", html: `Another location shares this website: ${related.join(", ")}. Check whether it's a chain.` });

  const identity = `<header class="rv-id" aria-label="Business identity">
  <div class="rv-eyebrow"><span>Candidate, not a prospect${frozen ? " (approved)" : ""}</span>${frozen ? "" : `<a class="small" href="/admin/discovery/candidates/${id}/edit">Edit research</a>`}</div>
  <h1>${esc(c.businessName)}</h1>
  <div class="rv-addr">${esc([c.streetAddress, place].filter(Boolean).join(" · ") || "Location not recorded")}</div>
  <ul class="rv-facts">
    <li><span class="k">Website</span>${websiteLine}</li>
    <li><span class="k">Phone</span>${phoneLine}</li>
    ${c.email ? `<li><span class="k">Email</span>${esc(c.email)} ${verdict("pos", "✓", "Verified", "sub")}</li>` : ""}
  </ul>
  ${issues.length ? `<ul class="rv-issues">${issues.map((i) => `<li class="t-${i.tone}"><span aria-hidden="true">${i.glyph}</span><span>${i.html}</span></li>`).join("")}</ul>` : ""}
</header>`;

  // ----- research summary: secondary, one line -----
  const latest = research?.latest ?? null;
  const researchState = research?.pending
    ? "Running now"
    : latest
      ? `${latest.status === "failed" ? "Failed" : outcomeLabel(latest.outcome)} · ${fmtDay(latest.finishedAt ?? latest.queuedAt)}`
      : "Not researched yet";
  const strip = `<div class="rv-strip" aria-label="Research summary">
  <div><span class="rv-k">Opportunity score · ranking only, not a verdict</span>${
    outsideTarget ? `<span class="muted">${NOT_SCORED}</span>` : `<b class="rv-score">${result.score}</b><span class="muted">/${MAX_SCORE}</span> <span class="small muted">· ${result.known} of ${result.total} signals known</span>`
  }</div>
  <div><span class="rv-k">Automated research</span>${esc(researchState)}</div>
  <div><span class="rv-k">Evidence</span>${c.evidence.length} item${c.evidence.length === 1 ? "" : "s"}</div>
  <div><a class="small" href="#research">Research details</a></div>
</div>`;

  // ----- secondary details (unchanged information, collapsed) -----
  const evidenceCount = new Map<string, number>();
  for (const e of c.evidence) evidenceCount.set(e.signalKey, (evidenceCount.get(e.signalKey) ?? 0) + 1);
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
  const fact = (label: string, value: string, src?: string | null) =>
    `<dt>${esc(label)}</dt><dd>${value}${src ? `<div class="src">listed at ${extLink(src)}</div>` : ""}</dd>`;

  const unknown = result.breakdown.filter((s) => s.state === "unknown");
  const unknownItems = unknown
    .map((s) => {
      const def = SIGNAL_DEFS.find((d) => d.key === s.key)!;
      return `<li><b>${esc(s.label)}</b> ${obsBadge("unknown")} <span class="small muted">${s.weight} pts</span> ${def.requiredCriterion ? '<span class="kind req">Required criterion</span>' : ""}
<div class="small muted">${esc(s.reason)}</div></li>`;
    })
    .join("");
  const missingPoints = unknown.reduce((n, s) => n + s.weight, 0);

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

  // The detection record (the decision itself is in the panel above).
  const dupItems = [
    detail.dupCandidate && `<li>Candidate <a href="/admin/discovery/candidates/${esc(detail.dupCandidate.id)}">${esc(detail.dupCandidate.businessName)}</a> (${esc(CANDIDATE_STATUS_LABELS[detail.dupCandidate.status])})</li>`,
    detail.dupProspect && `<li>Prospect <a href="/admin/prospects/${esc(detail.dupProspect.id)}">${esc(detail.dupProspect.businessName ?? "Unnamed")}</a> (${esc(detail.dupProspect.status)})</li>`,
  ].filter(Boolean);
  const dupState = duplicateState(c);
  const dupRecord = dupItems.length
    ? `<div class="card"><b>${esc(DUPLICATE_STATE_LABELS[dupState])}</b>
<p class="small" style="margin:6px 0">The duplicate check matched only on: ${esc(c.duplicateReason ?? "partial overlap")}. That was not enough to skip it automatically.${c.duplicateDecidedAt ? ` A person's decision was recorded ${fmtDate(c.duplicateDecidedAt)}.` : ""}</p>
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

  const allowed = CANDIDATE_TRANSITIONS[c.status];
  const statusErrs = fe.byField.get("status") ?? [];
  const advancedErrs = values.intent ? [] : statusErrs;
  const statusForm = allowed.length
    ? `<form method="post" action="/admin/discovery/candidates/${id}/status" class="row" style="align-items:flex-end" novalidate>
  <div style="min-width:180px"><label class="lbl" for="f-cstatus2">Move to</label><select id="f-cstatus2" name="status"${advancedErrs.length ? ' aria-invalid="true"' : ""}>${options(allowed.map((s): [string, string] => [s, CANDIDATE_STATUS_LABELS[s]]), values.intent ? undefined : values.status)}</select></div>
  <div style="flex:1;min-width:240px"><label class="lbl" for="f-creason">Reason <span class="muted" style="font-weight:400">(required for ${CANDIDATE_REASON_REQUIRED.map((s) => CANDIDATE_STATUS_LABELS[s]).join(" and ")})</span></label><input id="f-creason" type="text" name="reason" value="${esc(values.intent ? "" : values.reason)}" maxlength="${FIELD_LIMITS.reason}"></div>
  <button type="submit" class="btn-secondary">Change status</button>
</form>${advancedErrs.map((e) => `<div class="ferr">${esc(e)}</div>`).join("")}
<p class="small muted" style="margin-top:10px">The decision buttons above cover normal review. This form moves the research status directly. Researched needs at least one evidence item, and every yes/no signal needs its own.</p>`
    : `<p class="small">${frozen ? "Approved: this candidate is now a prospect." : ""}</p>`;

  const auto = detail.autoApproval;
  const autoColor = auto.decision === "approve" ? "var(--pos)" : auto.decision === "blocked" ? "var(--neg)" : "var(--amber)";
  const autoCard = frozen
    ? `<div class="card"><p class="small" style="margin:0">${isAutoApproved(c) ? `Approved automatically (${esc(AUTO_APPROVAL_RULES)}).` : "Approved by a person."}</p></div>`
    : `<div class="card" style="border-left:4px solid ${autoColor}"><b>Automatic approval (${esc(AUTO_APPROVAL_RULES)}): ${esc(AUTO_APPROVAL_LABELS[auto.decision])}</b>
<ul class="plain small" style="margin:6px 0">${auto.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>${auto.noted.length ? `<p class="small muted" style="margin:0 0 6px">Noted, not blocking: ${esc(auto.noted.join("; "))}.</p>` : ""}
<p class="small muted" style="margin:0">${
        auto.decision === "approve"
          ? "Research approves a candidate like this automatically after its next completed run, or the auto-approve job does. You can also approve it above."
          : auto.decision === "blocked"
            ? "The rules never approve this candidate. A person can still change its category or status."
            : "The rules leave this one to a person: use the decision above."
      }</p></div>`;

  const categoryErrs = [...(fe.byField.get("categoryVerdict") ?? []), ...(fe.byField.get("categoryReason") ?? [])];
  const evidenceErrs = ["signalKey", "sourceUrl", "excerpt"].some((k) => fe.byField.has(k));
  // After a decision, the next item needing attention is one click away.
  const nextLink = (cls: string) =>
    position?.next ? `<a class="${cls}" href="/admin/discovery/candidates/${esc(position.next.id)}" rel="next">Next: ${esc(position.next.businessName)} →</a>` : "";
  const decidedNotice = opts.notice
    ? `<p class="notice" role="status">✓ ${esc(opts.notice)}${opts.decided ? ` ${nextLink("")}${position?.next ? " · " : ""}<a href="/admin/discovery">Back to review queue</a>` : ""}</p>`
    : "";
  const queueNav = `<nav class="rv-nav" aria-label="Review queue">
  <a class="rv-back" href="/admin/discovery">← Review queue</a>
  <span class="rv-pos">${
    position
      ? position.index
        ? `${position.index} of ${position.total} needing attention`
        : position.total
          ? `${position.total} ${position.total === 1 ? "item needs" : "items need"} attention`
          : "Nothing else needs attention"
      : ""
  }</span>
  <span class="rv-step">${position?.previous ? `<a class="btn btn-ghost" href="/admin/discovery/candidates/${esc(position.previous.id)}" rel="prev">← Previous</a>` : ""}${position?.next ? `<a class="btn btn-ghost" href="/admin/discovery/candidates/${esc(position.next.id)}" rel="next">Next →<span class="sr-only">: ${esc(position.next.businessName)}</span></a>` : ""}</span>
</nav>`;

  return appPage(
    `${c.businessName} · Discovery · ReclaimBay admin`,
    "discovery",
    `${queueNav}
${decidedNotice}${errorSummary(opts.errors, fe, "Not done")}
<div class="rv">
${identity}
<nav class="dossier-nav" aria-label="Candidate dossier sections"><a href="#research">Research</a><a href="#category">Category / identity</a><a href="#evidence">Evidence</a><a href="#duplicates">Duplicate review</a><a href="#approval">Approval history</a></nav>
${duplicatePanel(detail)}
<div class="rv-grid">
${qualificationCard(detail)}
${decisionCard(detail, research, values, statusErrs)}
</div>
${strip}
</div>

<h2 class="rv-more">Research details</h2>
${disclosure("research", "Automated research", esc(researchState), researchSection(research, c.id, !["approved", "rejected", "duplicate"].includes(c.status)), Boolean(research?.pending))}
${disclosure(
  "evidence",
  "Evidence",
  `${c.evidence.length} item${c.evidence.length === 1 ? "" : "s"}`,
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
  evidenceErrs,
)}
${disclosure(
  "score",
  "Score breakdown",
  outsideTarget ? NOT_SCORED : `${result.score}/${MAX_SCORE} · ${result.known} of ${result.total} known`,
  `<div class="scroll"><table class="tbl cards">
<caption class="sr-only">Signals recorded for this candidate</caption>
<thead><tr><th scope="col">Signal</th><th scope="col">Observed</th><th scope="col" class="num">Points</th><th scope="col">Source</th></tr></thead>
<tbody>${knownRows || `<tr><td colspan="4" class="muted">No signals recorded yet.</td></tr>`}</tbody>
</table></div>
<p class="small muted" style="margin:8px 0 0">The opportunity score ranks businesses for research. It never decides qualification: a high score with an unknown required criterion still needs verification.</p>`,
)}
${disclosure(
  "know",
  "What we know",
  "",
  `<div class="card"><dl class="kv">
    ${fact("Website", c.website ? `${extLink(c.website)}${c.provider !== "manual" ? `<div class="src">Reported by ${esc(c.provider)}${c.websiteVerifiedAt ? `; confirmed by research ${fmtDate(c.websiteVerifiedAt)}` : ", unverified. Research confirms whether it is the business&#39;s own site"}.</div>` : ""}` : none)}
    ${fact("Street", c.streetAddress ? esc(c.streetAddress) : none)}
    ${fact("Location", place ? esc(place) : none)}
    ${c.latitude !== null && c.longitude !== null ? fact("Position", `<span class="small">${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}</span>`) : ""}
    ${fact("Phone", c.phone ? `${esc(c.phone)} <span class="tag">Verified business contact</span>` : none, c.phone ? c.phoneSourceUrl : null)}
    ${c.providerPhone ? fact("Provider phone", `${esc(c.providerPhone)} <span class="tag" style="border-color:var(--amber);color:var(--warn)">Unverified</span><div class="src">Reported by ${esc(c.provider)}. Not used for contact until research finds it on the business's own website.</div>`) : ""}
    ${fact("Email", c.email ? esc(c.email) : none, c.email ? c.emailSourceUrl : null)}
  </dl></div>`,
)}
${disclosure(
  "dont-know",
  "What we don't know",
  `${unknown.length} unknown`,
  `<div class="card">
  <p class="small" style="margin-top:0">${unknown.length} of ${result.total} signals are unknown (${missingPoints} points not yet established). Unknown adds nothing to the score and is never counted against the business.</p>
  <ul class="plain">${unknownItems || `<li class="muted">Nothing unknown.</li>`}</ul>
</div>`,
)}
${disclosure("duplicates", "Duplicate assessment", esc(DUPLICATE_STATE_LABELS[dupState]), dupRecord + relCard)}
${disclosure(
  "category",
  "Category check",
  categoryTag(c.categoryVerdict, c.categorySource),
  categoryCard(c, frozen, values, fe.byField.get("categoryVerdict") ?? [], fe.byField.get("categoryReason") ?? []),
  categoryErrs.length > 0,
)}
${disclosure(
  "provenance",
  "Discovery provenance",
  esc(c.provider === "overture" ? "Overture Maps Places" : c.provider),
  `<div class="card"><dl class="kv">
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
  </dl></div>`,
)}
${opts.aiShadow ? disclosure("ai", "AI shadow verdict (evaluation only)", aiShadowSummary(opts.aiShadow), aiShadowSection(opts.aiShadow)) : ""}
${disclosure("approval", "Automatic approval", esc(frozen ? (isAutoApproved(c) ? "Approved automatically" : "Approved by a person") : AUTO_APPROVAL_LABELS[auto.decision]), autoCard)}
${disclosure(
  "state",
  "Research status (advanced)",
  candidateBadge(c.status),
  `<div class="card">${stepper(RESEARCH_PATH, CANDIDATE_STATUS_LABELS, RESEARCH_PATH.includes(c.status) ? c.status : "")}
<p style="margin:0 0 10px">${candidateBadge(c.status)} <span class="small muted">${esc(CANDIDATE_STATUS_MEANINGS[c.status])}</span></p>
${statusForm}
${c.decisionReason ? `<p class="small" style="margin-top:10px">Decision: ${esc(c.decisionReason)}${c.decidedAt ? ` <span class="muted">(${fmtDate(c.decidedAt)})</span>` : ""}</p>` : ""}${c.researchedAt ? `<p class="small muted" style="margin-top:6px">Researched ${fmtDate(c.researchedAt)}</p>` : ""}</div>`,
  advancedErrs.length > 0,
)}
${disclosure(
  "notes",
  "Notes and history",
  `${c.notes.length} note${c.notes.length === 1 ? "" : "s"}`,
  `<div class="card">
  ${
    frozen
      ? ""
      : `<form method="post" action="/admin/discovery/candidates/${id}/notes" class="stack" novalidate>
    <div class="field"><label for="f-body">Add a note</label><textarea id="f-body" name="body" maxlength="${FIELD_LIMITS.note}"${fe.byField.has("body") ? ' aria-invalid="true"' : ""}>${esc(values.body)}</textarea><div class="hint">Business facts only; no personal details. Notes can't be edited or removed.</div>${fieldErr("body")}</div>
    <div><button type="submit" class="btn-secondary">Add note</button></div>
  </form>`
  }
  <div style="margin-top:${frozen ? 0 : 14}px">${c.notes.map((n) => `<div class="note"><div class="when">${fmtDate(n.createdAt)}</div><div class="body">${esc(n.body)}</div></div>`).join("") || emptyState("No notes yet.")}</div>
</div>`,
  fe.byField.has("body"),
)}`,
  );
}
