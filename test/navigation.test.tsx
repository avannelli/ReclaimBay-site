import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteHeader } from "../components/SiteChrome";
import UploadPanel from "../components/UploadPanel";
import { routerFields } from "../components/useReportHistory";
import { homeEntry, LANDING_SECTIONS, landingSection, readNavEntry, reportEntry, reportKey, resolveDestination } from "../lib/navigation";

const noop = () => undefined;
const report = reportKey(1760000000000.4, 1);
// Next.js keeps its own fields in every entry it touches; ours sit beside them.
const withNext = (entry: object) => ({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["", {}], ...entry });

test("Back from a report reaches the landing page where the visitor left it", () => {
  assert.deepEqual(resolveDestination(withNext(homeEntry(1849.6)), "", report), { view: "home", scroll: { y: 1850 } });
  // The hero's anchor may still be in the URL; the remembered position wins.
  assert.deepEqual(resolveDestination(withNext(homeEntry(0)), "#scan", report), { view: "home", scroll: { y: 0 } });
});

test("Forward returns to the report still in memory; entries for reports that are gone fall back to the landing page", () => {
  assert.deepEqual(resolveDestination(withNext(reportEntry(report)), "", report), { view: "report" });
  // A newer scan replaced it, or the page was reloaded (a new page load never reuses a key).
  assert.deepEqual(resolveDestination(withNext(reportEntry(report)), "", reportKey(1760000000000.4, 2)), { view: "home", scroll: { y: 0 }, forgotten: true });
  assert.deepEqual(resolveDestination(withNext(reportEntry(report)), "", null), { view: "home", scroll: { y: 0 }, forgotten: true });
  assert.notEqual(reportKey(1760000000000, 1), reportKey(1760000099999, 1));
});

test("header links from a report reach the actual landing sections; other fragments are left alone", () => {
  assert.deepEqual(resolveDestination(null, "#how-it-works", report), { view: "home", scroll: { section: "how-it-works" } });
  assert.deepEqual(resolveDestination(null, "#privacy", report), { view: "home", scroll: { section: "privacy" } });
  // The skip link, an empty fragment, and Next.js-only entries are not navigation between views.
  assert.equal(resolveDestination(null, "#main", report), null);
  assert.equal(resolveDestination(null, "", report), null);
  assert.equal(resolveDestination({ __NA: true }, "", report), null);
  assert.equal(landingSection("#evidence-heading"), null);
});

test("every header destination exists on the landing page, and the logo still goes home", () => {
  const header = renderToStaticMarkup(<SiteHeader />);
  const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
  const links = [...header.matchAll(/href="\/#([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links, ["how-it-works", "privacy"]);
  for (const id of links) assert.ok((LANDING_SECTIONS as readonly string[]).includes(id) && home.includes(`id="${id}"`), id);
  for (const id of LANDING_SECTIONS) assert.ok(home.includes(`id="${id}"`), id);
  assert.match(header, /<a href="\/" class="site-brand/);
});

test("navigation state can only hold a view, an opaque key, and a scroll position: never report contents", () => {
  assert.deepEqual(Object.keys(homeEntry(12)).sort(), ["rb", "scrollY"]);
  assert.deepEqual(Object.keys(reportEntry(report)).sort(), ["rb", "report"]);
  assert.match(report, /^\d+:\d+$/);
  // Anything else found in an entry is ignored, and malformed keys are refused.
  assert.deepEqual(readNavEntry({ rb: "report", report, customer: "Riley Chen", amount: 1285 }), reportEntry(report));
  assert.equal(readNavEntry({ rb: "report", report: "Timing belt and water pump" }), null);
  assert.equal(readNavEntry({ rb: "report", report: 1 }), null);
  assert.deepEqual(readNavEntry({ rb: "home", scrollY: Number.NaN }), homeEntry(0));
  // The hook writes history in one place, from these two builders plus Next.js's router fields, and never sees the report.
  const hook = readFileSync(new URL("../components/useReportHistory.ts", import.meta.url), "utf8");
  assert.equal((hook.match(/history\[method\]|history\.(?:push|replace)State/g) ?? []).length, 1);
  assert.match(hook, /window\.history\[method\]\(\{ \.\.\.router\.current, \.\.\.entry \}, ""\)/);
  const writes = [...hook.matchAll(/write\(router, "(?:push|replace)State", ([^;]+)\);/g)].map((m) => m[1].trim());
  assert.ok(writes.length >= 4 && writes.every((arg) => /^(homeEntry|reportEntry)\(/.test(arg)), writes.join(" | "));
  assert.doesNotMatch(hook, /\b(analysis|table|fileName|rows|Opportunity|localStorage|sessionStorage)\b/);
});

test("entries keep Next.js's router fields (or Back would reload the page) and nothing else from the old state", () => {
  const tree = ["", { children: ["__PAGE__", {}] }];
  assert.deepEqual(routerFields({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: tree, rb: "home", scrollY: 3, note: "x" }), { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: tree });
  // An in-page link's entry has no state: the last router fields seen are used instead.
  assert.equal(routerFields(null), null);
  assert.equal(routerFields({ rb: "home", scrollY: 0 }), null);
});

test("history handling sends no analytics of its own", () => {
  for (const file of ["../components/useReportHistory.ts", "../lib/navigation.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /analytics|track(Event|Export|LandingView)|fetch\(/);
  }
  // Landing views are still counted once per mount, scans only when analyzed, never on Back or Forward.
  const app = readFileSync(new URL("../components/ScannerApp.tsx", import.meta.url), "utf8");
  assert.equal((app.match(/trackLandingView\(\)/g) ?? []).length, 1);
  assert.equal((app.match(/trackEvent\("scan_completed"/g) ?? []).length, 1);
});
