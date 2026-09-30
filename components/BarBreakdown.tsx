"use client";

import { allocatePercents, formatCurrency } from "@/lib/format";
import type { Bucket } from "@/lib/types";
import { FillBar } from "./motion";

interface Props {
  buckets: Bucket[];
  /** Tailwind background class for a bar; lets callers highlight by meaning. */
  barClass?: (bucket: Bucket, index: number) => string;
  /** Optional small color dot beside each label. */
  dotClass?: (bucket: Bucket, index: number) => string;
  /**
   * "rows": on desktop each bucket is one line (label, bar, amount, detail).
   * "columns": on desktop buckets flow into two columns.
   * Both stack naturally on smaller screens.
   */
  layout?: "rows" | "columns";
  /** Money format for the amounts; defaults to whole dollars. */
  format?: (n: number) => string;
  /**
   * Informational bucket (e.g. undated work) listed after the bars without an
   * age bar. When present, shares include it and a total row is shown so the
   * section reconciles to the overall total.
   */
  unknown?: Bucket;
}

/** Horizontal bars sized by dollar value, with counts and share of total. */
export default function BarBreakdown({
  buckets,
  barClass = () => "bg-navy/80",
  dotClass,
  layout = "columns",
  format = formatCurrency,
  unknown,
}: Props) {
  const max = Math.max(...buckets.map((b) => b.value), 1);
  const extra = unknown && unknown.count > 0 ? unknown : undefined;
  const all = extra ? [...buckets, extra] : buckets;
  const shares = allocatePercents(all.map((b) => b.value));
  const rows = layout === "rows";
  const rowGrid = `grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 break-inside-avoid ${
    rows
      ? "lg:grid-cols-[9rem_minmax(0,1fr)_7rem_12rem] lg:items-center lg:gap-x-6"
      : "lg:mb-4"
  }`;
  const amountCell = `text-right text-sm font-semibold tabular-nums text-ink ${
    rows ? "lg:col-start-3 lg:row-start-1" : ""
  }`;
  const detailCell = `col-span-2 mt-1 text-xs tabular-nums text-ink-3 ${
    rows ? "lg:col-span-1 lg:col-start-4 lg:row-start-1 lg:mt-0 lg:text-right" : ""
  }`;
  const detail = (count: number, pct: number) => (
    <>
      {count.toLocaleString("en-US")}{" "}
      {count === 1 ? "opportunity" : "opportunities"}
      <span aria-hidden> · </span>
      {pct}% of value
    </>
  );

  return (
    <ul
      className={
        rows
          ? "space-y-4 lg:space-y-3"
          : "space-y-4 lg:columns-2 lg:gap-12 lg:space-y-0"
      }
    >
      {buckets.map((b, i) => (
        <li key={b.label} className={rowGrid}>
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
            {dotClass && (
              <span
                aria-hidden
                className={`h-2 w-2 shrink-0 rounded-full ${dotClass(b, i)}`}
              />
            )}
            {b.label}
          </span>
          <span className={amountCell}>{format(b.value)}</span>
          <div
            className={`col-span-2 mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 ${
              rows ? "lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:mt-0 lg:h-2" : ""
            }`}
          >
            <FillBar
              percent={(b.value / max) * 100}
              className={barClass(b, i)}
              delayMs={150 + i * 70}
            />
          </div>
          <p className={detailCell}>{detail(b.count, shares[i])}</p>
        </li>
      ))}
      {extra && (
        <>
          <li className={`${rowGrid} border-t border-dashed border-line pt-4 lg:pt-3`}>
            <span className="min-w-0 text-sm font-medium text-ink-2">
              {extra.label}
            </span>
            <span className={amountCell}>{format(extra.value)}</span>
            <div
              aria-hidden
              className={`col-span-2 mt-1.5 h-1.5 rounded-full border border-dashed border-slate-300 ${
                rows ? "lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:mt-0 lg:h-2" : ""
              }`}
            />
            <p className={detailCell}>
              {detail(extra.count, shares[buckets.length])}
            </p>
          </li>
          <li className={`${rowGrid} border-t border-line pt-4 lg:pt-3`}>
            <span className="text-sm font-semibold text-ink">Total</span>
            <span className={amountCell}>
              {format(all.reduce((s, b) => s + b.value, 0))}
            </span>
            <p className={detailCell}>
              {detail(
                all.reduce((s, b) => s + b.count, 0),
                shares.reduce((s, p) => s + p, 0),
              )}
            </p>
          </li>
        </>
      )}
    </ul>
  );
}
