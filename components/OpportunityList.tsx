"use client";

import { useId, useRef, useState } from "react";
import { RECENT_DAYS } from "@/lib/analyze";
import { formatAge, formatCurrencyExact, formatDate } from "@/lib/format";
import type { Opportunity } from "@/lib/types";

const INITIAL = 5;
const STEP = 10;
/** Rows included when the report is printed or saved as PDF. */
const PRINT_ROWS = 25;

/** Shared column template so the header lines up with every row on desktop. */
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 lg:grid-cols-[minmax(0,1fr)_11rem_9rem_7.5rem] lg:gap-x-6";

function Row({
  o,
  rank,
  revealDelay,
  printOnly,
}: {
  o: Opportunity;
  rank: number;
  /** Set for rows added by "View more" so they fade in one after another. */
  revealDelay?: number;
  /** Hidden on screen, included when printing. */
  printOnly?: boolean;
}) {
  const top = rank <= 3;
  const contact = [o.phone, o.email].filter(Boolean).join(" · ");
  const recent = o.ageDays !== undefined && o.ageDays <= RECENT_DAYS;
  return (
    <li
      style={revealDelay !== undefined ? { animationDelay: `${revealDelay}ms` } : undefined}
      className={`relative gap-3 px-5 py-4 transition-colors break-inside-avoid hover:bg-canvas sm:gap-4 sm:px-6 ${
        printOnly ? "hidden print:flex" : "flex"
      } ${revealDelay !== undefined ? "animate-fade-up motion-reduce:animate-none" : ""}`}
    >
      {top && (
        <span
          aria-hidden
          className="absolute inset-y-4 left-0 w-[3px] rounded-r-full bg-opportunity"
        />
      )}
      <span
        className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-semibold tabular-nums ${
          top
            ? "bg-opportunity-soft text-opportunity-ink ring-1 ring-inset ring-opportunity/30"
            : "bg-slate-100 text-ink-2"
        }`}
      >
        {rank}
      </span>
      <div className={`min-w-0 flex-1 ${COLUMNS}`}>
        <p className="col-start-1 row-start-1 min-w-0 wrap-break-word font-semibold leading-snug text-ink">
          {o.service}
        </p>
        {/* Below the title, details use the full row width on phones. */}
        <div className="col-span-2 min-w-0 lg:col-span-1 lg:col-start-1 lg:row-start-2">
          {(o.customer || o.vehicle) && (
            <p className="mt-1 wrap-break-word text-sm leading-snug text-ink-2">
              {o.customer && (
                <span className="font-medium text-ink">{o.customer}</span>
              )}
              {o.customer && o.vehicle && (
                <span aria-hidden className="text-slate-400">
                  {" · "}
                </span>
              )}
              {o.vehicle}
            </p>
          )}
          {contact && (
            <p className="mt-0.5 wrap-break-word text-xs text-ink-3">{contact}</p>
          )}
          {(recent || o.possibleDuplicate) && (
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {recent && (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-surface px-1.5 py-0.5 font-medium text-ink-2 ring-1 ring-inset ring-line">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-opportunity" />
                  Last {RECENT_DAYS} days
                </span>
              )}
              {o.possibleDuplicate && (
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-ink-2 ring-1 ring-inset ring-line">
                  Possible duplicate
                </span>
              )}
            </div>
          )}
        </div>

        <p
          className={`col-start-2 row-start-1 text-right font-semibold tabular-nums leading-snug text-ink lg:col-start-4 lg:row-span-2 ${
            top ? "text-lg" : "text-base"
          }`}
        >
          {formatCurrencyExact(o.amount)}
        </p>

        <p className="col-span-2 mt-2 inline-flex items-center gap-1.5 text-xs text-ink-3 lg:col-span-1 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0.5 lg:items-start lg:self-start lg:text-sm lg:text-ink-2">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full bg-slate-400 lg:mt-1.5"
          />
          {o.category}
        </p>

        {o.date && o.ageDays !== undefined && (
          <p className="col-span-2 mt-0.5 text-xs text-ink-3 lg:col-span-1 lg:col-start-3 lg:row-span-2 lg:row-start-1 lg:mt-0.5 lg:self-start">
            <span className="lg:hidden">Declined </span>
            <span className="lg:text-sm lg:text-ink-2">{formatDate(o.date)}</span>
            <span className="lg:hidden"> · </span>
            <span className="lg:block">{formatAge(o.ageDays)} ago</span>
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Ranked list of opportunities; shows only the details present in the file.
 * Starts with the five largest and expands in steps via the footer tab.
 */
export default function OpportunityList({ items }: { items: Opportunity[] }) {
  const [shown, setShown] = useState(INITIAL);
  // Rows at or past this index were just revealed and animate in.
  const [revealFrom, setRevealFrom] = useState(items.length);
  const listId = useId();
  const listRef = useRef<HTMLOListElement>(null);

  const visible = Math.min(shown, items.length);
  const printed = Math.max(visible, Math.min(PRINT_ROWS, items.length));
  const remaining = items.length - visible;
  const expandable = items.length > INITIAL;

  const toggle = () => {
    if (remaining > 0) {
      setRevealFrom(shown);
      setShown(shown + STEP);
      return;
    }
    setRevealFrom(items.length);
    setShown(INITIAL);
    // Collapsing a long list can leave the reader far below it.
    const card = listRef.current?.closest("section");
    if (card && card.getBoundingClientRect().top < 0) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      card.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }
  };

  return (
    <>
      <div
        aria-hidden
        className="hidden gap-4 bg-canvas/70 px-6 py-2.5 lg:flex"
      >
        <span className="w-7 shrink-0" />
        <div className={`eyebrow flex-1 text-ink-3 ${COLUMNS}`}>
          <span>Opportunity</span>
          <span>Category</span>
          <span>Declined</span>
          <span className="text-right">Amount</span>
        </div>
      </div>
      <ol
        ref={listRef}
        id={listId}
        className="divide-y divide-line/70 border-line/70 lg:border-t"
      >
        {items.slice(0, printed).map((o, i) => (
          <Row
            key={o.id}
            o={o}
            rank={i + 1}
            printOnly={i >= visible}
            revealDelay={i >= revealFrom && i < visible ? (i - revealFrom) * 45 : undefined}
          />
        ))}
      </ol>
      {printed < items.length && (
        <p className="hidden border-t border-line px-6 py-3 text-xs text-ink-3 print:block">
          Showing the {printed} largest of {items.length.toLocaleString("en-US")}{" "}
          opportunities. Export CSV for the full list.
        </p>
      )}
      {expandable && (
        <button
          type="button"
          onClick={toggle}
          aria-controls={listId}
          aria-expanded={remaining === 0}
          className="group flex w-full items-center justify-between gap-4 border-t border-line bg-canvas px-5 py-3.5 text-left transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-navy sm:px-6 print:hidden"
        >
          <span className="text-xs tabular-nums text-ink-3">
            Showing {visible.toLocaleString("en-US")} of{" "}
            {items.length.toLocaleString("en-US")}
          </span>
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-navy">
            {remaining > 0
              ? `View ${Math.min(STEP, remaining)} more`
              : "Show fewer"}
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className={`h-4 w-4 text-ink-3 transition-transform duration-200 group-hover:text-navy ${
                remaining > 0 ? "group-hover:translate-y-0.5" : "rotate-180 group-hover:-translate-y-0.5"
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
          </span>
        </button>
      )}
    </>
  );
}
