"use client";

import { useId, useMemo, useRef, useState } from "react";
import { RECENT_DAYS } from "@/lib/analyze";
import { formatAge, formatDate } from "@/lib/format";
import { scrollToElement } from "@/lib/scroll";
import type { Opportunity } from "@/lib/types";
import { InfoTip } from "./overlay";
import { button, size } from "./ui";

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
  format,
}: {
  o: Opportunity;
  /** The report's money format. */
  format: (n: number) => string;
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
          {(recent || o.possibleDuplicate) && (
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {recent && (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-surface px-1.5 py-0.5 font-medium text-ink-2 ring-1 ring-inset ring-line">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-opportunity" />
                  Last {RECENT_DAYS} days
                </span>
              )}
              {o.possibleDuplicate && (
                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-1.5 pr-1 font-medium text-ink-2 ring-1 ring-inset ring-line">
                  Possible duplicate
                  <InfoTip
                    label="possible duplicates"
                    text="Another row has the same customer, vehicle, service, amount, and date. With no unique record ID to confirm it, both stay in the totals."
                  />
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
          {format(o.amount)}
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
        <details className="source-record">
          <summary>View report details<span className="sr-only"> for {o.service}, {o.customer ?? "customer not provided"}</span></summary>
          <div className="source-record-body">
            <p><strong>Why it appears:</strong> A readable, positive declined amount in the column you mapped. Jobs are initially ranked by value.</p>
            <dl>
              <div><dt>Service from report</dt><dd>{o.service}</dd></div>
              <div><dt>Declined amount</dt><dd>{format(o.amount)}</dd></div>
              <div><dt>Customer</dt><dd>{o.customer ?? "Not provided"}</dd></div>
              <div><dt>Vehicle</dt><dd>{o.vehicle ?? "Not provided"}</dd></div>
              <div><dt>Decline date</dt><dd>{o.date ? formatDate(o.date) : "Not provided or unreadable"}</dd></div>
              <div><dt>Contact from report</dt><dd>{contact || "Not provided"}</dd></div>
            </dl>
            <p>These details come from your file. The current job status and customer interest have not been verified.</p>
          </div>
        </details>
      </div>
    </li>
  );
}

type SortKey = "value-desc" | "value-asc" | "date-desc" | "date-asc";
type RecencyKey = "all" | "recent" | "older" | "unknown";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "value-desc", label: "Highest value" },
  { key: "value-asc", label: "Lowest value" },
  { key: "date-desc", label: "Newest declined" },
  { key: "date-asc", label: "Oldest declined" },
];

const byDate = (dir: 1 | -1) => (a: Opportunity, b: Opportunity) => {
  // Records without a usable date go last either way; no dates are invented.
  if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : b.amount - a.amount;
  return (a.date.getTime() - b.date.getTime()) * dir || b.amount - a.amount;
};

const COMPARE: Record<SortKey, (a: Opportunity, b: Opportunity) => number> = {
  "value-desc": () => 0, // items arrive largest first
  "value-asc": (a, b) => a.amount - b.amount,
  "date-desc": byDate(-1),
  "date-asc": byDate(1),
};

const matchesRecency = (o: Opportunity, key: RecencyKey) =>
  key === "all" ||
  (key === "unknown"
    ? o.ageDays === undefined
    : o.ageDays !== undefined && (key === "recent") === o.ageDays <= RECENT_DAYS);

const controlBase =
  "h-10 rounded-lg border border-slate-300 bg-surface text-sm text-ink transition-colors hover:border-slate-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy";

/**
 * Ranked list of opportunities; shows only the details present in the file.
 * Search, sort, and the recency filter change this list only, never the
 * report totals. Ranks always reflect value. Starts with five rows and
 * expands in steps via the footer tab.
 */
export default function OpportunityList({
  items,
  format,
  hasDates,
  undatedCount,
}: {
  /** Largest first. */
  items: Opportunity[];
  /** The report's money format. */
  format: (n: number) => string;
  hasDates: boolean;
  undatedCount: number;
}) {
  const [shown, setShown] = useState(INITIAL);
  // Rows at or past this index were just revealed and animate in.
  const [revealFrom, setRevealFrom] = useState(items.length);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("value-desc");
  const [recency, setRecency] = useState<RecencyKey>("all");
  const listId = useId();
  const searchId = useId();
  const sortId = useId();
  const listRef = useRef<HTMLOListElement>(null);

  const rankOf = useMemo(
    () => new Map(items.map((o, i) => [o.id, i + 1])),
    [items],
  );
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = items.filter(
      (o) =>
        matchesRecency(o, recency) &&
        (!needle ||
          [o.customer, o.vehicle, o.service, o.category].some((v) =>
            v?.toLowerCase().includes(needle),
          )),
    );
    return sort === "value-desc" ? list : [...list].sort(COMPARE[sort]);
  }, [items, needle, recency, sort]);

  const filteredView = needle !== "" || recency !== "all";
  const visible = Math.min(shown, filtered.length);
  const printed = Math.max(visible, Math.min(PRINT_ROWS, filtered.length));
  const remaining = filtered.length - visible;
  const expandable = filtered.length > INITIAL;

  // Any change to the view starts again from the top rows.
  const resetView = () => {
    setShown(INITIAL);
    setRevealFrom(items.length);
  };
  const clearFilters = () => {
    setQuery("");
    setRecency("all");
    resetView();
  };

  const recencyOptions: { key: RecencyKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "recent", label: `Last ${RECENT_DAYS} days` },
    { key: "older", label: "Older" },
    ...(undatedCount > 0
      ? [{ key: "unknown" as const, label: "Unknown date" }]
      : []),
  ];

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
    if (card && card.getBoundingClientRect().top < 0) scrollToElement(card);
  };

  return (
    <>
      <div className="flex flex-col gap-2.5 border-b border-line px-5 py-3.5 sm:px-6 lg:flex-row lg:items-center lg:gap-3 print:hidden">
        <div className="relative min-w-0 lg:flex-1">
          <label htmlFor={searchId} className="sr-only">
            Search opportunities
          </label>
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              resetView();
            }}
            placeholder="Search customer, vehicle, service…"
            autoComplete="off"
            className={`${controlBase} w-full pl-9 pr-3 placeholder:text-ink-3`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {hasDates && (
            <div
              role="group"
              aria-label="Filter by when the work was declined"
              className="inline-flex flex-wrap rounded-lg bg-slate-100 p-0.5 ring-1 ring-inset ring-line"
            >
              {recencyOptions.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  aria-pressed={recency === opt.key}
                  onClick={() => {
                    setRecency(opt.key);
                    resetView();
                  }}
                  className={`h-9 rounded-md px-2.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy ${
                    recency === opt.key
                      ? "bg-surface text-navy shadow-sm ring-1 ring-line"
                      : "text-ink-2 hover:text-navy"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <label htmlFor={sortId} className="text-sm text-ink-2">
              Sort
            </label>
            <select
              id={sortId}
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as SortKey);
                resetView();
              }}
              className={`${controlBase} px-2.5`}
            >
              {SORTS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div role="status" aria-live="polite" className="print:hidden">
        {filteredView && (
          <p className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line bg-canvas/70 px-5 py-2 text-xs text-ink-2 sm:px-6">
            <span>
              Showing {filtered.length.toLocaleString("en-US")} of{" "}
              {items.length.toLocaleString("en-US")} opportunities. This filters
              the list only; report totals are unchanged.
            </span>
            {/* With no matches, the empty state below offers this instead. */}
            {filtered.length > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded font-semibold text-navy hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
              >
                Clear filters
              </button>
            )}
          </p>
        )}
      </div>
      {filtered.length > 0 && (
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
      )}
      {filtered.length === 0 && (
        <div className="px-5 py-12 text-center sm:px-6">
          <span
            aria-hidden
            className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-canvas text-ink-3 ring-1 ring-inset ring-line"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.5 10.5 3 3" />
            </svg>
          </span>
          <p className="mt-3 font-semibold text-ink">No matching opportunities</p>
          <p className="mt-1 text-sm text-ink-2">
            {needle
              ? `Nothing in this report matches \u201c${query.trim()}\u201d${recency !== "all" ? " with this filter" : ""}.`
              : "No opportunities fall in this date range."}
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className={`${button.secondary} ${size.md} mt-4`}
          >
            Clear filters
          </button>
        </div>
      )}
      <ol
        ref={listRef}
        id={listId}
        className="divide-y divide-line/70 border-line/70 lg:border-t"
      >
        {filtered.slice(0, printed).map((o, i) => (
          <Row
            key={o.id}
            o={o}
            rank={rankOf.get(o.id) ?? i + 1}
            format={format}
            printOnly={i >= visible}
            revealDelay={i >= revealFrom && i < visible ? (i - revealFrom) * 45 : undefined}
          />
        ))}
      </ol>
      {printed < filtered.length && (
        <p className="hidden border-t border-line px-6 py-3 text-xs text-ink-3 print:block">
          Showing the {printed} largest of {filtered.length.toLocaleString("en-US")}{" "}
          opportunities. Download the CSV for the full list.
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
            {filtered.length.toLocaleString("en-US")}
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
