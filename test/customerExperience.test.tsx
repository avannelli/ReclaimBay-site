import assert from "node:assert/strict";
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
import { SiteHeader } from "../components/SiteChrome";
import type { Analysis } from "../lib/types";

const noop = () => undefined;
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
  assert.equal((html.match(/<details\b/g) ?? []).length, 3);
  assert.match(html, /Why it appears/);
  assert.match(html, /Source record/);
  assert.match(html, /JAC-001/);
  assert.match(html, /Open full report/);
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
  assert.match(html, /Reading your report/);
  assert.match(html, /disabled=""/);
});
test("results expose total, real report details, next step and complete local exports", () => {
  const { analysis, table } = demoAnalysis();
  const html = renderToStaticMarkup(<Dashboard analysis={analysis} fileName={table.fileName} isSample analyzedAt={DEMO_DATE} onReset={noop} />);
  assert.match(html, /Reported declined value to review/);
  assert.match(html, /\$4,327.48/);
  assert.match(html, /made-up data/);
  assert.match(html, /View report details/);
  assert.match(html, /current job status and customer interest have not been verified/);
  assert.match(html, /Start with a job worth revisiting/);
  assert.match(html, /Download PDF/);
  assert.match(html, /Download CSV/);
  const summary = buildSummaryText({ analysis, fileName: table.fileName, isSample: true, analyzedAt: DEMO_DATE });
  assert.match(summary, /SAMPLE REPORT/);
  assert.match(summary, /Total declined work: \$4,327.48/);
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
  assert.match(html, /mailto:hello@reclaimbay.com/);
  assert.doesNotMatch(html, /reclaimbay.test@gmail.com/);
});
