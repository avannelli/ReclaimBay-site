"use client";

import { useEffect, useState, type RefObject } from "react";
import { formatCurrency } from "@/lib/format";

interface Props {
  /** The bar appears once this element has scrolled above the viewport. */
  watchRef: RefObject<HTMLElement | null>;
  total: number;
  count: number;
  onReset: () => void;
}

/** Compact bar that keeps the headline total in view while scrolling. */
export default function SummaryBar({ watchRef, total, count, onReset }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = watchRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [watchRef]);

  return (
    <div
      inert={!visible}
      aria-hidden={!visible}
      className={`fixed inset-x-0 top-0 z-40 print:hidden border-b border-opportunity/30 bg-navy-deep/95 text-white shadow-lg shadow-navy-deep/10 backdrop-blur transition duration-300 ease-out motion-reduce:transition-none ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0"
      }`}
    >
      <div className="mx-auto flex h-14 max-w-300 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <p className="flex min-w-0 items-baseline gap-2.5">
          <span className="eyebrow hidden text-opportunity md:inline">
            Declined work identified
          </span>
          <span className="text-lg font-semibold tracking-tight tabular-nums">
            {formatCurrency(total)}
          </span>
          <span className="hidden truncate text-sm text-slate-400 min-[430px]:inline">
            {count.toLocaleString("en-US")}{" "}
            {count === 1 ? "opportunity" : "opportunities"}
          </span>
        </p>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-sm font-semibold text-white ring-1 ring-inset ring-white/15 transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-opportunity"
        >
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" />
          </svg>
          Upload another report
        </button>
      </div>
    </div>
  );
}
