const whole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const cents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole-dollar currency, for headline and aggregate figures. */
export const formatCurrency = (n: number) => whole.format(n);

/** Always two decimals ($5,766.50). */
export const formatCents = (n: number) => cents.format(n);

/**
 * The report-level money format: two decimals on every figure when any
 * amount in the report has cents, otherwise whole dollars.
 */
export const moneyFormat = (showCents: boolean) =>
  showCents ? formatCents : formatCurrency;

/** Whole dollars when exact, otherwise always two decimals ($612.50, not $612.5). */
export const formatCurrencyExact = (n: number) =>
  Number.isInteger(n) ? whole.format(n) : cents.format(n);

/** Explains why dated value in the recency split can be less than the total. */
export const undatedSplitNote = (
  count: number,
  value: number,
  money: (n: number) => string,
) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "opportunity" : "opportunities"} (${money(value)}) ${count === 1 ? "has" : "have"} no usable date and ${count === 1 ? "is" : "are"} excluded from the recent/older split.`;

export const formatDate = (d: Date) =>
  d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** "Sep 30, 2026 at 11:42 AM", in the viewer's local time. */
export const formatDateTime = (d: Date) =>
  `${formatDate(d)} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

/** "2026-09-30" in local time, for file names and CSV dates. */
export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The average follows the report's money rule; whole-dollar reports keep
 * showing exact cents when the average itself isn't whole.
 */
export const formatAverage = (average: number, showCents: boolean) =>
  showCents
    ? formatCents(average)
    : formatCurrencyExact(Math.round(average * 100) / 100);

export const formatAge = (days: number) =>
  days === 1 ? "1 day" : `${days.toLocaleString("en-US")} days`;

/**
 * Whole-number percentages that always add up to 100 (largest-remainder
 * method), so displayed shares never look like 99% or 101% in total.
 */
export function allocatePercents(values: number[]): number[] {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const floors = raw.map(Math.floor);
  let remaining = 100 - floors.reduce((s, v) => s + v, 0);
  raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (remaining > 0 && values[i] > 0) {
        floors[i]++;
        remaining--;
      }
    });
  return floors;
}
