/*
 * Shared admin UI pieces. Everything here returns escaped HTML strings; no
 * scripts. Presentation only: no business rules live in this file.
 */
import { CANDIDATE_STATUS_LABELS, type CandidateStatus } from "../discovery/candidateStatus.js";
import { STATUS_LABELS, type Status } from "../prospectStatus.js";
import {
  BAND_LABELS,
  QUALIFICATION_LABELS,
  SIGNALS,
  type Qualification,
  type ScoreBand,
  type SignalDefinition,
  type SignalState,
} from "../scoring.js";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Small inline line icons (inline SVG, so the CSP's img-src doesn't apply). Labels always carry the meaning. */
const ICONS: Record<string, string> = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  discovery: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5M8 11h6m-3-3v6"/>',
  prospects: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  sending: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  prepare: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  messages: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',
  replies: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  reviews: '<path d="m12 3 8 3.5V12c0 4.6-3.4 8-8 9-4.6-1-8-4.4-8-9V6.5zM12 8v5m0 3h.01"/>',
  funnel: '<path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/>',
  campaigns: '<path d="m3 11 18-6v14L3 13zM7 14v7h4l-2-6"/>',
  health: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  activity: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  research: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8m-8 4h5"/>',
  product: '<path d="M4 20V10m8 10V4m8 16v-7"/>',
};
export function icon(name: string): string {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.activity}</svg>`;
}

export const fmtDate = (d: Date | null | undefined) =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";

export const fmtDay = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

/** "just now", "12 min ago", "3 h ago", "4 d ago": computed when the page renders, never later. */
export function relTime(d: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** A duration in words for "oldest" and "latest" labels: 12 min, 3 h, 4 d. */
export function ageText(d: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

/** A relative time with the exact UTC time on hover and in the markup. */
export const timeTag = (d: Date, now: Date) => `<time datetime="${d.toISOString()}" title="${fmtDate(d)}">${relTime(d, now)}</time>`;

// ---------- shared primitives ----------

/** Tones of the one badge system; the CSS gives each a foreground, a background, and a border. */
export type Tone = "pos" | "warn" | "neg" | "info" | "off" | "unknown";

/** A badge: words always, a glyph when given, tone last. */
export const badge = (text: string, tone?: Tone, glyph?: string) =>
  `<span class="badge${tone ? ` b-${tone}` : ""}">${glyph ? `<span aria-hidden="true">${glyph}</span>` : ""}${esc(text)}</span>`;

/** A card's heading row: title, optional explanation, optional link out. */
export function cardHead(title: string, opts: { id?: string; sub?: string; link?: { href: string; label: string } } = {}): string {
  return `<header class="card-head"><div><h2${opts.id ? ` id="${esc(opts.id)}"` : ""}>${esc(title)}</h2>${opts.sub ? `<p>${esc(opts.sub)}</p>` : ""}</div>${
    opts.link ? `<a class="card-link" href="${esc(opts.link.href)}">${esc(opts.link.label)} →</a>` : ""
  }</header>`;
}

/**
 * A card: a section with a heading. Level 0 sits in the page (a well),
 * 1 is a normal card, 2 an important one, 3 a confirmation panel.
 */
export function card(title: string, body: string, opts: { id: string; level?: 0 | 1 | 2 | 3; cls?: string; sub?: string; link?: { href: string; label: string } }): string {
  const level = opts.level ?? 1;
  return `<section class="card${level === 1 ? "" : ` lv${level}`}${opts.cls ? ` ${opts.cls}` : ""}" aria-labelledby="${esc(opts.id)}">${cardHead(title, { id: opts.id, sub: opts.sub, link: opts.link })}${body}</section>`;
}

/** One headline figure. The same markup the Funnel page has always used. */
export const kpi = (label: string, value: string | number, hint: string) =>
  `<div class="kpi"><div class="k-label">${esc(label)}</div><div class="k-value">${esc(value)}</div><div class="k-hint">${esc(hint)}</div></div>`;

/** A state banner: tone, glyph, and words together (the message page's state line). */
export const stateBanner = (o: { tone: string; glyph: string; title: string; detail: string; id: string }) =>
  `<section class="o-status t-${esc(o.tone)}" aria-labelledby="${esc(o.id)}"><div class="o-status-main">
  <h2 id="${esc(o.id)}" class="o-status-l"><span aria-hidden="true">${o.glyph}</span> ${esc(o.title)}</h2>
  <p class="o-status-d">${esc(o.detail)}</p>
</div></section>`;

/** Used out of a limit: one pip per unit for small limits, a bar for large ones. Decorative; the caller states the numbers in words. */
export function meter(used: number, limit: number): string {
  if (limit <= 0) return "";
  if (limit <= 24) {
    return `<span class="pips" aria-hidden="true">${Array.from({ length: limit }, (_, i) => `<i${i < used ? ' class="on"' : ""}></i>`).join("")}</span>`;
  }
  return `<span class="meter" aria-hidden="true"><span style="width:${Math.min(100, Math.round((used / limit) * 100))}%"></span></span>`;
}

/** Below this many, a share of a stage says nothing reliable: show counts only. */
export const MIN_COMPARE = 20;

/** "62% of qualified", or why no rate is shown. */
export function rateText(n: number, base: number | null, baseLabel: string, min = MIN_COMPARE): string {
  if (base === null) return "";
  if (base < min) return "Too few to compare";
  return `<b>${Math.round((n / base) * 100)}%</b> of ${esc(baseLabel)}`;
}

export interface FunnelStage {
  label: string;
  n: number;
  /** The stage this one is a share of, for its rate; null for the first stage. */
  base: number | null;
  baseLabel?: string;
}

/** A funnel as labelled bars: each bar against the segment's first stage, each rate against its own base. */
export function funnelBar(stages: FunnelStage[], label: string, min = MIN_COMPARE): string {
  const top = Math.max(1, ...stages.map((s) => s.n));
  return `<ol class="fbar" aria-label="${esc(label)}">${stages
    .map(
      (s) => `<li class="fbar-row${s.n === 0 ? " is-zero" : ""}"><span class="fbar-l">${esc(s.label)}</span><span class="fbar-track" aria-hidden="true"><span style="width:${s.n ? Math.max(1, Math.round((s.n / top) * 100)) : 0}%"></span></span><span class="fbar-n">${s.n}</span><span class="fbar-c">${rateText(s.n, s.base, s.baseLabel ?? "the stage before", min)}</span></li>`,
    )
    .join("")}</ol>`;
}

/** A table with a caption and column headers that becomes labelled cards on small screens. Cells are already escaped. */
export const dataTable = (caption: string, head: string[], rows: string[]) =>
  `<div class="scroll"><table class="tbl cards"><caption class="sr-only">${esc(caption)}</caption>
<thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("\n")}</tbody></table></div>`;

/** A section that couldn't be loaded: said plainly, never shown as zero. */
export const unavailable = (what: string) =>
  `<p class="unavailable" role="status">${esc(what)} could not be loaded. Nothing is shown in its place; refresh to try again.</p>`;

const SIGNAL_DEFS = SIGNALS as readonly SignalDefinition[];
export const signalLabel = (key: string) => SIGNAL_DEFS.find((s) => s.key === key)?.label ?? key;

// ---------- badges ----------

/** The tag every view shows for an internal outreach test prospect (Prospect.internalTest). */
export const INTERNAL_TEST_TAG = '<span class="tag" style="border-color:var(--amber);color:var(--warn)">Internal test</span>';

export const statusBadge = (s: Status) => `<span class="st st-${s}">${esc(STATUS_LABELS[s])}</span>`;
export const candidateBadge = (s: CandidateStatus) => `<span class="st cs-${s}">${esc(CANDIDATE_STATUS_LABELS[s])}</span>`;
export const qualificationBadge = (q: Qualification, extraClass = "") =>
  `<span class="st q-${q}${extraClass ? ` ${extraClass}` : ""}">${esc(QUALIFICATION_LABELS[q])}</span>`;
export const bandBadge = (b: ScoreBand) => `<span class="pill band-${b}">${esc(BAND_LABELS[b])}</span>`;
export const obsBadge = (s: SignalState) =>
  `<span class="obs obs-${s}">${s === "yes" ? "Yes" : s === "no" ? "No" : "Unknown"}</span>`;

/** Only http(s) URLs are ever stored, so they are safe as links. */
export const extLink = (url: string, label = url.replace(/^https?:\/\//, "").replace(/\/$/, "")) =>
  `<a class="url" href="${esc(url)}" rel="noreferrer noopener" target="_blank" title="${esc(url)}">${esc(label)}</a>`;

export const options = (items: [string, string][], selected: string | undefined) =>
  items.map(([v, l]) => `<option value="${esc(v)}"${v === (selected ?? "") ? " selected" : ""}>${esc(l)}</option>`).join("");

// ---------- page structure ----------

export function crumbs(trail: { label: string; href?: string }[]): string {
  const items = trail
    .map((t, i) =>
      i === trail.length - 1 || !t.href
        ? `<span aria-current="page">${esc(t.label)}</span>`
        : `<a href="${esc(t.href)}">${esc(t.label)}</a>`,
    )
    .join(" / ");
  return `<nav class="crumbs" aria-label="Breadcrumb">${items}</nav>`;
}

export function pageHead(opts: { title: string; lede?: string; actions?: string; badges?: string }): string {
  return `<div class="page-head">
  <div><h1>${esc(opts.title)}</h1>${opts.badges ? `<div class="row" style="margin-top:6px">${opts.badges}</div>` : ""}${opts.lede ? `<p class="lede">${opts.lede}</p>` : ""}</div>
  ${opts.actions ? `<div class="actions">${opts.actions}</div>` : ""}
</div>`;
}

export const notice = (text?: string) => (text ? `<p class="notice" role="status">${esc(text)}</p>` : "");

export function emptyState(title: string, hint?: string, action?: string): string {
  return `<div class="empty"><div class="empty-mark" aria-hidden="true">${icon("activity")}</div><b>${esc(title)}</b>${hint ? `<span>${esc(hint)}</span>` : ""}${action ? `<div style="margin-top:14px">${action}</div>` : ""}</div>`;
}

export const section = (id: string, title: string, body: string, aside?: string) =>
  `<section class="section" id="${esc(id)}" aria-labelledby="${esc(id)}-h"><h2 id="${esc(id)}-h">${esc(title)}${aside ? ` <span class="aside">${aside}</span>` : ""}</h2>${body}</section>`;

/** Horizontal pipeline: done / current / upcoming, by text and glyph as well as shade. */
export function stepper(order: readonly string[], labels: Record<string, string>, current: string): string {
  const at = order.indexOf(current);
  const items = order
    .map((s, i) => {
      const cls = at === -1 ? "next" : i < at ? "done" : i === at ? "now" : "next";
      const sr = cls === "done" ? " (done)" : cls === "now" ? " (current)" : "";
      return `<li class="${cls}"${cls === "now" ? ' aria-current="step"' : ""}>${esc(labels[s])}<span class="sr-only">${sr}</span></li>`;
    })
    .join("");
  return `<ol class="steps" aria-label="Pipeline progress">${items}</ol>`;
}

// ---------- forms ----------

/** Validation messages grouped by the field they are about; the rest stay general. */
export interface FieldErrors {
  byField: Map<string, string[]>;
  all: string[];
}

const FIELD_PATTERNS: [string, RegExp][] = [
  ["phoneSourceUrl", /^Phone (source URL|needs)/],
  ["phone", /^Phone/],
  ["emailSourceUrl", /^Email (source URL|needs)/],
  ["email", /^Email/],
  ["businessName", /^Business name/],
  ["website", /^Website/],
  ["city", /^City/],
  ["state", /^State/],
  ["postalCode", /^Postal code/],
  ["country", /^Country/],
  // evidence, notes, and status forms on the detail pages
  ["signalKey", /^Choose the signal/],
  ["sourceUrl", /^Source URL/],
  ["excerpt", /^Excerpt/],
  ["body", /^Note /],
  ["categoryVerdict", /^Choose a category decision/],
  ["categoryReason", /^(A category decision needs a reason|Category reason is too long)/],
  ["status", /^(Unknown status|Already |Can't move|Do not contact is permanent|Moving to|Qualified requires|Ready to contact requires|Researched requires|Every recorded signal|Use Approve|The status changed|Reason is too long)/],
];

/** Maps the existing validator messages onto fields, by their wording only. */
export function fieldErrors(errors?: readonly string[]): FieldErrors {
  const byField = new Map<string, string[]>();
  const add = (name: string, msg: string) => byField.set(name, [...(byField.get(name) ?? []), msg]);
  for (const msg of errors ?? []) {
    // Signal messages first: a label like "Website not on HTTPS" must not be read as the Website field.
    const sig = SIGNAL_DEFS.find((d) => msg.startsWith(`${d.label}:`)) ?? SIGNAL_DEFS.find((d) => msg.includes(`signal ${d.key}`));
    if (sig) {
      add(`signal_${sig.key}`, msg);
      continue;
    }
    const hit = FIELD_PATTERNS.find(([, re]) => re.test(msg));
    if (hit) add(hit[0], msg);
  }
  return { byField, all: [...(errors ?? [])] };
}

/** Summary box at the top of a form; each mapped message links to its field. */
export function errorSummary(errors: readonly string[] | undefined, fe: FieldErrors, heading = "Not saved"): string {
  if (!errors?.length) return "";
  const target = (msg: string) => [...fe.byField].find(([, list]) => list.includes(msg))?.[0];
  return `<div class="errbox" role="alert" tabindex="-1"><b>${esc(heading)}: fix ${errors.length === 1 ? "this" : "these"} and try again</b><ul>${errors
    .map((e) => {
      const t = target(e);
      return `<li>${t ? `<a href="#f-${esc(t)}">${esc(e)}</a>` : esc(e)}</li>`;
    })
    .join("")}</ul></div>`;
}

type Values = Record<string, string | undefined>;

export function field(opts: {
  name: string;
  label: string;
  values: Values;
  errors?: FieldErrors;
  hint?: string;
  attrs?: string;
  placeholder?: string;
  wide?: boolean;
  type?: string;
}): string {
  const errs = opts.errors?.byField.get(opts.name) ?? [];
  const described = [opts.hint ? `h-${opts.name}` : "", errs.length ? `e-${opts.name}` : ""].filter(Boolean).join(" ");
  return `<div class="field${opts.wide ? " wide" : ""}">
  <label for="f-${esc(opts.name)}">${esc(opts.label)}</label>
  <input id="f-${esc(opts.name)}" type="${opts.type ?? "text"}" name="${esc(opts.name)}" value="${esc(opts.values[opts.name])}"${opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : ""}${opts.attrs ? ` ${opts.attrs}` : ""}${errs.length ? ' aria-invalid="true"' : ""}${described ? ` aria-describedby="${described}"` : ""}>
  ${opts.hint ? `<div class="hint" id="h-${esc(opts.name)}">${esc(opts.hint)}</div>` : ""}
  ${errs.map((e) => `<div class="ferr" id="e-${esc(opts.name)}">${esc(e)}</div>`).join("")}
</div>`;
}

export function fieldset(step: number | null, title: string, body: string, note?: string, id?: string): string {
  return `<fieldset class="fs"${id ? ` id="${esc(id)}"` : ""}><legend>${step ? `<span class="step-n" aria-hidden="true">${step}</span>` : ""}${esc(title)}</legend>${note ? `<p class="fs-note">${note}</p>` : ""}${body}</fieldset>`;
}
