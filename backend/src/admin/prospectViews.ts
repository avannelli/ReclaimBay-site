import type { getProspectDetail, listProspects } from "../prospects.js";
import { FIELD_LIMITS, SORTS, referralUrl, signalFieldName } from "../prospects.js";
import {
  STATUSES,
  STATUS_LABELS,
  STATUS_MEANINGS,
  TRANSITIONS,
  REASON_REQUIRED,
  type Status,
} from "../prospectStatus.js";
import {
  BAND_LABELS,
  BAND_THRESHOLDS,
  MAX_SCORE,
  QUALIFICATION_LABELS,
  REQUIRED_CRITERIA,
  SCORING_VERSION,
  SIGNALS,
  type Qualification,
  type ScoreBand,
  type SignalDefinition,
  type SignalKey,
} from "../scoring.js";
import { adminHeader, esc, fmtDate, page } from "./views.js";

/* Admin pages for prospects. Server-rendered, no scripts, all values escaped. */

type ListResult = Awaited<ReturnType<typeof listProspects>>;
type Detail = NonNullable<Awaited<ReturnType<typeof getProspectDetail>>>;
type Values = Record<string, string | undefined>;

const SIGNAL_DEFS = SIGNALS as readonly SignalDefinition[];
const signalLabel = (key: string) => SIGNAL_DEFS.find((s) => s.key === key)?.label ?? key;

const statusPill = (s: Status) => `<span class="st st-${s}">${esc(STATUS_LABELS[s])}</span>`;
const bandPill = (b: ScoreBand) => `<span class="pill band-${b}">${esc(BAND_LABELS[b])}</span>`;
const qualificationPill = (q: Qualification) => `<span class="st q-${q}">${esc(QUALIFICATION_LABELS[q])}</span>`;
const criteriaNames = REQUIRED_CRITERIA.map(signalLabel).join(" and ");

function errorBox(errors?: string[]): string {
  if (!errors?.length) return "";
  return `<div class="errs" role="alert"><b>Not saved</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
}

/** Only http(s) URLs are ever stored, so they are safe as links. */
const extLink = (url: string, label = url.replace(/^https?:\/\//, "").replace(/\/$/, "")) =>
  `<a href="${esc(url)}" rel="noreferrer noopener" target="_blank">${esc(label)}</a>`;

const options = (items: [string, string][], selected: string | undefined) =>
  items.map(([v, l]) => `<option value="${esc(v)}"${v === (selected ?? "") ? " selected" : ""}>${esc(l)}</option>`).join("");

// ---------- list ----------

export function prospectListPage(opts: {
  list: ListResult;
  filters: Values;
  statusCounts: Partial<Record<Status, number>>;
}): string {
  const { list, filters, statusCounts } = opts;
  const statusTabs = STATUSES.map((s) => {
    const n = statusCounts[s] ?? 0;
    const on = filters.status === s;
    return `<a class="st${on ? " on" : ""}" href="/admin/prospects?status=${s}"${on ? ' aria-current="true"' : ""}>${esc(STATUS_LABELS[s])} · ${n}</a>`;
  }).join(" ");

  const rows = list.rows
    .map(({ prospect: p, result, stale }) => {
      const loc = [p.city, p.state].filter(Boolean).join(", ");
      const contact = [p.phone && "phone", p.email && "email"].filter(Boolean).join(", ");
      return `<tr>
  <td><a href="/admin/prospects/${esc(p.id)}"><b>${esc(p.businessName ?? "Unnamed prospect")}</b></a>${p.website ? `<div class="small">${extLink(p.website)}</div>` : ""}</td>
  <td>${loc ? esc(loc) : '<span class="muted">—</span>'}${p.postalCode ? `<div class="small muted">${esc(p.postalCode)}</div>` : ""}</td>
  <td>${statusPill(p.status)}</td>
  <td>${qualificationPill(result.qualification)}</td>
  <td class="n"><b>${result.score}</b><span class="muted">/${MAX_SCORE}</span>${stale ? `<div class="small" style="color:var(--warn)">cache stale</div>` : ""}</td>
  <td>${bandPill(result.band)}<div class="small muted">${result.known}/${result.total} signals known</div></td>
  <td>${contact ? esc(contact) : '<span class="muted">—</span>'}</td>
  <td class="small">${fmtDate(p.updatedAt)}</td>
</tr>`;
    })
    .join("\n");

  const f = filters;
  const shown = list.rows.length < list.total ? `Showing the first ${list.rows.length} of ${list.total}.` : `${list.total} prospect${list.total === 1 ? "" : "s"}.`;
  return page(
    "Prospects · ReclaimBay admin",
    `${adminHeader("prospects")}
<div class="row" style="justify-content:space-between"><h2 style="margin:0">Prospects</h2><a class="btn" href="/admin/prospects/new">Add prospect</a></div>
<p class="small" style="margin:10px 0">${statusTabs} <a href="/admin/prospects" class="small">All</a></p>
<form class="card inline" method="get" action="/admin/prospects">
  <label>Search<input type="text" name="q" value="${esc(f.q)}" placeholder="Name, website, city, email, ref" maxlength="100"></label>
  <label>Status<select name="status">${options([["", "Any"], ...STATUSES.map((s): [string, string] => [s, STATUS_LABELS[s]])], f.status)}</select></label>
  <label>Qualification<select name="qualification">${options([["", "Any"], ...Object.entries(QUALIFICATION_LABELS)], f.qualification)}</select></label>
  <label>Score band<select name="band">${options([["", "Any"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]], f.band)}</select></label>
  <label>State<input type="text" name="state" value="${esc(f.state)}" maxlength="50" style="min-width:80px;width:90px"></label>
  <label>City<input type="text" name="city" value="${esc(f.city)}" maxlength="100" style="min-width:140px"></label>
  <label>Sort<select name="sort">${options(Object.entries(SORTS), list.sort)}</select></label>
  <button type="submit">Apply</button> <a href="/admin/prospects" class="small">Reset</a>
</form>
<p class="small muted">${esc(shown)} Qualification comes only from the required criteria (${esc(criteriaNames)}): Disqualified if either is “no”, Meets criteria if both are “yes”. The opportunity score ranks prospects separately; its band is High ≥ ${BAND_THRESHOLDS.high}, Medium ≥ ${BAND_THRESHOLDS.medium}. Scoring ${esc(SCORING_VERSION)}.</p>
<div class="scroll"><table>
<thead><tr><th>Prospect</th><th>Location</th><th>Status</th><th>Qualification</th><th class="n">Opportunity score</th><th>Band</th><th>Public contact</th><th>Updated</th></tr></thead>
<tbody>${rows || `<tr><td colspan="8" class="muted">No prospects match.</td></tr>`}</tbody>
</table></div>`,
  );
}

// ---------- create / edit form ----------

function input(name: string, label: string, values: Values, attrs = "") {
  return `<label>${esc(label)}<input type="text" name="${name}" value="${esc(values[name])}" ${attrs}></label>`;
}

function signalFieldset(def: SignalDefinition, values: Values): string {
  const name = signalFieldName(def.key as SignalKey);
  const current = values[name] === "yes" || values[name] === "no" ? values[name] : "unknown";
  const derived = def.kind === "derived";
  const choice = (v: "yes" | "no" | "unknown", label: string, disabled = false) =>
    `<label><input type="radio" name="${name}" value="${v}"${current === v ? " checked" : ""}${disabled ? " disabled" : ""}> ${label}</label>`;
  const tags = [
    `${def.weight} pts`,
    def.requiredCriterion ? "required criterion: no disqualifies" : "",
    derived ? "yes is automatic" : "",
    def.requiresWebsite ? "needs a website" : "",
  ].filter(Boolean);
  return `<div class="signal">
  <b>${esc(def.label)}</b> <span class="small muted">${esc(tags.join(" · "))}</span>
  <div class="small">${esc(def.question)}</div>
  <div class="choices">${choice("yes", "Yes", derived)}${choice("no", "No")}${choice("unknown", "Unknown")}</div>
  <details><summary>Rules</summary><dl class="kv small" style="margin-top:6px">
    <dt>Yes</dt><dd>${esc(def.yes)}</dd><dt>No</dt><dd>${esc(def.no)}</dd><dt>Unknown</dt><dd>${esc(def.unknown)}</dd><dt>Why ${def.weight}</dt><dd>${esc(def.rationale)}</dd>
  </dl></details>
</div>`;
}

export function prospectFormPage(opts: { mode: "new" } | { mode: "edit"; id: string; name: string | null }, values: Values, errors?: string[]): string {
  const editing = opts.mode === "edit";
  const action = editing ? `/admin/prospects/${esc(opts.id)}` : "/admin/prospects";
  const title = editing ? `Edit ${opts.name ?? "prospect"}` : "Add prospect";
  const L = FIELD_LIMITS;
  return page(
    `${title} · ReclaimBay admin`,
    `${adminHeader("prospects")}
<p class="small"><a href="${editing ? action : "/admin/prospects"}">← ${editing ? "Back to prospect" : "Prospects"}</a></p>
<h2>${esc(title)}</h2>
${errorBox(errors)}
<form method="post" action="${action}" class="stack">
  <fieldset><legend>Business</legend><div class="fields">
    ${input("businessName", "Business name", values, `maxlength="${L.businessName}"`)}
    ${input("website", "Website", values, `maxlength="${L.website}" placeholder="smithauto.com"`)}
  </div></fieldset>
  <fieldset><legend>Location</legend><div class="fields">
    ${input("city", "City", values, `maxlength="${L.city}"`)}
    ${input("state", "State / region", values, `maxlength="${L.state}" placeholder="IL"`)}
    ${input("postalCode", "Postal code", values, `maxlength="${L.postalCode}"`)}
    ${input("country", "Country (2-letter)", { country: "US", ...values }, `maxlength="2"`)}
  </div></fieldset>
  <fieldset><legend>Public business contact</legend>
    <p class="small muted" style="margin-top:0">Only contact details the business itself publishes, each with the page where it is listed. Never an owner's personal phone, personal email, home address, or social profile.</p>
    <div class="fields">
      ${input("phone", "Business phone", values, `maxlength="${L.phone}"`)}
      ${input("phoneSourceUrl", "Where the phone is listed (URL)", values, `maxlength="${L.sourceUrl}"`)}
      ${input("email", "Business email", values, `maxlength="${L.email}"`)}
      ${input("emailSourceUrl", "Where the email is listed (URL)", values, `maxlength="${L.sourceUrl}"`)}
    </div>
  </fieldset>
  <fieldset><legend>Signals</legend>
    <p class="small muted" style="margin-top:0">Record only what a public source shows, following each signal's rules. When unsure, leave it Unknown: unknown adds no points and is never counted against the shop.</p>
    ${SIGNAL_DEFS.map((d) => signalFieldset(d, values)).join("")}
  </fieldset>
  <div class="row"><button type="submit">${editing ? "Save changes" : "Create prospect"}</button><a href="${editing ? action : "/admin/prospects"}">Cancel</a></div>
</form>`,
  );
}

// ---------- detail ----------

function qualificationDetail(result: Detail["result"]): string {
  const names = (keys: readonly string[]) => esc(keys.map(signalLabel).join(" and "));
  if (result.qualification === "disqualified") {
    return `${names(result.disqualifiedBy)} observed as “no”. The score below is still shown for reference.`;
  }
  if (result.qualification === "unverified") return `Still unknown: ${names(result.unverifiedCriteria)}.`;
  return `${esc(criteriaNames)} both observed as “yes”.`;
}

const EVENT_LABELS: Record<string, string> = {
  landing_view: "Visits",
  upload_started: "Uploads",
  scan_completed: "Real scans",
  tour_completed: "Tours",
  report_exported: "Exports",
};

export function prospectDetailPage(opts: {
  detail: Detail;
  siteUrl: string;
  notice?: string;
  errors?: string[];
  values?: Values;
}): string {
  const { detail, siteUrl, notice, errors, values = {} } = opts;
  const { prospect: p, result, stale, activity } = detail;
  const id = esc(p.id);
  const evidenceBySignal = new Map<string, number>();
  for (const e of p.evidence) evidenceBySignal.set(e.signalKey, (evidenceBySignal.get(e.signalKey) ?? 0) + 1);
  const observedAt = new Map(p.signals.map((s) => [s.key, s.observedAt]));

  const kv = (label: string, value: string) => `<dt>${esc(label)}</dt><dd>${value}</dd>`;
  const none = '<span class="muted">—</span>';
  const contact = (value: string | null, source: string | null) =>
    value ? `${esc(value)}${source ? `<div class="small">found at ${extLink(source)}</div>` : ""}` : none;

  const breakdown = result.breakdown
    .map((s) => {
      const def = SIGNAL_DEFS.find((d) => d.key === s.key)!;
      const when = observedAt.get(s.key);
      const ev = evidenceBySignal.get(s.key) ?? 0;
      return `<tr>
  <td><b>${esc(s.label)}</b>${def.requiredCriterion ? '<div class="small muted">required criterion</div>' : ""}${s.derived ? '<div class="small muted">derived</div>' : ""}</td>
  <td>${s.state === "unknown" ? '<span class="muted">Unknown</span>' : s.state === "yes" ? "Yes" : "No"}${when && !s.derived ? `<div class="small muted">${fmtDate(when)}</div>` : ""}</td>
  <td class="n">${s.points}<span class="muted">/${s.weight}</span></td>
  <td class="small">${esc(s.reason)}</td>
  <td class="n small">${ev || '<span class="muted">0</span>'}</td>
</tr>`;
    })
    .join("");

  const allowed = TRANSITIONS[p.status];
  const statusForm =
    allowed.length === 0
      ? `<p class="small">This prospect must never be contacted. The status is permanent and can't be changed here.</p>`
      : `<form method="post" action="/admin/prospects/${id}/status" class="inline">
  <label>Move to<select name="status">${options(allowed.map((s): [string, string] => [s, STATUS_LABELS[s]]), values.status)}</select></label>
  <label style="flex:1;min-width:220px">Reason <span class="small">(required for ${REASON_REQUIRED.map((s) => STATUS_LABELS[s]).join(", ")})</span><input type="text" name="reason" value="${esc(values.reason)}" maxlength="${FIELD_LIMITS.reason}"></label>
  <button type="submit">Change status</button>
</form>
<p class="small muted">Qualified needs a business name and Qualification “Meets criteria” (both required criteria “yes”); the score doesn't matter. Ready to contact also needs a public phone or email with its source. Do not contact is permanent.</p>`;

  const counts = (type: string, sample: boolean) =>
    activity.counts.filter((c) => c.eventType === type && c.isSample === sample).reduce((n, c) => n + c.count, 0);
  const sampleTotal = activity.counts.filter((c) => c.isSample).reduce((n, c) => n + c.count, 0);

  return page(
    `${p.businessName ?? "Prospect"} · ReclaimBay admin`,
    `${adminHeader("prospects")}
<p class="small"><a href="/admin/prospects">← Prospects</a></p>
${notice ? `<p class="ok" role="status">${esc(notice)}</p>` : ""}
${errorBox(errors)}
<div class="row" style="justify-content:space-between">
  <div><h2 style="margin:0 0 6px;font-size:20px">${esc(p.businessName ?? "Unnamed prospect")}</h2>
    <div class="row">${statusPill(p.status)} <span class="small muted">since ${fmtDate(p.statusChangedAt)}</span></div></div>
  <a class="btn" href="/admin/prospects/${id}/edit">Edit</a>
</div>
<div class="grid2" style="margin-top:14px">
  <div class="card"><div class="small muted">Qualification · required criteria</div>
    <div style="margin:6px 0">${qualificationPill(result.qualification)}</div>
    <div class="small">${qualificationDetail(result)}</div></div>
  <div class="card"><div class="small muted">Opportunity score · ranking only, not a verdict</div>
    <div style="margin:2px 0"><span style="font-size:28px;font-weight:700">${result.score}</span><span class="muted">/${MAX_SCORE}</span> ${bandPill(result.band)}</div>
    <div class="small">${result.known} of ${result.total} signals known.</div></div>
</div>
${stale ? `<p class="errs small">Cached score (${p.score}, ${esc(p.scoreVersion ?? "never scored")}) differs from the current scoring ${esc(SCORING_VERSION)}. Saving the prospect or running <code>npm run prospects:rescore</code> updates it.</p>` : ""}

<div class="grid2" style="margin-top:16px">
  <div class="card"><dl class="kv">
    ${kv("Website", p.website ? extLink(p.website) : none)}
    ${kv("Location", esc([p.city, p.state, p.postalCode].filter(Boolean).join(", ") || "—") + ` <span class="small muted">${esc(p.country)}</span>`)}
    ${kv("Phone", contact(p.phone, p.phoneSourceUrl))}
    ${kv("Email", contact(p.email, p.emailSourceUrl))}
    ${kv("Referral", `<code>${esc(p.referralCode)}</code><div><input class="link" readonly value="${esc(referralUrl(siteUrl, p.referralCode))}" aria-label="Referral link"></div>`)}
    ${kv("Added", fmtDate(p.createdAt))}
    ${kv("Updated", fmtDate(p.updatedAt))}
  </dl></div>
  <div class="card"><b>Referral activity</b>
    <dl class="kv" style="margin-top:8px">
      ${kv("Visitors", String(activity.sessions))}
      ${Object.entries(EVENT_LABELS).map(([t, l]) => kv(l, String(counts(t, false)))).join("")}
      ${kv("Sample activity", String(sampleTotal))}
      ${kv("Last activity", fmtDate(activity.lastActivity))}
    </dl>
  </div>
</div>

<h2>Score breakdown</h2>
<p class="small muted" style="margin-top:-4px">${result.known} of ${result.total} signals known. Points come only from “yes”; unknown adds nothing and is never counted against the shop.</p>
<div class="scroll"><table>
<thead><tr><th>Signal</th><th>Observed</th><th class="n">Points</th><th>Why</th><th class="n">Evidence</th></tr></thead>
<tbody>${breakdown}</tbody>
<tfoot><tr><td colspan="2"><b>Total</b></td><td class="n"><b>${result.score}</b><span class="muted">/${MAX_SCORE}</span></td><td colspan="2" class="small muted">Scoring ${esc(result.version)}</td></tr></tfoot>
</table></div>

<h2>Status</h2>
<div class="card">
  <p style="margin-top:0">${statusPill(p.status)} <span class="small">${esc(STATUS_MEANINGS[p.status])}</span></p>
  ${statusForm}
  <details style="margin-top:8px"><summary>History (${p.statusChanges.length})</summary>
    <ul class="small">${p.statusChanges.map((c) => `<li>${fmtDate(c.createdAt)}: ${c.fromStatus ? `${esc(STATUS_LABELS[c.fromStatus])} → ` : ""}<b>${esc(STATUS_LABELS[c.toStatus])}</b>${c.reason ? ` · ${esc(c.reason)}` : ""}</li>`).join("")}</ul>
  </details>
</div>

<h2>Evidence</h2>
<div class="card stack">
  <form method="post" action="/admin/prospects/${id}/evidence" class="stack">
    <div class="fields">
      <label>Supports signal<select name="signalKey">${options([["", "Choose…"], ...SIGNAL_DEFS.map((d): [string, string] => [d.key, d.label])], values.signalKey)}</select></label>
      <label>Public source URL<input type="text" name="sourceUrl" value="${esc(values.sourceUrl)}" maxlength="${FIELD_LIMITS.sourceUrl}"></label>
    </div>
    <label>Short excerpt (max ${FIELD_LIMITS.excerpt} characters: a quote, not a copied page)<textarea name="excerpt" maxlength="${FIELD_LIMITS.excerpt}">${esc(values.excerpt)}</textarea></label>
    <div><button type="submit">Add evidence</button></div>
  </form>
  ${
    p.evidence.length
      ? `<table><thead><tr><th>Signal</th><th>Excerpt</th><th>Source</th><th>Added</th><th></th></tr></thead><tbody>${p.evidence
          .map(
            (e) => `<tr><td class="small"><b>${esc(signalLabel(e.signalKey))}</b></td><td><blockquote class="small">${esc(e.excerpt)}</blockquote></td><td class="small">${extLink(e.sourceUrl)}</td><td class="small">${fmtDate(e.createdAt)}</td>
<td><form method="post" action="/admin/prospects/${id}/evidence/${esc(e.id)}/delete" class="inline-form"><button class="link" type="submit">Remove</button></form></td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="small muted">No evidence yet.</p>`
  }
</div>

<h2>Notes</h2>
<div class="card stack">
  <form method="post" action="/admin/prospects/${id}/notes" class="stack">
    <label>Add a note <span class="small">(business facts only; no personal details)</span><textarea name="body" maxlength="${FIELD_LIMITS.note}">${esc(values.body)}</textarea></label>
    <div><button type="submit">Add note</button></div>
  </form>
  ${p.notes.map((n) => `<div><div class="small muted">${fmtDate(n.createdAt)}</div><div style="white-space:pre-wrap">${esc(n.body)}</div></div>`).join("") || `<p class="small muted">No notes yet.</p>`}
</div>`,
  );
}
