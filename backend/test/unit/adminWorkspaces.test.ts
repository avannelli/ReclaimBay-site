import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activityPage, campaignsPage, systemPage } from "../../src/admin/commandViews.js";
import type { SystemStatus } from "../../src/admin/commandCenter.js";
import { dashboardPage } from "../../src/admin/views.js";
import { unsubscribeReviewsPage } from "../../src/admin/outreachViews.js";
import type { FunnelRow } from "../../src/outreach/metrics.js";
import type { Summary } from "../../src/admin/stats.js";

const campaign: FunnelRow = {
  campaign: "pilot", firstMessages: 1, followUps: 0, everDrafted: 1, everQueued: 1,
  refusedBeforeSending: 0, sent: 1, bounced: 0, failedAfterSending: 0, replied: 1,
  positive: 0, negative: 0, other: 0, unclassified: 1, unsubscribed: 0, complained: 0,
  invitationsSent: 1, opened: 0, activated: 0, prospectsEmailed: 1, prospectsReached: 1,
  replyingProspects: 1, meetings: 0, proposals: 0, customers: 0, lost: 0,
};
const summary: Summary = {
  attributedProspects: 1, uniqueVisitors: 1, uploadSessions: 1, uploadEvents: 2,
  realScanSessions: 1, realScanEvents: 2, realExportSessions: 1, realExportEvents: 3,
  contactClickSessions: 0, contactClickEvents: 0, sampleScanEvents: 4, scanConversionRate: 1,
};

describe("Workspace reporting preserves evidence boundaries", () => {
  test("follow-up-only campaign attribution is unavailable, not zero", () => {
    const html = campaignsPage({ metrics: [{ ...campaign, campaign: "follow-up", firstMessages: 0, followUps: 1, prospectsEmailed: 0 }], versions: [] });
    assert.match(html, /campaign-reach"><b>&mdash;<\/b>/);
    assert.match(html, /Invitations opened<\/dt><dd><span[^>]*title="Not attributable to this campaign">&mdash;/);
    assert.match(html, /Analyses activated<\/dt><dd><span[^>]*title="Not attributable to this campaign">&mdash;/);
    assert.match(html, /Sent messages<\/dt><dd>1<\/dd>/);
    assert.match(html, /Replying messages<\/dt><dd>1<\/dd>/);
  });
  test("a measured zero remains zero and a small campaign has no invented rate", () => {
    const html = campaignsPage({ metrics: [{ ...campaign, campaign: '<script>unsafe</script>' }], versions: [] });
    assert.match(html, /Invitations opened<\/dt><dd>0<\/dd>/);
    assert.match(html, /Too few to compare/);
    assert.doesNotMatch(html, /<script>unsafe/);
    assert.match(html, /&#60;script&#62;unsafe/);
  });
  test("campaign exceptions remain recorded message counts with the campaign filter intact", () => {
    const html = campaignsPage({ metrics: [{ ...campaign, campaign: "pilot & follow-up", refusedBeforeSending: 2, complained: 1 }], versions: [] });
    assert.match(html, /Messages with unclassified replies: 1 &middot; 2 refused before sending &middot; Spam complaints: 1/);
    assert.match(html, /href="\/admin\/outreach\/messages\?campaign=pilot%20%26%20follow-up"/);
    assert.match(html, /Invitation opens are not email opens/);
    assert.match(html, /Delivery, email opens and recovered revenue are not inferred/);
    assert.doesNotMatch(campaignsPage({ metrics: [{ ...campaign, unclassified: 0 }], versions: [] }).split('<main')[1]!, /class="campaign-attention"/);
  });
  test("unknown system health cannot become an all-clear verdict and warnings precede verified checks", () => {
    const data: SystemStatus = { at: new Date("2026-10-06T12:00:00Z"), sending: null, shell: null, reviews: { ok: true, value: 0 }, rail: [
      { key: "web", name: "Web", state: "verified", label: "Verified now", evidence: "Served this page.", href: "/admin/system" },
      { key: "inbox", name: "Inbox", state: "unknown", label: "Not observable", evidence: "No inbox heartbeat.", href: "/admin/outreach/messages?view=replies" },
    ] };
    const unknown = systemPage(data).split('<main')[1]!;
    assert.match(unknown, /Some system health is not verified/);
    assert.doesNotMatch(unknown, /No observed system problems/);
    data.rail.push({ key: "database", name: "Database", state: "down", label: "Down", evidence: "A read query failed.", href: "/admin/system" });
    const failed = systemPage(data).split('<main')[1]!;
    assert.ok(failed.indexOf("A read query failed.") < failed.indexOf("Served this page."));
    assert.match(failed, /1 system check needs attention/);
    assert.match(failed, /No inbox heartbeat/);
    assert.match(failed, /No Railway API is called/);
    assert.match(failed, /Sending status could not be loaded/);
  });
  test("Activity keeps the recent window, exact UTC times and internal labels without merging events", () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ key: `event-${i}`, at: new Date(`2026-10-0${i < 2 ? 6 : 5}T12:34:56Z`), label: "Reply received", name: i === 50 ? "Outside recent window" : "<Long & business>", href: "/admin/outreach/fixture", kind: "outreach" as const, internal: i === 0 }));
    const html = activityPage(rows, true).split('<main')[1]!;
    assert.equal((html.match(/datetime="/g) ?? []).length, 50);
    assert.match(html, /datetime="2026-10-06T12:34:56\.000Z"/);
    assert.match(html, />12:34:56<span>UTC/);
    assert.match(html, /aria-label="2026-10-05 UTC"/);
    assert.match(html, /class="audit-test">Internal test/);
    assert.match(html, /&#60;Long &#38; business&#62;/);
    assert.doesNotMatch(html, /Outside recent window/);
    assert.match(html, /No inferred events/);
    assert.match(activityPage([], false), /No recorded activity yet/);
  });
  test("Funnel retains session and event counts while suppressing small-sample rates", () => {
    const html = dashboardPage({ summary, rows: [], siteUrl: "https://reclaimbay.example" });
    const main = html.slice(html.indexOf('<main'));
    assert.match(main, /Too few to compare/);
    assert.doesNotMatch(main.replace(/style="[^"]*"/g, ""), /100(?:\.0)?%/);
    assert.match(main, /2 upload events/);
    assert.match(main, /3 real exports/);
    assert.match(main, /4 sample excluded/);
    assert.match(main, /not a single cohort/);
    assert.match(main, /not proof of a customer or revenue/);
    const larger = dashboardPage({ summary: { ...summary, uniqueVisitors: 20, scanConversionRate: 0.05 }, rows: [], siteUrl: "https://reclaimbay.example" });
    assert.match(larger, /5\.0%/);
  });
  test("an empty later review page never implies that the whole queue is clear", () => {
    assert.match(unsubscribeReviewsPage([], 1), /No unresolved unsubscribe requests/);
    const later = unsubscribeReviewsPage([], 2);
    assert.match(later, /No reviews on this page/);
    assert.doesNotMatch(later, /No unresolved unsubscribe requests/);
    assert.match(later, /href="\?page=1">Previous/);
  });
});
