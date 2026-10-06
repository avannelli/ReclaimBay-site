/*
 * The admin stylesheet. One inline <style> block, because the admin CSP
 * allows only inline styles (default-src 'none'; style-src 'unsafe-inline')
 * and the admin ships no scripts, fonts, or external assets. Type therefore
 * uses the operating system's own UI fonts.
 *
 * One design system, in this order: tokens, base, the shell (sidebar, top
 * bar, sending strip), surfaces and their elevation, the one badge system,
 * buttons, forms, tables, the shared primitives (attention item, meter,
 * funnel bar, feed, status rail, guardrail), the Overview, then the page
 * components the other workspaces still use, then responsive rules.
 *
 * Meaning is never carried by color alone: every badge and state also has a
 * text label and a glyph, and the pipeline stages differ in shape as well as
 * shade.
 */
export const STYLE = `
:root {
  color-scheme: light dark;
  --font: "Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Roboto,Arial,sans-serif;
  --font-display: "Segoe UI Variable Display","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Roboto,Arial,sans-serif;
  --mono: ui-monospace,"Cascadia Mono",SFMono-Regular,Consolas,monospace;
  --fs-12:12px; --fs-13:13px; --fs-14:14px; --fs-16:16px; --fs-20:20px; --fs-24:24px; --fs-30:30px;

  --canvas:#F7F8F6; --surface:#FFFFFF; --well:#F1F3F1;
  --ink:#10263C; --ink-2:#44576B; --muted:#5B6B7E;
  --line:#E2E8F0; --line-2:#CBD5E1;
  --navy:#0B2238; --navy-deep:#071725; --navy-2:#173A59; --navy-hover:#122E4A;
  --side-ink:#C3CFDC; --side-muted:#8193A8;
  --accent:#0B6B8A; --accent-soft:#E3F1F5; --ring:#0B6B8A;
  --gold:#F2A51A; --gold-soft:#FFF4DC; --gold-ink:#975E0B;
  --pos:#13784F; --pos-soft:#EAF7F0;
  --warn:#975E0B; --warn-soft:#FFF4DC;
  --neg:#C2413A; --neg-soft:#FDF3F2;
  --off:#475569; --off-soft:#EEF1F4;
  --info:#2F5D8A; --info-soft:#E8F0F8;
  --btn:#0B2238; --btn-hover:#173A59; --on-btn:#FFFFFF; --on-go:#FFFFFF; --on-neg:#FFFFFF;

  --r-sm:6px; --r:10px; --r-lg:14px;
  /* Elevation: 0 flat wells, 1 cards, 2 important surfaces, 3 confirmation panels. */
  --e1:0 1px 2px rgb(11 31 51 / .05), 0 8px 24px -16px rgb(11 31 51 / .20);
  --e2:0 1px 3px rgb(11 31 51 / .07), 0 18px 40px -20px rgb(11 31 51 / .32);
  --e3:0 2px 6px rgb(7 23 37 / .09), 0 28px 64px -24px rgb(7 23 37 / .42);
  --e-btn:0 1px 2px rgb(11 31 51 / .14), inset 0 1px 0 rgb(255 255 255 / .08);

  /* Older names, still used by inline styles in the page views. */
  --bg:var(--canvas); --surface-2:var(--well); --amber:var(--gold); --radius:var(--r); --shadow:var(--e1);
  --sidebar:248px;
}
@media (prefers-color-scheme: dark) { :root {
  --canvas:#0B141E; --surface:#121D2A; --well:#0F1924;
  --ink:#E8EEF5; --ink-2:#BCC8D6; --muted:#90A0B3;
  --line:#22313F; --line-2:#34485C;
  --navy:#071725; --navy-deep:#040E18; --navy-2:#173A59; --navy-hover:#0F2740;
  --accent:#5CC6E6; --accent-soft:#0F3140; --ring:#5CC6E6;
  --gold-soft:#3A2A0C; --gold-ink:#F6C25B;
  --pos:#4FD1A0; --pos-soft:#0E2C22;
  --warn:#F2B24A; --warn-soft:#33260E;
  --neg:#FF8A7D; --neg-soft:#3A1814;
  --off:#AAB7C6; --off-soft:#1B2735;
  --info:#93B9E8; --info-soft:#13263A;
  --btn:#E8EEF5; --btn-hover:#FFFFFF; --on-btn:#0B2238; --on-go:#04211B; --on-neg:#2A0905;
  --e1:0 0 0 1px rgb(255 255 255 / .015), 0 10px 26px -18px rgb(0 0 0 / .7);
  --e2:0 0 0 1px rgb(255 255 255 / .03), 0 18px 40px -20px rgb(0 0 0 / .8);
  --e3:0 0 0 1px rgb(255 255 255 / .04), 0 28px 64px -24px rgb(0 0 0 / .85);
  --e-btn:none;
} }

/* ---------- base ---------- */
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; font:var(--fs-14)/1.55 var(--font); background:var(--canvas); color:var(--ink); -webkit-font-smoothing:antialiased; }
a { color:var(--accent); text-underline-offset:2px; }
a:hover { text-decoration-thickness:2px; }
:focus-visible { outline:2px solid var(--ring); outline-offset:2px; border-radius:4px; box-shadow:0 0 0 5px rgb(11 107 138 / .18); }
h1,h2,h3,h4,p { margin:0; }
h1,h2,h3 { font-family:var(--font-display); }
code { font:12px var(--mono); background:var(--well); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
.muted { color:var(--muted); } .small { font-size:var(--fs-13); } .num { text-align:right; font-variant-numeric:tabular-nums; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.skip { position:absolute; left:8px; top:-48px; background:var(--btn); color:var(--on-btn); padding:8px 12px; border-radius:var(--r-sm); z-index:50; }
.skip:focus { top:8px; }
.eyebrow { font-size:var(--fs-12); font-weight:650; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.ui-icon { width:18px; height:18px; flex:none; }

/* ---------- shell: sidebar ---------- */
.side { position:fixed; inset:0 auto 0 0; width:var(--sidebar); background:var(--navy); color:var(--side-ink); border-right:1px solid var(--navy-deep); display:flex; flex-direction:column; z-index:30; }
.side-brand { padding:24px 22px 18px; border-bottom:1px solid rgb(255 255 255 / .06); }
.brand { display:inline-flex; border-radius:6px; }
.brand svg { display:block; width:156px; height:auto; }
.side-sub { margin-top:10px; font-size:var(--fs-12); color:var(--side-muted); letter-spacing:.02em; }
.side .nav { flex:1; overflow-y:auto; padding:14px 12px 8px; scrollbar-width:thin; }
.nav-group + .nav-group { margin-top:18px; }
.nav-label { display:block; padding:0 12px 6px; font-size:var(--fs-12); font-weight:650; letter-spacing:.09em; text-transform:uppercase; color:var(--side-muted); }
.nav a { position:relative; display:flex; align-items:center; gap:12px; min-height:38px; padding:8px 12px; margin:1px 0; border-radius:8px; color:var(--side-ink); text-decoration:none; font-size:var(--fs-14); font-weight:500; }
.nav a .ui-icon { opacity:.78; }
.nav a:hover { background:var(--navy-hover); color:#FFFFFF; }
.nav a[aria-current="page"] { background:var(--navy-2); color:#FFFFFF; font-weight:600; }
.nav a[aria-current="page"] .ui-icon { opacity:1; }
.nav a[aria-current="page"]::before { content:""; position:absolute; left:-12px; top:8px; bottom:8px; width:3px; border-radius:0 3px 3px 0; background:var(--gold); }
.nav a:focus-visible { outline-color:#8FD3EE; box-shadow:none; }
.nav-n { margin-left:auto; min-width:24px; padding:1px 7px; border-radius:6px; font-size:var(--fs-12); font-weight:700; line-height:1.5; text-align:center; font-variant-numeric:tabular-nums; }
.nav-n.n-warn { background:#FFF4DC; color:#7A4A06; }
.nav-n.n-neg { background:#FDF3F2; color:#A1302A; }
.side-foot { padding:14px 22px 18px; border-top:1px solid rgb(255 255 255 / .06); display:grid; gap:10px; }
.side-private { display:flex; align-items:center; gap:8px; font-size:var(--fs-12); color:var(--side-muted); }
.side-private::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--side-muted); }
.side form { margin:0; }
.side .btn-quiet { width:100%; justify-content:flex-start; background:transparent; color:var(--side-ink); border:1px solid rgb(255 255 255 / .12); box-shadow:none; }
.side .btn-quiet:hover { background:var(--navy-hover); color:#FFFFFF; filter:none; }

/* ---------- shell: top bar and the sending strip ---------- */
.content { margin-left:var(--sidebar); min-height:100vh; display:flex; flex-direction:column; }
.top { position:sticky; top:0; z-index:20; background:var(--surface); border-bottom:1px solid var(--line); box-shadow:0 1px 0 rgb(11 31 51 / .02); }
.top-in { display:flex; align-items:center; gap:20px; min-height:64px; padding:10px 32px; }
.top-context { font-size:var(--fs-13); color:var(--muted); white-space:nowrap; }
.top-context b { color:var(--ink); font-weight:600; }
.top-context .sep { margin:0 8px; color:var(--line-2); }
.global-search { margin:0 0 0 auto; width:min(280px, 30vw); }
.global-search input { min-height:36px; background:var(--well); border-color:var(--line); }
.sendbar { display:flex; align-items:stretch; flex:none; border:1px solid var(--sb-bd, var(--line-2)); border-radius:var(--r); background:var(--surface); color:var(--ink); text-decoration:none; font-size:var(--fs-13); overflow:hidden; box-shadow:var(--e1); }
a.sendbar:hover { text-decoration:none; border-color:var(--sb-fg, var(--ink-2)); }
.sendbar > span { display:flex; align-items:center; gap:6px; padding:6px 12px; white-space:nowrap; }
.sendbar > span + span { border-left:1px solid var(--line); }
.sendbar .sb-state { background:var(--sb-bg, var(--off-soft)); color:var(--sb-fg, var(--off)); font-weight:700; letter-spacing:.02em; }
.sendbar .sb-k { color:var(--muted); }
.sendbar b { font-variant-numeric:tabular-nums; }
.sendbar .sb-alert { color:var(--neg); font-weight:600; } .sendbar .sb-alert .sb-k { color:var(--neg); }
.sendbar .sb-note { color:var(--muted); font-size:var(--fs-12); }
.sendbar.m-off { --sb-fg:var(--off); --sb-bg:var(--off-soft); --sb-bd:var(--line-2); }
.sendbar.m-on { --sb-fg:var(--pos); --sb-bg:var(--pos-soft); --sb-bd:var(--pos); }
.sendbar.m-blocked { --sb-fg:var(--neg); --sb-bg:var(--neg-soft); --sb-bd:var(--neg); }
.sendbar.m-paused { --sb-fg:var(--warn); --sb-bg:var(--warn-soft); --sb-bd:var(--gold); }
.sendbar.m-unknown { --sb-fg:var(--muted); --sb-bg:transparent; border-style:dashed; box-shadow:none; }
.mobile-nav { display:none; }
.wrap { width:100%; max-width:1360px; margin:0 auto; padding:32px 32px 56px; flex:1; }
.foot { padding:0 32px 24px; font-size:var(--fs-12); color:var(--muted); display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }

/* ---------- page structure ---------- */
.crumbs { font-size:var(--fs-13); color:var(--muted); margin-bottom:10px; }
.crumbs a { color:var(--muted); } .crumbs span[aria-current] { color:var(--ink-2); }
.page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
.page-head h1 { font-size:var(--fs-24); line-height:1.25; font-weight:650; letter-spacing:-.015em; }
.lede { color:var(--ink-2); margin-top:6px; max-width:76ch; font-size:var(--fs-14); }
.actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.section { margin-top:32px; }
.section > h2 { font-size:var(--fs-13); font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:0 0 12px; display:flex; align-items:baseline; gap:10px; }
.section > h2 .aside { text-transform:none; letter-spacing:0; font-weight:400; }
.grid-2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:16px; align-items:stretch; }
.grid-2 > .card + .card { margin-top:0; }
.stack > * + * { margin-top:14px; }
.row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.spread { justify-content:space-between; }
.dossier-nav { display:flex; gap:4px; flex-wrap:wrap; border-bottom:1px solid var(--line); margin:4px 0 24px; padding-bottom:8px; }
.dossier-nav a { padding:6px 12px; border-radius:var(--r-sm); font-size:var(--fs-13); font-weight:500; color:var(--ink-2); text-decoration:none; }
.dossier-nav a:hover { color:var(--accent); background:var(--accent-soft); }

/* ---------- surfaces ---------- */
.card { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); padding:20px 24px; box-shadow:var(--e1); }
.card + .card { margin-top:16px; }
.card.lv0 { background:var(--well); box-shadow:none; }
.card.lv2 { box-shadow:var(--e2); }
.card.lv3 { box-shadow:var(--e3); }
.card-h { font-size:var(--fs-12); font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin-bottom:8px; }
.card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:16px; }
.card-head h2 { font-size:var(--fs-16); font-weight:650; letter-spacing:-.01em; line-height:1.35; }
.card-head p { font-size:var(--fs-13); color:var(--muted); margin-top:2px; }
.card-head .card-link { font-size:var(--fs-13); font-weight:600; white-space:nowrap; text-decoration:none; }
.card-head .card-link:hover { text-decoration:underline; }
.unavailable { display:flex; gap:10px; align-items:flex-start; padding:14px 16px; border:1px dashed var(--line-2); border-radius:var(--r-sm); color:var(--ink-2); font-size:var(--fs-13); }
.unavailable::before { content:"\\25CC"; color:var(--muted); }

/* ---------- notices ---------- */
.notice { border:1px solid var(--pos); background:var(--pos-soft); color:var(--ink); border-left-width:4px; border-radius:var(--r); padding:10px 14px; margin-bottom:16px; font-weight:600; }
.errbox { border:1px solid var(--neg); background:var(--neg-soft); border-left-width:4px; border-radius:var(--r); padding:12px 16px; margin-bottom:18px; }
.errbox b { color:var(--neg); } .errbox ul { margin:6px 0 0; padding-left:18px; } .errbox li { margin:2px 0; } .errbox a { color:var(--ink); }
.callout { border:1px solid var(--line-2); background:var(--well); border-left:4px solid var(--info); border-radius:var(--r); padding:10px 14px; font-size:var(--fs-13); }
.callout.warn { border-left-color:var(--gold); }

/* ---------- the badge system: one shape, one type size, tone by variables ---------- */
.badge, .st, .pill, .obs, .tag, .vd, .kind {
  --b-fg:var(--ink-2); --b-bg:var(--surface); --b-bd:var(--line-2);
  display:inline-flex; align-items:center; gap:5px; font-size:var(--fs-12); font-weight:600; line-height:1.4; padding:2px 8px;
  border-radius:var(--r-sm); border:1px solid var(--b-bd); background:var(--b-bg); color:var(--b-fg); white-space:nowrap; vertical-align:middle;
}
.st::before, .pill::before, .obs::before { font-size:12px; line-height:1; }
.b-pos { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); }
.b-warn { --b-fg:var(--warn); --b-bg:var(--warn-soft); --b-bd:var(--gold); }
.b-neg { --b-fg:var(--neg); --b-bg:var(--neg-soft); --b-bd:var(--neg); }
.b-info { --b-fg:var(--info); --b-bg:var(--info-soft); --b-bd:var(--info); }
.b-off { --b-fg:var(--off); --b-bg:var(--off-soft); --b-bd:var(--line-2); }
.b-unknown { --b-fg:var(--muted); --b-bg:transparent; border-style:dashed; font-weight:500; }
.b-strong { font-weight:700; }
/* prospect pipeline stage: the glyph fills as the prospect advances */
.st-new::before { content:"\\25CB"; } .st-qualified::before { content:"\\25D4"; } .st-ready_to_contact::before { content:"\\25D1"; }
.st-contacted::before { content:"\\25D5"; } .st-engaged::before { content:"\\25CF"; } .st-customer::before { content:"\\2713"; }
.st-qualified, .st-contacted { --b-fg:var(--info); --b-bg:var(--info-soft); --b-bd:var(--info); }
.st-ready_to_contact, .st-engaged, .st-customer { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); }
.st-customer { font-weight:700; }
.st-not_a_fit::before { content:"\\2715"; } .st-not_a_fit { --b-fg:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; }
.st-archived::before { content:"\\25AB"; } .st-archived { --b-fg:var(--muted); border-style:dashed; }
.st-do_not_contact::before { content:"\\2298"; font-size:13px; } .st-do_not_contact { --b-fg:var(--neg); --b-bg:var(--neg-soft); --b-bd:var(--neg); border-width:2px; font-weight:700; }
.st-meeting::before { content:"\\25C9"; } .st-proposal::before { content:"\\25C8"; } .st-meeting, .st-proposal { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); }
.st-lost::before { content:"\\2717"; } .st-lost { --b-fg:var(--muted); border-style:dashed; }
/* outreach message states */
.os-draft::before { content:"\\270E"; } .os-draft { border-style:dashed; }
.os-queued::before { content:"\\25F7"; } .os-sent::before { content:"\\2192"; } .os-queued, .os-sent { --b-fg:var(--info); --b-bg:var(--info-soft); --b-bd:var(--info); }
.os-delivered::before { content:"\\2713"; } .os-replied::before { content:"\\21A9"; } .os-delivered, .os-replied { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); } .os-replied { font-weight:700; }
.os-bounced::before { content:"\\2715"; } .os-failed::before { content:"!"; font-weight:800; } .os-bounced, .os-failed { --b-fg:var(--neg); --b-bg:var(--neg-soft); --b-bd:var(--neg); }
.os-cancelled::before { content:"\\2014"; } .os-cancelled { --b-fg:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; }
/* discovery states */
.cs-discovered::before { content:"\\25CB"; } .cs-researching::before { content:"\\25D4"; } .cs-researched::before { content:"\\25D1"; }
.cs-researching { --b-fg:var(--info); --b-bg:var(--info-soft); --b-bd:var(--info); } .cs-researched { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); }
.cs-needs_review::before { content:"!"; font-weight:800; } .cs-needs_review { --b-fg:var(--warn); --b-bg:var(--warn-soft); --b-bd:var(--gold); border-width:2px; font-weight:700; }
.cs-approved::before { content:"\\2713"; } .cs-approved { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); font-weight:700; }
.cs-rejected::before { content:"\\2715"; } .cs-rejected { --b-fg:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; }
.cs-duplicate::before { content:"\\2261"; } .cs-duplicate { --b-fg:var(--muted); border-style:dashed; text-decoration:line-through; text-decoration-thickness:1px; }
/* qualification: required criteria only */
.q-meets_criteria::before { content:"\\2713"; } .q-meets_criteria { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); }
.q-unverified::before { content:"?"; font-weight:800; } .q-unverified { border-style:dashed; }
.q-disqualified::before { content:"\\2715"; } .q-disqualified { --b-fg:var(--neg); --b-bg:var(--neg-soft); --b-bd:var(--neg); }
/* opportunity band: a ranking, deliberately a different (teal) family from qualification */
.pill::before { content:"\\25B2"; } .pill { --b-fg:var(--on-btn); --b-bg:var(--accent); --b-bd:var(--accent); }
@media (prefers-color-scheme: dark) { .pill { --b-fg:#06202B; } }
.band-high::before { content:"\\25B2"; } .band-medium::before { content:"\\25C6"; } .band-low::before { content:"\\25BD"; }
.band-medium { --b-fg:var(--accent); --b-bg:var(--accent-soft); } .band-low { --b-fg:var(--muted); --b-bg:var(--well); --b-bd:var(--line-2); }
/* observed signal value: Unknown is a normal state, not an error */
.obs-yes::before { content:"\\2713"; } .obs-yes { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); }
.obs-no::before { content:"\\2715"; } .obs-no { --b-bg:var(--well); }
.obs-unknown::before { content:"?"; font-weight:800; } .obs-unknown { --b-fg:var(--muted); --b-bg:transparent; border-style:dashed; font-weight:500; }
.tag { font-weight:500; --b-bg:var(--well); }
.kind { font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:1px 6px; --b-fg:var(--muted); }
.kind.req { --b-fg:var(--info); --b-bg:var(--info-soft); --b-bd:var(--info); }
/* verdicts: glyph, words, and tone (the review pages) */
.vd { font-weight:700; }
.vd-pos { --b-fg:var(--pos); --b-bg:var(--pos-soft); --b-bd:var(--pos); } .vd-warn { --b-fg:var(--warn); --b-bg:var(--warn-soft); --b-bd:var(--gold); }
.vd-neg { --b-fg:var(--neg); --b-bg:var(--neg-soft); --b-bd:var(--neg); } .vd-info { --b-fg:var(--info); --b-bg:var(--info-soft); --b-bd:var(--info); }
.vd-quiet { --b-fg:var(--muted); --b-bg:transparent; border-style:dashed; }
.vd.lg { font-size:var(--fs-16); padding:5px 12px; gap:8px; }
/* A supporting mark next to a fact: tone, glyph, and words, without a filled badge. */
.vd.sub { font-weight:600; padding:0; gap:4px; border:0; background:transparent; }

/* ---------- buttons: one primary per region, outlined secondary, red destructive, quiet neutral ---------- */
button, .btn { white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:36px; padding:7px 14px; border:1px solid var(--btn); border-radius:8px; background:var(--btn); color:var(--on-btn); font:inherit; font-weight:600; font-size:var(--fs-14); line-height:1.2; cursor:pointer; text-decoration:none; box-shadow:var(--e-btn); }
button:hover, .btn:hover { background:var(--btn-hover); border-color:var(--btn-hover); text-decoration:none; }
.btn-secondary, button.btn-secondary { background:var(--surface); color:var(--ink); border-color:var(--line-2); box-shadow:0 1px 2px rgb(11 31 51 / .06); }
.btn-secondary:hover, button.btn-secondary:hover { background:var(--well); border-color:var(--ink-2); }
.btn-ghost, button.btn-ghost { background:transparent; color:var(--ink-2); border-color:transparent; box-shadow:none; }
.btn-ghost:hover, button.btn-ghost:hover { background:var(--well); border-color:var(--line-2); }
.btn-danger, button.btn-danger { background:var(--surface); color:var(--neg); border-color:var(--neg); box-shadow:none; }
.btn-danger:hover, button.btn-danger:hover { background:var(--neg-soft); border-color:var(--neg); }
.btn-go, button.btn-go { background:var(--pos); border-color:var(--pos); color:var(--on-go); min-height:40px; padding:8px 18px; }
.btn-go:hover, button.btn-go:hover { background:var(--pos); border-color:var(--pos); filter:brightness(1.08); }
/* Destructive as the primary action (outside the category, or doesn't qualify). */
.btn-stop, button.btn-stop { background:var(--neg); border-color:var(--neg); color:var(--on-neg); min-height:40px; padding:8px 18px; }
.btn-stop:hover, button.btn-stop:hover { background:var(--neg); border-color:var(--neg); filter:brightness(1.08); }
.btn-sm, button.btn-sm { min-height:32px; padding:5px 12px; font-size:var(--fs-13); }
.btn-primary-lg { min-height:40px; padding:8px 18px; }
.btn-quiet { background:transparent; color:var(--ink-2); border-color:var(--line-2); box-shadow:none; }
button.link { min-height:0; padding:0; border:0; background:none; color:var(--neg); font-weight:600; font-size:var(--fs-13); text-decoration:underline; box-shadow:none; }
.inline-form { display:inline; margin:0; }

/* ---------- KPIs and metrics ---------- */
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
.kpi { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); padding:14px 16px; box-shadow:var(--e1); }
.kpi .k-label { font-size:var(--fs-13); color:var(--muted); font-weight:600; }
.kpi .k-value { font-size:var(--fs-24); line-height:1.2; font-weight:650; font-variant-numeric:tabular-nums; margin-top:4px; }
.kpi .k-hint { font-size:var(--fs-12); color:var(--muted); margin-top:2px; }
dl.metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin:0; }
dl.metrics > div { border:1px solid var(--line); border-radius:8px; padding:8px 12px; background:var(--well); }
dl.metrics dt { font-size:var(--fs-12); color:var(--muted); font-weight:600; }
dl.metrics dd { margin:0; font-size:var(--fs-20); font-weight:650; font-variant-numeric:tabular-nums; }
dl.metrics .m-sample { background:transparent; border-style:dashed; } dl.metrics .m-sample dd { font-size:var(--fs-16); font-weight:500; color:var(--muted); }
dl.kv { display:grid; grid-template-columns:120px 1fr; gap:10px 14px; margin:0; }
dl.kv dt { color:var(--muted); font-size:var(--fs-13); font-weight:600; padding-top:1px; }
dl.kv dd { margin:0; overflow-wrap:anywhere; min-width:0; }
.src { font-size:var(--fs-13); color:var(--muted); margin-top:2px; }
.url { display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom; }

/* qualification / opportunity cards */
.verdict { border-top:3px solid var(--line-2); }
.verdict.v-meets_criteria { border-top-color:var(--pos); } .verdict.v-disqualified { border-top-color:var(--neg); } .verdict.v-unverified { border-top-style:dashed; }
.verdict.v-score { border-top-color:var(--accent); }
.v-label { font-size:var(--fs-12); font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.v-sub { font-size:var(--fs-13); color:var(--muted); margin-top:1px; }
.v-big { font-size:var(--fs-20); font-weight:700; margin:8px 0 6px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.v-big .big { font-size:var(--fs-30); line-height:1; font-weight:700; font-variant-numeric:tabular-nums; }
.v-big .q-big { font-size:var(--fs-16); padding:5px 12px; }
.v-big .pill { font-size:var(--fs-13); padding:3px 10px; }

/* ---------- tables ---------- */
.scroll { position:relative; overflow-x:auto; background:var(--surface); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--e1); }
table.tbl { width:100%; border-collapse:collapse; }
.tbl th { text-align:left; font-size:var(--fs-12); font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); background:var(--well); padding:10px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
.tbl td { padding:13px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
.tbl tbody tr:last-child td { border-bottom:0; }
.tbl tbody tr:hover td { background:var(--well); }
.tbl th.num { text-align:right; }
.tbl .name { font-weight:650; color:var(--ink); text-decoration:none; font-size:var(--fs-14); }
.tbl .name:hover { color:var(--accent); text-decoration:underline; }
.tbl tr.attn td:first-child { box-shadow:inset 3px 0 0 var(--gold); }
.tbl tr.hl td { background:var(--accent-soft); }
.tbl tr.zero td { color:var(--muted); }
.tbl td .sub { font-size:var(--fs-13); color:var(--muted); margin-top:2px; overflow-wrap:anywhere; }
.tbl td .sub a, .src a { color:var(--muted); text-decoration:none; } .tbl td .sub a:hover, .src a:hover { color:var(--accent); text-decoration:underline; }
.score-cell { white-space:nowrap; } .score-cell b { font-size:15px; font-variant-numeric:tabular-nums; } .score-cell .of { color:var(--muted); font-size:var(--fs-12); }
.tbl tfoot td { background:var(--well); border-top:1px solid var(--line); font-weight:650; }

/* ---------- filters ---------- */
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
.chip { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border:1px solid var(--line-2); border-radius:8px; background:var(--surface); color:var(--ink-2); text-decoration:none; font-size:var(--fs-13); font-weight:600; }
.chip:hover { border-color:var(--ink-2); text-decoration:none; }
.chip .n { color:var(--muted); font-weight:500; font-variant-numeric:tabular-nums; }
.chip[aria-current="true"] { background:var(--btn); color:var(--on-btn); border-color:var(--btn); } .chip[aria-current="true"] .n { color:inherit; opacity:.75; }
.chip.attn { border-color:var(--gold); }
.filters { display:grid; gap:12px; }
.filters .search { width:100%; }
.filter-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; align-items:end; }
.filter-actions { display:flex; gap:8px; align-items:center; align-self:end; }
.result-line { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:16px 0 10px; font-size:var(--fs-13); color:var(--muted); }

/* ---------- forms ---------- */
label.lbl, .field > label { display:block; font-size:var(--fs-13); font-weight:600; color:var(--ink-2); margin-bottom:4px; }
input[type=text], input[type=password], input[type=search], input[type=date], select, textarea { width:100%; min-height:38px; padding:8px 11px; border:1px solid var(--line-2); border-radius:8px; background:var(--surface); color:var(--ink); font:inherit; }
textarea { min-height:84px; resize:vertical; }
input[readonly] { background:var(--well); font:12px var(--mono); }
input:hover, select:hover, textarea:hover { border-color:var(--muted); }
input:focus-visible, select:focus-visible, textarea:focus-visible { border-color:var(--ring); border-radius:8px; }
input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"] { border-color:var(--neg); box-shadow:inset 3px 0 0 var(--neg); }
.hint { font-size:var(--fs-13); color:var(--muted); margin-top:3px; }
.ferr { font-size:var(--fs-13); color:var(--neg); font-weight:600; margin-top:4px; display:flex; gap:5px; }
.ferr::before { content:"\\2715"; font-size:12px; padding-top:2px; }
.fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px; }
.fields .wide { grid-column:1/-1; }
fieldset.fs { border:1px solid var(--line); border-radius:var(--r); background:var(--surface); padding:18px 22px 20px; margin:0; box-shadow:var(--e1); min-width:0; }
fieldset.fs > legend { float:left; width:100%; padding:0; margin:0 0 12px; font-weight:650; font-size:var(--fs-16); display:flex; align-items:center; gap:10px; }
fieldset.fs > legend + * { clear:both; }
.step-n { display:inline-grid; place-items:center; width:24px; height:24px; border-radius:50%; background:var(--navy); color:#FFFFFF; font-size:var(--fs-12); font-weight:700; }
.fs-note { font-size:var(--fs-13); color:var(--muted); margin:-4px 0 12px; }
.form-foot { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }

/* signal rows */
.sig { border:1px solid var(--line); border-radius:var(--r); background:var(--well); padding:12px 14px; }
.sig + .sig { margin-top:10px; }
.sig.req { border-left:4px solid var(--info); background:var(--surface); }
.sig-h { display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap; }
.sig-name { font-weight:700; letter-spacing:.01em; }
.sig-pts { font-weight:700; font-variant-numeric:tabular-nums; color:var(--ink-2); }
.sig-q { font-size:var(--fs-13); color:var(--ink-2); margin:3px 0 10px; }
.sig-foot { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-top:10px; }
.seg-group { display:inline-flex; border:1px solid var(--line-2); border-radius:8px; overflow:hidden; background:var(--surface); }
.seg { position:relative; display:block; margin:0; }
.seg input { position:absolute; inset:0; opacity:0; margin:0; cursor:pointer; width:100%; height:100%; }
.seg span { display:block; padding:6px 16px; font-size:var(--fs-13); font-weight:600; color:var(--ink-2); border-left:1px solid var(--line-2); cursor:pointer; min-width:84px; text-align:center; }
.seg:first-child span { border-left:0; }
.seg input:checked + span::before { content:"\\2713\\00a0"; }
.seg-yes input:checked + span { background:var(--pos); color:#FFFFFF; }
.seg-no input:checked + span { background:var(--ink-2); color:var(--surface); }
.seg-unknown input:checked + span { background:var(--well); color:var(--ink); box-shadow:inset 0 0 0 2px var(--line-2); }
.seg input:focus-visible + span { outline:2px solid var(--ring); outline-offset:-3px; }
.seg input:disabled + span { opacity:.45; cursor:not-allowed; }
.seg:hover input:not(:disabled):not(:checked) + span { background:var(--well); }
details.rules summary { cursor:pointer; color:var(--accent); font-size:var(--fs-13); font-weight:600; }
details.rules dl { margin-top:8px; }

/* ---------- pipeline stepper ---------- */
ol.steps { display:flex; flex-wrap:wrap; gap:6px; list-style:none; margin:0 0 14px; padding:0; }
ol.steps li { display:flex; align-items:center; gap:6px; padding:5px 11px; border:1px solid var(--line-2); border-radius:8px; font-size:var(--fs-13); font-weight:600; color:var(--muted); background:var(--surface); }
ol.steps li.done { color:var(--ink-2); background:var(--well); } ol.steps li.done::before { content:"\\2713"; }
ol.steps li.now { background:var(--btn); color:var(--on-btn); border-color:var(--btn); } ol.steps li.now::before { content:"\\25B6"; font-size:12px; }
ol.steps li.next::before { content:"\\25CB"; }

/* ---------- evidence, notes, timeline ---------- */
.ev { border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:8px; background:var(--surface); padding:12px 16px; }
.ev + .ev { margin-top:10px; }
.ev blockquote { margin:6px 0; padding:0; font-size:var(--fs-14); }
.ev .meta { display:flex; gap:10px; flex-wrap:wrap; align-items:center; font-size:var(--fs-12); color:var(--muted); }
.note { border-bottom:1px solid var(--line); padding:10px 0; } .note:last-child { border-bottom:0; } .note .when { font-size:var(--fs-12); color:var(--muted); } .note .body { white-space:pre-wrap; }
ul.timeline { list-style:none; margin:10px 0 0; padding:0; border-left:2px solid var(--line); }
ul.timeline li { position:relative; padding:0 0 10px 16px; font-size:var(--fs-13); } ul.timeline li::before { content:""; position:absolute; left:-6px; top:6px; width:10px; height:10px; border-radius:50%; background:var(--surface); border:2px solid var(--line-2); }
ul.timeline .when { font-size:var(--fs-12); color:var(--muted); display:block; }
.empty { text-align:center; padding:28px 16px; color:var(--muted); }
.empty b { display:block; color:var(--ink-2); font-size:var(--fs-16); margin-bottom:4px; }
.empty span { display:block; font-size:var(--fs-13); }
ul.plain { margin:6px 0 0; padding-left:18px; } ul.plain li { margin:5px 0; }
pre.msg { margin:0; white-space:pre-wrap; word-break:break-word; font:inherit; font-size:var(--fs-14); line-height:1.65; }
.attn-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
.attn-item { display:flex; align-items:center; gap:12px; padding:10px 14px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); text-decoration:none; color:var(--ink); box-shadow:var(--e1); }
.attn-item:hover { border-color:var(--accent); text-decoration:none; }
.attn-item b { font-size:var(--fs-20); font-variant-numeric:tabular-nums; min-width:28px; } .attn-item span { color:var(--ink-2); font-size:var(--fs-13); }
.attn-item.zero { opacity:.6; }

/* =====================================================================
   Shared primitives
   ===================================================================== */

/* state dot: shape and words, never color alone */
.dot { display:inline-grid; place-items:center; width:16px; height:16px; flex:none; font-size:12px; line-height:1; color:var(--d, var(--muted)); }
.s-verified { --d:var(--pos); } .s-recent { --d:var(--pos); } .s-attention { --d:var(--warn); } .s-down { --d:var(--neg); } .s-unknown { --d:var(--muted); } .s-off { --d:var(--off); }

/* meter: discrete pips for small limits, a bar for large ones */
.pips { display:inline-flex; flex-wrap:wrap; gap:4px; vertical-align:middle; max-width:220px; }
.pips i { width:12px; height:12px; border-radius:3px; border:1.5px solid var(--line-2); background:transparent; }
.pips i.on { background:var(--pip, var(--ink-2)); border-color:var(--pip, var(--ink-2)); }
.meter { display:inline-block; width:160px; max-width:100%; height:8px; border-radius:4px; background:var(--well); border:1px solid var(--line); overflow:hidden; vertical-align:middle; }
.meter > span { display:block; height:100%; background:var(--pip, var(--ink-2)); }

/* attention item */
.att-tier + .att-tier { margin-top:18px; }
.att-tier-h { font-size:var(--fs-12); font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:8px; display:flex; align-items:center; gap:8px; }
.att-tier-h::after { content:""; flex:1; height:1px; background:var(--line); }
.att-list { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.att-item { display:grid; grid-template-columns:52px minmax(0,1fr) auto auto; gap:4px 16px; align-items:center; padding:12px 14px 12px 12px; border:1px solid var(--line); border-left:4px solid var(--a, var(--line-2)); border-radius:var(--r); background:var(--surface); }
.att-item:hover { background:var(--well); }
.att-item.t-neg { --a:var(--neg); --a-bg:var(--neg-soft); } .att-item.t-warn { --a:var(--gold); --a-bg:var(--warn-soft); --a-fg:var(--warn); }
.att-item.t-info { --a:var(--info); --a-bg:var(--info-soft); } .att-item.t-pos { --a:var(--pos); --a-bg:var(--pos-soft); }
.att-n { display:grid; place-items:center; min-height:44px; border-radius:8px; background:var(--a-bg, var(--well)); color:var(--a-fg, var(--a, var(--ink))); font-family:var(--font-display); font-size:var(--fs-20); font-weight:700; font-variant-numeric:tabular-nums; }
.att-title { font-size:15px; font-weight:650; color:var(--ink); line-height:1.35; }
.att-why { font-size:var(--fs-13); color:var(--ink-2); margin-top:2px; }
.att-age { font-size:var(--fs-13); color:var(--muted); white-space:nowrap; text-align:right; }
.att-age b { color:var(--ink-2); font-weight:600; }
.all-clear { display:grid; justify-items:center; text-align:center; gap:8px; padding:36px 20px 32px; }
.all-clear-mark { display:grid; place-items:center; width:48px; height:48px; border-radius:50%; background:var(--pos-soft); color:var(--pos); font-size:22px; font-weight:700; }
.all-clear h3 { font-size:var(--fs-20); font-weight:650; }
.all-clear p { color:var(--ink-2); max-width:52ch; }
.all-clear .btn { margin-top:8px; }

/* funnel bar */
.fbar { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
.fbar-row { display:grid; grid-template-columns:minmax(120px,170px) minmax(60px,1fr) 56px minmax(120px,150px); gap:14px; align-items:center; }
.fbar-l { font-size:var(--fs-13); font-weight:600; color:var(--ink-2); }
.fbar-track { height:12px; border-radius:4px; background:var(--well); border:1px solid var(--line); overflow:hidden; }
.fbar-track > span { display:block; height:100%; min-width:2px; background:var(--fb, var(--navy-2)); border-radius:0 3px 3px 0; }
.fbar-n { font-size:var(--fs-16); font-weight:650; text-align:right; font-variant-numeric:tabular-nums; }
.fbar-c { font-size:var(--fs-12); color:var(--muted); }
.fbar-c b { color:var(--ink-2); font-size:var(--fs-13); }
.fbar-row.is-zero .fbar-n { color:var(--muted); }
@media (prefers-color-scheme: dark) { .fbar-track > span { --fb:#5C8FBF; } }

/* activity feed, grouped by day */
.feed-day + .feed-day { margin-top:14px; }
.feed-day-h { font-size:var(--fs-12); font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
.feed { list-style:none; margin:0; padding:0; }
.feed li { display:grid; grid-template-columns:30px minmax(0,1fr) auto; gap:12px; align-items:start; padding:10px 0; border-top:1px solid var(--line); }
.feed li:first-child { border-top:0; }
.feed-glyph { display:grid; place-items:center; width:30px; height:30px; border-radius:8px; background:var(--well); color:var(--ink-2); border:1px solid var(--line); }
.feed-glyph .ui-icon { width:16px; height:16px; }
.feed a { font-weight:600; color:var(--ink); text-decoration:none; }
.feed a:hover { color:var(--accent); text-decoration:underline; }
.feed p { font-size:var(--fs-13); color:var(--muted); overflow-wrap:anywhere; }
.feed time { font-size:var(--fs-12); color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; padding-top:2px; }

/* system status rail: one bar, one cell per system */
.rail { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--e1); }
.rail-list { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); }
.rail-list > li { min-width:0; border-left:1px solid var(--line); }
.rail-list > li:first-child { border-left:0; }
.rail-cell { display:grid; gap:3px; height:100%; padding:14px 16px; color:inherit; text-decoration:none; border-radius:0; }
a.rail-cell:hover { background:var(--well); text-decoration:none; }
.rail-name { font-size:var(--fs-12); font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.rail-state { display:flex; align-items:center; gap:6px; font-size:var(--fs-14); font-weight:650; color:var(--ink); }
.rail-ev { font-size:var(--fs-12); color:var(--muted); line-height:1.45; overflow-wrap:anywhere; }
.rail-list > li.s-unknown .rail-state { color:var(--ink-2); font-weight:600; border-bottom:1px dashed var(--line-2); padding-bottom:3px; }
.rail-list > li.s-attention .rail-state { color:var(--warn); } .rail-list > li.s-down .rail-state { color:var(--neg); }
.rail-list > li.s-attention { box-shadow:inset 0 3px 0 var(--gold); } .rail-list > li.s-down { box-shadow:inset 0 3px 0 var(--neg); background:var(--neg-soft); }

/* the sending guardrail: operational, not a KPI */
.guard { --g:var(--off); --g-bg:var(--off-soft); position:relative; display:grid; grid-template-columns:minmax(260px,1.1fr) minmax(0,2fr) auto; gap:24px; align-items:center; padding:20px 24px 20px 28px; border:1px solid var(--line); border-radius:var(--r-lg); background:var(--surface); box-shadow:var(--e2); overflow:hidden; }
.guard::before { content:""; position:absolute; inset:0 auto 0 0; width:6px; background:var(--g); }
.guard.m-on { --g:var(--pos); --g-bg:var(--pos-soft); } .guard.m-blocked { --g:var(--neg); --g-bg:var(--neg-soft); border-color:var(--neg); } .guard.m-paused { --g:var(--gold); --g-bg:var(--warn-soft); }
.guard-title { display:flex; align-items:center; gap:12px; margin-top:6px; font-size:var(--fs-24); font-weight:650; letter-spacing:-.01em; color:var(--ink); }
.guard-title b { color:var(--g); font-weight:800; letter-spacing:.03em; }
.guard.m-paused .guard-title b { color:var(--warn); }
.switch { position:relative; width:46px; height:26px; flex:none; border-radius:13px; background:var(--g-bg); border:2px solid var(--g); }
.switch::after { content:""; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:var(--g); }
.guard.m-on .switch::after, .guard.m-blocked .switch::after, .guard.m-paused .switch::after { left:auto; right:3px; }
.guard-detail { margin-top:8px; font-size:var(--fs-13); color:var(--ink-2); max-width:52ch; }
.guard-why { margin-top:6px; font-size:var(--fs-12); color:var(--muted); }
.guard-facts { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:0; margin:0; border:1px solid var(--line); border-radius:var(--r); background:var(--well); }
.guard-facts > div { padding:12px 16px; border-left:1px solid var(--line); min-width:0; }
.guard-facts > div:first-child { border-left:0; }
.guard-facts dt { font-size:var(--fs-12); font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
.guard-facts dd { margin:6px 0 0; display:grid; gap:4px; }
.guard-facts dd b { font-family:var(--font-display); font-size:var(--fs-20); font-weight:700; font-variant-numeric:tabular-nums; color:var(--ink); line-height:1.2; }
.guard-facts dd span { font-size:var(--fs-12); color:var(--muted); }
.guard-facts .is-alert { background:var(--neg-soft); } .guard-facts .is-alert b, .guard-facts .is-alert dt { color:var(--neg); }
.guard-act { display:grid; gap:8px; justify-items:end; }
.guard-act form { margin:0; }

/* next best action */
.nba { position:relative; padding:22px 24px 22px 28px; overflow:hidden; }
.nba::before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:var(--gold); }
.nba-eyebrow { display:flex; align-items:center; gap:8px; font-size:var(--fs-12); font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--gold-ink); }
.nba-title { margin-top:10px; font-size:var(--fs-20); font-weight:650; line-height:1.3; letter-spacing:-.01em; }
.nba dl { margin:14px 0 18px; display:grid; gap:10px; }
.nba dt { font-size:var(--fs-12); font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
.nba dd { margin:2px 0 0; color:var(--ink-2); }

/* compact figures (the outreach snapshot) */
.figs { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); margin:0; border:1px solid var(--line); border-radius:var(--r); overflow:hidden; }
.figs > div { padding:12px 14px; border-left:1px solid var(--line); border-top:1px solid var(--line); background:var(--surface); }
.figs > div:nth-child(3n+1) { border-left:0; } .figs > div:nth-child(-n+3) { border-top:0; }
.figs dt { font-size:var(--fs-12); color:var(--muted); font-weight:600; }
.figs dd { margin:2px 0 0; font-family:var(--font-display); font-size:var(--fs-20); font-weight:650; font-variant-numeric:tabular-nums; }
.card-note { margin-top:12px; font-size:var(--fs-12); color:var(--muted); line-height:1.5; }

/* =====================================================================
   Overview
   ===================================================================== */
.ov-head { display:flex; justify-content:space-between; align-items:flex-end; gap:20px; flex-wrap:wrap; margin-bottom:24px; }
.ov-title { font-family:var(--font); font-size:var(--fs-13); font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.ov-verdict { margin-top:6px; display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; font-family:var(--font-display); font-size:var(--fs-24); font-weight:600; letter-spacing:-.015em; line-height:1.3; color:var(--ink); }
.ov-verdict .vsep { color:var(--line-2); font-weight:400; }
.ov-verdict .v-send { color:var(--vc, var(--off)); font-weight:700; }
.ov-verdict .v-send.m-on { --vc:var(--pos); } .ov-verdict .v-send.m-blocked { --vc:var(--neg); } .ov-verdict .v-send.m-paused { --vc:var(--warn); } .ov-verdict .v-send.m-unknown { --vc:var(--muted); }
.ov-verdict .v-bad { color:var(--neg); }
.ov-meta { margin-top:8px; font-size:var(--fs-13); color:var(--muted); }
.ov-stack > * + * { margin-top:24px; }
.ov-grid { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:24px; align-items:start; }
.ov-side > * + * { margin-top:24px; }
.ov-pair { display:grid; grid-template-columns:minmax(0,5fr) minmax(0,7fr); gap:24px; align-items:start; }
.fn-cols { display:grid; grid-template-columns:minmax(0,1.55fr) minmax(0,1fr); gap:28px; }
.fn-h { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; font-size:var(--fs-14); font-weight:700; margin-bottom:4px; }
.fn-h span { font-size:var(--fs-12); font-weight:500; color:var(--muted); }
.fn-explain { font-size:var(--fs-12); color:var(--muted); margin-bottom:14px; max-width:70ch; }
.fn-seg + .fn-seg { margin-top:18px; padding-top:16px; border-top:1px dashed var(--line); }
.fn-seg-h { font-size:var(--fs-12); font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin-bottom:10px; }
.fn-now { border-left:1px solid var(--line); padding-left:28px; }
.inv { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
.inv li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; padding:8px 12px; border-radius:8px; background:var(--well); border:1px solid var(--line); }
.inv li.inv-cand { background:transparent; border-style:dashed; }
.inv-l { font-size:var(--fs-13); font-weight:600; color:var(--ink-2); display:flex; align-items:center; gap:8px; }
.inv-n { font-family:var(--font-display); font-size:var(--fs-16); font-weight:700; font-variant-numeric:tabular-nums; }
.inv-closed { margin-top:12px; font-size:var(--fs-12); color:var(--muted); line-height:1.7; }

/* ---------- Discovery work queue: what needs attention, why, and the one next action ---------- */
.q-head { margin-bottom:18px; }
.q-head .lede b { color:var(--ink); }
.q-tiles { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:22px; }
.q-tile { display:grid; gap:2px; padding:14px 16px; border:1px solid var(--line); border-top:3px solid var(--line-2); border-radius:var(--r); background:var(--surface); color:var(--ink); text-decoration:none; box-shadow:var(--e1); }
.q-tile:hover { border-color:var(--line-2); background:var(--well); text-decoration:none; }
.q-tile.t-warn { border-top-color:var(--gold); } .q-tile.t-pos { border-top-color:var(--pos); } .q-tile.t-info { border-top-color:var(--info); }
.q-tile[aria-current="true"] { box-shadow:inset 0 0 0 2px var(--ring); }
.q-tile-n { font-family:var(--font-display); font-size:var(--fs-30); line-height:1.1; font-weight:700; font-variant-numeric:tabular-nums; }
.q-tile-l { font-size:15px; font-weight:650; }
.q-tile.t-warn .q-tile-l span { color:var(--warn); } .q-tile.t-pos .q-tile-l span { color:var(--pos); } .q-tile.t-info .q-tile-l span { color:var(--info); }
.q-tile-h { font-size:var(--fs-13); color:var(--muted); }
.q-tile.zero .q-tile-n { color:var(--muted); }
/* Outreach: is mail going out, and if not, why. Tone, glyph, and words together. */
.o-status { display:flex; flex-wrap:wrap; gap:14px 24px; align-items:flex-start; justify-content:space-between; padding:18px 22px; margin-bottom:16px; border:1px solid var(--line); border-left:5px solid var(--line-2); border-radius:var(--r-lg); background:var(--surface); box-shadow:var(--e2); }
.o-status.t-pos { border-left-color:var(--pos); } .o-status.t-warn { border-left-color:var(--gold); } .o-status.t-neg { border-left-color:var(--neg); }
.o-status-main { flex:1 1 320px; min-width:0; }
.o-status-l { margin:0; font-size:var(--fs-20); font-weight:700; line-height:1.3; }
.o-status.t-pos .o-status-l span { color:var(--pos); } .o-status.t-warn .o-status-l span { color:var(--warn); } .o-status.t-neg .o-status-l span { color:var(--neg); } .o-status.t-quiet .o-status-l span { color:var(--muted); }
.o-status-d { margin:4px 0 6px; font-size:var(--fs-14); }
.o-status-act { flex:0 1 auto; }
.o-blockers { flex-basis:100%; padding:10px 14px; border-radius:var(--r); background:var(--well); font-size:var(--fs-14); }
.o-blockers p { margin:0; } .o-blockers ul { margin:4px 0 0; padding-left:20px; } .o-blockers li { margin:2px 0; }
.safety-switch > summary { cursor:pointer; font-size:var(--fs-13); font-weight:650; color:var(--warn); }
.safety-switch[open] { max-width:440px; padding:14px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); box-shadow:var(--e3); }
.safety-switch p { font-size:var(--fs-13); margin:10px 0; color:var(--ink-2); }
.o-attn { padding:12px 16px; border:1px solid var(--line); border-left:4px solid var(--gold); border-radius:var(--r); background:var(--surface); }
.o-attn.t-neg { border-left-color:var(--neg); }
.o-attn.t-pos { border-left-color:var(--pos); } .o-attn.t-pos h3 > span:first-child { color:var(--pos); }
.o-attn h3 { margin:0; font-size:var(--fs-16); display:flex; align-items:baseline; gap:8px; }
.o-attn.t-warn h3 > span:first-child { color:var(--warn); } .o-attn.t-neg h3 > span:first-child { color:var(--neg); }
.o-attn ul { margin:0; padding-left:20px; font-size:var(--fs-14); } .o-attn li { margin:3px 0; }
details.o-why { margin-top:12px; } details.o-why > summary { cursor:pointer; color:var(--muted); font-size:var(--fs-13); font-weight:600; width:max-content; max-width:100%; }
details.o-why > summary:hover { color:var(--accent); } details.o-why ul { margin:8px 0 0; padding-left:20px; }
.q-chips { margin-bottom:12px; }
.q-search { margin-bottom:14px; }
.q-search-row { display:flex; gap:8px; align-items:center; }
.q-search-row .search { flex:1; min-height:40px; }
details.q-more { margin-top:8px; }
details.q-more > summary { cursor:pointer; color:var(--muted); font-size:var(--fs-13); font-weight:600; width:max-content; }
details.q-more > summary:hover { color:var(--accent); }
details.q-more[open] > .filter-row { margin-top:10px; padding:14px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
.q-batch { display:flex; flex-wrap:wrap; gap:10px 18px; align-items:center; justify-content:space-between; padding:12px 16px; margin-bottom:14px; border:1px solid var(--line); border-left:3px solid var(--info); border-radius:var(--r); background:var(--well); font-size:var(--fs-14); }
.q-group { margin-top:22px; }
.q-group-h { font-size:var(--fs-16); font-weight:700; display:flex; align-items:baseline; gap:8px; }
.q-count { font-size:var(--fs-13); font-weight:700; color:var(--muted); padding:1px 8px; border:1px solid var(--line-2); border-radius:var(--r-sm); font-variant-numeric:tabular-nums; }
.q-hint { color:var(--muted); font-size:var(--fs-13); margin:2px 0 10px; }
.q-list { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.q-row { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,1.6fr) minmax(150px,.75fr) auto; grid-template-areas:"id state qual act" "meta meta meta meta"; gap:6px 20px; align-items:center; padding:14px 18px; background:var(--surface); border:1px solid var(--line); border-left:3px solid var(--line-2); border-radius:var(--r); }
.q-row.t-warn { border-left-color:var(--gold); } .q-row.t-neg { border-left-color:var(--neg); } .q-row.t-pos { border-left-color:var(--pos); } .q-row.t-info { border-left-color:var(--info); }
.q-row:hover { background:var(--well); }
.q-id { grid-area:id; min-width:0; }
.q-name { margin:0; font-size:var(--fs-16); font-weight:700; line-height:1.3; overflow-wrap:anywhere; }
.q-name a { color:var(--ink); text-decoration:none; } .q-name a:hover { color:var(--accent); text-decoration:underline; }
.q-where { font-size:var(--fs-13); color:var(--muted); margin-top:2px; overflow-wrap:anywhere; }
.q-where a { color:var(--muted); }
.q-state { grid-area:state; min-width:0; }
.q-why { margin:4px 0 0; font-size:var(--fs-13); color:var(--ink-2); }
.q-qual { grid-area:qual; display:grid; gap:2px; }
.q-k { font-size:var(--fs-12); font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
.q-qual .vd.sub { font-size:var(--fs-13); }
.q-act { grid-area:act; justify-self:end; }
.q-act .btn, .q-act button { min-height:38px; }
.q-wait { font-size:var(--fs-13); color:var(--info); font-weight:600; white-space:nowrap; }
.q-meta { grid-area:meta; display:flex; flex-wrap:wrap; gap:4px 8px; align-items:center; font-size:var(--fs-13); color:var(--ink-2); }
.q-dot { color:var(--line-2); }
.q-handled { margin-top:28px; }
.q-handled .q-row { background:transparent; }
/* candidate page: where you are in the queue */
.rv-nav { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; margin-bottom:14px; font-size:var(--fs-14); }
.rv-back { font-weight:600; color:var(--ink-2); text-decoration:none; } .rv-back:hover { color:var(--accent); text-decoration:underline; }
.rv-pos { color:var(--muted); }
.rv-step { margin-left:auto; display:flex; gap:6px; }

/* ---------- review page: identity -> duplicate -> qualification -> decision ---------- */
.rv { display:grid; gap:16px; }
.rv-id, .rv-card { background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); box-shadow:var(--e1); }
.rv-id { padding:22px 24px; box-shadow:var(--e2); }
.rv-eyebrow { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; font-size:var(--fs-13); color:var(--muted); }
.rv-eyebrow a { margin-left:auto; color:var(--muted); }
.rv-id h1 { font-size:var(--fs-30); line-height:1.15; font-weight:700; letter-spacing:-.02em; margin:8px 0 4px; overflow-wrap:anywhere; }
.rv-addr { font-size:15px; color:var(--ink-2); }
.rv-facts { list-style:none; margin:14px 0 0; padding:0; display:flex; flex-wrap:wrap; gap:10px 26px; font-size:var(--fs-14); }
.rv-facts li { display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap; }
.rv-facts .k { font-size:var(--fs-12); font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
.rv-issues { list-style:none; margin:16px 0 0; padding:0; display:grid; gap:6px; }
.rv-issues li { display:flex; gap:10px; align-items:baseline; font-size:var(--fs-13); padding:8px 12px; border-radius:8px; background:var(--well); border-left:3px solid var(--line-2); }
.rv-issues li.t-warn { border-left-color:var(--gold); } .rv-issues li.t-warn > span:first-child { color:var(--warn); }
.rv-issues li.t-neg { border-left-color:var(--neg); } .rv-issues li.t-neg > span:first-child { color:var(--neg); }
.rv-issues li.t-info { border-left-color:var(--info); } .rv-issues li.t-info > span:first-child { color:var(--info); }
.rv-card { padding:20px 22px; border-top-width:3px; }
.rv-card.t-pos { border-top-color:var(--pos); } .rv-card.t-warn { border-top-color:var(--gold); } .rv-card.t-neg { border-top-color:var(--neg); } .rv-card.t-quiet { border-top-style:dashed; }
.rv-h { font-size:var(--fs-12); font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.rv-q { font-size:var(--fs-13); color:var(--ink-2); margin-top:2px; }
.rv-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; align-items:stretch; }
.rv-result { margin:14px 0 4px; }
.rv-why { font-size:var(--fs-13); color:var(--ink-2); margin-top:8px; }
.rv-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:flex-start; margin-top:16px; }
.crit { list-style:none; margin:14px 0 6px; padding:0; display:grid; gap:8px; }
.crit li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; align-items:center; padding:10px 12px; border-radius:8px; background:var(--well); }
.crit .cname { font-size:15px; font-weight:650; }
.crit .cev { grid-column:1/-1; font-size:var(--fs-13); color:var(--muted); overflow-wrap:anywhere; }
.crit .cev .src { display:inline; }
.rv-blockers { list-style:none; margin:10px 0 0; padding:0; display:grid; gap:6px; font-size:var(--fs-13); }
.rv-blockers li::before { content:"\\26A0\\00a0"; color:var(--warn); }
/* the duplicate question */
.rv-dup { border-top-color:var(--gold); }
.rv-dup-head { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px 24px; align-items:flex-start; }
.rv-dup-head h2 { margin:0; }
.rv-reason { font-size:var(--fs-14); text-align:right; }
.rv-k { display:block; font-size:var(--fs-12); font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--info); margin-bottom:2px; }
.rv-dup-done { padding:12px 18px; }
.cmp-wrap { overflow-x:auto; margin-top:14px; border:1px solid var(--line); border-radius:8px; }
.cmp { width:100%; border-collapse:collapse; font-size:var(--fs-14); }
.cmp th, .cmp td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
.cmp tbody tr:last-child th, .cmp tbody tr:last-child td { border-bottom:0; }
.cmp thead th { font-size:var(--fs-12); font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); background:var(--well); white-space:nowrap; }
.cmp thead th a { text-transform:none; letter-spacing:0; font-weight:600; margin-left:6px; }
.cmp tbody th { width:96px; font-size:var(--fs-13); font-weight:600; color:var(--muted); }
.cmp td.diff { background:var(--warn-soft); }
.cmp .eq, .cmp .ne { font-size:var(--fs-12); font-weight:700; white-space:nowrap; }
.cmp .eq { color:var(--pos); } .cmp .ne { color:var(--warn); }
details.rv-disregard { display:inline-block; }
details.rv-disregard > summary { list-style:none; }
details.rv-disregard > summary::-webkit-details-marker { display:none; }
details.rv-disregard[open] { display:block; flex-basis:100%; }
/* Confirmation panels: the highest surface, because they hold a destructive decision. */
.rv-reason-form { margin-top:10px; padding:16px; border:1px solid var(--line-2); border-radius:var(--r); background:var(--surface); box-shadow:var(--e3); }
/* research, secondary */
.rv-strip { display:flex; flex-wrap:wrap; gap:10px 32px; align-items:flex-end; padding:12px 16px; border:1px solid var(--line); border-radius:var(--r); background:var(--well); font-size:var(--fs-13); color:var(--ink-2); }
.rv-strip > div:last-child { margin-left:auto; }
.rv-score { font-size:18px; color:var(--ink); font-variant-numeric:tabular-nums; }
.rv-more { margin:30px 0 10px; font-size:var(--fs-12); font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
details.disc { border:1px solid var(--line); border-radius:var(--r); background:var(--surface); box-shadow:var(--e1); }
details.disc + details.disc { margin-top:8px; }
details.disc > summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:12px; padding:14px 18px; border-radius:var(--r); }
details.disc > summary::-webkit-details-marker { display:none; }
details.disc > summary::before { content:"\\25B8"; color:var(--muted); display:inline-block; width:12px; font-size:15px; line-height:1; }
details.disc[open] > summary::before { content:"\\25BE"; }
details.disc > summary h2 { margin:0; font-size:15px; font-weight:650; color:var(--ink); }
details.disc > summary:hover h2 { color:var(--accent); }
details.disc > summary:hover { background:var(--well); }
.disc-sum { margin-left:auto; font-size:var(--fs-13); color:var(--muted); text-align:right; }
.disc-body { padding:4px 18px 18px; }

/* ---------- sign-in ---------- */
body.login { background:var(--navy); min-height:100vh; display:grid; place-items:center; padding:24px; }
.login-wrap { width:100%; max-width:420px; display:grid; gap:28px; justify-items:center; }
.login-logo svg { display:block; width:min(100%, 300px); height:auto; }
.login-card { width:100%; background:var(--surface); border-radius:var(--r-lg); padding:30px; border-top:4px solid var(--gold); box-shadow:0 24px 60px rgb(0 0 0 / .35); }
.login-card h1 { font-size:var(--fs-20); margin:6px 0 4px; }
.login-card form { display:grid; gap:14px; margin-top:18px; }

/* ---------- responsive ---------- */
@media (max-width: 1280px) {
  .ov-grid { grid-template-columns:minmax(0,1fr) 320px; }
  .guard { grid-template-columns:minmax(0,1fr) auto; }
  .guard-facts { grid-column:1/-1; grid-row:2; }
  .guard-act { grid-column:2; grid-row:1; }
  .rail-list { grid-template-columns:repeat(4,minmax(0,1fr)); }
  .rail-list > li:nth-child(5) { border-left:0; }
  .rail-list > li:nth-child(n+5) { border-top:1px solid var(--line); }
}
@media (max-width: 1024px) {
  :root { --sidebar:216px; }
  .top-in { padding:10px 24px; }
  .top-context { display:none; }
  .wrap { padding:24px 24px 48px; }
  .ov-grid, .ov-pair, .fn-cols { grid-template-columns:1fr; }
  .fn-now { border-left:0; padding-left:0; border-top:1px solid var(--line); padding-top:20px; }
  .hide-lg { display:none; }
  .q-tiles { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .q-row { grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"id act" "state state" "qual qual" "meta meta"; }
  .q-qual { grid-auto-flow:column; justify-content:start; align-items:baseline; gap:8px; }
}
@media (max-width: 860px) {
  .hide-md { display:none; }
  dl.kv { grid-template-columns:100px 1fr; }
  .rv-grid { grid-template-columns:1fr; }
  .rv-id h1 { font-size:var(--fs-24); }
  .rv-reason { text-align:left; }
  .rv-strip > div:last-child { margin-left:0; }
}
@media (max-width: 768px) {
  .side { display:none; }
  .content { margin-left:0; }
  .top-in { flex-wrap:wrap; gap:10px 12px; padding:10px 16px; }
  .global-search { width:auto; flex:1; min-width:140px; }
  .sendbar { order:3; flex-basis:100%; flex-wrap:wrap; }
  .sendbar > span { flex:1 1 auto; justify-content:center; }
  .mobile-nav { display:block; }
  .mobile-nav > summary { list-style:none; display:inline-flex; align-items:center; gap:8px; min-height:36px; padding:6px 12px; border-radius:8px; background:var(--navy); color:#FFFFFF; font-weight:600; cursor:pointer; }
  .mobile-nav > summary::-webkit-details-marker { display:none; }
  .mobile-nav > summary::before { content:"\\2630"; }
  .mobile-nav[open] > summary::before { content:"\\2715"; }
  .drawer { position:absolute; left:0; right:0; top:100%; max-height:calc(100vh - 120px); overflow-y:auto; background:var(--navy); padding:12px 12px 16px; box-shadow:var(--e3); }
  .drawer .nav { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px 12px; }
  .drawer .nav-group + .nav-group { margin-top:0; }
  .drawer form { margin:12px 12px 0; }
  .drawer .btn-quiet { background:transparent; color:var(--side-ink); border:1px solid rgb(255 255 255 / .16); }
  .wrap { padding:20px 16px 40px; }
  .foot { padding:0 16px 20px; }
  .rail-list { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .rail-list > li { border-left:0; border-top:1px solid var(--line); }
  .rail-list > li:nth-child(even) { border-left:1px solid var(--line); }
  .rail-list > li:nth-child(-n+2) { border-top:0; }
  .guard { grid-template-columns:1fr; padding:18px 18px 18px 24px; }
  .guard-act { grid-column:auto; grid-row:auto; justify-items:start; }
  .guard-facts { grid-template-columns:repeat(2,minmax(0,1fr)); grid-row:auto; }
  .guard-facts > div:nth-child(3) { border-left:0; }
  .guard-facts > div:nth-child(n+3) { border-top:1px solid var(--line); }
  .att-item { grid-template-columns:48px minmax(0,1fr); }
  .att-age { grid-column:2; text-align:left; }
  .att-item .btn { grid-column:2; justify-self:start; }
  .fbar-row { grid-template-columns:minmax(0,1fr) 48px; }
  .fbar-track { grid-column:1/-1; grid-row:2; }
  .fbar-c { grid-column:1/-1; }
}
@media (max-width: 600px) {
  .hide-sm { display:none; }
  /* Tables that can't fit become one labelled card per row (no scripts). */
  .tbl.cards thead { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  .tbl.cards, .tbl.cards tbody, .tbl.cards tr { display:block; width:100%; }
  .tbl.cards tr { padding:12px 16px; border-bottom:1px solid var(--line); }
  .tbl.cards tbody tr:last-child { border-bottom:0; }
  .tbl.cards td { display:flex; justify-content:space-between; align-items:baseline; gap:14px; padding:4px 0; border:0; text-align:right; overflow-wrap:anywhere; }
  .tbl.cards td::before { content:attr(data-label); color:var(--muted); font-size:var(--fs-12); font-weight:600; text-align:left; flex:none; }
  .tbl.cards td:first-child { display:block; text-align:left; padding-bottom:8px; }
  .tbl.cards td:first-child::before, .tbl.cards td[data-label=""]::before { content:none; }
  .tbl.cards td .sub { text-align:right; }
  .tbl.cards td:first-child .sub { text-align:left; }
  .tbl.cards td.hide-sm, .tbl.cards td.hide-md, .tbl.cards td.hide-lg { display:flex; }
  .tbl.cards tbody tr:hover td { background:transparent; }
  .tbl.cards tfoot, .tbl.cards tfoot tr { display:block; } .tbl.cards tfoot tr { padding:10px 14px; } .tbl.cards tfoot td { display:flex; justify-content:space-between; padding:0; } .tbl.cards tfoot td:empty, .tbl.cards tfoot td:last-child:not([class]) { display:none; }
  .page-head h1 { font-size:var(--fs-20); } .actions { width:100%; }
  .grid-2 { grid-template-columns:1fr; }
  .tbl td, .tbl th { padding:9px 10px; }
  .seg span { padding:7px 12px; min-width:0; }
  .q-tiles { grid-template-columns:1fr 1fr; gap:8px; }
  .q-tile-h { display:none; }
  .q-row { grid-template-columns:1fr; grid-template-areas:"id" "state" "qual" "act" "meta"; padding:12px 14px; }
  .q-act { justify-self:start; }
  .rv-step { margin-left:0; }
  .card, fieldset.fs { padding:16px 18px; }
}
@media (max-width: 480px) {
  .ov-verdict { font-size:var(--fs-20); }
  .rail-list { grid-template-columns:1fr; }
  .rail-list > li, .rail-list > li:nth-child(even) { border-left:0; }
  .rail-list > li:nth-child(2) { border-top:1px solid var(--line); }
  .guard-title { font-size:var(--fs-20); }
  .figs { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .figs > div { border-left:1px solid var(--line); border-top:1px solid var(--line); }
  .figs > div:nth-child(odd) { border-left:0; } .figs > div:nth-child(-n+2) { border-top:0; }
  .drawer .nav { grid-template-columns:1fr; }
  .sendbar .sb-note { flex-basis:100%; }
}
@media (prefers-reduced-motion: no-preference) {
  .chip, button, .btn, .attn-item, .nav a, .att-item, a.rail-cell, .dossier-nav a { transition:background-color .14s, border-color .14s, color .14s, box-shadow .14s; }
}

/* Overview polish only: shared pages keep their existing presentation. */
.ov-page { --ov-gap:24px; }
.ov-page .ov-head { margin-bottom:0; }
.ov-page .ov-head h1 { font-size:var(--fs-24); letter-spacing:-.02em; }
.ov-page .ov-verdict { font-size:var(--fs-20); gap:5px 10px; margin-top:10px; }
.ov-page .ov-verdict .v-attention { color:var(--warn); }
.ov-page .ov-meta { font-size:var(--fs-12); margin-top:10px; }
.ov-page > .card { padding:24px 28px; }
.ov-page .card-head { align-items:center; margin-bottom:22px; }
.ov-page .card-head h2 { font-size:var(--fs-16); }
.ov-page .card-head p { margin-top:5px; }
.ov-page .ov-context { margin-top:16px; font-size:var(--fs-12); color:var(--muted); }
.ov-page .ov-context > summary { display:list-item; cursor:pointer; width:fit-content; padding:4px 0; font-weight:600; color:var(--accent); }
.ov-page .ov-context[open] > summary { margin-bottom:12px; }
.ov-page .ov-context > p { color:var(--ink-2); line-height:1.65; max-width:80ch; }
.ov-page .ov-context .fn-cols { margin-top:18px; }
.ov-page .rail { overflow:hidden; box-shadow:var(--e1); }
.ov-page .rail-head { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 22px 14px; border-bottom:1px solid var(--line); }
.ov-page .rail-head h2 { font-size:var(--fs-14); font-weight:650; }
.ov-page .rail-head p { font-size:var(--fs-12); color:var(--muted); margin-top:3px; }
.ov-page .rail-head > a { font-size:var(--fs-12); white-space:nowrap; text-decoration:none; font-weight:600; }
.ov-page .rail-list { background:var(--well); }
.ov-page .rail-list > li { border-left-color:var(--line); }
.ov-page .rail-cell { padding:16px 14px; gap:8px; align-content:start; }
.ov-page .rail-name { letter-spacing:.04em; }
.ov-page .rail-state { font-size:var(--fs-13); font-weight:600; align-items:flex-start; }
.ov-page .rail-state .dot { margin-top:2px; }
.ov-page .rail-list > li.s-verified .rail-state { color:var(--muted); }
.ov-page .rail-list > li.s-attention { background:var(--warn-soft); }
.ov-page .rail-list > li.s-down { background:var(--neg-soft); }
.ov-page .rail-list > li.s-attention .rail-state,.ov-page .rail-list > li.s-down .rail-state { font-weight:700; }
.ov-page .rail-list > li.s-unknown .rail-state { border:0; padding:0; }
.ov-page .rail-list > li.s-unknown .rail-state .dot { border:1px dashed var(--line-2); border-radius:50%; }
.ov-page .rail-context { padding:10px 22px; margin:0; background:var(--surface); border-top:1px solid var(--line); }
.ov-page .rail-context dl { margin:0 0 10px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px 28px; }
.ov-page .rail-context dt { font-weight:650; color:var(--ink); font-size:var(--fs-13); }
.ov-page .rail-context dt span { font-weight:400; color:var(--muted); margin-left:8px; }
.ov-page .rail-context dd { margin:4px 0 0; color:var(--ink-2); overflow-wrap:anywhere; }
.ov-page .guard { gap:16px 24px; padding:22px 26px; grid-template-columns:minmax(240px,1.2fr) minmax(0,1.4fr) auto; }
.ov-page .guard-facts { grid-template-columns:repeat(3,minmax(0,1fr)); }
.ov-page .guard-facts > div { padding:14px; }
.ov-page .guard-title { font-size:var(--fs-20); }
.ov-page .guard-detail { margin-top:8px; }
.ov-page .guard-context { grid-column:1/-1; margin:0; padding-top:8px; border-top:1px solid var(--line); }
.ov-page .guard-last { font-size:var(--fs-12); color:var(--muted); text-align:right; line-height:1.6; }
.ov-page .work-queue { padding:24px; }
.ov-page .work-queue .card-head { margin-bottom:20px; }
.ov-page .att-tier + .att-tier { margin-top:20px; }
.ov-page .att-tier-h { margin-bottom:6px; color:var(--ink-2); letter-spacing:.06em; }
.ov-page .att-list { gap:0; }
.ov-page .att-item { border:0; border-radius:0; border-top:1px solid var(--line); padding:15px 0; grid-template-columns:42px minmax(0,1fr) auto auto; gap:12px; background:transparent; }
.ov-page .att-item:first-child { border-top:0; }
.ov-page .att-item:hover { background:transparent; }
.ov-page .att-n { min-height:38px; border-radius:7px; font-size:var(--fs-20); }
.ov-page .att-title { font-size:var(--fs-14); }
.ov-page .att-why { font-size:var(--fs-13); margin-top:5px; }
.ov-page .att-age { font-size:var(--fs-12); }
.ov-page .att-copy { min-width:0; }
.ov-page .att-context { margin:3px 0 0; }
.ov-page .att-context > summary { padding:2px 0; font-weight:500; }
.ov-page .att-context p { font-size:var(--fs-13); }
.ov-page .att-footnote { font-size:var(--fs-12); color:var(--muted); margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
.ov-page .nba { padding:26px; border-top:1px solid var(--gold); background:var(--surface); }
.ov-page .nba-intro { font-size:var(--fs-12); color:var(--muted); margin-top:22px; }
.ov-page .nba-title { font-size:var(--fs-20); margin-top:5px; line-height:1.35; max-width:25ch; }
.ov-page .nba-what { color:var(--muted); font-size:var(--fs-13); margin-top:8px; }
.ov-page .nba dl { margin:24px 0; gap:22px; }
.ov-page .nba dd { font-size:var(--fs-14); line-height:1.65; margin-top:7px; }
.ov-page .nba-where { padding:12px 14px; border-radius:var(--r-sm); background:var(--well); }
.ov-page .nba-where dd { margin-top:3px; }
.ov-page .nba .btn { width:100%; justify-content:center; min-height:40px; }
.ov-page .acq-summary { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.15fr); gap:32px; }
.ov-page .acq-current dl { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin:16px 0 0; }
.ov-page .acq-current dl > div { border-left:1px solid var(--line); padding-left:14px; }
.ov-page .acq-current dl > div:first-child { border-left:0; padding-left:0; }
.ov-page .acq-current dt { font-size:var(--fs-13); min-height:40px; color:var(--muted); }
.ov-page .acq-current a { text-decoration:none; color:var(--ink-2); }
.ov-page .acq-current a:hover { color:var(--accent); text-decoration:underline; }
.ov-page .acq-current dd { margin:9px 0 0; font-size:var(--fs-24); font-weight:650; font-variant-numeric:tabular-nums; }
.ov-page .acq-performance .fn-h { margin-bottom:16px; }
.ov-page .compact-bars .fbar-row { grid-template-columns:145px minmax(40px,1fr) 40px; gap:12px; }
.ov-page .compact-bars .fbar-c { display:none; }
.ov-page .compact-bars .fbar-track { height:8px; border:0; }
.ov-page .compact-bars .fbar-track > span { min-width:0; }
.ov-page .acq-engagement { display:flex; gap:12px 28px; flex-wrap:wrap; align-items:baseline; padding:14px 0 0; margin-top:22px; border-top:1px solid var(--line); font-size:var(--fs-13); color:var(--ink-2); }
.ov-page .acq-engagement > span:first-child { font-size:var(--fs-12); color:var(--muted); }
.ov-page .acq-engagement b { color:var(--ink); font-weight:650; }
.ov-page .acquisition-context { margin-top:12px; }
.ov-page .figs { background:var(--well); border:0; border-radius:0; gap:20px 16px; }
.ov-page .figs > div { padding:0; border:0; background:transparent; }
.ov-page .figs dd { font-size:var(--fs-20); margin-top:5px; }
.ov-page .feed-day + .feed-day { margin-top:22px; }
.ov-page .feed-day-h { display:flex; gap:10px; align-items:center; margin-bottom:10px; }
.ov-page .feed-day-h span { text-transform:none; letter-spacing:0; font-weight:400; }
.ov-page .feed li { padding:11px 0; border-top:0; position:relative; }
.ov-page .feed li::before { content:""; position:absolute; left:14px; top:40px; bottom:-9px; width:1px; background:var(--line); }
.ov-page .feed li:last-child::before { content:none; }
.ov-page .feed-glyph { border:0; background:transparent; }
.ov-page .event-dot { width:6px; height:6px; border-radius:50%; background:var(--line-2); }
.ov-page .event-key .feed-glyph { background:var(--accent-soft); color:var(--accent); border-radius:8px; }
.ov-page .event-key a { font-weight:650; }
.ov-page .event-routine a { font-weight:500; color:var(--ink-2); }
.ov-page .event-business { font-size:var(--fs-13); color:var(--muted); overflow-wrap:anywhere; }
.ov-page .feed li.event-routine { align-items:center; padding:7px 0; }
.ov-page .feed li.event-routine::before { top:30px; bottom:-7px; }
.ov-page .feed p { margin-top:3px; }
.ov-page .feed time { padding-top:4px; }
@media (max-width:1280px) {
  .ov-page .guard { grid-template-columns:minmax(0,1fr) auto; }
  .ov-page .guard-facts { grid-column:1/-1; grid-row:2; }
  .ov-page .guard-act { grid-column:2; grid-row:1; }
  .ov-page .guard-context { grid-row:3; }
}
@media (max-width:1024px) {
  .ov-page .ov-grid { grid-template-columns:minmax(0,1fr) 280px; gap:20px; }
  .ov-page .work-queue,.ov-page .nba { padding:20px; }
  .ov-page .att-item { grid-template-columns:36px minmax(0,1fr) auto; }
  .ov-page .att-age { grid-column:2; grid-row:2; text-align:left; }
  .ov-page .att-age br { display:none; }
  .ov-page .att-age b { margin-left:5px; }
  .ov-page .att-item .btn { grid-column:3; grid-row:1; }
  .ov-page .acq-summary { grid-template-columns:1fr; gap:24px; }
}
@media (max-width:768px) {
  .ov-page .ov-grid { grid-template-columns:1fr; gap:20px; }
  .ov-page .ov-side { order:-1; }
  .ov-page .nba { padding:20px 24px; }
  .ov-page .nba-intro { margin-top:12px; }
  .ov-page .nba-title { max-width:none; }
  .ov-page .nba dl { margin:18px 0; gap:14px; }
  .ov-page .nba .btn { width:auto; }
  .ov-page .rail-cell { padding:13px 16px; }
  .ov-page .rail-head { padding:14px 16px; }
  .ov-page .rail-context { padding:10px 16px; }
  .ov-page .rail-context dl { grid-template-columns:1fr; }
  .ov-page .guard { grid-template-columns:1fr; padding:20px; }
  .ov-page .guard-facts > div:nth-child(3) { border-left:1px solid var(--line); border-top:0; }
  .ov-page .guard-act { grid-column:1; grid-row:3; display:flex; justify-content:space-between; align-items:center; }
  .ov-page .guard-context { grid-row:4; }
  .ov-page > .card { padding:20px; }
  .ov-page .compact-bars .fbar-track { grid-column:auto; grid-row:auto; }
}
@media (max-width:480px) {
  .ov-page .rail-list { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .ov-page .rail-list > li { border-left:0; border-top:1px solid var(--line); }
  .ov-page .rail-list > li:nth-child(even) { border-left:1px solid var(--line); }
  .ov-page .rail-list > li:nth-child(-n+2) { border-top:0; }
  .ov-page .rail-head p { max-width:24ch; }
  .ov-page .guard-facts > div { padding:12px 9px; }
  .ov-page .guard-facts > div:nth-child(3) { border-left:1px solid var(--line); border-top:0; }
  .ov-page .guard-facts dd b { font-size:var(--fs-16); }
  .ov-page .att-item { grid-template-columns:36px minmax(0,1fr); gap:8px 12px; }
  .ov-page .att-item .btn { grid-column:2; grid-row:3; justify-self:start; }
  .ov-page .compact-bars .fbar-row { grid-template-columns:120px minmax(20px,1fr) 28px; gap:8px; }
  .ov-page .acq-current dl { gap:8px; }
  .ov-page .acq-current dl > div { padding-left:10px; }
  .ov-page .acq-engagement { gap:8px 18px; }
  .ov-page .acq-engagement > span:first-child { width:100%; }
  .ov-page .card-head { align-items:flex-start; gap:12px; }
  .ov-page .card-head .card-link { white-space:normal; text-align:right; }
}
/* =====================================================================
   Complete workspace presentation. Existing forms, state gates and sources
   are unchanged. Native disclosures keep secondary context accessible.
   ===================================================================== */
.pipeline-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:0; background:var(--surface); border:1px solid var(--line); border-radius:9px; box-shadow:var(--e1); margin-bottom:10px; }
.pipeline-summary a { display:grid; gap:6px; padding:18px 20px; color:var(--ink); text-decoration:none; border-left:1px solid var(--line); }
.pipeline-summary a:first-child { border-left:0; }
.pipeline-summary a:hover { background:var(--well); }
.pipeline-summary span { font-size:13px; color:var(--ink-2); font-weight:600; }
.pipeline-summary b { font-size:28px; font-weight:650; line-height:1.2; font-variant-numeric:tabular-nums; }
.pipeline-summary small { font-size:12px; color:var(--muted); }
.pipeline-scope { font-size:12px; color:var(--muted); margin-bottom:20px; }
.q-research-link { text-decoration:none; }
.q-research-link:hover .tag { border-color:var(--accent); }
@media (max-width:600px) {
  .pipeline-summary { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .pipeline-summary a { padding:16px; }
  .pipeline-summary a:nth-child(3) { border-left:0; }
  .pipeline-summary a:nth-child(n+3) { border-top:1px solid var(--line); }
  .pipeline-summary b { font-size:24px; }
}
.aos { --r:9px; --r-lg:12px; }
.aos .wrap { max-width:1540px; }
.aos .side-brand { padding:23px 24px 20px; }
.aos .side .nav { padding:18px 14px; }
.aos .nav-group + .nav-group { margin-top:20px; }
.aos .nav a { min-height:40px; border-radius:6px; }
.aos .nav a[aria-current="page"] { box-shadow:inset 0 0 0 1px rgb(255 255 255 / .07); }
.aos .nav a[aria-current="page"]::before { left:-14px; }
.aos .top-in { min-height:68px; gap:16px; }
.aos .top-context { font-size:12px; }
.aos .global-search { position:relative; min-width:150px; }
.aos .global-search input { padding-right:40px; border-color:transparent; }
.aos .global-search button { position:absolute; right:3px; top:3px; min-height:30px; width:32px; padding:5px; background:transparent; color:var(--muted); box-shadow:none; border:0; }
.aos .global-search button:hover { background:var(--accent-soft); color:var(--accent); }
.aos .sendbar { box-shadow:none; font-size:12px; }
.aos .sendbar > span { padding:7px 9px; }
.aos .foot { border-top:1px solid var(--line); margin:0 32px; padding:18px 0 22px; }
.aos .page-head { padding-bottom:22px; border-bottom:1px solid var(--line); margin-bottom:24px; }
.aos .page-head h1 { font-size:28px; letter-spacing:-.025em; }
.aos .page-head .lede { max-width:64ch; }
.aos .page-head > div:first-child { min-width:0; }
.aos h1 { overflow-wrap:anywhere; }
.aos .crumbs { font-size:12px; margin-bottom:14px; }
.aos .section > h2 { letter-spacing:.04em; }
.aos .card, .aos .cc-card { border-color:var(--line); }
.aos .card-head { gap:16px; }
.aos .card-head > div { min-width:0; }
.aos .card-head h2 { overflow-wrap:anywhere; }
.aos .grid-2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
.aos .grid-2 > *, .aos .filter-row > *, .aos .fields > * { min-width:0; }
.aos button, .aos .btn { border-radius:6px; }
.aos .btn-secondary { background:var(--surface); }
.aos .badge, .aos .tag, .aos .obs, .aos .st:not(.st-do_not_contact) { border-color:color-mix(in srgb,var(--b-fg) 22%,transparent); border-radius:5px; }
.aos .tag { background:var(--well); }
.aos .empty { padding:44px 24px; }
.aos .empty-mark { display:grid; place-items:center; width:44px; height:44px; border-radius:10px; background:var(--well); color:var(--accent); margin:0 auto 16px; }
.aos .empty b { font-size:18px; font-weight:650; }
.aos .empty > span { max-width:55ch; margin:8px auto 0; line-height:1.7; }
.aos .empty .btn { margin-top:4px; }
.aos .chips { gap:3px; padding:4px; background:var(--well); border-radius:8px; }
.aos .chip { border-color:transparent; background:transparent; padding:7px 11px; border-radius:5px; font-weight:500; }
.aos .chip:hover { background:var(--surface); }
.aos .chip[aria-current="true"] { background:var(--surface); color:var(--ink); box-shadow:var(--e1); font-weight:650; border-color:var(--line); }
.aos .chip.attn .n { background:var(--warn-soft); color:var(--warn); border-radius:4px; padding:0 5px; }
.aos .filters { padding:16px 18px; background:var(--surface); box-shadow:none; }
.workspace-search { display:flex; gap:10px; }
.workspace-search input { min-width:0; flex:1; }
.workspace-context, .row-context { font-size:13px; color:var(--muted); }
.workspace-context { margin:16px 0; }
.workspace-context > summary, .row-context > summary, .filter-panel > summary { cursor:pointer; color:var(--accent); font-weight:600; width:fit-content; max-width:100%; padding:6px 0; }
.workspace-context[open] > summary, .row-context[open] > summary { margin-bottom:10px; }
.workspace-context p { max-width:85ch; line-height:1.7; }
.workspace-context p + a { display:inline-block; margin-top:10px; }
.filters .workspace-context { margin:0; }
.row-context { margin-top:8px; font-size:12px; max-width:58ch; }
.row-context > summary { font-weight:500; color:var(--muted); padding:0; }
.row-context[open] { text-align:left; }
.filter-panel { margin:16px 0; border:1px solid var(--line); border-radius:8px; background:var(--surface); }
.filter-panel > summary { padding:12px 18px; font-size:13px; }
.filter-panel .filters { border:0; margin:0; padding-top:4px; }
.workspace-scope { margin-bottom:18px; font-size:12px; color:var(--muted); }
.aos .scroll { max-width:100%; border:1px solid var(--line); border-radius:10px; box-shadow:var(--e1); background:var(--surface); }
.aos .tbl { font-size:13px; }
.aos .tbl th { padding:14px 16px; font-size:12px; letter-spacing:.035em; background:var(--well); }
.aos .tbl td { padding:18px 16px; vertical-align:top; }
.aos .tbl .name { font-size:14px; font-weight:650; color:var(--ink); line-height:1.5; }
.aos .tbl .sub { font-size:12px; margin-top:5px; }
.aos .column-hint { font-weight:400; text-transform:none; letter-spacing:0; }
.aos .tbl .url { color:var(--muted); }
.aos .tbl tbody tr.attn td { background:color-mix(in srgb,var(--warn-soft) 50%,var(--surface)); }
.pipeline-table .tbl { min-width:900px; }
.aos .pipeline-table .tbl th { white-space:normal; padding:14px 12px; }
.aos .pipeline-table .tbl td { padding:16px 12px; }
.pipeline-table .tbl td:first-child { width:23%; min-width:180px; }
.pipeline-table .tbl td:nth-child(5) { min-width:135px; }
.aos .score-cell b { font-size:18px; font-weight:650; }
.aos .q-tile { padding:18px 20px; gap:7px; border-top-width:2px; }
.aos .q-tile-n { font-size:28px; font-weight:650; }
.aos .q-tile-l { font-size:13px; }
.aos .q-tile-h { font-size:12px; line-height:1.5; }
.aos .q-tile.zero { opacity:1; color:var(--muted); border-top-color:var(--line-2); }
.aos .q-tile.zero .q-tile-n { color:var(--muted); }
.aos .q-search { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
.aos .q-group { margin-top:26px; }
.aos .q-group-h { font-size:16px; font-weight:650; }
.aos .q-count { background:var(--well); border:0; }
.aos .q-list { gap:12px; }
.aos .q-row { padding:20px; box-shadow:var(--e1); gap:14px 22px; }
.aos .q-row:hover { background:var(--surface); border-right-color:var(--line-2); }
.aos .q-meta { padding-top:12px; border-top:1px solid var(--line); font-size:12px; }
.aos .q-why { margin-top:8px; line-height:1.6; }
.aos .q-qual .vd { width:fit-content; }
.aos .rv-id { padding:26px; }
.aos .rv-card { border-top-width:2px; padding:24px; }
.aos .rv-strip { border:0; padding:18px 20px; }
.aos .dossier-nav { padding:6px; background:var(--well); border:1px solid var(--line); border-radius:8px; gap:2px; }
.aos .dossier-nav a { padding:8px 12px; }
.aos .ev { box-shadow:var(--e1); }
.aos .ev blockquote { font-size:15px; line-height:1.7; border-left:2px solid var(--accent); padding-left:16px; }
.aos pre.msg { max-width:76ch; padding:8px; line-height:1.8; }
.workflow { margin:24px 0; padding:18px 22px; border:1px solid var(--line); border-radius:9px; background:var(--surface); }
.workflow ol { list-style:none; display:flex; align-items:center; gap:10px; justify-content:space-between; padding:0; margin:0; }
.workflow li { display:flex; gap:10px; align-items:center; font-size:13px; }
.workflow li + li::before { content:"\\203A"; color:var(--muted); }
.workflow a { display:flex; align-items:center; gap:8px; text-decoration:none; color:var(--ink-2); font-weight:600; }
.workflow a:hover { color:var(--accent); }
.workflow a span { display:grid; place-items:center; width:23px; height:23px; border-radius:50%; background:var(--well); font-size:12px; font-weight:500; }
.workflow p { font-size:12px; color:var(--muted); margin-top:14px; }
.aos .o-status { box-shadow:var(--e2); padding:24px 26px; margin-bottom:24px; }
.aos .o-status-l { font-size:24px; }
.aos .o-blockers { padding:14px 18px; }
.aos .o-attn { padding:18px 22px; box-shadow:var(--e1); }
.review-link { display:flex; flex-wrap:wrap; gap:6px 18px; margin:18px 0; font-size:13px; }
.prepare-toolbar { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:14px 24px; padding:22px; background:var(--surface); border:1px solid var(--line); border-bottom:0; border-radius:10px 10px 0 0; }
.prepare-toolbar h2 { font-size:18px; font-weight:650; margin-top:4px; }
.prepare-toolbar > span { flex-basis:100%; }
.records-eligible .scroll { border-radius:0 0 10px 10px; }
.records-eligible .tbl { min-width:740px; }
.records-eligible input[type=checkbox] { width:18px; height:18px; accent-color:var(--accent); }
.records-eligible .tbl td:nth-child(2) { min-width:170px; }
.records-eligible .tbl td:nth-child(3) { max-width:280px; }
.evidence-link { display:block; font-size:12px; margin-top:10px; }
.message-subject { display:block; font-size:13px; margin-top:8px; line-height:1.5; }
.records-messages .tbl { min-width:900px; }
.records-messages .tbl td:first-child { min-width:220px; max-width:350px; }
.records-replies .tbl { min-width:660px; }
.records-replies .tbl td:first-child { width:27%; }
.records-replies .tbl td:nth-child(2) { width:48%; }
.records-replies .tbl td:last-child { min-width:155px; }
.reply-excerpt { font-size:15px; line-height:1.65; margin:10px 0; color:var(--ink); overflow-wrap:anywhere; }
.reply-action { margin-top:12px; }
.inbox-verdict { display:flex; flex-wrap:wrap; gap:6px 18px; padding:16px 20px; border-left:3px solid var(--gold); background:var(--warn-soft); border-radius:6px; margin:18px 0; font-size:13px; }
.inbox-verdict span { color:var(--ink-2); }
.review-guidance { margin:0 0 22px; padding:14px 18px; background:var(--well); border-radius:6px; font-size:13px; color:var(--ink-2); }
.review-records h2 { font-size:18px; }
.review-records form { border-top:1px solid var(--line); padding-top:18px; }
.journey { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:0; margin-bottom:24px; background:var(--surface); border:1px solid var(--line); border-radius:10px; box-shadow:var(--e1); }
.journey a { display:grid; gap:7px; padding:20px; color:var(--ink); text-decoration:none; border-left:1px solid var(--line); }
.journey a:first-child { border-left:0; }
.journey a:hover { background:var(--well); }
.journey strong { font-size:14px; font-weight:650; }
.journey span:last-child { color:var(--muted); font-size:12px; }
.intelligence { padding:26px; }
.intelligence .fbar { gap:20px; margin:28px 0; }
.intelligence .fbar-track { height:10px; border:0; }
.analytics-context { display:grid; grid-template-columns:1fr 1fr; gap:24px; padding-top:18px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); line-height:1.7; }
.metric-details .kpis { margin-top:18px; }
.aos .k-value { overflow-wrap:anywhere; }
.campaign-list { display:grid; gap:22px; }
.campaign-list .card + .card { margin:0; }
.campaign-card { border-top:2px solid var(--accent); padding:24px 28px; }
.campaign-reach { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; padding:16px 0 24px; }
.campaign-reach > b { font-size:32px; font-weight:650; line-height:1; font-variant-numeric:tabular-nums; }
.campaign-reach > span { font-size:13px; color:var(--ink-2); }
.campaign-reach .campaign-sample { margin-left:auto; font-size:12px; color:var(--muted); }
.campaign-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); margin:0; padding:20px 0; background:var(--well); border-radius:6px; }
.campaign-metrics > div { padding:0 20px; border-left:1px solid var(--line); }
.campaign-metrics > div:first-child { border-left:0; }
.campaign-metrics dt { font-size:12px; color:var(--muted); }
.campaign-metrics dd { font-size:24px; font-weight:650; margin:6px 0 0; font-variant-numeric:tabular-nums; }
.campaign-card .workspace-context { margin-bottom:0; }
.health-verdict { display:flex; flex-wrap:wrap; gap:6px 18px; margin-bottom:20px; padding:16px 20px; background:var(--well); border-radius:8px; border-left:3px solid var(--line-2); }
.health-verdict.has-issues { border-left-color:var(--gold); }
.health-verdict span { font-size:13px; color:var(--muted); }
.service-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
.service-card { display:flex; flex-direction:column; padding:20px; background:var(--surface); border:1px solid var(--line); border-radius:9px; box-shadow:var(--e1); min-width:0; }
.service-card header { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; }
.service-card h2 { font-size:16px; font-weight:650; }
.service-state { display:flex; align-items:center; gap:5px; font-size:12px; color:var(--muted); }
.service-card p { font-size:13px; line-height:1.65; color:var(--ink-2); margin:14px 0 18px; overflow-wrap:anywhere; }
.service-card > a { margin-top:auto; font-size:12px; font-weight:600; text-decoration:none; }
.service-card.s-attention { border-top:3px solid var(--gold); }
.service-card.s-down { border-top:3px solid var(--neg); background:var(--neg-soft); }
.service-card.s-attention .service-state { color:var(--warn); }
.service-card.s-down .service-state { color:var(--neg); }
.service-card.s-unknown .dot { border:1px dashed var(--line-2); border-radius:50%; }
.health-guard { margin-top:24px; }
.coverage-list { display:grid; gap:16px; margin:0; }
.coverage-list dt { font-size:13px; font-weight:600; }
.coverage-list dd { margin:4px 0 0; font-size:13px; color:var(--muted); line-height:1.65; }
.readiness-list { margin:0; padding-left:18px; color:var(--ink-2); font-size:13px; }
.readiness-list li + li { margin-top:10px; }
.activity-toolbar { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px; margin-bottom:20px; }
.activity-toolbar > span { font-size:12px; color:var(--muted); }
.activity-stream { padding:26px 30px; }
.activity-stream .feed-day + .feed-day { margin-top:28px; }
.activity-stream .feed-day-h { display:flex; gap:12px; padding-bottom:12px; border-bottom:1px solid var(--line); }
.activity-stream .feed-day-h span { font-weight:400; }
.activity-stream .feed li { padding:15px 0; border:0; }
.activity-stream .event-key .feed-glyph { background:var(--accent-soft); color:var(--accent); border:0; }
.activity-stream .event-routine .feed-glyph { background:transparent; border:0; }
.activity-stream .event-routine a { font-weight:500; color:var(--ink-2); font-size:13px; }
.activity-stream .event-business { color:var(--muted); font-size:13px; }
.activity-stream .event-dot { width:6px; height:6px; border-radius:50%; background:var(--line-2); }
.activity-stream .feed time { padding-top:4px; }
/* Compact, useful Overview first viewport; detailed context stays in disclosures. */
.aos .ov-head { border-bottom:1px solid var(--line); padding-bottom:22px; }
.aos .ov-head h1 { font-size:28px; }
.aos .ov-page .rail-head { padding:12px 20px; }
.aos .ov-page .rail-cell { padding:12px; gap:6px; }
.aos .ov-page .rail-context { padding:6px 20px; }
.aos .ov-page .nba-intro { margin-top:16px; }
.aos .ov-page .nba dl { gap:16px; margin:20px 0; }
.aos .ov-page .nba-title { font-size:22px; }
@media (min-width:1101px) {
  .aos .ov-page .guard { grid-template-columns:minmax(200px,1fr) minmax(0,1.4fr) auto; gap:14px 20px; padding:20px 24px; }
  .aos .ov-page .guard-facts { grid-column:auto; grid-row:auto; }
  .aos .ov-page .guard-act { grid-column:auto; grid-row:auto; }
  .aos .ov-page .guard-facts > div { padding:12px 10px; }
}
@media (max-width:1280px) {
  .aos .top-context .sep, .aos .top-context { white-space:normal; }
  .aos .top-context { max-width:120px; }
  .aos .global-search { width:180px; }
  .aos .q-row { grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) auto; grid-template-areas:"id state act" "qual qual qual" "meta meta meta"; }
  .aos .q-qual { display:flex; align-items:center; gap:12px; }
  .service-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .workflow ol { flex-wrap:wrap; justify-content:flex-start; gap:12px 18px; }
  .campaign-metrics > div { padding:0 14px; }
}
@media (max-width:1024px) {
  .aos .top-in { padding:12px 22px; flex-wrap:wrap; }
  .aos .top-context { max-width:none; }
  .aos .global-search { flex:1; max-width:280px; }
  .aos .sendbar { margin-left:auto; }
  .aos .wrap { padding:26px 22px 40px; }
  .aos .q-tile { padding:16px 14px; }
  .aos .grid-2 { grid-template-columns:1fr; }
  .journey { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .journey a:nth-child(3) { border-left:0; }
  .journey a:nth-child(n+3) { border-top:1px solid var(--line); }
  .campaign-metrics { grid-template-columns:repeat(3,minmax(0,1fr)); gap:20px 0; }
  .campaign-metrics > div:nth-child(4) { border-left:0; }
  .analytics-context { grid-template-columns:1fr; gap:12px; }
}
@media (max-width:768px) {
  .aos .top-in { padding:10px 16px; gap:10px; }
  .aos .top-context { display:none; }
  .aos .global-search { max-width:none; }
  .aos .wrap { padding:22px 16px 36px; }
  .aos .page-head h1, .aos .ov-head h1 { font-size:24px; }
  .aos .foot { margin:0 16px; }
  .aos .page-head { gap:18px; padding-bottom:20px; }
  .aos .chips { flex-wrap:nowrap; overflow-x:auto; max-width:100%; padding:5px; scrollbar-width:thin; }
  .aos .chip { flex:none; }
  .aos .q-row { grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"id act" "state state" "qual qual" "meta meta"; }
  .aos .q-tile { padding:16px; }
  .service-card { padding:18px; }
  .activity-stream { padding:20px; }
  .aos .card-head { flex-wrap:wrap; }
  .aos .card-head .card-link { white-space:normal; }
  .aos .drawer .nav a { min-height:42px; }
}
@media (max-width:600px) {
  .aos .tbl.cards { min-width:0; }
  .aos .tbl.cards tr { padding:18px; }
  .aos .tbl.cards td { display:block; text-align:left; padding:8px 0; width:auto; max-width:none; min-width:0; }
  .aos .tbl.cards td::before { display:block; margin-bottom:4px; }
  .aos .tbl.cards td .sub { text-align:left; }
  .aos .tbl.cards td:first-child { padding-bottom:12px; }
  .aos .tbl.cards td:has(.score-cell) { text-align:left; }
  .records-eligible .tbl.cards td:first-child { display:flex; align-items:center; gap:12px; }
  .records-eligible .tbl.cards td:first-child::before { display:block; content:"Select prospect"; }
  .aos .q-row { padding:18px; grid-template-columns:1fr; grid-template-areas:"id" "state" "qual" "act" "meta"; }
  .aos .q-act { justify-self:start; }
  .aos .q-act .btn, .aos .q-act button { min-height:42px; }
  .aos .q-qual { flex-wrap:wrap; }
  .aos .q-tile-h { display:block; }
  .aos .q-tile-n { font-size:24px; }
  .aos .filters { padding:14px; }
  .aos .filter-row { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .aos .filter-actions { grid-column:1/-1; flex-wrap:wrap; }
  .aos input, .aos select, .aos textarea { max-width:100%; }
  .aos .row > div { min-width:0 !important; max-width:100%; }
  .aos .q-search-row { flex-wrap:wrap; }
  .aos .q-search-row .search { flex-basis:100%; }
  .aos .o-status { padding:20px; }
  .aos .o-status-l { font-size:20px; }
  .prepare-toolbar { padding:18px; }
  .prepare-toolbar button { width:100%; }
  .workflow { padding:16px; }
  .workflow ol { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
  .workflow li + li::before { content:none; }
  .service-grid { grid-template-columns:1fr; }
  .campaign-card { padding:20px; }
  .campaign-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .campaign-metrics > div:nth-child(odd) { border-left:0; }
  .campaign-metrics > div:nth-child(even) { border-left:1px solid var(--line); }
  .campaign-reach .campaign-sample { margin-left:0; flex-basis:100%; }
  .journey a { padding:16px; }
  .intelligence { padding:20px; }
  .aos .rv-id, .aos .rv-card { padding:20px; }
  .aos .rv-facts { display:grid; gap:14px; }
  .aos .rv-facts li { align-items:baseline; }
  .aos .rv-facts .k { width:100%; }
  .aos .rv-nav { font-size:13px; }
  .aos .activity-stream .feed li { gap:10px; }
}
@media (max-width:480px) {
  .aos .q-tiles { gap:10px; }
  .aos .q-tile { padding:14px; }
  .aos .q-tile-h { font-size:12px; }
  .aos .result-line { align-items:flex-start; }
  .aos .workspace-search { flex-wrap:wrap; }
  .aos .workspace-search input { flex-basis:100%; }
  .aos .page-head .actions .btn { min-height:40px; }
  .aos .empty { padding:32px 12px; }
  .aos .filter-row { grid-template-columns:1fr; }
  .aos .fields { grid-template-columns:1fr; }
  .aos .disc-sum { font-size:12px; }
  .activity-stream .event-business { display:block; }
}
/* Insights + System polish. Deliberately scoped away from approved workspaces. */
[data-workspace="funnel"] .funnel-summary { display:flex; justify-content:space-between; align-items:center; gap:20px; margin:0 0 24px; padding:22px 24px; background:var(--well); border-radius:8px; }
[data-workspace="funnel"] .funnel-summary p { margin:6px 0; }
[data-workspace="funnel"] .funnel-summary strong { font-size:26px; font-weight:650; font-variant-numeric:tabular-nums; margin-right:5px; }
[data-workspace="funnel"] .funnel-summary span { font-size:12px; color:var(--muted); }
[data-workspace="funnel"] .funnel-summary > a { font-size:13px; flex-shrink:0; }
[data-workspace="funnel"] #activity th { white-space:normal; }
[data-workspace="funnel"] #activity th, [data-workspace="funnel"] #activity td { padding-left:12px; padding-right:12px; }
[data-workspace="funnel"] .journey { margin-top:18px; }
[data-workspace="campaigns"] .campaign-card { border-top:1px solid var(--line); }
[data-workspace="campaigns"] .card-head h2, [data-workspace="campaigns"] .card-head p { overflow-wrap:anywhere; }
[data-workspace="campaigns"] .campaign-observations { display:grid; grid-template-columns:3fr 2fr; gap:24px; }
[data-workspace="campaigns"] .campaign-observations h3 { margin:0 0 10px; font-size:13px; font-weight:650; }
[data-workspace="campaigns"] .campaign-observations p { font-size:12px; color:var(--muted); line-height:1.6; margin:10px 0 0; }
[data-workspace="campaigns"] .campaign-metrics { grid-template-columns:repeat(3,minmax(0,1fr)); gap:0; }
[data-workspace="campaigns"] .campaign-observations section:last-child .campaign-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
[data-workspace="campaigns"] .campaign-metrics > div { padding:0 14px; border-left:1px solid var(--line); }
[data-workspace="campaigns"] .campaign-metrics > div:first-child { border-left:0; }
[data-workspace="campaigns"] .campaign-attention { margin-top:22px; border-left:3px solid var(--gold); background:var(--well); padding:14px 18px; font-size:13px; }
[data-workspace="campaigns"] .campaign-attention p { margin:6px 0 10px; color:var(--ink-2); }
[data-workspace="health"] .health-verdict { margin-bottom:10px; }
[data-workspace="health"] .health-checked { margin:0 0 24px; font-size:12px; color:var(--muted); }
[data-workspace="health"] .health-group { margin:24px 0; }
[data-workspace="health"] .health-group > header { margin-bottom:14px; }
[data-workspace="health"] .health-group > header h2 { font-size:16px; font-weight:650; margin:0; }
[data-workspace="health"] .health-group > header p { color:var(--muted); font-size:13px; margin:5px 0 0; }
[data-workspace="health"] .service-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
[data-workspace="health"] .service-card h3 { margin:0; font-size:15px; font-weight:650; }
[data-workspace="health"] .service-card.s-verified, [data-workspace="health"] .service-card.s-off, [data-workspace="health"] .service-card.s-recent { background:var(--well); box-shadow:none; }
[data-workspace="health"] .service-card.s-verified p { margin-bottom:0; }
[data-workspace="health"] .service-card.s-unknown { box-shadow:none; border-style:dashed; }
[data-workspace="activity"] .audit-day + .audit-day { margin-top:30px; }
[data-workspace="activity"] .audit-day h3 { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; margin:20px 0 0; padding:0 0 12px; border-bottom:1px solid var(--line); font-size:14px; }
[data-workspace="activity"] .audit-day h3 span { font-size:12px; color:var(--muted); font-weight:400; }
[data-workspace="activity"] .audit-events { list-style:none; margin:0; padding:0; }
[data-workspace="activity"] .audit-events li { display:grid; grid-template-columns:84px minmax(0,1fr) auto; align-items:start; gap:18px; padding:18px 0; border-bottom:1px solid var(--line); }
[data-workspace="activity"] .audit-events li:last-child { border-bottom:0; }
[data-workspace="activity"] .audit-kind { font-size:12px; color:var(--muted); padding-top:2px; }
[data-workspace="activity"] .audit-record a { font-size:14px; font-weight:600; text-decoration:none; }
[data-workspace="activity"] .audit-record p { font-size:13px; margin:5px 0 0; color:var(--ink-2); overflow-wrap:anywhere; }
[data-workspace="activity"] .audit-events time { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; text-align:right; }
[data-workspace="activity"] .audit-events time span { display:block; margin-top:4px; }
[data-workspace="activity"] .audit-test { display:inline-block; margin-top:7px; font-size:12px; color:var(--muted); border:1px dashed var(--line-2); border-radius:4px; padding:2px 6px; }
@media (max-width:1024px) {
  [data-workspace="campaigns"] .campaign-observations { grid-template-columns:1fr; gap:20px; }
}
@media (max-width:600px) {
  [data-workspace="funnel"] .funnel-summary { align-items:flex-start; flex-direction:column; gap:14px; padding:20px; }
  [data-workspace="health"] .service-grid { grid-template-columns:1fr; }
  [data-workspace="activity"] .audit-events li { grid-template-columns:minmax(0,1fr) auto; gap:5px 14px; }
  [data-workspace="activity"] .audit-kind { grid-column:1; }
  [data-workspace="activity"] .audit-record { grid-column:1; grid-row:2; }
  [data-workspace="activity"] .audit-events time { grid-column:2; grid-row:1 / span 2; }
}
`;
