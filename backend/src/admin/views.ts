import { STYLE } from "./styles.js";
import type { ProspectRow, Summary } from "./stats.js";
import { emptyState, esc, extLink, fmtDate, pageHead, section } from "./ui.js";

export { esc, fmtDate };

/* Server-rendered admin shell and pages. No scripts; every dynamic value is escaped. */

const head = (title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${STYLE}</style></head>`;

/** Unauthenticated pages (login, disabled): a plain centered card. */
export function page(title: string, body: string): string {
  return `${head(title)}<body class="login">${body}</body></html>`;
}

export type AdminSection = "funnel" | "prospects" | "discovery";

const NAV: [AdminSection, string, string][] = [
  ["funnel", "/admin", "Funnel"],
  ["prospects", "/admin/prospects", "Prospects"],
  ["discovery", "/admin/discovery", "Discovery"],
];

/** The shared shell for every signed-in page: one header, one main landmark. */
export function appPage(title: string, active: AdminSection, body: string): string {
  const links = NAV.map(
    ([key, href, label]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("");
  return `${head(title)}<body>
<a class="skip" href="#main">Skip to content</a>
<header class="appbar"><div class="appbar-in">
  <a class="brand" href="/admin" aria-label="ReclaimBay admin home">RECLAIM<b>BAY</b></a>
  <nav class="nav" aria-label="Admin sections">${links}</nav>
  <form method="post" action="/admin/logout"><button class="btn-quiet" type="submit">Sign out</button></form>
</div></header>
<main id="main" class="wrap">${body}</main>
</body></html>`;
}

export function loginPage(error?: string): string {
  return page(
    "Sign in · ReclaimBay admin",
    `<div class="login-card">
  <div class="brand-line">RECLAIM<b>BAY</b></div>
  <h1>Admin sign in</h1>
  <form method="post" action="/admin/login">
    <div class="field">
      <label for="f-secret">Admin secret</label>
      <input id="f-secret" type="password" name="secret" autocomplete="current-password" required autofocus${error ? ' aria-invalid="true" aria-describedby="e-secret"' : ""}>
      ${error ? `<div class="ferr" id="e-secret" role="alert">${esc(error)}</div>` : ""}
    </div>
    <button type="submit" class="btn-primary-lg">Sign in</button>
  </form>
</div>`,
  );
}

export function disabledPage(): string {
  return page(
    "Admin disabled · ReclaimBay",
    `<div class="login-card"><div class="brand-line">RECLAIM<b>BAY</b></div><h1>Admin disabled</h1>
<p class="lede">ADMIN_SECRET is not configured (or is shorter than the minimum length) on the server.</p></div>`,
  );
}

const fmtPct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

export interface Attention {
  candidatesToReview: number;
  readyToContact: number;
  newProspects: number;
}

interface DashboardOptions {
  summary: Summary;
  rows: ProspectRow[];
  siteUrl: string;
  attention?: Attention;
  highlightId?: string;
}

function attentionStrip(a: Attention): string {
  const item = (n: number, label: string, href: string) =>
    `<a class="attn-item${n === 0 ? " zero" : ""}" href="${href}"><b>${n}</b><span>${esc(label)}</span></a>`;
  const total = a.candidatesToReview + a.readyToContact + a.newProspects;
  return section(
    "attention",
    "Needs attention",
    `<div class="attn-list">
  ${item(a.candidatesToReview, a.candidatesToReview === 1 ? "candidate needs review" : "candidates need review", "/admin/discovery?status=needs_review")}
  ${item(a.newProspects, a.newProspects === 1 ? "new prospect to research" : "new prospects to research", "/admin/prospects?status=new")}
  ${item(a.readyToContact, "ready to contact", "/admin/prospects?status=ready_to_contact")}
</div>${total === 0 ? `<p class="small muted" style="margin-top:8px">Nothing is waiting on you right now.</p>` : ""}`,
  );
}

function activityRow(r: ProspectRow, highlightId?: string): string {
  const real = r.uploads + r.scans + r.tours + r.exports;
  const any = r.visits + real + r.sampleEvents > 0;
  const sampleOnly = real === 0 && r.sampleEvents > 0;
  const name = r.id
    ? `<a class="name" href="/admin/prospects/${esc(r.id)}">${esc(r.businessName ?? "Unnamed prospect")}</a>${r.website ? `<div class="sub">${extLink(r.website)}</div>` : ""}`
    : `<span class="name"><i>Direct visits</i></span><div class="sub">No referral link</div>`;
  const cls = [r.id && r.id === highlightId ? "hl" : "", any ? "" : "zero"].filter(Boolean).join(" ");
  const n = (v: number) => (v > 0 ? String(v) : `<span class="muted">0</span>`);
  return `<tr${cls ? ` class="${cls}"` : ""}>
  <td>${name}${sampleOnly ? `<div class="sub"><span class="tag">Sample activity only</span></div>` : ""}</td>
  <td class="hide-md" data-label="Referral">${r.referralCode ? `<code>${esc(r.referralCode)}</code>` : '<span class="muted">—</span>'}</td>
  <td class="num" data-label="Visits">${n(r.visits)}${r.visitors ? `<div class="sub">${r.visitors} visitor${r.visitors === 1 ? "" : "s"}</div>` : ""}</td>
  <td class="num hide-sm" data-label="Uploads">${n(r.uploads)}</td>
  <td class="num" data-label="Real scans">${n(r.scans)}${r.sampleEvents ? `<div class="sub">+${r.sampleEvents} sample</div>` : ""}</td>
  <td class="num hide-sm" data-label="Exports">${n(r.exports)}${r.exports > 0 ? `<div class="sub">${esc(r.exportTypes.join(", "))}</div>` : ""}</td>
  <td class="hide-md small" data-label="Last activity">${fmtDate(r.lastActivity)}</td>
  <td data-label="Intent">${r.highIntent ? '<span class="pill">High</span>' : '<span class="muted">—</span>'}</td>
</tr>`;
}

export function dashboardPage({ summary: s, rows, attention, highlightId }: DashboardOptions): string {
  const tiles: [string, string, string][] = [
    ["Attributed prospects", String(s.attributedProspects), "with at least one visit"],
    ["Unique visitors", String(s.uniqueVisitors), "anonymous browser sessions"],
    ["Uploads started", String(s.uploadSessions), `${s.uploadEvents} upload events`],
    ["Real scans completed", String(s.realScanSessions), `${s.realScanEvents} ${s.realScanEvents === 1 ? "scan" : "scans"} · ${s.sampleScanEvents} sample excluded`],
    ["Exports", String(s.realExportSessions), `${s.realExportEvents} real exports`],
    ["Scan conversion", fmtPct(s.scanConversionRate), "visitors with a real scan"],
  ];
  const kpis = tiles
    .map(([label, value, hint]) => `<div class="kpi"><div class="k-label">${esc(label)}</div><div class="k-value">${esc(value)}</div><div class="k-hint">${esc(hint)}</div></div>`)
    .join("");

  const hasActivity = rows.some((r) => r.visits + r.uploads + r.scans + r.tours + r.exports + r.sampleEvents > 0 || r.lastActivity);
  const table = hasActivity
    ? `<div class="scroll"><table class="tbl cards">
<caption class="sr-only">Prospect activity from referral links</caption>
<thead><tr><th scope="col">Prospect</th><th scope="col" class="hide-md">Referral</th><th scope="col" class="num">Visits</th><th scope="col" class="num hide-sm">Uploads</th><th scope="col" class="num">Real scans</th><th scope="col" class="num hide-sm">Exports</th><th scope="col" class="hide-md">Last activity</th><th scope="col">Intent</th></tr></thead>
<tbody>${rows.map((r) => activityRow(r, highlightId)).join("\n")}</tbody>
</table></div>
<p class="small muted" style="margin-top:8px">Uploads, real scans, and exports count real activity only; sample-report activity is shown separately. High intent means a real scan and a real export.</p>`
    : `<div class="card">${emptyState("No prospect activity yet.", "Activity appears here once someone opens a prospect's referral link.", `<a class="btn btn-secondary" href="/admin/prospects">View prospects</a>`)}</div>`;

  return appPage(
    "Funnel · ReclaimBay admin",
    "funnel",
    `${pageHead({
      title: "Funnel",
      lede: "Product usage and prospect activity from referral links. Sample-report activity is kept out of the real numbers.",
    })}
<section aria-label="Key metrics"><div class="kpis">${kpis}</div></section>
${attention ? attentionStrip(attention) : ""}
${section("activity", "Prospect activity", table)}`,
  );
}
