/*
 * The admin stylesheet. One inline <style> block, because the admin CSP
 * allows only inline styles (default-src 'none'; style-src 'unsafe-inline')
 * and the admin ships no scripts or external assets.
 *
 * Meaning is never carried by color alone: every badge also has a text label
 * and a leading glyph (added with ::before, so screen readers read the text),
 * and the pipeline stages differ in shape as well as shade.
 */
export const STYLE = `
:root {
  color-scheme: light dark;
  --bg:#f3f5f9; --surface:#ffffff; --surface-2:#f7f9fc; --ink:#0f1f33; --ink-2:#34445a; --muted:#64748b;
  --line:#e3e8ef; --line-2:#cbd5e1;
  --navy:#0c253b; --navy-2:#16344f; --amber:#d9901a;
  --accent:#0b6b8a; --accent-soft:#e1f1f6; --on-accent:#ffffff;
  --pos:#0f766e; --pos-soft:#dcf3ef;
  --warn:#9a5b00; --warn-soft:#fdf1dc;
  --neg:#b42318; --neg-soft:#fde9e7;
  --info:#1d4ed8; --info-soft:#e4ecfd;
  --btn:#0c253b; --on-btn:#ffffff; --on-go:#ffffff; --on-neg:#ffffff;
  --radius:8px; --shadow:0 1px 2px rgba(15,31,51,.06);
  --ring:#0b6b8a;
}
@media (prefers-color-scheme: dark) { :root {
  --bg:#09111b; --surface:#101b29; --surface-2:#0c1621; --ink:#e8eef6; --ink-2:#c2cedc; --muted:#8c9db2;
  --line:#1e2d40; --line-2:#2d4058;
  --accent:#4cc2e8; --accent-soft:#12303d; --on-accent:#06202b;
  --pos:#4fd1b5; --pos-soft:#0f2f2b;
  --warn:#f2b24a; --warn-soft:#33260e;
  --neg:#ff8a7d; --neg-soft:#3a1814;
  --info:#8fb0ff; --info-soft:#15254a;
  --btn:#e8eef6; --on-btn:#0c253b; --on-go:#04211b; --on-neg:#2a0905;
  --shadow:none; --ring:#4cc2e8;
} }

* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--ink); }
a { color:var(--accent); text-underline-offset:2px; }
a:hover { text-decoration-thickness:2px; }
:focus-visible { outline:2px solid var(--ring); outline-offset:2px; border-radius:3px; }
h1,h2,h3,p { margin:0; }
code { font:12px ui-monospace,SFMono-Regular,Consolas,monospace; background:var(--surface-2); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
.muted { color:var(--muted); } .small { font-size:13px; } .num { text-align:right; font-variant-numeric:tabular-nums; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.skip { position:absolute; left:8px; top:-48px; background:var(--btn); color:var(--on-btn); padding:8px 12px; border-radius:6px; z-index:10; }
.skip:focus { top:8px; }

/* ---------- app shell ---------- */
.appbar { background:var(--navy); color:#e8eef6; border-bottom:3px solid var(--amber); }
.appbar-in { max-width:1240px; margin:0 auto; padding:0 20px; display:flex; align-items:center; gap:28px; min-height:52px; flex-wrap:wrap; }
.brand { display:flex; align-items:center; padding:12px 0; border-radius:4px; }
.brand svg { display:block; height:24px; width:auto; }
.nav { display:flex; gap:4px; flex:1; flex-wrap:wrap; }
.nav a { color:#b8c6d8; text-decoration:none; font-weight:600; font-size:13.5px; padding:16px 12px 13px; border-bottom:3px solid transparent; margin-bottom:-3px; }
.nav a:hover { color:#fff; }
.nav a[aria-current="page"] { color:#fff; border-bottom-color:#fff; }
.appbar form { margin:0; }
.appbar .btn-quiet { background:transparent; color:#b8c6d8; border:1px solid #2c4764; }
.appbar .btn-quiet:hover { color:#fff; border-color:#5b7a9b; }
.appbar :focus-visible { outline-color:#8fd3ee; }
.wrap { max-width:1240px; margin:0 auto; padding:24px 20px 64px; }

/* ---------- page structure ---------- */
.crumbs { font-size:13px; color:var(--muted); margin-bottom:10px; }
.crumbs a { color:var(--muted); } .crumbs span[aria-current] { color:var(--ink-2); }
.page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:20px; }
.page-head h1 { font-size:26px; line-height:1.25; font-weight:650; letter-spacing:-.01em; }
.lede { color:var(--ink-2); margin-top:6px; max-width:75ch; font-size:15.5px; }
.actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.section { margin-top:36px; }
.section > h2 { font-size:12.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:0 0 10px; display:flex; align-items:baseline; gap:10px; }
.section > h2 .aside { text-transform:none; letter-spacing:0; font-weight:400; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:16px 18px; box-shadow:var(--shadow); }
.card + .card { margin-top:14px; }
.card-h { font-size:12px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); margin-bottom:8px; }
.grid-2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:14px; align-items:stretch; }
.grid-2 > .card + .card { margin-top:0; }
.stack > * + * { margin-top:14px; }
.row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.spread { justify-content:space-between; }

/* ---------- notices ---------- */
.notice { border:1px solid var(--pos); background:var(--pos-soft); color:var(--ink); border-left-width:4px; border-radius:var(--radius); padding:10px 14px; margin-bottom:16px; font-weight:600; }
.errbox { border:1px solid var(--neg); background:var(--neg-soft); border-left-width:4px; border-radius:var(--radius); padding:12px 16px; margin-bottom:18px; }
.errbox b { color:var(--neg); } .errbox ul { margin:6px 0 0; padding-left:18px; } .errbox li { margin:2px 0; } .errbox a { color:var(--ink); }
.callout { border:1px solid var(--line-2); background:var(--surface-2); border-left:4px solid var(--info); border-radius:var(--radius); padding:10px 14px; font-size:13px; }
.callout.warn { border-left-color:var(--amber); }

/* ---------- badges: text + glyph + shape, never color alone ---------- */
.st, .pill, .obs, .tag { display:inline-flex; align-items:center; gap:5px; font-size:12.5px; font-weight:600; line-height:1.3; padding:2px 8px; border-radius:5px; border:1px solid var(--line-2); background:var(--surface); color:var(--ink-2); white-space:nowrap; vertical-align:middle; }
.st::before, .pill::before, .obs::before { font-size:11px; line-height:1; }
/* pipeline stage: the glyph fills as the prospect advances */
.st-new::before { content:"\\25CB"; } .st-qualified::before { content:"\\25D4"; } .st-ready_to_contact::before { content:"\\25D1"; }
.st-contacted::before { content:"\\25D5"; } .st-engaged::before { content:"\\25CF"; } .st-customer::before { content:"\\2713"; }
.st-qualified, .st-contacted { border-color:var(--info); color:var(--info); background:var(--info-soft); }
.st-ready_to_contact, .st-engaged, .st-customer { border-color:var(--pos); color:var(--pos); background:var(--pos-soft); }
.st-customer { font-weight:700; }
.st-not_a_fit::before { content:"\\2715"; } .st-not_a_fit { color:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; }
.st-archived::before { content:"\\25AB"; } .st-archived { color:var(--muted); border-style:dashed; }
.st-do_not_contact::before { content:"\\2298"; font-size:13px; } .st-do_not_contact { border:2px solid var(--neg); color:var(--neg); background:var(--neg-soft); font-weight:700; }
.st-meeting::before { content:"\\25C9"; } .st-proposal::before { content:"\\25C8"; } .st-meeting, .st-proposal { border-color:var(--pos); color:var(--pos); background:var(--pos-soft); }
.st-lost::before { content:"\\2717"; } .st-lost { color:var(--muted); border-style:dashed; }
/* outreach message states */
.os-draft::before { content:"\\270E"; } .os-draft { border-style:dashed; }
.os-queued::before { content:"\\25F7"; } .os-sent::before { content:"\\2192"; } .os-queued, .os-sent { border-color:var(--info); color:var(--info); background:var(--info-soft); }
.os-delivered::before { content:"\\2713"; } .os-replied::before { content:"\\21A9"; } .os-delivered, .os-replied { border-color:var(--pos); color:var(--pos); background:var(--pos-soft); } .os-replied { font-weight:700; }
.os-bounced::before { content:"\\2715"; } .os-failed::before { content:"!"; font-weight:800; } .os-bounced, .os-failed { border-color:var(--neg); color:var(--neg); background:var(--neg-soft); }
.os-cancelled::before { content:"\\2014"; } .os-cancelled { color:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; }
pre.msg { margin:0; white-space:pre-wrap; word-break:break-word; font:inherit; font-size:14px; line-height:1.55; }
/* discovery states */
.cs-discovered::before { content:"\\25CB"; } .cs-researching::before { content:"\\25D4"; } .cs-researched::before { content:"\\25D1"; }
.cs-researching { border-color:var(--info); color:var(--info); background:var(--info-soft); } .cs-researched { border-color:var(--pos); color:var(--pos); background:var(--pos-soft); }
.cs-needs_review::before { content:"!"; font-weight:800; } .cs-needs_review { border:2px solid var(--amber); color:var(--warn); background:var(--warn-soft); font-weight:700; }
.cs-approved::before { content:"\\2713"; } .cs-approved { border-color:var(--pos); color:var(--pos); background:var(--pos-soft); font-weight:700; }
.cs-rejected::before { content:"\\2715"; } .cs-rejected { color:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; }
.cs-duplicate::before { content:"\\2261"; } .cs-duplicate { color:var(--muted); border-style:dashed; text-decoration:line-through; text-decoration-thickness:1px; }
/* qualification: required criteria only */
.q-meets_criteria::before { content:"\\2713"; } .q-meets_criteria { border-color:var(--pos); color:var(--pos); background:var(--pos-soft); }
.q-unverified::before { content:"?"; font-weight:800; } .q-unverified { border-style:dashed; color:var(--ink-2); }
.q-disqualified::before { content:"\\2715"; } .q-disqualified { border-color:var(--neg); color:var(--neg); background:var(--neg-soft); }
/* opportunity band: a ranking, deliberately a different (blue) family from qualification */
.pill::before { content:"\\25B2"; } .pill { border-color:var(--accent); background:var(--accent); color:var(--on-accent); }
.band-high::before { content:"\\25B2"; } .band-medium::before { content:"\\25C6"; } .band-low::before { content:"\\25BD"; }
.band-medium { background:var(--accent-soft); color:var(--accent); } .band-low { background:var(--surface-2); color:var(--muted); border-color:var(--line-2); }
/* observed signal value: Unknown is a normal state, not an error */
.obs-yes::before { content:"\\2713"; } .obs-yes { border-color:var(--pos); color:var(--pos); background:var(--pos-soft); }
.obs-no::before { content:"\\2715"; } .obs-no { color:var(--ink-2); background:var(--surface-2); }
.obs-unknown::before { content:"?"; font-weight:800; } .obs-unknown { border-style:dashed; color:var(--muted); background:transparent; font-weight:500; }
.tag { font-weight:500; font-size:11.5px; padding:1px 6px; color:var(--ink-2); background:var(--surface-2); }
.kind { font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; padding:1px 6px; border-radius:4px; border:1px solid var(--line-2); color:var(--muted); white-space:nowrap; }
.kind.req { color:var(--info); border-color:var(--info); background:var(--info-soft); }

/* ---------- buttons ---------- */
button, .btn { white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:34px; padding:6px 14px; border:1px solid var(--btn); border-radius:6px; background:var(--btn); color:var(--on-btn); font:inherit; font-weight:600; font-size:13.5px; cursor:pointer; text-decoration:none; }
button:hover, .btn:hover { filter:brightness(1.12); text-decoration:none; }
.btn-secondary, button.btn-secondary { background:var(--surface); color:var(--ink); border-color:var(--line-2); }
.btn-secondary:hover { background:var(--surface-2); filter:none; }
.btn-danger, button.btn-danger { background:var(--surface); color:var(--neg); border-color:var(--neg); }
.btn-danger:hover { background:var(--neg-soft); filter:none; }
.btn-primary-lg { min-height:40px; padding:8px 18px; }
button.link { min-height:0; padding:0; border:0; background:none; color:var(--neg); font-weight:600; font-size:12px; text-decoration:underline; }
.inline-form { display:inline; margin:0; }

/* ---------- KPIs and metrics ---------- */
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
.kpi { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:12px 14px; box-shadow:var(--shadow); }
.kpi .k-label { font-size:12px; color:var(--muted); font-weight:600; }
.kpi .k-value { font-size:26px; line-height:1.15; font-weight:650; font-variant-numeric:tabular-nums; margin-top:2px; }
.kpi .k-hint { font-size:12px; color:var(--muted); margin-top:2px; }
dl.metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:10px; margin:0; }
dl.metrics > div { border:1px solid var(--line); border-radius:6px; padding:8px 10px; background:var(--surface-2); }
dl.metrics dt { font-size:11.5px; color:var(--muted); font-weight:600; }
dl.metrics dd { margin:0; font-size:20px; font-weight:650; font-variant-numeric:tabular-nums; }
dl.metrics .m-sample { background:transparent; border-style:dashed; } dl.metrics .m-sample dd { font-size:16px; font-weight:500; color:var(--muted); }
dl.kv { display:grid; grid-template-columns:110px 1fr; gap:10px 14px; margin:0; }
dl.kv dt { color:var(--muted); font-size:12.5px; font-weight:600; padding-top:1px; }
dl.kv dd { margin:0; overflow-wrap:anywhere; min-width:0; }
.src { font-size:13px; color:var(--muted); margin-top:2px; }
.url { display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom; }

/* qualification / opportunity cards */
.verdict { border-top:3px solid var(--line-2); }
.verdict.v-meets_criteria { border-top-color:var(--pos); } .verdict.v-disqualified { border-top-color:var(--neg); } .verdict.v-unverified { border-top-style:dashed; }
.verdict.v-score { border-top-color:var(--accent); }
.v-label { font-size:12px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
.v-sub { font-size:12.5px; color:var(--muted); margin-top:1px; }
.v-big { font-size:22px; font-weight:700; margin:8px 0 6px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.v-big .big { font-size:34px; line-height:1; font-weight:700; font-variant-numeric:tabular-nums; }
.v-big .q-big { font-size:16px; padding:5px 12px; }
.v-big .pill { font-size:13px; padding:3px 10px; }

/* ---------- tables ---------- */
.scroll { position:relative; overflow-x:auto; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); }
table.tbl { width:100%; border-collapse:collapse; }
.tbl th { text-align:left; font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); background:var(--surface-2); padding:9px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
.tbl td { padding:12px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
.tbl tbody tr:last-child td { border-bottom:0; }
.tbl tbody tr:hover td { background:var(--surface-2); }
.tbl th.num { text-align:right; }
.tbl .name { font-weight:650; color:var(--ink); text-decoration:none; font-size:14.5px; }
.tbl .name:hover { color:var(--accent); text-decoration:underline; }
.tbl tr.attn td:first-child { box-shadow:inset 3px 0 0 var(--amber); }
.tbl tr.hl td { background:var(--accent-soft); }
.tbl tr.zero td { color:var(--muted); }
.tbl td .sub { font-size:13px; color:var(--muted); margin-top:1px; overflow-wrap:anywhere; }
.tbl td .sub a, .src a { color:var(--muted); text-decoration:none; } .tbl td .sub a:hover, .src a:hover { color:var(--accent); text-decoration:underline; }
.score-cell { white-space:nowrap; } .score-cell b { font-size:15px; font-variant-numeric:tabular-nums; } .score-cell .of { color:var(--muted); font-size:12px; }
.tbl tfoot td { background:var(--surface-2); border-top:1px solid var(--line); font-weight:650; }

/* ---------- filters ---------- */
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
.chip { display:inline-flex; align-items:center; gap:6px; padding:7px 14px; border:1px solid var(--line-2); border-radius:999px; background:var(--surface); color:var(--ink-2); text-decoration:none; font-size:14px; font-weight:600; }
.chip:hover { border-color:var(--ink-2); text-decoration:none; }
.chip .n { color:var(--muted); font-weight:500; font-variant-numeric:tabular-nums; }
.chip[aria-current="true"] { background:var(--btn); color:var(--on-btn); border-color:var(--btn); } .chip[aria-current="true"] .n { color:inherit; opacity:.75; }
.chip.attn { border-color:var(--amber); }
.filters { display:grid; gap:12px; }
.filters .search { width:100%; }
.filter-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; align-items:end; }
.filter-actions { display:flex; gap:8px; align-items:center; align-self:end; }
.result-line { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:14px 0 8px; font-size:13px; color:var(--muted); }

/* ---------- forms ---------- */
label.lbl, .field > label { display:block; font-size:12.5px; font-weight:600; color:var(--ink-2); margin-bottom:4px; }
input[type=text], input[type=password], input[type=search], select, textarea { width:100%; min-height:36px; padding:7px 10px; border:1px solid var(--line-2); border-radius:6px; background:var(--surface); color:var(--ink); font:inherit; }
textarea { min-height:84px; resize:vertical; }
input[readonly] { background:var(--surface-2); font:12px ui-monospace,Consolas,monospace; }
input:hover, select:hover, textarea:hover { border-color:var(--muted); }
input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"] { border-color:var(--neg); box-shadow:inset 3px 0 0 var(--neg); }
.hint { font-size:13px; color:var(--muted); margin-top:3px; }
.ferr { font-size:12.5px; color:var(--neg); font-weight:600; margin-top:4px; display:flex; gap:5px; }
.ferr::before { content:"\\2715"; font-size:11px; padding-top:2px; }
.fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px; }
.fields .wide { grid-column:1/-1; }
fieldset.fs { border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); padding:16px 18px 18px; margin:0; box-shadow:var(--shadow); min-width:0; }
fieldset.fs > legend { float:left; width:100%; padding:0; margin:0 0 12px; font-weight:650; font-size:15px; display:flex; align-items:center; gap:10px; }
fieldset.fs > legend + * { clear:both; }
.step-n { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:50%; background:var(--navy); color:#fff; font-size:12px; font-weight:700; }
.fs-note { font-size:13px; color:var(--muted); margin:-4px 0 12px; }
.form-foot { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }

/* signal rows */
.sig { border:1px solid var(--line); border-radius:var(--radius); background:var(--surface-2); padding:12px 14px; }
.sig + .sig { margin-top:10px; }
.sig.req { border-left:4px solid var(--info); background:var(--surface); }
.sig-h { display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap; }
.sig-name { font-weight:700; letter-spacing:.01em; }
.sig-pts { font-weight:700; font-variant-numeric:tabular-nums; color:var(--ink-2); }
.sig-q { font-size:13px; color:var(--ink-2); margin:3px 0 10px; }
.sig-foot { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-top:10px; }
.seg-group { display:inline-flex; border:1px solid var(--line-2); border-radius:6px; overflow:hidden; background:var(--surface); }
.seg { position:relative; display:block; margin:0; }
.seg input { position:absolute; inset:0; opacity:0; margin:0; cursor:pointer; width:100%; height:100%; }
.seg span { display:block; padding:6px 16px; font-size:13px; font-weight:600; color:var(--ink-2); border-left:1px solid var(--line-2); cursor:pointer; min-width:84px; text-align:center; }
.seg:first-child span { border-left:0; }
.seg input:checked + span::before { content:"\\2713\\00a0"; }
.seg-yes input:checked + span { background:var(--pos); color:#fff; }
.seg-no input:checked + span { background:var(--ink-2); color:var(--surface); }
.seg-unknown input:checked + span { background:var(--surface-2); color:var(--ink); box-shadow:inset 0 0 0 2px var(--line-2); }
.seg input:focus-visible + span { outline:2px solid var(--ring); outline-offset:-3px; }
.seg input:disabled + span { opacity:.45; cursor:not-allowed; }
.seg:hover input:not(:disabled):not(:checked) + span { background:var(--surface-2); }
details.rules summary { cursor:pointer; color:var(--accent); font-size:12.5px; font-weight:600; }
details.rules dl { margin-top:8px; }

/* ---------- pipeline stepper ---------- */
ol.steps { display:flex; flex-wrap:wrap; gap:6px; list-style:none; margin:0 0 14px; padding:0; }
ol.steps li { display:flex; align-items:center; gap:6px; padding:5px 11px; border:1px solid var(--line-2); border-radius:999px; font-size:12.5px; font-weight:600; color:var(--muted); background:var(--surface); }
ol.steps li.done { color:var(--ink-2); background:var(--surface-2); } ol.steps li.done::before { content:"\\2713"; }
ol.steps li.now { background:var(--btn); color:var(--on-btn); border-color:var(--btn); } ol.steps li.now::before { content:"\\25B6"; font-size:9px; }
ol.steps li.next::before { content:"\\25CB"; }

/* ---------- evidence, notes, timeline ---------- */
.ev { border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:6px; background:var(--surface); padding:10px 14px; }
.ev + .ev { margin-top:10px; }
.ev blockquote { margin:6px 0; padding:0; font-size:14px; }
.ev .meta { display:flex; gap:10px; flex-wrap:wrap; align-items:center; font-size:12px; color:var(--muted); }
.note { border-bottom:1px solid var(--line); padding:10px 0; } .note:last-child { border-bottom:0; } .note .when { font-size:12px; color:var(--muted); } .note .body { white-space:pre-wrap; }
ul.timeline { list-style:none; margin:10px 0 0; padding:0; border-left:2px solid var(--line); }
ul.timeline li { position:relative; padding:0 0 10px 16px; font-size:13px; } ul.timeline li::before { content:""; position:absolute; left:-6px; top:6px; width:10px; height:10px; border-radius:50%; background:var(--surface); border:2px solid var(--line-2); }
ul.timeline .when { font-size:12px; color:var(--muted); display:block; }
.empty { text-align:center; padding:28px 16px; color:var(--muted); }
.empty b { display:block; color:var(--ink-2); font-size:14.5px; margin-bottom:2px; }
ul.plain { margin:6px 0 0; padding-left:18px; } ul.plain li { margin:5px 0; }
.attn-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
.attn-item { display:flex; align-items:center; gap:12px; padding:10px 14px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); text-decoration:none; color:var(--ink); box-shadow:var(--shadow); }
.attn-item:hover { border-color:var(--accent); text-decoration:none; }
.attn-item b { font-size:22px; font-variant-numeric:tabular-nums; min-width:28px; } .attn-item span { color:var(--ink-2); font-size:13px; }
.attn-item.zero { opacity:.6; }

/* ---------- Discovery work queue: what needs attention, why, and the one next action ---------- */
.q-head { margin-bottom:18px; }
.q-head .lede b { color:var(--ink); }
.q-tiles { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:22px; }
.q-tile { display:grid; gap:2px; padding:14px 16px; border:1px solid var(--line); border-top:3px solid var(--line-2); border-radius:12px; background:var(--surface); color:var(--ink); text-decoration:none; box-shadow:var(--shadow); }
.q-tile:hover { border-color:var(--line-2); background:var(--surface-2); text-decoration:none; }
.q-tile.t-warn { border-top-color:var(--amber); } .q-tile.t-pos { border-top-color:var(--pos); } .q-tile.t-info { border-top-color:var(--info); }
.q-tile[aria-current="true"] { box-shadow:inset 0 0 0 2px var(--ring); }
.q-tile-n { font-size:30px; line-height:1.1; font-weight:750; font-variant-numeric:tabular-nums; }
.q-tile-l { font-size:15px; font-weight:650; }
.q-tile.t-warn .q-tile-l span { color:var(--warn); } .q-tile.t-pos .q-tile-l span { color:var(--pos); } .q-tile.t-info .q-tile-l span { color:var(--info); }
.q-tile-h { font-size:13px; color:var(--muted); }
.q-tile.zero .q-tile-n { color:var(--muted); }
/* Outreach: is mail going out, and if not, why. Tone, glyph, and words together. */
.o-status { display:flex; flex-wrap:wrap; gap:14px 24px; align-items:flex-start; justify-content:space-between; padding:16px 20px; margin-bottom:16px; border:1px solid var(--line); border-left:5px solid var(--line-2); border-radius:12px; background:var(--surface); box-shadow:var(--shadow); }
.o-status.t-pos { border-left-color:var(--pos); } .o-status.t-warn { border-left-color:var(--amber); } .o-status.t-neg { border-left-color:var(--neg); }
.o-status-main { flex:1 1 320px; min-width:0; }
.o-status-l { margin:0; font-size:22px; font-weight:750; line-height:1.25; }
.o-status.t-pos .o-status-l span { color:var(--pos); } .o-status.t-warn .o-status-l span { color:var(--warn); } .o-status.t-neg .o-status-l span { color:var(--neg); } .o-status.t-quiet .o-status-l span { color:var(--muted); }
.o-status-d { margin:4px 0 6px; font-size:15px; }
.o-status-act { flex:0 1 auto; }
.o-blockers { flex-basis:100%; padding:10px 14px; border-radius:10px; background:var(--surface-2); font-size:14px; }
.o-blockers p { margin:0; } .o-blockers ul { margin:4px 0 0; padding-left:20px; } .o-blockers li { margin:2px 0; }
.o-attn { padding:12px 16px; border:1px solid var(--line); border-left:4px solid var(--amber); border-radius:10px; background:var(--surface); }
.o-attn.t-neg { border-left-color:var(--neg); }
.o-attn.t-pos { border-left-color:var(--pos); } .o-attn.t-pos h3 > span:first-child { color:var(--pos); }
.o-attn h3 { margin:0; font-size:16px; display:flex; align-items:baseline; gap:8px; }
.o-attn.t-warn h3 > span:first-child { color:var(--warn); } .o-attn.t-neg h3 > span:first-child { color:var(--neg); }
.o-attn ul { margin:0; padding-left:20px; font-size:14.5px; } .o-attn li { margin:3px 0; }
details.o-why { margin-top:12px; } details.o-why > summary { cursor:pointer; color:var(--muted); font-size:13.5px; font-weight:600; width:max-content; max-width:100%; }
details.o-why > summary:hover { color:var(--accent); } details.o-why ul { margin:8px 0 0; padding-left:20px; }
.q-chips { margin-bottom:12px; }
.q-search { margin-bottom:14px; }
.q-search-row { display:flex; gap:8px; align-items:center; }
.q-search-row .search { flex:1; min-height:40px; font-size:15px; }
details.q-more { margin-top:8px; }
details.q-more > summary { cursor:pointer; color:var(--muted); font-size:13.5px; font-weight:600; width:max-content; }
details.q-more > summary:hover { color:var(--accent); }
details.q-more[open] > .filter-row { margin-top:10px; padding:14px; border:1px solid var(--line); border-radius:10px; background:var(--surface); }
.q-batch { display:flex; flex-wrap:wrap; gap:10px 18px; align-items:center; justify-content:space-between; padding:12px 16px; margin-bottom:14px; border:1px solid var(--line); border-left:3px solid var(--info); border-radius:10px; background:var(--surface-2); font-size:14px; }
.q-group { margin-top:22px; }
.q-group-h { font-size:18px; font-weight:700; display:flex; align-items:baseline; gap:8px; }
.q-count { font-size:13px; font-weight:700; color:var(--muted); padding:1px 9px; border:1px solid var(--line-2); border-radius:999px; font-variant-numeric:tabular-nums; }
.q-hint { color:var(--muted); font-size:14px; margin:2px 0 10px; }
.q-list { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.q-row { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,1.6fr) minmax(150px,.75fr) auto; grid-template-areas:"id state qual act" "meta meta meta meta"; gap:6px 20px; align-items:center; padding:14px 18px; background:var(--surface); border:1px solid var(--line); border-left:3px solid var(--line-2); border-radius:10px; }
.q-row.t-warn { border-left-color:var(--amber); } .q-row.t-neg { border-left-color:var(--neg); } .q-row.t-pos { border-left-color:var(--pos); } .q-row.t-info { border-left-color:var(--info); }
.q-row:hover { background:var(--surface-2); }
.q-id { grid-area:id; min-width:0; }
.q-name { margin:0; font-size:16.5px; font-weight:700; line-height:1.3; overflow-wrap:anywhere; }
.q-name a { color:var(--ink); text-decoration:none; } .q-name a:hover { color:var(--accent); text-decoration:underline; }
.q-where { font-size:13.5px; color:var(--muted); margin-top:2px; overflow-wrap:anywhere; }
.q-where a { color:var(--muted); }
.q-state { grid-area:state; min-width:0; }
.q-why { margin:4px 0 0; font-size:14px; color:var(--ink-2); }
.q-qual { grid-area:qual; display:grid; gap:2px; }
.q-k { font-size:11.5px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
.q-qual .vd.sub { font-size:14px; }
.q-act { grid-area:act; justify-self:end; }
.q-act .btn, .q-act button { min-height:38px; }
.q-wait { font-size:14px; color:var(--info); font-weight:600; white-space:nowrap; }
.q-meta { grid-area:meta; display:flex; flex-wrap:wrap; gap:4px 8px; align-items:center; font-size:13px; color:var(--ink-2); }
.q-dot { color:var(--line-2); }
.q-handled { margin-top:28px; }
.q-handled .q-row { background:transparent; }
/* candidate page: where you are in the queue */
.rv-nav { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; margin-bottom:14px; font-size:14px; }
.rv-back { font-weight:600; color:var(--ink-2); text-decoration:none; } .rv-back:hover { color:var(--accent); text-decoration:underline; }
.rv-pos { color:var(--muted); }
.rv-step { margin-left:auto; display:flex; gap:6px; }
@media (max-width: 1024px) {
  .q-tiles { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .q-row { grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"id act" "state state" "qual qual" "meta meta"; }
  .q-qual { grid-auto-flow:column; justify-content:start; align-items:baseline; gap:8px; }
}
@media (max-width: 600px) {
  .q-tiles { grid-template-columns:1fr 1fr; gap:8px; }
  .q-tile-h { display:none; }
  .q-row { grid-template-columns:1fr; grid-template-areas:"id" "state" "qual" "act" "meta"; padding:12px 14px; }
  .q-act { justify-self:start; }
  .rv-step { margin-left:0; }
}

/* ---------- review page: identity -> duplicate -> qualification -> decision ---------- */
/* Verdicts carry a glyph and words as well as a tone: green go, amber look, red stop, blue information. */
.vd { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:700; line-height:1.3; padding:3px 10px; border-radius:999px; border:1px solid currentColor; white-space:nowrap; vertical-align:middle; }
.vd-pos { color:var(--pos); background:var(--pos-soft); } .vd-warn { color:var(--warn); background:var(--warn-soft); }
.vd-neg { color:var(--neg); background:var(--neg-soft); } .vd-info { color:var(--info); background:var(--info-soft); }
.vd-quiet { color:var(--muted); background:transparent; border-style:dashed; }
.vd.lg { font-size:17px; padding:6px 14px; gap:8px; }
/* A supporting mark next to a fact: tone, glyph, and words, without a filled pill. */
.vd.sub { font-size:12px; font-weight:600; padding:0; gap:4px; border:0; background:transparent; }
.rv { display:grid; gap:14px; }
.rv-id, .rv-card { background:var(--surface); border:1px solid var(--line); border-radius:12px; box-shadow:var(--shadow); }
.rv-id { padding:20px 22px; }
.rv-eyebrow { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; font-size:12.5px; color:var(--muted); }
.rv-eyebrow a { margin-left:auto; color:var(--muted); }
.rv-id h1 { font-size:30px; line-height:1.15; font-weight:750; letter-spacing:-.02em; margin:8px 0 4px; overflow-wrap:anywhere; }
.rv-addr { font-size:15px; color:var(--ink-2); }
.rv-facts { list-style:none; margin:14px 0 0; padding:0; display:flex; flex-wrap:wrap; gap:10px 26px; font-size:14.5px; }
.rv-facts li { display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap; }
.rv-facts .k { font-size:11.5px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
.rv-issues { list-style:none; margin:16px 0 0; padding:0; display:grid; gap:6px; }
.rv-issues li { display:flex; gap:10px; align-items:baseline; font-size:13.5px; padding:8px 12px; border-radius:8px; background:var(--surface-2); border-left:3px solid var(--line-2); }
.rv-issues li.t-warn { border-left-color:var(--amber); } .rv-issues li.t-warn > span:first-child { color:var(--warn); }
.rv-issues li.t-neg { border-left-color:var(--neg); } .rv-issues li.t-neg > span:first-child { color:var(--neg); }
.rv-issues li.t-info { border-left-color:var(--info); } .rv-issues li.t-info > span:first-child { color:var(--info); }
.rv-card { padding:18px 20px; border-top-width:3px; }
.rv-card.t-pos { border-top-color:var(--pos); } .rv-card.t-warn { border-top-color:var(--amber); } .rv-card.t-neg { border-top-color:var(--neg); } .rv-card.t-quiet { border-top-style:dashed; }
.rv-h { font-size:12px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.rv-q { font-size:13.5px; color:var(--ink-2); margin-top:2px; }
.rv-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:14px; align-items:stretch; }
.rv-result { margin:14px 0 4px; }
.rv-why { font-size:13.5px; color:var(--ink-2); margin-top:8px; }
.rv-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:flex-start; margin-top:16px; }
.crit { list-style:none; margin:14px 0 6px; padding:0; display:grid; gap:8px; }
.crit li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; align-items:center; padding:10px 12px; border-radius:8px; background:var(--surface-2); }
.crit .cname { font-size:15.5px; font-weight:650; }
.crit .cev { grid-column:1/-1; font-size:12.5px; color:var(--muted); overflow-wrap:anywhere; }
.crit .cev .src { display:inline; }
.rv-blockers { list-style:none; margin:10px 0 0; padding:0; display:grid; gap:6px; font-size:13.5px; }
.rv-blockers li::before { content:"\\26A0\\00a0"; color:var(--warn); }
/* the duplicate question */
.rv-dup { border-top-color:var(--amber); }
.rv-dup-head { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px 24px; align-items:flex-start; }
.rv-dup-head h2 { margin:0; }
.rv-reason { font-size:14px; text-align:right; }
.rv-k { display:block; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--info); margin-bottom:2px; }
.rv-dup-done { padding:12px 18px; }
.cmp-wrap { overflow-x:auto; margin-top:14px; border:1px solid var(--line); border-radius:8px; }
.cmp { width:100%; border-collapse:collapse; font-size:14px; }
.cmp th, .cmp td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
.cmp tbody tr:last-child th, .cmp tbody tr:last-child td { border-bottom:0; }
.cmp thead th { font-size:11.5px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); background:var(--surface-2); white-space:nowrap; }
.cmp thead th a { text-transform:none; letter-spacing:0; font-weight:600; margin-left:6px; }
.cmp tbody th { width:96px; font-size:12.5px; font-weight:600; color:var(--muted); }
.cmp td.diff { background:var(--warn-soft); }
.cmp .eq, .cmp .ne { font-size:11.5px; font-weight:700; white-space:nowrap; }
.cmp .eq { color:var(--pos); } .cmp .ne { color:var(--warn); }
/* buttons by weight: one filled primary, outlined secondary, red destructive, quiet neutral */
.btn-go, button.btn-go { background:var(--pos); border-color:var(--pos); color:var(--on-go); min-height:40px; padding:8px 18px; font-size:14.5px; }
.btn-ghost, button.btn-ghost { background:transparent; color:var(--ink-2); border-color:transparent; }
.btn-ghost:hover { background:var(--surface-2); border-color:var(--line-2); filter:none; }
/* Destructive as the primary action (outside the category, or doesn't qualify). */
.btn-stop, button.btn-stop { background:var(--neg); border-color:var(--neg); color:var(--on-neg); min-height:40px; padding:8px 18px; font-size:14.5px; }
details.rv-disregard { display:inline-block; }
details.rv-disregard > summary { list-style:none; }
details.rv-disregard > summary::-webkit-details-marker { display:none; }
details.rv-disregard[open] { display:block; flex-basis:100%; }
.rv-reason-form { margin-top:10px; padding:12px; border:1px solid var(--line); border-radius:8px; background:var(--surface-2); }
/* research, secondary */
.rv-strip { display:flex; flex-wrap:wrap; gap:10px 32px; align-items:flex-end; padding:12px 16px; border:1px solid var(--line); border-radius:10px; background:var(--surface-2); font-size:13.5px; color:var(--ink-2); }
.rv-strip > div:last-child { margin-left:auto; }
.rv-score { font-size:18px; color:var(--ink); font-variant-numeric:tabular-nums; }
.rv-more { margin:30px 0 10px; font-size:12px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
details.disc { border:1px solid var(--line); border-radius:10px; background:var(--surface); }
details.disc + details.disc { margin-top:8px; }
details.disc > summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:10px; }
details.disc > summary::-webkit-details-marker { display:none; }
details.disc > summary::before { content:"\\25B8"; color:var(--muted); display:inline-block; width:12px; font-size:15px; line-height:1; }
details.disc[open] > summary::before { content:"\\25BE"; }
details.disc > summary h2 { margin:0; font-size:14.5px; font-weight:650; color:var(--ink); }
details.disc > summary:hover h2 { color:var(--accent); }
details.disc > summary:hover { background:var(--surface-2); }
.disc-sum { margin-left:auto; font-size:12.5px; color:var(--muted); text-align:right; }
.disc-body { padding:4px 16px 16px; }
@media (max-width: 860px) {
  .rv-grid { grid-template-columns:1fr; }
  .rv-id h1 { font-size:24px; }
  .rv-reason { text-align:left; }
  .rv-strip > div:last-child { margin-left:0; }
}

/* ---------- login ---------- */
body.login { background:var(--navy); min-height:100vh; display:grid; place-items:center; padding:24px; }
.login-wrap { width:100%; max-width:380px; display:grid; gap:26px; justify-items:center; }
.login-logo svg { display:block; width:min(100%, 330px); height:auto; }
.login-card { width:100%; max-width:380px; background:var(--surface); border-radius:10px; padding:28px; border-top:4px solid var(--amber); box-shadow:0 10px 30px rgba(0,0,0,.35); }
.login-card h1 { font-size:20px; margin:0 0 4px; }
.login-card form { display:grid; gap:14px; margin-top:16px; }

/* ---------- responsive: tables drop secondary columns instead of overflowing ---------- */
@media (max-width: 1024px) { .hide-lg { display:none; } }
@media (max-width: 860px) {
  .hide-md { display:none; }
  .appbar-in { gap:12px; } .appbar form { margin-left:auto; } .nav { order:3; flex-basis:100%; margin:0 -12px; } .nav a { padding:10px 12px 9px; }
  dl.kv { grid-template-columns:96px 1fr; }
}
@media (max-width: 600px) {
  .hide-sm { display:none; }
  /* Tables that can't fit become one labelled card per row (no scripts). */
  .tbl.cards thead { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  .tbl.cards, .tbl.cards tbody, .tbl.cards tr { display:block; width:100%; }
  .tbl.cards tr { padding:10px 14px; border-bottom:1px solid var(--line); }
  .tbl.cards tbody tr:last-child { border-bottom:0; }
  .tbl.cards td { display:flex; justify-content:space-between; align-items:baseline; gap:14px; padding:3px 0; border:0; text-align:right; }
  .tbl.cards td::before { content:attr(data-label); color:var(--muted); font-size:12px; font-weight:600; text-align:left; flex:none; }
  .tbl.cards td:first-child { display:block; text-align:left; padding-bottom:6px; }
  .tbl.cards td:first-child::before, .tbl.cards td[data-label=""]::before { content:none; }
  .tbl.cards td .sub { text-align:right; }
  .tbl.cards td:first-child .sub { text-align:left; }
  .tbl.cards td.hide-sm, .tbl.cards td.hide-md, .tbl.cards td.hide-lg { display:flex; }
  .tbl.cards tbody tr:hover td { background:transparent; }
  .tbl.cards tfoot, .tbl.cards tfoot tr { display:block; } .tbl.cards tfoot tr { padding:10px 14px; } .tbl.cards tfoot td { display:flex; justify-content:space-between; padding:0; } .tbl.cards tfoot td:empty, .tbl.cards tfoot td:last-child:not([class]) { display:none; }
  .wrap { padding:16px 14px 48px; }
  .page-head h1 { font-size:20px; } .actions { width:100%; }
  .grid-2 { grid-template-columns:1fr; }
  .tbl td, .tbl th { padding:9px 10px; }
  .seg span { padding:7px 12px; min-width:0; }
}
@media (prefers-reduced-motion: no-preference) { .chip, button, .btn, .attn-item { transition:background-color .12s, border-color .12s, filter .12s; } }
`;
