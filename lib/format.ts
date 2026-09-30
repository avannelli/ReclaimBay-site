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

/** Whole dollars when exact, otherwise always two decimals ($612.50, not $612.5). */
export const formatCurrencyExact = (n: number) =>
  Number.isInteger(n) ? whole.format(n) : cents.format(n);

export const formatPercent = (ratio: number) => `${Math.round(ratio * 100)}%`;

export const formatDate = (d: Date) =>
  d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

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
