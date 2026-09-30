import type { Analysis, Bucket, DataQuality, Opportunity } from "./types";

export const RECENT_DAYS = 90;

const AGE_BANDS: { label: string; max: number }[] = [
  { label: "0–30 days", max: 30 },
  { label: "31–90 days", max: 90 },
  { label: "91–180 days", max: 180 },
  { label: "181–365 days", max: 365 },
  { label: "Over 1 year", max: Infinity },
];

const sum = (items: Opportunity[]) => items.reduce((s, o) => s + o.amount, 0);

const toBucket = (label: string, items: Opportunity[]): Bucket => ({
  label,
  count: items.length,
  value: sum(items),
});

/** Returns null when there are no opportunities to analyze. */
export function analyze(
  opportunities: Opportunity[],
  quality: DataQuality,
): Analysis | null {
  if (opportunities.length === 0) return null;

  const total = sum(opportunities);
  const byValue = [...opportunities].sort(
    (a, b) =>
      b.amount - a.amount || (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0),
  );

  const dated = opportunities.filter((o) => o.ageDays !== undefined);
  const undated = opportunities.filter((o) => o.ageDays === undefined);
  const ageBuckets = AGE_BANDS.map((band, i) => {
    const min = i === 0 ? -1 : AGE_BANDS[i - 1].max;
    return toBucket(
      band.label,
      dated.filter((o) => o.ageDays! > min && o.ageDays! <= band.max),
    );
  });

  const byCategory = new Map<string, Opportunity[]>();
  for (const o of opportunities) {
    byCategory.set(o.category, [...(byCategory.get(o.category) ?? []), o]);
  }
  const categories = [...byCategory.entries()]
    .map(([label, items]) => toBucket(label, items))
    .sort((a, b) => b.value - a.value);

  const recentItems = dated.filter((o) => o.ageDays! <= RECENT_DAYS);
  const olderItems = dated.filter((o) => o.ageDays! > RECENT_DAYS);
  const datedTotal = sum(dated);

  return {
    total,
    count: opportunities.length,
    average: total / opportunities.length,
    highest: byValue[0],
    ranked: byValue,
    showCents: opportunities.some((o) => Math.round(o.amount * 100) % 100 !== 0),
    hasDates: dated.length > 0,
    undatedCount: undated.length,
    undated: toBucket("Unknown / invalid date", undated),
    ageBuckets,
    categories,
    recency: {
      thresholdDays: RECENT_DAYS,
      recent: toBucket(`Last ${RECENT_DAYS} days`, recentItems),
      older: toBucket(`Older than ${RECENT_DAYS} days`, olderItems),
      recentShare: datedTotal > 0 ? sum(recentItems) / datedTotal : 0,
    },
    quality,
  };
}
