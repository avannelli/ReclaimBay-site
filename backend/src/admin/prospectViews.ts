import type { getProspectDetail, listProspects } from "../prospects.js";
import { FIELD_LIMITS, SORTS, referralUrl, signalFieldName } from "../prospects.js";
import {
  REASON_REQUIRED,
  STATUSES,
  STATUS_LABELS,
  STATUS_MEANINGS,
  TRANSITIONS,
  type Status,
} from "../prospectStatus.js";
import {
  BAND_THRESHOLDS,
  FIT_CRITERION,
  MAX_SCORE,
  QUALIFICATION_LABELS,
  REQUIRED_CRITERIA,
  SCORING_VERSION,
  SIGNALS,
  resolveSignals,
  type ScoreResult,
  type SignalDefinition,
  type SignalKey,
} from "../scoring.js";
import { INTERNAL_TEST_IDENTITY } from "../internalTest.js";
import { outreachSection } from "./outreachViews.js";
import type { prospectListContext } from "./commandCenter.js";
import { appPage } from "./views.js";
import {
  bandBadge,
  crumbs,
  emptyState,
  errorSummary,
  esc,
  extLink,
  field,
  fieldErrors,
  fieldset,
  fmtDate,
  fmtDay,
  notice,
  obsBadge,
  options,
  pageHead,
  qualificationBadge,
  section,
  signalLabel,
  statusBadge,
  stepper,
  type FieldErrors,
  INTERNAL_TEST_TAG,
} from "./ui.js";

/* Admin pages for prospects. Server-rendered, no scripts, all values escaped. */

type ListResult = Awaited<ReturnType<typeof listProspects>>;
type Detail = NonNullable<Awaited<ReturnType<typeof getProspectDetail>>>;
export type Values = Record<string, string | undefined>;

const SIGNAL_DEFS = SIGNALS as readonly SignalDefinition[];
export const criteriaNames = REQUIRED_CRITERIA.map(signalLabel).join(" and ");

/** The plain-language reason behind a qualification result. Shared with candidates. */
export function qualificationDetail(result: ScoreResult): string {
  const names = (keys: readonly string[]) => esc(keys.map(signalLabel).join(" and "));
  if (result.qualification === "disqualified") {
    return `${names(result.disqualifiedBy)} observed as “no”. The opportunity score is still shown for reference.`;
  }
  if (result.qualification === "unverified") return `Still unknown: ${names(result.unverifiedCriteria)}.`;
  return `${esc(criteriaNames)} observed as “yes”.`;
}

// ---------- list ----------

export function prospectListPage(opts: {
  list: ListResult;
  filters: Values;
  statusCounts: Partial<Record<Status, number>>;
  context?: Awaited<ReturnType<typeof prospectListContext>>;
}): string {
  const { list, filters: f, statusCounts } = opts;
  const contexts = new Map((opts.context ?? []).map(x => [x.id, x]));
  const total = Object.values(statusCounts).reduce((n, v) => n + (v ?? 0), 0);
  const anyFilter = Boolean(f.q || f.status || f.qualification || f.band || f.state || f.city);
  const summary = `<section class="pipeline-summary" aria-label="Current prospect inventory">${[
    { label: "All prospects", n: total, href: "/admin/prospects", hint: "Current records" },
    { label: "Ready to contact", n: statusCounts.ready_to_contact ?? 0, href: "/admin/prospects?status=ready_to_contact", hint: "Current lifecycle status" },
    { label: "Contacted", n: statusCounts.contacted ?? 0, href: "/admin/prospects?status=contacted", hint: "Current lifecycle status" },
    { label: "Engaged", n: statusCounts.engaged ?? 0, href: "/admin/prospects?status=engaged", hint: "Current lifecycle status" },
  ].map(s => `<a href="${s.href}"><span>${s.label}</span><b>${s.n}</b><small>${s.hint}</small></a>`).join("")}</section><p class="pipeline-scope">All records, including internal tests. Current states, not historical reach. Search filters apply to the list below.</p>`;

  const chips = [
    `<a class="chip" href="/admin/prospects"${!f.status ? ' aria-current="true"' : ""}>All <span class="n">${total}</span></a>`,
    ...STATUSES.map((s) => {
      const on = f.status === s;
      return `<a class="chip" href="/admin/prospects?status=${s}"${on ? ' aria-current="true"' : ""}>${esc(STATUS_LABELS[s])} <span class="n">${statusCounts[s] ?? 0}</span></a>`;
    }),
  ].join("");

  const rows = list.rows
    .map(({ prospect: p, result, stale }) => {
      const loc = [p.city, p.state].filter(Boolean).join(", ");
      const contact = [p.phone && '<span class="tag">Phone</span>', p.email && '<span class="tag">Email</span>'].filter(Boolean).join(" ");
      const ctx = contexts.get(p.id);
      const repair = result.breakdown.find(s => s.key === FIT_CRITERION)?.state ?? "unknown";
      return `<tr>
  <td><a class="name" href="/admin/prospects/${esc(p.id)}">${esc(p.businessName ?? "Unnamed prospect")}</a>${p.internalTest ? ` ${INTERNAL_TEST_TAG}` : ""}${p.website ? `<div class="sub">${extLink(p.website)}</div>` : ""}<details class="row-context"><summary>Record details</summary><div>Public contact: ${contact || "None recorded"}</div><div>Updated ${fmtDay(p.updatedAt)}</div></details></td>
  <td data-label="Location">${loc ? esc(loc) : '<span class="muted">—</span>'}${p.postalCode ? `<div class="sub">${esc(p.postalCode)}</div>` : ""}</td>
  <td data-label="Status">${statusBadge(p.status)}</td>
  <td data-label="Qualification">${qualificationBadge(result.qualification)}</td>
  <td data-label="Repair evidence"><a href="/admin/prospects/${esc(p.id)}#evidence">${ctx?.evidence.length ? `${ctx.evidence.length} source record${ctx.evidence.length === 1 ? "" : "s"}` : "No source recorded"}</a><div class="sub">Automotive repair ${esc(repair === "unknown" ? "Unknown" : repair === "yes" ? "Yes" : "No")}</div></td>
  <td data-label="Outreach">${ctx?.outreach[0] ? `<span class="tag">${esc(ctx.outreach[0].status.replace(/_/g, " "))}</span><div class="sub">${fmtDay(ctx.outreach[0].statusChangedAt)}</div>` : '<span class="muted">Not contacted</span>'}</td>
  <td class="num" data-label="Opportunity score"><span class="score-cell"><b>${result.score}</b><span class="of">/${MAX_SCORE}</span></span><div class="sub">${bandBadge(result.band)}</div><div class="sub">${result.known}/${result.total} signals known</div>${stale ? `<div class="sub" style="color:var(--warn)">cache stale</div>` : ""}</td>
</tr>`;
    })
    .join("\n");

  const empty =
    total === 0
      ? emptyState("No prospects yet.", "Add your first prospect to begin building the research pipeline.", `<a class="btn" href="/admin/prospects/new">+ Add prospect</a>`)
      : emptyState("No prospects match these filters.", "Try clearing a filter or changing your search.", `<a class="btn btn-secondary" href="/admin/prospects">Clear filters</a>`);

  const shown = list.rows.length < list.total ? `Showing the first ${list.rows.length} of ${list.total}` : `${list.total} prospect${list.total === 1 ? "" : "s"}`;

  return appPage(
    "Prospects · ReclaimBay admin",
    "prospects",
    `${pageHead({
      title: "Prospects",
      lede: "The businesses in your pipeline, tracked from first research to customer.",
      actions: `<a class="btn" href="/admin/prospects/new">+ Add prospect</a><a class="btn btn-ghost" href="/admin/prospects/internal-test">Internal outreach test</a>`,
    })}
${summary}
<nav class="chips" aria-label="Filter by status">${chips}</nav>
<form class="card filters" method="get" action="/admin/prospects" role="search" aria-label="Search and filter prospects">
  <div class="workspace-search"><label class="sr-only" for="f-q">Search prospects</label>
  <input class="search" id="f-q" type="search" name="q" value="${esc(f.q)}" placeholder="Search name, website, city, phone, or referral code" maxlength="100"><button type="submit" class="btn-secondary">Search</button></div>
  <details class="workspace-context"${anyFilter || f.sort ? " open" : ""}><summary>Pipeline filters${anyFilter ? " · in use" : ""}</summary>
  <div class="filter-row">
    <div><label class="lbl" for="f-status">Status</label><select id="f-status" name="status">${options([["", "Any"], ...STATUSES.map((s): [string, string] => [s, STATUS_LABELS[s]])], f.status)}</select></div>
    <div><label class="lbl" for="f-qual">Qualification</label><select id="f-qual" name="qualification">${options([["", "Any"], ...Object.entries(QUALIFICATION_LABELS)], f.qualification)}</select></div>
    <div><label class="lbl" for="f-band">Score band</label><select id="f-band" name="band">${options([["", "Any"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]], f.band)}</select></div>
    <div><label class="lbl" for="f-state">State</label><input id="f-state" type="text" name="state" value="${esc(f.state)}" maxlength="50"></div>
    <div><label class="lbl" for="f-city">City</label><input id="f-city" type="text" name="city" value="${esc(f.city)}" maxlength="100"></div>
    <div><label class="lbl" for="f-sort">Sort by</label><select id="f-sort" name="sort">${options(Object.entries(SORTS), list.sort)}</select></div>
    <div class="filter-actions"><button type="submit">Apply filters</button><a class="btn btn-secondary" href="/admin/prospects">Reset</a></div>
  </div></details>
</form>
<div class="result-line"><span><b>${esc(shown)}</b>${anyFilter ? " match" : ""}</span>
  <details class="row-context"><summary>Qualification &amp; ranking</summary><p><b>Qualification</b> uses only the required criteria (${esc(criteriaNames)}). <b>Opportunity score</b> is a research ranking, not a verdict: High ≥ ${BAND_THRESHOLDS.high}, Medium ≥ ${BAND_THRESHOLDS.medium}.</p></details></div>
${
  list.rows.length
    ? `<div class="scroll pipeline-table"><table class="tbl cards">
<caption class="sr-only">Prospects</caption>
<thead><tr><th scope="col">Business</th><th scope="col">Location</th><th scope="col">Lifecycle</th><th scope="col">Qualification<br><span class="column-hint">required criteria</span></th><th scope="col">Repair evidence</th><th scope="col">Outreach</th><th scope="col" class="num">Opportunity score<br><span class="column-hint">research ranking</span></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`
    : `<div class="card">${empty}</div>`
}`,
  );
}

// ---------- form sections (shared with discovery candidates) ----------

/** Steps 1-3: business, location, and public contact. */
export function businessSections(values: Values, fe?: FieldErrors): string {
  const L = FIELD_LIMITS;
  const f = (name: string, label: string, extra: Partial<Parameters<typeof field>[0]> = {}) =>
    field({ name, label, values, errors: fe, ...extra });
  return [
    fieldset(1, "Business", `<div class="fields">
    ${f("businessName", "Business name", { attrs: `maxlength="${L.businessName}" autocomplete="off"` })}
    ${f("website", "Website", { attrs: `maxlength="${L.website}"`, placeholder: "smithauto.com", hint: "The shop's own site, not a directory or social page." })}
  </div>`),
    fieldset(2, "Location", `<div class="fields">
    ${f("city", "City", { attrs: `maxlength="${L.city}"` })}
    ${f("state", "State / region", { attrs: `maxlength="${L.state}"`, placeholder: "IL" })}
    ${f("postalCode", "Postal code", { attrs: `maxlength="${L.postalCode}"` })}
    ${f("country", "Country", { values: { country: "US", ...values }, attrs: `maxlength="2"`, hint: "2-letter code" })}
  </div>`),
    fieldset(
      3,
      "Public business contact",
      `<div class="fields">
    ${f("phone", "Business phone", { attrs: `maxlength="${L.phone}"` })}
    ${f("phoneSourceUrl", "Where the phone is listed", { attrs: `maxlength="${L.sourceUrl}"`, placeholder: "https://…/contact", hint: "Public page URL. Required with a phone." })}
    ${f("email", "Business email", { attrs: `maxlength="${L.email}"` })}
    ${f("emailSourceUrl", "Where the email is listed", { attrs: `maxlength="${L.sourceUrl}"`, placeholder: "https://…/contact", hint: "Public page URL. Required with an email." })}
  </div>`,
      "Only record contact information publicly published by the business itself.",
    ),
  ].join("\n  ");
}

function signalRow(def: SignalDefinition, values: Values, fe?: FieldErrors): string {
  const key = def.key as SignalKey;
  const name = signalFieldName(key);
  const current = values[name] === "yes" || values[name] === "no" ? values[name]! : "unknown";
  const derived = def.kind === "derived";
  const errs = fe?.byField.get(name) ?? [];

  // What the server will actually compute for this signal, from the same scoring code.
  const recorded: Partial<Record<string, "yes" | "no">> = {};
  for (const k of SIGNAL_DEFS) {
    const v = values[signalFieldName(k.key as SignalKey)];
    if (v === "yes" || v === "no") recorded[k.key] = v;
  }
  // A hint about the typed values only makes sense when those values are valid.
  const fieldsInvalid = ["website", "phone", "phoneSourceUrl", "email", "emailSourceUrl"].some((n) => fe?.byField.has(n));
  const effective = fieldsInvalid ? "unknown" : resolveSignals({
    signals: recorded,
    website: values.website,
    phone: values.phone,
    phoneSourceUrl: values.phoneSourceUrl,
    email: values.email,
    emailSourceUrl: values.emailSourceUrl,
  })[key];

  const choice = (v: "yes" | "no" | "unknown", label: string, disabled = false) =>
    `<label class="seg seg-${v}"><input type="radio" name="${name}" value="${v}"${current === v ? " checked" : ""}${disabled ? " disabled" : ""}><span>${label}</span></label>`;
  const notes = [
    derived ? `<span class="small muted">${effective === "yes" ? "Currently <b>Yes</b> automatically, from the fields above." : "“Yes” is set automatically from the fields above; choose No only after searching and finding none."}</span>` : "",
    def.requiresWebsite ? `<span class="small muted">Needs a website.</span>` : "",
    def.requiredCriterion ? `<span class="small muted">A “No” here disqualifies the business.</span>` : "",
    def.establishes ? `<span class="small muted">A “Yes” here also counts as verified automotive repair; a “No” never disqualifies.</span>` : "",
  ].filter(Boolean);

  return `<div class="sig${def.requiredCriterion ? " req" : ""}" role="group" aria-labelledby="sig-${key}"${errs.length ? ` id="f-${name}"` : ` id="f-${name}"`}>
  <div class="sig-h">
    <div><span class="sig-name" id="sig-${key}">${esc(def.label)}</span> ${signalKindTag(def)}</div>
    <span class="sig-pts" title="Points added when Yes">+${def.weight}</span>
  </div>
  <div class="sig-q">${esc(def.question)}</div>
  <div class="seg-group">${choice("yes", "Yes", derived)}${choice("no", "No")}${choice("unknown", "Unknown")}</div>
  ${errs.map((e) => `<div class="ferr">${esc(e)}</div>`).join("")}
  <div class="sig-foot">${notes.join(" ")}
    <details class="rules"><summary>View rules</summary><dl class="kv small">
      <dt>Yes</dt><dd>${esc(def.yes)}</dd><dt>No</dt><dd>${esc(def.no)}</dd><dt>Unknown</dt><dd>${esc(def.unknown)}</dd><dt>Why ${def.weight} points</dt><dd>${esc(def.rationale)}</dd>
    </dl></details>
  </div>
</div>`;
}

/** What a signal is for, in one tag: the required criterion, a segment that can establish it, or a ranking signal. */
export function signalKindTag(def: SignalDefinition, derived = false): string {
  if (def.requiredCriterion) return '<span class="kind req">Required criterion</span>';
  if (def.establishes) return '<span class="kind">Segment · counts as repair</span>';
  return derived ? '<span class="kind">Derived</span>' : '<span class="kind">Opportunity signal</span>';
}

/** Steps 4-5: the required criterion (with the segment that can establish it), then the opportunity signals. */
export function signalSections(values: Values, fe?: FieldErrors): string {
  const required = SIGNAL_DEFS.filter((d) => d.requiredCriterion || d.establishes);
  const other = SIGNAL_DEFS.filter((d) => !d.requiredCriterion && !d.establishes);
  return [
    fieldset(
      4,
      "Required qualification criteria",
      required.map((d) => signalRow(d, values, fe)).join(""),
      `<b>Verified automotive repair</b> decides <b>Qualification</b>: “Yes” meets criteria, “No” disqualifies. Collision/body repair is one segment: its “Yes” also counts as automotive repair, and its “No” never disqualifies. Leave Unknown until a public source shows it.`,
    ),
    fieldset(
      5,
      "Opportunity signals",
      other.map((d) => signalRow(d, values, fe)).join(""),
      `These add to the <b>Opportunity score</b> (a research ranking). They never change Qualification. Unknown adds nothing and is never held against the business.`,
    ),
  ].join("\n  ");
}

const GATE_NOTES: Partial<Record<Status, string>> = {
  qualified:
    "This prospect is <b>Qualified</b>. A save is refused if it would leave no business name or make Qualification anything but Meets criteria. To change those details, first move it to an earlier status.",
  ready_to_contact:
    "This prospect is <b>Ready to contact</b>. A save is refused if it would leave no business name, make Qualification anything but Meets criteria, or remove the public phone or email together with its source URL. To change those details, first move it to an earlier status.",
};

export function prospectFormPage(
  opts: { mode: "new" } | { mode: "internal" } | { mode: "edit"; id: string; name: string | null; status?: Status },
  values: Values,
  errors?: string[],
): string {
  const editing = opts.mode === "edit";
  const internal = opts.mode === "internal";
  const action = editing ? `/admin/prospects/${esc(opts.id)}` : internal ? "/admin/prospects/internal-test" : "/admin/prospects";
  const title = editing ? `Edit ${opts.name ?? "prospect"}` : internal ? "Add internal outreach test" : "Add prospect";
  const fe = fieldErrors(errors);
  const gate = editing && opts.status ? GATE_NOTES[opts.status] : undefined;
  return appPage(
    `${title} · ReclaimBay admin`,
    "prospects",
    `${crumbs([{ label: "Prospects", href: "/admin/prospects" }, ...(editing ? [{ label: opts.name ?? "Prospect", href: action }, { label: "Edit" }] : [{ label: title }])])}
${pageHead({ title, lede: editing ? "Same steps as adding a prospect. Every rule is checked when you save." : internal ? "ReclaimBay's own controlled test identity, not a business, to prove outreach end to end." : "Record what public sources show. Qualification and the opportunity score are worked out from what you enter." })}
${errorSummary(errors, fe)}
${internal ? `<div class="callout warn" style="margin-bottom:14px"><b>Internal test, not a business.</b> It is marked as an internal test permanently, from creation: that can't be changed later, and a real prospect can never be marked this way. It always carries the fixed identity below and no business details, signals, or evidence, so business qualification doesn't apply: Qualified and Ready to contact require this exact identity instead. Every sending check still applies (the deployment arm, the switch, the provider, the daily limit, recipient and suppression rules, the send gate). There is only one: creating it is refused while any record uses its mailbox. Its activity is left out of the outreach funnel, the analytics summary, and prospect intent.</div>` : ""}
${gate ? `<div class="callout warn" style="margin-bottom:14px">${gate}</div>` : ""}
<form method="post" action="${action}" class="stack" novalidate>
  ${internal ? `<div class="card">${internalTestIdentityList()}</div>` : `${businessSections(values, fe)}
  ${signalSections(values, fe)}`}
  ${fieldset(internal ? 1 : 6, internal ? "Confirm and create" : "Review and save", `<p class="fs-note" style="margin:0 0 12px">${editing ? "Saving recalculates the score and re-checks the status requirements." : internal ? "It starts as <b>New</b>. Prepare, review, and queue its message like any other." : "The prospect starts as <b>New</b>. You can move it through the pipeline after creating it."}</p>
  ${internal ? `<label class="check" style="margin:0 0 12px;display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="confirmInternalTest" value="yes"${values.confirmInternalTest === "yes" ? " checked" : ""}${(fe.byField.get("confirmInternalTest") ?? []).length ? ' aria-invalid="true"' : ""}> <span>This is ReclaimBay's own internal outreach test identity, not a business. It stays marked as one permanently.</span></label>` : ""}
  <div class="form-foot"><button type="submit" class="btn-primary-lg">${editing ? "Save changes" : internal ? "Create internal test" : "Create prospect"}</button><a class="btn btn-secondary btn-primary-lg" href="${editing ? action : "/admin/prospects"}">Cancel</a></div>`)}
</form>`,
  );
}

/** The internal outreach test's fixed identity, as the form and its page show it. */
function internalTestIdentityList(): string {
  const { businessName, email, emailSourceUrl } = INTERNAL_TEST_IDENTITY;
  return `<dl class="kv">
    <dt>Identity</dt><dd><b>${esc(businessName)}</b>: ReclaimBay's own controlled test, not a business</dd>
    <dt>Recipient</dt><dd><code>${esc(email)}</code>, a mailbox ReclaimBay controls</dd>
    <dt>Documented at</dt><dd>${extLink(emailSourceUrl)}</dd>
    <dt>Qualification</dt><dd>Business qualification and automotive repair evidence don't apply. Qualified and Ready to contact require this exact identity instead.</dd>
  </dl>`;
}

// ---------- detail ----------

const PIPELINE: Status[] = ["new", "qualified", "ready_to_contact", "contacted", "engaged", "meeting", "proposal", "customer"];
const EVENT_LABELS: [string, string][] = [
  ["landing_view", "Visits"],
  ["upload_started", "Uploads"],
  ["scan_completed", "Real scans"],
  ["report_exported", "Exports"],
  ["tour_completed", "Tours"],
  ["contact_clicked", "Contact clicks"],
];

export function prospectDetailPage(opts: {
  detail: Detail;
  siteUrl: string;
  /** The Outreach section's data; omitted, the section isn't shown. */
  outreach?: Parameters<typeof outreachSection>[1];
  notice?: string;
  errors?: string[];
  values?: Values;
}): string {
  const { detail, siteUrl, values = {} } = opts;
  const { prospect: p, result, stale, activity } = detail;
  const id = esc(p.id);
  const fe = fieldErrors(opts.errors);
  const none = '<span class="muted">—</span>';

  const evidenceCount = new Map<string, number>();
  for (const e of p.evidence) evidenceCount.set(e.signalKey, (evidenceCount.get(e.signalKey) ?? 0) + 1);
  const observedAt = new Map(p.signals.map((s) => [s.key, s.observedAt]));

  const contact = (value: string | null, source: string | null) =>
    value
      ? `${esc(value)} <span class="tag">Public business contact</span>${source ? `<div class="src">found at ${extLink(source)}</div>` : ""}`
      : none;
  const location = [p.city, p.state, p.postalCode].filter(Boolean).join(", ");

  const breakdown = result.breakdown
    .map((s) => {
      const def = SIGNAL_DEFS.find((d) => d.key === s.key)!;
      const when = observedAt.get(s.key);
      const ev = evidenceCount.get(s.key) ?? 0;
      return `<tr>
  <td><b>${esc(s.label)}</b><div class="sub">${signalKindTag(def, s.derived)}</div></td>
  <td data-label="Observed">${obsBadge(s.state)}${when && !s.derived ? `<div class="sub">${fmtDay(when)}</div>` : ""}</td>
  <td class="num" data-label="Points"><span class="score-cell"><b>${s.points}</b><span class="of">/${s.weight}</span></span></td>
  <td class="small" data-label="Why">${esc(s.reason)}</td>
  <td class="num" data-label="Evidence">${ev ? `<a href="#evidence">${ev}</a>` : '<span class="muted">0</span>'}</td>
</tr>`;
    })
    .join("");

  const allowed = TRANSITIONS[p.status];
  const statusErrs = fe.byField.get("status") ?? [];
  const statusBlock =
    allowed.length === 0
      ? `<p>This prospect must never be contacted. The status is permanent and can't be changed here.</p>`
      : `${stepper(PIPELINE, STATUS_LABELS, p.status)}
<form method="post" action="/admin/prospects/${id}/status" class="row" style="align-items:flex-end" novalidate>
  <div style="min-width:180px"><label class="lbl" for="f-status">Move to</label><select id="f-status" name="status"${statusErrs.length ? ' aria-invalid="true"' : ""}>${options(allowed.map((s): [string, string] => [s, STATUS_LABELS[s]]), values.status)}</select></div>
  <div style="flex:1;min-width:240px"><label class="lbl" for="f-reason">Reason <span class="muted" style="font-weight:400">(required for ${REASON_REQUIRED.map((s) => STATUS_LABELS[s]).join(" and ")})</span></label><input id="f-reason" type="text" name="reason" value="${esc(values.reason)}" maxlength="${FIELD_LIMITS.reason}"></div>
  <button type="submit">Change status</button>
</form>
${statusErrs.map((e) => `<div class="ferr">${esc(e)}</div>`).join("")}
<p class="small muted" style="margin-top:10px">Only valid next steps are listed. Qualified needs a business name and Qualification “Meets criteria” (the opportunity score doesn't matter). Ready to contact also needs a public phone or email with its source. Do not contact is permanent.</p>`;

  const counts = (type: string, sample: boolean) =>
    activity.counts.filter((c) => c.eventType === type && c.isSample === sample).reduce((n, c) => n + c.count, 0);
  const sampleTotal = activity.counts.filter((c) => c.isSample).reduce((n, c) => n + c.count, 0);

  const evidence = p.evidence.length
    ? p.evidence
        .map(
          (e) => `<article class="ev">
  <div class="row spread"><span><span class="kind">Signal</span> <b>${esc(signalLabel(e.signalKey))}</b></span>
    <form method="post" action="/admin/prospects/${id}/evidence/${esc(e.id)}/delete" class="inline-form"><button class="link" type="submit" aria-label="Remove evidence for ${esc(signalLabel(e.signalKey))}">Remove</button></form></div>
  <blockquote>${esc(e.excerpt)}</blockquote>
  <div class="meta"><span>Source: ${extLink(e.sourceUrl)}</span><span>${fmtDate(e.createdAt)}</span></div>
</article>`,
        )
        .join("")
    : `<div class="card">${emptyState("No evidence recorded yet.", "Add a short public excerpt and its source URL for each signal you record.")}</div>`;

  const ef = (name: string, label: string, attrs: string, hint?: string) =>
    field({ name, label, values, errors: fe, attrs, hint });

  return appPage(
    `${p.businessName ?? "Prospect"} · ReclaimBay admin`,
    "prospects",
    `${crumbs([{ label: "Prospects", href: "/admin/prospects" }, { label: p.businessName ?? "Unnamed prospect" }])}
${notice(opts.notice)}${errorSummary(opts.errors, fe, "Not done")}
${pageHead({
  title: p.businessName ?? "Unnamed prospect",
  badges: `${statusBadge(p.status)}${p.internalTest ? INTERNAL_TEST_TAG : ""}${location ? `<span class="muted">${esc(location)}</span>` : ""}<span class="muted small">Status since ${fmtDay(p.statusChangedAt)}</span>`,
  actions: `${p.internalTest ? "" : `<a class="btn" href="/admin/prospects/${id}/edit">Edit</a>`}${allowed.length ? `<a class="btn btn-secondary" href="#status">Change status</a>` : ""}`,
})}
<nav class="dossier-nav" aria-label="Business dossier sections"><a href="#business">Business</a><a href="#evidence">Repair evidence</a><a href="#score">Scoring</a><a href="#status">Decisions</a><a href="#outreach">Outreach</a><a href="#notes">Research notes</a><a href="#activity">Engagement</a></nav>
${p.internalTest ? `<div class="callout warn" style="margin-bottom:14px"><b>Internal outreach test.</b> Not a business: ReclaimBay's own controlled test identity, which can't be edited or given evidence. It is sent through every normal sending check, and its activity is left out of the outreach funnel, the analytics summary, and prospect intent. Its own activity is shown below.</div>
<div class="card" style="margin-bottom:14px"><div class="card-h">Internal test identity</div>${internalTestIdentityList()}</div>` : ""}
${stale ? `<div class="callout warn" style="margin-bottom:14px">The saved score (${p.score}, ${esc(p.scoreVersion ?? "never scored")}) differs from the current scoring ${esc(SCORING_VERSION)}. Saving the prospect or running <code>npm run prospects:rescore</code> updates it. The numbers on this page are always current.</div>` : ""}

${p.internalTest ? "" : `<div class="grid-2">
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
</div>`}

${section(
  "business",
  "Business information",
  `<div class="grid-2">
  <div class="card"><dl class="kv">
    <dt>Website</dt><dd>${p.website ? extLink(p.website) : none}</dd>
    <dt>Location</dt><dd>${location ? esc(location) : none}</dd>
    <dt>Country</dt><dd>${esc(p.country)}</dd>
    <dt>Phone</dt><dd>${contact(p.phone, p.phoneSourceUrl)}</dd>
    <dt>Email</dt><dd>${contact(p.email, p.emailSourceUrl)}</dd>
  </dl></div>
  <div class="card"><dl class="kv">
    <dt>Referral code</dt><dd><code>${esc(p.referralCode)}</code></dd>
    <dt>Referral link</dt><dd><input type="text" readonly aria-label="Referral link" value="${esc(referralUrl(siteUrl, p.referralCode))}"></dd>
    <dt>Added</dt><dd>${fmtDate(p.createdAt)}</dd>
    <dt>Updated</dt><dd>${fmtDate(p.updatedAt)}</dd>
  </dl></div>
</div>`,
)}

${section(
  "activity",
  "Referral and product activity",
  `<div class="card"><dl class="metrics">
  <div><dt>Visitors</dt><dd>${activity.sessions}</dd></div>
  ${EVENT_LABELS.map(([t, l]) => `<div><dt>${esc(l)}</dt><dd>${counts(t, false)}</dd></div>`).join("")}
  <div class="m-sample"><dt>Sample activity</dt><dd>${sampleTotal}</dd></div>
</dl><p class="small muted" style="margin-top:10px">Last activity: ${fmtDate(activity.lastActivity)}. Real counts exclude the built-in sample report.</p></div>`,
)}

${section(
  "score",
  "Score breakdown",
  `<p class="small muted" style="margin:-4px 0 10px">${result.known} of ${result.total} signals known. Points come only from “Yes”. Unknown adds nothing and is never counted against the business.</p>
<div class="scroll"><table class="tbl cards">
<caption class="sr-only">How the opportunity score was calculated</caption>
<thead><tr><th scope="col">Signal</th><th scope="col">Observed</th><th scope="col" class="num">Points</th><th scope="col">Why</th><th scope="col" class="num">Evidence</th></tr></thead>
<tbody>${breakdown}</tbody>
<tfoot><tr><td colspan="2">Total</td><td class="num"><span class="score-cell"><b>${result.score}</b><span class="of">/${MAX_SCORE}</span></span></td><td colspan="2" class="small muted" style="font-weight:400">Scoring ${esc(result.version)}</td></tr></tfoot>
</table></div>`,
)}

${section(
  "status",
  "Status",
  `<div class="card"><p style="margin:0 0 10px">${statusBadge(p.status)} <span class="small muted">${esc(STATUS_MEANINGS[p.status])}</span></p>
${statusBlock}
<h3 class="card-h" style="margin-top:16px">History</h3>
<ul class="timeline">${p.statusChanges.map((c) => `<li><span class="when">${fmtDate(c.createdAt)}</span>${c.fromStatus ? `${esc(STATUS_LABELS[c.fromStatus])} → ` : ""}<b>${esc(STATUS_LABELS[c.toStatus])}</b>${c.reason ? ` · ${esc(c.reason)}` : ""}</li>`).join("")}</ul></div>`,
)}

${opts.outreach ? outreachSection(p.id, opts.outreach) : ""}

${section(
  "evidence",
  "Evidence",
  `${evidence}
${p.internalTest ? "" : `<form method="post" action="/admin/prospects/${id}/evidence" class="card stack" style="margin-top:14px" novalidate>
  <div class="card-h" style="margin:0">Add evidence</div>
  <div class="fields">
    <div class="field"><label for="f-signalKey">Supports signal</label><select id="f-signalKey" name="signalKey"${fe.byField.has("signalKey") ? ' aria-invalid="true"' : ""}>${options([["", "Choose…"], ...SIGNAL_DEFS.map((d): [string, string] => [d.key, d.label])], values.signalKey)}</select>${(fe.byField.get("signalKey") ?? []).map((e) => `<div class="ferr">${esc(e)}</div>`).join("")}</div>
    ${ef("sourceUrl", "Public source URL", `maxlength="${FIELD_LIMITS.sourceUrl}"`)}
  </div>
  <div class="field"><label for="f-excerpt">Short excerpt</label><textarea id="f-excerpt" name="excerpt" maxlength="${FIELD_LIMITS.excerpt}"${fe.byField.has("excerpt") ? ' aria-invalid="true"' : ""}>${esc(values.excerpt)}</textarea><div class="hint">Up to ${FIELD_LIMITS.excerpt} characters: a short quote, not a copied page.</div>${(fe.byField.get("excerpt") ?? []).map((e) => `<div class="ferr">${esc(e)}</div>`).join("")}</div>
  <div><button type="submit">Add evidence</button></div>
</form>`}`,
)}

${section(
  "notes",
  "Research notes",
  `<div class="card">
  <form method="post" action="/admin/prospects/${id}/notes" class="stack" novalidate>
    <div class="field"><label for="f-body">Add a note</label><textarea id="f-body" name="body" maxlength="${FIELD_LIMITS.note}"${fe.byField.has("body") ? ' aria-invalid="true"' : ""}>${esc(values.body)}</textarea><div class="hint">Business facts only. Notes can't be edited or removed.</div>${(fe.byField.get("body") ?? []).map((e) => `<div class="ferr">${esc(e)}</div>`).join("")}</div>
    <div><button type="submit">Add note</button></div>
  </form>
  <div style="margin-top:14px">${p.notes.map((n) => `<div class="note"><div class="when">${fmtDate(n.createdAt)}</div><div class="body">${esc(n.body)}</div></div>`).join("") || emptyState("No research notes yet.")}</div>
</div>`,
)}`,
  );
}
