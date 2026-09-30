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
}

/** Horizontal bars sized by dollar value, with counts and share of total. */
export default function BarBreakdown({
  buckets,
  barClass = () => "bg-navy/80",
  dotClass,
  layout = "columns",
}: Props) {
  const max = Math.max(...buckets.map((b) => b.value), 1);
  const shares = allocatePercents(buckets.map((b) => b.value));
  const rows = layout === "rows";

  return (
    <ul
      className={
        rows
          ? "space-y-4 lg:space-y-3"
          : "space-y-4 lg:columns-2 lg:gap-12 lg:space-y-0"
      }
    >
      {buckets.map((b, i) => (
        <li
          key={b.label}
          className={`grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 break-inside-avoid ${
            rows
              ? "lg:grid-cols-[9rem_minmax(0,1fr)_7rem_12rem] lg:items-center lg:gap-x-6"
              : "lg:mb-4"
          }`}
        >
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
            {dotClass && (
              <span
                aria-hidden
                className={`h-2 w-2 shrink-0 rounded-full ${dotClass(b, i)}`}
              />
            )}
            {b.label}
          </span>
          <span
            className={`text-right text-sm font-semibold tabular-nums text-ink ${
              rows ? "lg:col-start-3 lg:row-start-1" : ""
            }`}
          >
            {formatCurrency(b.value)}
          </span>
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
          <p
            className={`col-span-2 mt-1 text-xs tabular-nums text-ink-3 ${
              rows ? "lg:col-span-1 lg:col-start-4 lg:row-start-1 lg:mt-0 lg:text-right" : ""
            }`}
          >
            {b.count.toLocaleString("en-US")}{" "}
            {b.count === 1 ? "opportunity" : "opportunities"}
            <span aria-hidden> · </span>
            {shares[i]}% of value
          </p>
        </li>
      ))}
    </ul>
  );
}
