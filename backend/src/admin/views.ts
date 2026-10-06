import { ICON_LINKS } from "../routes/brandIcons.js";
import { LOGO_FULL_REVERSE, LOGO_LOCKUP_REVERSE } from "./brandArt.js";
import { STYLE } from "./styles.js";
import type { ProspectRow, Summary } from "./stats.js";
import { emptyState, esc, extLink, fmtDate, funnelBar, icon, kpi, MIN_COMPARE, pageHead, section } from "./ui.js";

export { esc, fmtDate };

/* Server-rendered admin shell and pages. No scripts; every dynamic value is escaped. */

const head = (title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>${ICON_LINKS}<style>${STYLE}</style></head>`;

/** Unauthenticated pages (login, disabled): the full logo over a plain centered card. */
export function page(title: string, body: string): string {
  return `${head(title)}<body class="login"><div class="login-wrap">
<div class="login-logo">${LOGO_FULL_REVERSE}</div>
${body}
</div></body></html>`;
}

export type AdminSection =
  | "outreach" // Compatibility for existing callers; belongs to Sending.
  | "overview"
  | "discovery"
  | "prospects"
  | "sending"
  | "prepare"
  | "messages"
  | "replies"
  | "reviews"
  | "funnel"
  | "campaigns"
  | "health"
  | "activity";

/**
 * The navigation, grouped by what the operator is doing. Research is a step
 * on Discovery candidates, so its pages belong to Discovery. Nothing that
 * doesn't exist yet is listed.
 */
const NAV: { group: string; links: [AdminSection, string, string][] }[] = [
  { group: "Command center", links: [["overview", "/admin", "Overview"]] },
  { group: "Acquisition", links: [["discovery", "/admin/discovery", "Discovery"], ["prospects", "/admin/prospects", "Prospects"]] },
  {
    group: "Outreach",
    links: [
      ["sending", "/admin/outreach", "Sending"],
      ["prepare", "/admin/outreach/messages?view=eligible", "Prepare"],
      ["messages", "/admin/outreach/messages", "Messages"],
      ["replies", "/admin/outreach/messages?view=replies", "Replies"],
      ["reviews", "/admin/outreach/unsubscribe-reviews", "Unsubscribe reviews"],
    ],
  },
  { group: "Insights", links: [["funnel", "/admin/analytics", "Funnel"], ["campaigns", "/admin/campaigns", "Campaigns"]] },
  { group: "System", links: [["health", "/admin/system", "Health"], ["activity", "/admin/activity", "Activity"]] },
];

/**
 * Where the live shell status goes: the sending strip in the top bar and the
 * counts beside some nav items. Pages render without it; the admin scope's
 * response hook (routes/admin.ts) fills these in from one loader, or removes
 * them and says the status is unavailable. Never zeros in its place.
 */
export const SHELL_STATUS_SLOT = "<!--rb:status-->";
export const navCountSlot = (key: AdminSection) => `<!--rb:n:${key}-->`;
/** The nav items that can carry a count: work waiting on a person. */
export const NAV_COUNT_KEYS = ["sending", "replies", "reviews"] as const satisfies readonly AdminSection[];

/** The shared shell for every signed-in page: one header, one main landmark. */
export function appPage(title: string, active: AdminSection, body: string): string {
  if (active === "outreach") active = "sending";
  const label = NAV.flatMap((g) => g.links).find(([key]) => key === active)?.[2] ?? "Workspace";
  const group = NAV.find((g) => g.links.some(([key]) => key === active))?.group ?? "Workspace";
  const counted = new Set<AdminSection>(NAV_COUNT_KEYS);
  const links = (idPrefix: string) =>
    NAV.map(
      (g, i) =>
        `<div class="nav-group" role="group" aria-labelledby="${idPrefix}-g${i}"><span class="nav-label" id="${idPrefix}-g${i}">${esc(g.group)}</span>${g.links
          .map(
            ([key, href, text]) =>
              `<a href="${href}"${key === active ? ' aria-current="page"' : ""}>${icon(key)}<span>${esc(text)}</span>${counted.has(key) ? navCountSlot(key) : ""}</a>`,
          )
          .join("")}</div>`,
    ).join("");
  return `${head(title)}<body class="aos" data-workspace="${active}">
<a class="skip" href="#main">Skip to content</a>
<div class="side">
  <div class="side-brand"><a class="brand" href="/admin" aria-label="ReclaimBay admin home">${LOGO_LOCKUP_REVERSE}</a><p class="side-sub">Acquisition Command Center</p></div>
  <nav class="nav" aria-label="Admin sections">${links("nav")}</nav>
  <div class="side-foot"><span class="side-private">Private operator workspace</span><form method="post" action="/admin/logout"><button class="btn-quiet btn-sm" type="submit">Sign out</button></form></div>
</div>
<div class="content">
<header class="top"><div class="top-in">
  <details class="mobile-nav"><summary>Menu</summary><div class="drawer"><nav class="nav" aria-label="Mobile admin sections">${links("mnav")}</nav><form method="post" action="/admin/logout"><button class="btn-quiet btn-sm" type="submit">Sign out</button></form></div></details>
  <p class="top-context">${esc(group)}<span class="sep" aria-hidden="true">/</span><b>${esc(label)}</b></p>
  <form class="global-search" method="get" action="/admin/prospects" role="search" aria-label="Find a business"><label class="sr-only" for="workspace-search">Find a business</label><input id="workspace-search" name="q" type="search" placeholder="Find a business…" maxlength="100"><button type="submit" aria-label="Search businesses">${icon("discovery")}</button></form>
  ${SHELL_STATUS_SLOT}
</div></header>
<main id="main" class="wrap">${body}</main>
<footer class="foot"><span>ReclaimBay · Acquisition Command Center</span><span>Evidence before action.</span></footer>
</div>
</body></html>`;
}

export function loginPage(error?: string): string {
  return page(
    "Sign in · ReclaimBay admin",
    `<div class="login-card">
  <p class="eyebrow">Acquisition Command Center</p><h1>Admin sign in</h1><p class="lede">Your private workspace for running acquisition, one considered decision at a time.</p>
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
    `<div class="login-card"><h1>Admin disabled</h1>
<p class="lede">ADMIN_SECRET is not configured (or is shorter than the minimum length) on the server.</p></div>`,
  );
}

const fmtPct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

export interface Attention {
  /** Discovery queue: candidates waiting on a person's decision. */
  candidatesToDecide: number;
  /** Discovery queue: candidates ready to approve. */
  candidatesToApprove: number;
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
  const total = a.candidatesToDecide + a.candidatesToApprove + a.readyToContact + a.newProspects;
  return section(
    "attention",
    "Needs attention",
    `<div class="attn-list">
  ${item(a.candidatesToDecide, a.candidatesToDecide === 1 ? "candidate needs your decision" : "candidates need your decision", "/admin/discovery?view=decision")}
  ${item(a.candidatesToApprove, a.candidatesToApprove === 1 ? "candidate ready to approve" : "candidates ready to approve", "/admin/discovery?view=ready")}
  ${item(a.newProspects, a.newProspects === 1 ? "new prospect to research" : "new prospects to research", "/admin/prospects?status=new")}
  ${item(a.readyToContact, "ready to contact", "/admin/prospects?status=ready_to_contact")}
</div>${total === 0 ? `<p class="small muted" style="margin-top:8px">Nothing is waiting on you right now.</p>` : ""}`,
  );
}

function activityRow(r: ProspectRow, highlightId?: string): string {
  const real = r.uploads + r.scans + r.tours + r.exports + r.contacts;
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
  <td class="num" data-label="Contact clicks">${n(r.contacts)}</td>
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
    ["Contact clicks", String(s.contactClickSessions), `${s.contactClickEvents} real ${s.contactClickEvents === 1 ? "click" : "clicks"}`],
    ["Scan conversion", s.uniqueVisitors < MIN_COMPARE ? "Too few to compare" : fmtPct(s.scanConversionRate), "visitors with a real scan"],
  ];
  const kpis = tiles.map(([label, value, hint]) => kpi(label, value, hint)).join("");
  const journey = `<nav class="journey" aria-label="Acquisition and engagement workspaces">${[
    ["01", "Discovery & qualification", "Establish evidence", "/admin/discovery"],
    ["02", "Outreach & replies", "Review recorded outcomes", "/admin/outreach"],
    ["03", "Product engagement", "Inspect real activity", "#engagement"],
    ["04", "Prospect activity", "Review intent, then decide", "#activity"],
  ].map(([n, label, detail, href]) => `<a href="${href}"><span class="eyebrow">${n}</span><strong>${label}</strong><span>${detail}</span></a>`).join("")}</nav>`;
  const engagement = funnelBar([
    { label: "Product visitors", n: s.uniqueVisitors, base: null },
    { label: "Upload started", n: s.uploadSessions, base: s.uniqueVisitors, baseLabel: "visitors" },
    { label: "Real scan completed", n: s.realScanSessions, base: s.uniqueVisitors, baseLabel: "visitors" },
    { label: "Report exported", n: s.realExportSessions, base: s.realScanSessions, baseLabel: "scanning sessions" },
    { label: "Contact clicked", n: s.contactClickSessions, base: s.uniqueVisitors, baseLabel: "visitors" },
  ], "Observed product sessions");

  const hasActivity = rows.some((r) => r.visits + r.uploads + r.scans + r.tours + r.exports + r.contacts + r.sampleEvents > 0 || r.lastActivity);
  const table = hasActivity
    ? `<div class="scroll"><table class="tbl cards">
<caption class="sr-only">Prospect activity from referral links</caption>
<thead><tr><th scope="col">Prospect</th><th scope="col" class="hide-md">Referral</th><th scope="col" class="num">Visits</th><th scope="col" class="num hide-sm">Uploads</th><th scope="col" class="num">Real scans</th><th scope="col" class="num hide-sm">Exports</th><th scope="col" class="num">Contact clicks</th><th scope="col" class="hide-md">Last activity</th><th scope="col">Intent</th></tr></thead>
<tbody>${rows.map((r) => activityRow(r, highlightId)).join("\n")}</tbody>
</table></div>
<p class="small muted" style="margin-top:8px">Uploads, real scans, exports, and contact clicks count real activity only; sample-report activity is shown separately. High intent means a real scan and a real export, or a contact click.</p>`
    : `<div class="card">${emptyState("No prospect activity yet.", "Activity appears here once someone opens a prospect's referral link.", `<a class="btn btn-secondary" href="/admin/prospects">View prospects</a>`)}</div>`;

  return appPage(
    "Funnel · ReclaimBay admin",
    "funnel",
    `${pageHead({
      title: "Funnel",
      lede: "Follow recorded progress. Review the evidence behind product engagement.",
    })}
<div class="funnel-summary"><div><p class="eyebrow">Observed reach &middot; all time</p><p><strong>${s.attributedProspects}</strong> ${s.attributedProspects === 1 ? "prospect has" : "prospects have"} an attributed visit</p><span>${s.uniqueVisitors} anonymous browser ${s.uniqueVisitors === 1 ? "session" : "sessions"}, including direct visitors. Internal tests excluded.</span></div><a href="#activity">Inspect prospect activity &rarr;</a></div>
<section class="card intelligence" id="engagement" aria-labelledby="engagement-h"><header class="card-head"><div><h2 id="engagement-h">Observed product engagement</h2><p>Distinct sessions at each step &middot; real events exclude samples</p></div><a href="/admin#acquisition-h" class="card-link">Acquisition pipeline &rarr;</a></header>${engagement}<div class="analytics-context"><p>Observed session counts, not a single cohort or a guaranteed sequence. Comparisons require at least ${MIN_COMPARE} observations in the stated denominator.</p><p>High intent is a real scan and export, or a contact click. It is a signal to review, not proof of a customer or revenue.</p></div></section>
${attention ? attentionStrip(attention) : ""}
${section("activity", "Prospect activity", table)}
<details class="workspace-context metric-details"><summary>All product metrics &amp; event counts</summary><section aria-label="Key metrics"><div class="kpis">${kpis}</div></section></details>
<details class="workspace-context"><summary>Attribution &amp; acquisition context</summary><p>A referral links recorded activity to a prospect. Direct visits have no referral link. These observations do not establish one journey from discovery to a customer.</p><p>Inspect each workspace for its own recorded evidence.</p>${journey}</details>`,
  );
}
