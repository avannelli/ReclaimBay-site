"use client";

import { useEffect, useState, type ReactNode, type RefObject } from "react";

interface Props {
  /** The bar appears once this element has scrolled above the viewport. */
  watchRef: RefObject<HTMLElement | null>;
  total: number;
  count: number;
  /** The report's money format. */
  format: (n: number) => string;
  isSample: boolean;
  uploadLabel: string;
  onReset: () => void;
  onPdf: () => void;
  onCsv: () => void;
  pdfBusy: boolean;
  /** Hidden while a dialog or the tour has the page. */
  suppressed?: boolean;
}

const glyph = (d: string) => (
  <svg
    aria-hidden
    viewBox="0 0 20 20"
    className="h-4 w-4 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

const ICON = {
  upload: glyph("M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"),
  pdf: glyph("M11.5 3H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 17h8a1.5 1.5 0 0 0 1.5-1.5V7zM11.5 3v4h4M10 9.5v5M7.75 12.25 10 14.5l2.25-2.25"),
  csv: glyph("M3.5 4.5h13v11h-13zM3.5 8.5h13M3.5 12h13M8 8.5v7"),
};

/** Icon-only on small screens; the label appears once there's room. */
function BarButton({
  icon,
  label,
  labelFrom,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  labelFrom: "md" | "lg";
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-sm font-semibold text-white ring-1 ring-inset ring-white/15 transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-opportunity disabled:cursor-progress disabled:opacity-60"
    >
      {icon}
      <span className={labelFrom === "md" ? "sr-only md:not-sr-only" : "sr-only lg:not-sr-only"}>
        {label}
      </span>
    </button>
  );
}

/** Compact bar that keeps the total and report actions in view while scrolling. */
export default function SummaryBar({
  watchRef,
  total,
  count,
  format,
  isSample,
  uploadLabel,
  onReset,
  onPdf,
  onCsv,
  pdfBusy,
  suppressed = false,
}: Props) {
  const [pastHero, setPastHero] = useState(false);
  const visible = pastHero && !suppressed;

  useEffect(() => {
    const el = watchRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) =>
      setPastHero(!entry.isIntersecting && entry.boundingClientRect.top < 0),
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
      <div className="mx-auto flex h-14 max-w-300 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <p className="flex min-w-0 items-baseline gap-2.5">
          <span className="eyebrow hidden text-opportunity xl:inline">
            Declined work identified
          </span>
          <span className="text-lg font-semibold tracking-tight tabular-nums">
            {format(total)}
          </span>
          <span className="hidden truncate text-sm text-slate-400 sm:inline">
            {count.toLocaleString("en-US")}{" "}
            {count === 1 ? "opportunity" : "opportunities"}
          </span>
          {isSample && (
            <span className="self-center rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-200 ring-1 ring-inset ring-white/15">
              Sample
            </span>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <BarButton icon={ICON.pdf} label="Download report" labelFrom="lg" onClick={onPdf} disabled={pdfBusy} />
          <BarButton icon={ICON.csv} label="Export opportunities" labelFrom="lg" onClick={onCsv} />
          <BarButton icon={ICON.upload} label={uploadLabel} labelFrom="md" onClick={onReset} />
        </div>
      </div>
    </div>
  );
}
