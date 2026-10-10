import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { demoAnalysis, DEMO_DATE } from "../lib/demoReport";
import { buildOpportunitiesCsv } from "../lib/exportCsv";
import { buildSummaryText } from "../lib/summaryText";
import { detectColumns } from "../lib/normalize";
import { moneyFormat } from "../lib/format";
import { analyze } from "../lib/analyze";
import UploadPanel from "../components/UploadPanel";
import ProductDemo from "../components/ProductDemo";
import Dashboard from "../components/Dashboard";
import OpportunityList from "../components/OpportunityList";
import ColumnMapper from "../components/ColumnMapper";
import EmptyResult from "../components/EmptyResult";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import type { Analysis } from "../lib/types";

const noop = () => undefined;
test("the footer quietly identifies the builder with only the approved identity copy", () => {
  const html = renderToStaticMarkup(<SiteFooter />);
  assert.match(html, /<footer class="site-footer">/);
  const identity = [...html.matchAll(/<p>([^<]+)<\/p>/g)]
    .map((match) => match[1])
    .filter((text) => text.startsWith("Built independently") || text.startsWith("ReclaimBay was built"));
  assert.deepEqual(identity, [
    "Built independently by Alessandro Vannelli.",
    "ReclaimBay was built to help independent repair shops take a second look at declined work.",
  ]);
  assert.doesNotMatch(html, /<section\b|<a\b|<button\b|tabindex|aria-hidden|mailto:|testimonial|credential|years of experience|guarantee|recovered revenue|LinkedIn|integration/i);
});
test("the demonstration reconciles its six source jobs through the actual scanner pipeline", () => {
  const { table, analysis } = demoAnalysis();
  assert.equal(analysis.count, 6);
  assert.equal(analysis.total.toFixed(2), "4327.48");
  assert.equal(analysis.quality.skippedRows, 0);
  assert.equal(analysis.quality.confirmedDuplicateRows, 0);
  assert.equal(analysis.ranked[0].service, "Timing belt and water pump");
  assert.equal(detectColumns(table).confident, true);
  assert.equal(analysis.ranked.reduce((total, job) => total + job.amount, 0), analysis.total);
  assert.equal(buildOpportunitiesCsv(analysis.ranked).split("\r\n").length, table.rows.length + 1);
});
test("homepage has one headline, direct upload path, real sample total and truthful boundaries", () => {
  const html = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /Find the value/);
  assert.match(html, /href="#scan"/);
  assert.match(html, /id="scan"/);
  assert.match(html, /accept=".csv,.xlsx"/);
  assert.match(html, /\$4,327.48/);
  assert.match(html, /Fictional data/);
  assert.match(html, /not recovered revenue/);
  assert.match(html, /does not track recovered revenue or contact your customers/);
});
test("product demo offers named, keyboard-native source/evidence interactions", () => {
  const html = renderToStaticMarkup(<ProductDemo onOpen={noop} />);
  assert.match(html, /aria-label="Demonstration view"/);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /<details\b/);
  assert.equal((html.match(/class="demo-job"/g) ?? []).length, 3);
  assert.equal((html.match(/aria-controls=/g) ?? []).length, 3);
  assert.match(html, /role="region" aria-label="Selected opportunity evidence" aria-live="polite"/);
  assert.equal((html.match(/data-active="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-hidden="true" inert=""/g) ?? []).length, 3);
  assert.match(html, /Why it appears/);
  assert.match(html, /Report reference/);
  assert.match(html, /JAC-001/);
  assert.match(html, /Open full report/);
});
test("how it works describes opening the export locally, never sending it to ReclaimBay", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  const start = home.indexOf('<section id="how-it-works"');
  const method = home.slice(start, home.indexOf("</section>", start));
  assert.match(method, /<h2>Choose your export<\/h2>/);
  assert.match(method, /Open a CSV or Excel export of the declined or deferred work your shop already tracks\./);
  assert.doesNotMatch(method, /Give us your export|Upload a CSV/);
});
test("how it works leads straight into where the numbers come from, with no separate review-list preview", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  const method = home.indexOf('<section id="how-it-works"');
  const next = home.indexOf("<section", home.indexOf("</section>", method));
  assert.ok(method >= 0);
  assert.equal(home.indexOf('<section class="evidence-story"'), next);
  assert.doesNotMatch(home, /Your report becomes a|What you get|review-sheet/);
});
test("the page explains, then reassures, then asks: how it works, evidence, privacy and FAQ, the one upload area, the close", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  const at = (marker: string) => { const i = home.indexOf(marker); assert.ok(i >= 0, marker); return i; };
  const order = ['id="how-it-works"', 'class="evidence-story"', 'id="privacy"', 'class="home-faq"', 'id="scan"', 'class="home-close"'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal((home.match(/id="scan"/g) ?? []).length, 1);
  assert.equal((home.match(/type="file"/g) ?? []).length, 1);
  assert.equal((home.match(/href="#scan"/g) ?? []).length, 1, "the hero leads to it; nothing below it points back up");
});
test("evidence traces one opportunity to its JAC-004 source row without repeating the review list", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />).replace(/<!-- -->/g, "");
  const start = home.indexOf('<section class="evidence-story"');
  const evidence = home.slice(start, home.indexOf("</section>", start));
  assert.match(evidence, /Every opportunity has <em>a source\.<\/em>/);
  assert.match(evidence, /ReclaimBay ties each included opportunity back to the row it came from, so you can inspect the original details before deciding what deserves a second look\./);
  assert.match(evidence, /Front brake pads and rotors[\s\S]*\$612\.50[\s\S]*Source row JAC-004/);
  assert.match(evidence, /<dt>Estimate Total<\/dt><dd>612\.5<\/dd>/);
  assert.match(evidence, /This is reported declined work, not recovered revenue\./);
  assert.doesNotMatch(evidence, /4,327\.48|opportunities to review|JAC-00[1-3]|verified/i);
});
test("privacy states only what the code does: local reading and exports, no account, honest analytics", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  const start = home.indexOf('<section id="privacy"');
  const privacy = home.slice(start, home.indexOf("</section>", start));
  assert.match(privacy, /Your report stays <em>yours\.<\/em>/);
  assert.match(privacy, /Your file is read in your browser and is not uploaded to ReclaimBay’s servers for analysis\./);
  for (const fact of ["Local", "Private", "Exports", "No account"]) assert.match(privacy, new RegExp(`<dt>${fact}</dt>`));
  assert.match(privacy, /PDF and CSV files are made locally\./);
  assert.match(privacy, /may collect basic usage analytics[\s\S]*never include your report’s contents/);
  assert.equal((privacy.match(/<details>/g) ?? []).length, 5);
  assert.doesNotMatch(privacy, /<details open|SOC ?2|HIPAA|GDPR|encrypt|bank-level|military|certif|zero data|nothing leaves/i);
});
test("FAQ asks the practical questions in a first-visit order, all closed, without an account question", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  const faq = home.slice(home.indexOf('<div class="home-faq">'), home.indexOf("</section>", home.indexOf('<div class="home-faq">')));
  assert.deepEqual([...faq.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]), [
    "What file types can I use?",
    "Does my report leave my computer?",
    "What does ReclaimBay remember?",
    "How are the numbers calculated?",
    "Does this show recovered revenue?",
  ]);
  assert.equal((faq.match(/<details>/g) ?? []).length, 5);
  assert.match(faq, /Use a CSV or Excel \(\.xlsx\) export, up to 15 MB\. Each job needs a service description and an amount\. Older \.xls files need to be re-saved as \.xlsx or CSV\./);
  assert.match(faq, /No\. Your report is read and analyzed in your browser and is not sent to ReclaimBay’s servers for analysis\. Basic site analytics may still be collected, but they do not include your report’s contents\./);
  assert.match(faq, /Not your report\.[\s\S]*Your report itself is not stored\./);
  assert.match(faq, /The reported value is the total of the readable, positive declined amounts in your report\./);
  assert.doesNotMatch(faq, /account|predict|guarantee|AI\b|nothing leaves/i);
});
test("cost is stated as it is today, without implying a pricing model", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  assert.match(home, /Free analysis\. No account needed\./);
  assert.doesNotMatch(home, /get started|free forever|always free|pricing|per month|credit card|trial/i);
  const invite = readFileSync(new URL("../components/InvitationExperience.tsx", import.meta.url), "utf8");
  assert.match(invite, /Start a free analysis/);
  assert.doesNotMatch(invite, /Get started free/);
});
test("the upload area is the page's one action; the close after it is a statement, not another control", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  assert.equal((home.match(/class="upload-section"/g) ?? []).length, 1);
  const upload = home.indexOf('id="scan"');
  const closeAt = home.indexOf('<div class="home-close">');
  assert.ok(upload >= 0 && closeAt > upload, "the close follows the upload area");
  const close = home.slice(closeAt);
  assert.match(close, /Ready to take <em>a second look\?<\/em>/);
  assert.match(close, /Bring your declined or deferred-work export and see which jobs are worth reviewing\./);
  assert.doesNotMatch(close, /<a\b|<button|tabindex|Analyze my report|recover|revenue|losing|No account|stays on your device/i);
});
test("the upload area says column names can differ, and offers the contact form for choosing an export", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  const upload = home.slice(home.indexOf('id="scan"'), home.indexOf('<div class="home-close">'));
  assert.doesNotMatch(home, /Unusual headers|Match the columns before analyzing/);
  // The hint keeps its place under the upload actions; only "Talk to ReclaimBay" is interactive, and it's the shared contact form.
  const help = /<p class="upload-hint">Different column names are fine\. You&#x27;ll match them in the next step\.<\/p><p>Not sure which report to export\? <button type="button" aria-haspopup="dialog"[^>]*>Talk to ReclaimBay<\/button><\/p>/;
  assert.match(upload, help);
  assert.ok(upload.indexOf(">Analyze my report</button>") < upload.indexOf(">See an example</button>"));
  assert.ok(upload.indexOf(">See an example</button>") < upload.search(help));
  assert.match(upload, /<h3><span class="upload-desktop-instruction">Drop your report here<\/span><span class="upload-mobile-instruction">Export on your shop computer\? Try the example first\.<\/span><\/h3><p>CSV or XLSX · Up to 15 MB<\/p>/);
  assert.equal((upload.match(/<button\b/g) ?? []).length, 3, "Analyze my report, See an example, Talk to ReclaimBay");
  assert.doesNotMatch(upload, /mailto:|<a\b|<form\b/);
  const source = readFileSync(new URL("../components/UploadPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /<ContactLink unstyled label="Talk to ReclaimBay"/);
  assert.doesNotMatch(source, /ContactDialog/);
  const newCopy = upload.match(help)![0].replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(newCopy, /system|integrat|support|AI\b|automatic|any export|all shop|guarantee|recover|revenue|free|pric|sample/i);
});
test("touch upload guidance uses semantic text, with only the appropriate instruction exposed", () => {
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  const upload = home.slice(home.indexOf('id="scan"'), home.indexOf('<div class="home-close">'));
  assert.equal((upload.match(/>Analyze my report<\/button>/g) ?? []).length, 1);
  assert.equal((upload.match(/>See an example<\/button>/g) ?? []).length, 1);
  assert.match(upload, /<input[^>]*type="file"[^>]*accept=".csv,.xlsx"[^>]*tabindex="-1" aria-hidden="true"/);
  assert.doesNotMatch(upload, /aria-label=|mailto:/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.upload-mobile-instruction\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)\s*\{\s*\.upload-desktop-instruction\s*\{\s*display:\s*none;\s*\}\s*\.upload-mobile-instruction\s*\{\s*display:\s*block;\s*text-wrap:\s*balance;\s*\}\s*\}/);
});
test("mapping still labels every control and blocks a scan without the required fields", () => {
  const { table } = demoAnalysis();
  const html = renderToStaticMarkup(<ColumnMapper table={table} initial={{}} remembered={0} error={null} onConfirm={noop} onCancel={noop} />);
  assert.match(html, /for="map-amount"/);
  assert.match(html, /for="map-service"/);
  assert.match(html, /id="map-amount"/);
  assert.match(html, /id="map-service"/);
  assert.match(html, /disabled=""/);
});
test("upload errors are announced, file actions are blocked while reading", () => {
  const html = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy error="Synthetic invalid report" />);
  assert.match(html, /role="alert"/);
  assert.match(html, /Synthetic invalid report/);
  assert.match(html, /Reviewing your report/);
  assert.match(html, /disabled=""/);
});
test("results expose total, real report details, next step and complete local exports", () => {
  const { analysis, table } = demoAnalysis();
  const html = renderToStaticMarkup(<Dashboard analysis={analysis} fileName={table.fileName} isSample analyzedAt={DEMO_DATE} onReset={noop} />);
  assert.match(html, /Reported declined value to review/);
  assert.match(html, /\$4,327.48/);
  assert.match(html, /made-up data/);
  assert.match(html, /View source evidence/);
  assert.match(html, /current job status and customer interest have not been verified/);
  assert.match(html, /Start with a job worth revisiting/);
  assert.match(html, /Download PDF/);
  assert.match(html, /Download CSV/);
  const summary = buildSummaryText({ analysis, fileName: table.fileName, isSample: true, analyzedAt: DEMO_DATE });
  assert.match(summary, /SAMPLE REPORT/);
  assert.match(summary, /Reported declined value: \$4,327.48/);
  assert.match(summary, /Recovery is not tracked/);
});
test("missing source details are stated plainly and imported text stays escaped", () => {
  const { analysis } = demoAnalysis();
  const job = { ...analysis.highest, service: '<script>alert("fixture")</script>', customer: undefined, vehicle: undefined, date: undefined, ageDays: undefined };
  const html = renderToStaticMarkup(<OpportunityList items={[job]} format={moneyFormat(true)} hasDates={false} undatedCount={1} />);
  assert.match(html, /Not provided or unreadable/);
  assert.match(html, /Not provided/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
test("empty reports retain remapping and reset instead of claiming a zero-value audit", () => {
  const html = renderToStaticMarkup(<EmptyResult fileName="fixture.csv" rowCount={2} amountHeader="Amount" onReset={noop} onRemap={noop} />);
  assert.match(html, /No declined-work opportunities found/);
  assert.match(html, /Choose a different amount column/);
  assert.match(html, /2 rows were read/);
});
test("no-date results omit date breakdowns while preserving all other opportunities", () => {
  const { analysis } = demoAnalysis();
  const jobs = analysis.ranked.map((job) => ({ ...job, date: undefined, ageDays: undefined }));
  const undated = analyze(jobs, analysis.quality) as Analysis;
  const html = renderToStaticMarkup(<Dashboard analysis={undated} fileName="fixture.csv" isSample={false} analyzedAt={DEMO_DATE} onReset={noop} />);
  assert.doesNotMatch(html, /When the work was declined/);
  assert.match(html, /No usable dates were found/);
  assert.match(html, /\$4,327.48/);
});
test("site chrome supplies a skip link, named navigation and fixed public contact", () => {
  const html = renderToStaticMarkup(<SiteHeader />);
  assert.match(html, /href="#main"/);
  assert.match(html, /aria-label="Main navigation"/);
  // Contact opens the in-site form; no email app is involved.
  assert.match(html, /<button type="button" aria-haspopup="dialog"[^>]*>Talk to ReclaimBay<\/button>/);
  assert.doesNotMatch(html, /mailto:/);
  assert.doesNotMatch(html, /reclaimbay.test@gmail.com/);
});
