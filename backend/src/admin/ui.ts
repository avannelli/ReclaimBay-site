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

export const fmtDate = (d: Date | null | undefined) =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";

export const fmtDay = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

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
  return `<div class="empty"><b>${esc(title)}</b>${hint ? `<span>${esc(hint)}</span>` : ""}${action ? `<div style="margin-top:12px">${action}</div>` : ""}</div>`;
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
