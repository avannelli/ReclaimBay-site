import { RECENT_DAYS } from "./analyze";
import { BRAND } from "./brand";
import { formatAverage, formatDateTime, moneyFormat } from "./format";
import type { Analysis } from "./types";

/**
 * A short plain-text summary for pasting into an email, chat, or notes.
 * Built in the browser from the current analysis only.
 */
export function buildSummaryText({
  analysis: a,
  fileName,
  isSample,
  analyzedAt,
}: {
  analysis: Analysis;
  fileName: string;
  isSample: boolean;
  analyzedAt: Date;
}): string {
  const money = moneyFormat(a.showCents);
  const lines = [`${BRAND.name} declined-work summary`];
  if (isSample) lines.push("SAMPLE REPORT: made-up data, not a real shop");
  lines.push(
    "",
    `Total declined work: ${money(a.total)}`,
    `Opportunities: ${a.count.toLocaleString("en-US")}`,
    `Average opportunity: ${formatAverage(a.average, a.showCents)}`,
    "Values are reported declined estimates. Recovery is not tracked.",
  );
  if (a.hasDates) {
    lines.push(`Declined in last ${RECENT_DAYS} days: ${money(a.recency.recent.value)}`);
  }
  lines.push(
    `Highest-value opportunity: ${money(a.highest.amount)}`,
    "",
    "Top opportunities:",
    ...a.ranked
      .slice(0, 3)
      .map((o, i) => `${i + 1}. ${o.service} — ${money(o.amount)}`),
    "",
    "Generated from:",
    fileName,
    `Analyzed ${formatDateTime(analyzedAt)}`,
  );
  return lines.join("\n");
}
