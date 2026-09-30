import { referralUrl } from "../prospects.js";
import type { ProspectRow, Summary } from "./stats.js";

/* Server-rendered admin pages. No scripts; every dynamic value is escaped. */

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --ink:#0b1f33; --muted:#5b6b7b; --line:#dfe3e8; --accent:#0f766e; --warn:#b45309; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b1119; --card:#121b26; --ink:#e6edf3; --muted:#8b9aab; --line:#243140; --accent:#2dd4bf; --warn:#f59e0b; } }
* { box-sizing:border-box; }
body { margin:0; font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--ink); }
main { max-width:1200px; margin:0 auto; padding:24px 16px 48px; }
header { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:20px; }
h1 { font-size:20px; margin:0; } h2 { font-size:15px; margin:28px 0 10px; }
a { color:var(--accent); }
.muted { color:var(--muted); } .small { font-size:12px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.tile b { display:block; font-size:24px; font-variant-numeric:tabular-nums; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
.scroll { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
table { border-collapse:collapse; width:100%; min-width:900px; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--muted); font-weight:600; }
td.n { font-variant-numeric:tabular-nums; text-align:right; } th.n { text-align:right; }
tr:last-child td { border-bottom:0; } tr.hl td { background:color-mix(in srgb,var(--accent) 12%,transparent); }
code { font:12px ui-monospace,Consolas,monospace; }
.link { width:100%; min-width:260px; font:12px ui-monospace,Consolas,monospace; padding:4px 6px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); }
.pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; font-weight:600; background:var(--accent); color:var(--bg); }
form.inline { display:flex; flex-wrap:wrap; gap:8px; align-items:end; }
label { display:grid; gap:4px; font-size:12px; color:var(--muted); }
input[type=text],input[type=password] { padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); font:inherit; min-width:220px; }
button { padding:7px 14px; border:0; border-radius:6px; background:var(--ink); color:var(--bg); font:inherit; font-weight:600; cursor:pointer; }
a.btn { display:inline-block; padding:7px 14px; border-radius:6px; background:var(--ink); color:var(--bg); font-weight:600; text-decoration:none; }
a.st { text-decoration:none; color:var(--ink); } a.st.on { background:var(--ink); color:var(--bg); }
button.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); }
.err { color:var(--warn); margin:8px 0 0; }
.login { max-width:360px; margin:12vh auto 0; }
nav.top { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
nav.top a { text-decoration:none; font-weight:600; color:var(--muted); } nav.top a.on { color:var(--ink); }
.row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:14px; align-items:start; }
.stack > * + * { margin-top:14px; }
dl.kv { display:grid; grid-template-columns:max-content 1fr; gap:6px 14px; margin:0; } dl.kv dt { color:var(--muted); font-size:12px; padding-top:2px; } dl.kv dd { margin:0; overflow-wrap:anywhere; }
.band-high { background:var(--accent); } .band-medium { background:#2563eb; } .band-low { background:var(--muted); }
.q-meets_criteria { border-color:var(--accent); color:var(--accent); } .q-disqualified { border-color:var(--warn); color:var(--warn); } .q-unverified { border-style:dashed; color:var(--muted); }
.st { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; font-weight:600; border:1px solid var(--line); white-space:nowrap; }
.st-do_not_contact { border-color:var(--warn); color:var(--warn); }
.ok { color:var(--accent); margin:0 0 12px; font-weight:600; }
.errs { border:1px solid var(--warn); border-radius:10px; padding:10px 14px; margin:0 0 14px; color:var(--warn); } .errs ul { margin:4px 0 0; padding-left:18px; }
select,textarea { padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); font:inherit; }
textarea { width:100%; min-height:70px; resize:vertical; }
fieldset { border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin:0; } legend { font-weight:600; padding:0 4px; }
.fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
.fields input[type=text] { min-width:0; width:100%; }
.signal { border-top:1px solid var(--line); padding:10px 0; } .signal:first-of-type { border-top:0; }
.choices { display:flex; flex-wrap:wrap; gap:14px; margin:6px 0; } .choices label { display:flex; gap:6px; align-items:center; font-size:14px; color:var(--ink); }
details summary { cursor:pointer; color:var(--muted); font-size:12px; }
blockquote { margin:0; padding-left:10px; border-left:3px solid var(--line); }
.inline-form { display:inline; }
button.link { background:none; color:var(--warn); padding:0; font-weight:600; font-size:12px; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return page(
    "ReclaimBay admin",
    `<div class="login card">
  <h1>ReclaimBay admin</h1>
  <form method="post" action="/admin/login" style="display:grid;gap:10px;margin-top:14px">
    <label>Admin secret<input type="password" name="secret" autocomplete="current-password" required autofocus></label>
    <button type="submit">Sign in</button>
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
  </form>
</div>`,
  );
}

export function disabledPage(): string {
  return page(
    "Admin disabled",
    `<div class="login card"><h1>Admin disabled</h1><p class="muted">ADMIN_SECRET is not configured (or is shorter than the minimum length) on the server.</p></div>`,
  );
}

export type AdminSection = "funnel" | "prospects";

/** Shared header for signed-in pages. */
export function adminHeader(active: AdminSection): string {
  const link = (href: string, label: string, on: boolean) =>
    `<a href="${href}"${on ? ` class="on" aria-current="page"` : ""}>${label}</a>`;
  return `<header><nav class="top"><h1>ReclaimBay</h1>${link("/admin", "Funnel", active === "funnel")}${link("/admin/prospects", "Prospects", active === "prospects")}</nav>
  <form method="post" action="/admin/logout"><button class="ghost" type="submit">Sign out</button></form></header>`;
}

export const fmtDate = (d: Date | null) =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
const fmtPct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);
const num = (n: number) => (n > 0 ? String(n) : `<span class="muted">0</span>`);

interface DashboardOptions {
  summary: Summary;
  rows: ProspectRow[];
  siteUrl: string;
  highlightId?: string;
}

function prospectCell(r: ProspectRow): string {
  if (!r.id) return `<i class="muted">No referral (direct)</i>`;
  const name = `<a href="/admin/prospects/${esc(r.id)}">${esc(r.businessName ?? "Unnamed prospect")}</a>`;
  const site = r.website
    ? `<div class="small"><a href="${esc(r.website)}" rel="noreferrer noopener" target="_blank">${esc(r.website.replace(/^https?:\/\//, ""))}</a></div>`
    : "";
  return `${name}${site}<div class="small muted">${esc(r.status)}</div>`;
}

function referralCell(r: ProspectRow, siteUrl: string): string {
  if (!r.referralCode) return "—";
  const link = referralUrl(siteUrl, r.referralCode);
  return `<code>${esc(r.referralCode)}</code><div><input class="link" readonly value="${esc(link)}" aria-label="Referral link"></div>`;
}

function tableRow(r: ProspectRow, siteUrl: string, highlightId?: string): string {
  const visitors = r.visitors
    ? `<div class="small muted">${r.visitors} visitor${r.visitors === 1 ? "" : "s"}</div>`
    : "";
  const exportsCell =
    r.exports > 0 ? `${r.exports}<div class="small muted">${esc(r.exportTypes.join(", "))}</div>` : num(0);
  const intent = r.highIntent ? `<span class="pill">High</span>` : `<span class="muted">—</span>`;
  const hl = r.id && r.id === highlightId ? ` class="hl"` : "";
  return `<tr${hl}>
  <td>${prospectCell(r)}</td><td>${referralCell(r, siteUrl)}</td>
  <td class="n">${num(r.visits)}${visitors}</td>
  <td class="n">${num(r.uploads)}</td><td class="n">${num(r.scans)}</td><td class="n">${num(r.tours)}</td>
  <td class="n">${exportsCell}</td><td class="n">${num(r.sampleEvents)}</td>
  <td>${fmtDate(r.lastActivity)}</td><td>${intent}</td>
</tr>`;
}

export function dashboardPage({ summary: s, rows, siteUrl, highlightId }: DashboardOptions): string {
  const tiles: [string, string, string][] = [
    ["Attributed prospects", String(s.attributedProspects), "prospects with at least one visit"],
    ["Unique visitors", String(s.uniqueVisitors), "anonymous browser sessions"],
    ["Uploads started", String(s.uploadSessions), `${s.uploadEvents} upload events`],
    ["Real scans completed", String(s.realScanSessions), `${s.realScanEvents} scans, ${s.sampleScanEvents} sample scans excluded`],
    ["Exports", String(s.realExportSessions), `${s.realExportEvents} real exports`],
    ["Scan conversion", fmtPct(s.scanConversionRate), "visitors with a real scan"],
  ];
  const tileHtml = tiles
    .map(
      ([label, value, hint]) =>
        `<div class="tile"><span class="small muted">${esc(label)}</span><b>${esc(value)}</b><span class="small muted">${esc(hint)}</span></div>`,
    )
    .join("");
  const body = rows.map((r) => tableRow(r, siteUrl, highlightId)).join("\n");

  return page(
    "ReclaimBay admin",
    `${adminHeader("funnel")}
<p class="small muted" style="margin-top:-12px">Visitor, upload, scan and export tiles count unique browser sessions.</p>
<div class="tiles">${tileHtml}</div>

<h2>Prospects</h2>
<p class="small muted" style="margin-top:-4px">Funnel activity per referral link. <a href="/admin/prospects">Manage prospects</a> or <a href="/admin/prospects/new">add one</a>.</p>
<div class="scroll"><table>
<thead><tr><th>Prospect</th><th>Referral</th><th class="n">Visit</th><th class="n">Upload</th><th class="n">Scan</th><th class="n">Tour</th><th class="n">Export</th><th class="n">Sample</th><th>Last activity</th><th>Intent</th></tr></thead>
<tbody>${body || `<tr><td colspan="10" class="muted">No prospects yet.</td></tr>`}</tbody>
</table></div>
<p class="small muted">Upload, Scan, Tour and Export count real (non-sample) events only. Sample counts all sample-report activity. High intent = a real scan and a real export.</p>`,
  );
}
