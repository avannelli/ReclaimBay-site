"use client";

import { useEffect, useRef, useState } from "react";
import {
  allocatePercents,
  formatAverage,
  formatDateTime,
  moneyFormat,
  undatedSplitNote,
} from "@/lib/format";
import { buildOpportunitiesCsv, exportFileName } from "@/lib/exportCsv";
import { downloadSummaryPdf } from "@/lib/pdfReport";
import { readTourState, saveTourState, type TourState } from "@/lib/prefs";
import { scrollPageTo } from "@/lib/scroll";
import { buildSummaryText } from "@/lib/summaryText";
import type { Analysis } from "@/lib/types";
import BarBreakdown from "./BarBreakdown";
import { CountUp, FillBar, Reveal } from "./motion";
import OpportunityList from "./OpportunityList";
import { Dialog, InfoTip, dialogPrimary, dialogSecondary } from "./overlay";
import PrivacyBadge from "./PrivacyBadge";
import ReportTour from "./ReportTour";
import SummaryBar from "./SummaryBar";

interface Props {
  fileName: string;
  analysis: Analysis;
  isSample: boolean;
  /** When this report was analyzed, in the viewer's local time. */
  analyzedAt: Date;
  onReset: () => void;
}

/** Fallback for browsers that block the async clipboard API. */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** How many of the largest jobs the hero spotlight adds up. */
const LEAD_N = 5;

// The largest category gets the amber accent; the rest stay navy or slate.
const CATEGORY_TONE = (i: number) =>
  i === 0 ? "bg-opportunity" : i < 4 ? "bg-navy/85" : "bg-slate-400";

// Newer work gets warmer bars; older work fades to gray.
const AGE_BAR = [
  "bg-opportunity",
  "bg-opportunity/45",
  "bg-slate-400",
  "bg-slate-300",
  "bg-slate-300",
];

function Card({
  title,
  subtitle,
  flush = false,
  children,
  className = "",
  id,
  tour,
}: {
  id?: string;
  /** Marks the section as a report-tour step. */
  tour?: string;
  title: string;
  subtitle?: string;
  /** Lets the content run edge to edge (used by the ranked list). */
  flush?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      data-tour={tour}
      className={`scroll-mt-20 overflow-hidden rounded-2xl border border-line bg-surface shadow-card ${className}`}
    >
      <header className="flex items-start gap-3 border-b border-line/80 bg-linear-to-b from-canvas to-surface px-5 py-4 sm:px-6">
        <span aria-hidden className="mt-1 h-4 w-1 shrink-0 rounded-full bg-navy" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-navy">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-sm text-ink-3">{subtitle}</p>}
        </div>
      </header>
      <div className={flush ? "" : "px-5 py-5 sm:px-6 sm:pb-6"}>
        {children}
      </div>
    </section>
  );
}

const statIcon = (d: string) => (
  <svg
    viewBox="0 0 16 16"
    className="h-4 w-4"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

/**
 * Semantic treatments for the summary cards: neutral count, cool average,
 * amber for the single largest job, emerald for recent dollar value.
 */
const TONES = {
  neutral: {
    accent: "bg-slate-400",
    wash: "from-slate-100/80",
    icon: "bg-slate-100 text-slate-600 ring-slate-200",
    value: "text-ink",
    valueLarge: "text-ink",
    glyph: statIcon("M6 4.5h7M6 8h7M6 11.5h7M3 4.5h.01M3 8h.01M3 11.5h.01"),
  },
  secondary: {
    accent: "bg-navy/70",
    wash: "from-navy/[0.05]",
    icon: "bg-navy/[0.07] text-navy ring-navy/10",
    value: "text-navy",
    valueLarge: "text-navy",
    glyph: statIcon("M3 8h10M8 4.5h.01M8 11.5h.01"),
  },
  amber: {
    accent: "bg-opportunity",
    wash: "from-opportunity-soft",
    icon: "bg-opportunity-soft text-opportunity-ink ring-opportunity/25",
    value: "text-opportunity-ink",
    valueLarge: "text-opportunity-hover",
    glyph: statIcon("M8 13V3.5M4.5 7 8 3.5 11.5 7"),
  },
  green: {
    accent: "bg-positive",
    wash: "from-positive-soft",
    icon: "bg-positive-soft text-positive-ink ring-positive/20",
    value: "text-positive-ink",
    valueLarge: "text-positive",
    glyph: statIcon("M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 5v3l2 1.5"),
  },
};

function Stat({
  label,
  value,
  note,
  help,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  /** Explains a term in the note. */
  help?: { label: string; text: string };
  tone: keyof typeof TONES;
}) {
  const t = TONES[tone];
  // Two cards share a phone-width row, so long figures step down in size.
  // Brand amber/emerald meet contrast only at large sizes (24px+), so long
  // figures that step down use the deeper text shades instead.
  const large = value.length <= 8;
  const size =
    large
      ? "text-2xl sm:text-3xl"
      : value.length <= 10
        ? "text-xl sm:text-3xl"
        : "text-base sm:text-2xl";
  return (
    <div className="relative h-full overflow-hidden rounded-2xl border border-line bg-surface p-4 shadow-card transition duration-200 hover:-translate-y-0.5 hover:shadow-lift sm:p-5">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${t.accent}`} />
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-20 bg-linear-to-b to-transparent ${t.wash}`}
      />
      <div className="relative flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
        <p className="text-[10px] font-semibold uppercase leading-4 tracking-[0.08em] text-ink-3 sm:pt-1 sm:text-[11px] sm:tracking-[0.12em]">
          {label}
        </p>
        <span
          aria-hidden
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset ${t.icon}`}
        >
          {t.glyph}
        </span>
      </div>
      <p
        className={`relative mt-2 font-semibold tracking-tight tabular-nums wrap-anywhere sm:mt-3 ${size} ${large ? t.valueLarge : t.value}`}
      >
        {value}
      </p>
      {note && (
        <p className="relative mt-1 text-xs leading-snug text-ink-3 sm:text-sm">
          <span className="line-clamp-2" title={note}>
            {note}
            {help && <InfoTip label={help.label} text={help.text} className="ml-1" />}
          </span>
        </p>
      )}
    </div>
  );
}

const actionIcon = (d: string) => (
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

const ICONS = {
  upload: actionIcon("M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"),
  pdf: actionIcon("M11.5 3H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 17h8a1.5 1.5 0 0 0 1.5-1.5V7zM11.5 3v4h4M10 9.5v5M7.75 12.25 10 14.5l2.25-2.25"),
  csv: actionIcon("M3.5 4.5h13v11h-13zM3.5 8.5h13M3.5 12h13M8 8.5v7"),
};

/** Secondary action; kept quiet so it never competes with the results. */
function ActionButton({
  onClick,
  icon,
  className = "",
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-surface px-3.5 py-2 text-center text-sm font-semibold leading-tight text-navy shadow-sm transition-colors duration-150 enabled:hover:border-slate-400 enabled:hover:bg-canvas enabled:active:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy disabled:cursor-progress disabled:opacity-60 sm:col-span-1 sm:h-10 sm:py-0 ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

/** Low-emphasis text action, kept quieter than the main report actions. */
function UtilityAction({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-medium text-ink-2 transition-colors duration-150 hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
    >
      {icon}
      {children}
    </button>
  );
}

const UTILITY_ICONS = {
  copy: actionIcon("M7 7V4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5v7a1.5 1.5 0 0 1-1.5 1.5H13M4.5 7h7A1.5 1.5 0 0 1 13 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 15.5v-7A1.5 1.5 0 0 1 4.5 7z"),
  check: actionIcon("m4.5 10.5 3.5 3.5 7.5-8"),
  tour: actionIcon("M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM12.9 7.1l-1.6 4.2-4.2 1.6 1.6-4.2z"),
};

export default function Dashboard({
  fileName,
  analysis: a,
  isSample,
  analyzedAt,
  onReset,
}: Props) {
  const { recency } = a;
  // One money format for the whole report: cents everywhere, or nowhere.
  const money = moneyFormat(a.showCents);
  const uploadLabel = isSample ? "Upload your own report" : "Upload another report";

  // The report lives only in this tab, so replacing it asks first. The
  // sample has nothing worth keeping and is replaced straight away.
  const [confirmReplace, setConfirmReplace] = useState(false);
  const requestReset = () => (isSample ? onReset() : setConfirmReplace(true));

  // Offer the tour once, after the headline total has landed.
  const [tour, setTour] = useState<"prompt" | "running" | null>(null);
  useEffect(() => {
    if (readTourState() !== null) return;
    const id = window.setTimeout(() => setTour((t) => t ?? "prompt"), 1600);
    return () => window.clearTimeout(id);
  }, []);
  const finishTour = (state: TourState) => {
    saveTourState(state);
    setTour(null);
    // Finishing (not dismissing) the tour hands the report back from the top.
    if (state === "completed") scrollPageTo(0);
  };

  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const copySummary = async () => {
    const text = buildSummaryText({ analysis: a, fileName, isSample, analyzedAt });
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    setCopyStatus(ok ? "copied" : "failed");
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyStatus("idle"), 2500);
  };
  const {
    skippedRows,
    confirmedDuplicateRows,
    possibleDuplicateRows,
    possibleDuplicateValue,
  } = a.quality;
  // Displayed percentages always add up to exactly 100.
  const [recentPct, olderPct] = allocatePercents([
    recency.recent.value,
    recency.older.value,
  ]);

  const notes = [
    skippedRows > 0 &&
      `${plural(skippedRows, "row was", "rows were")} left out because the declined amount was blank, unreadable, zero, or negative.`,
    confirmedDuplicateRows > 0 &&
      `${plural(confirmedDuplicateRows, "confirmed duplicate", "confirmed duplicates")} removed. ${confirmedDuplicateRows === 1 ? "A repeated unique record ID contained an otherwise identical record, so it was" : "Repeated unique record IDs contained otherwise identical records, so each was"} counted once.`,
    possibleDuplicateRows > 0 &&
      `${plural(possibleDuplicateRows, "possible duplicate", "possible duplicates")} preserved (${money(possibleDuplicateValue)}). ${possibleDuplicateRows === 1 ? "It matches" : "They match"} another row on customer, vehicle, service, amount, and date, but with no unique record ID to confirm, ${possibleDuplicateRows === 1 ? "it stays" : "they stay"} in the totals. Review ${possibleDuplicateRows === 1 ? "it" : "them"} in the list below.`,
    a.hasDates &&
      a.undatedCount > 0 &&
      `${plural(a.undatedCount, "opportunity has", "opportunities have")} a missing or unreadable date (${money(a.undated.value)}). ${a.undatedCount === 1 ? "It is" : "They are"} included in the totals, shown as "Unknown / invalid date" in the age breakdown, and left out of the recent/older split.`,
    !a.hasDates &&
      "No usable dates were found, so the age breakdowns aren't shown.",
  ].filter((n): n is string => Boolean(n));

  // Long totals (e.g. $1,234,567) step down in size so they never overflow.
  const heroText = money(a.total);
  const heroSize =
    heroText.length <= 8
      ? "text-6xl sm:text-8xl"
      : heroText.length <= 10
        ? "text-5xl sm:text-7xl"
        : "text-4xl sm:text-6xl";

  const showRecent = a.hasDates && recency.recent.count > 0;

  const heroRef = useRef<HTMLElement>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const leadValue = a.ranked
    .slice(0, LEAD_N)
    .reduce((s, o) => s + o.amount, 0);
  const leadPct = Math.round((leadValue / a.total) * 100);
  const showLead = a.count > LEAD_N;

  const exportSource = { fileName, isSample, date: analyzedAt };

  // Everything is generated in this tab; nothing is sent anywhere.
  const exportCsv = () => {
    const csv = buildOpportunitiesCsv(a.ranked);
    const url = URL.createObjectURL(
      new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName("opportunities", "csv", exportSource);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  // Builds the summary PDF in the browser and downloads it directly.
  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadSummaryPdf(
        { analysis: a, fileName, isSample, notes, analyzedAt },
        exportFileName("report", "pdf", exportSource),
      );
    } catch {
      window.alert("We couldn't create the PDF. Please try again.");
    } finally {
      setPdfBusy(false);
    }
  };

  const actions = (
    <>
      <ActionButton onClick={requestReset} icon={ICONS.upload} className="col-span-2">
        {uploadLabel}
      </ActionButton>
      <ActionButton
        onClick={downloadPdf}
        icon={ICONS.pdf}
        disabled={pdfBusy}
        title="PDF summary of this analysis"
      >
        Download report
      </ActionButton>
      <ActionButton
        onClick={exportCsv}
        icon={ICONS.csv}
        title="CSV of every opportunity"
      >
        Export opportunities
      </ActionButton>
    </>
  );

  return (
    <div className="space-y-5">
      <SummaryBar
        watchRef={heroRef}
        total={a.total}
        count={a.count}
        format={money}
        isSample={isSample}
        uploadLabel={uploadLabel}
        onReset={requestReset}
        onPdf={downloadPdf}
        onCsv={exportCsv}
        pdfBusy={pdfBusy}
        suppressed={tour !== null || confirmReplace}
      />
      <Reveal className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="eyebrow text-ink-2">ReclaimBay report</p>
          <h1 className="mt-1 wrap-anywhere text-lg font-semibold tracking-tight text-ink">
            {fileName}
          </h1>
          <p className="mt-0.5 text-sm text-ink-3">
            Analyzed {formatDateTime(analyzedAt)}
          </p>
        </div>
        <div className="flex flex-col gap-2.5 lg:items-end print:hidden">
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
            {actions}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <UtilityAction
              onClick={copySummary}
              icon={copyStatus === "copied" ? UTILITY_ICONS.check : UTILITY_ICONS.copy}
            >
              {/* Both labels share one grid cell so the width never changes. */}
              <span className="grid">
                <span aria-hidden className="invisible col-start-1 row-start-1">
                  Summary copied
                </span>
                <span className="col-start-1 row-start-1 text-left">
                  {copyStatus === "copied"
                    ? "Summary copied"
                    : copyStatus === "failed"
                      ? "Copy failed"
                      : "Copy summary"}
                </span>
              </span>
            </UtilityAction>
            <UtilityAction onClick={() => setTour("running")} icon={UTILITY_ICONS.tour}>
              Take report tour
            </UtilityAction>
            <span role="status" className="sr-only">
              {copyStatus === "copied"
                ? "Summary copied to the clipboard"
                : copyStatus === "failed"
                  ? "Copying failed. Your browser blocked clipboard access."
                  : ""}
            </span>
          </div>
        </div>
      </Reveal>

      {isSample && (
        <Reveal delay={60}>
          <p className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5 rounded-xl border border-navy/10 bg-navy/[0.035] px-4 py-3 text-sm text-ink-2 sm:flex-nowrap">
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="mt-0.5 h-4 w-4 shrink-0 text-navy"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <circle cx="8" cy="8" r="6" />
              <path d="M8 7.25v3.5M8 5.25h.01" />
            </svg>
            <span className="flex-1">
              You&apos;re viewing a sample report built from made-up data.
              Upload your own file to see your shop&apos;s numbers.
            </span>
            <button
              type="button"
              onClick={onReset}
              className="shrink-0 rounded font-semibold text-navy underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy print:hidden"
            >
              Upload your own report
            </button>
          </p>
        </Reveal>
      )}

      <Reveal delay={100}>
        <section
          ref={heroRef}
          data-tour="total"
          className="relative overflow-hidden rounded-2xl bg-navy-deep px-6 py-9 text-white shadow-xl shadow-navy-deep/15 ring-1 ring-white/5 break-inside-avoid sm:px-10 sm:py-11 lg:px-12"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_0%_0%,var(--color-navy)_0%,transparent_65%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.06)_1px,transparent_1px)] bg-size-[22px_22px] mask-[linear-gradient(to_right,transparent,black_75%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-32 h-96 w-96 rounded-full bg-slate-400/10 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-linear-to-r from-transparent via-opportunity/70 to-transparent"
          />
          <div className="relative grid gap-8 lg:grid-cols-12 lg:items-end lg:gap-10">
            <div className={`min-w-0 ${showLead ? "lg:col-span-7" : "lg:col-span-12"}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="eyebrow text-opportunity">Declined work identified</p>
                {isSample && (
                  <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-slate-200 ring-1 ring-inset ring-white/15">
                    Sample report
                  </span>
                )}
              </div>
              <p
                className={`mt-4 font-semibold leading-none tracking-tight tabular-nums ${heroSize}`}
              >
                <CountUp
                  value={a.total}
                  format={money}
                  settleClassName="origin-left animate-settle motion-reduce:animate-none"
                />
              </p>
              <div className="mt-7 flex flex-col gap-2 border-t border-white/10 pt-5 text-base text-slate-300 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8">
                <p>
                  <span className="font-semibold text-white">
                    {a.count.toLocaleString("en-US")}
                  </span>{" "}
                  {a.count === 1 ? "opportunity" : "opportunities"} found
                </p>
                {showRecent && (
                  <p className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-positive-bright"
                    />
                    <span>
                      <span className="font-semibold text-positive-bright">
                        {money(recency.recent.value)}
                      </span>{" "}
                      declined in the last {recency.thresholdDays} days
                    </span>
                  </p>
                )}
              </div>
              <PrivacyBadge onDark className="mt-5" />
            </div>

            {showLead && (
              <div className="min-w-0 rounded-2xl bg-navy p-5 shadow-lg shadow-navy-deep/40 ring-1 ring-inset ring-white/10 sm:p-6 lg:col-span-5">
                <p className="eyebrow text-slate-400">
                  Largest {LEAD_N} opportunities
                </p>
                <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums text-white">
                  {money(leadValue)}
                </p>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <FillBar percent={leadPct} className="bg-opportunity" delayMs={700} />
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  <span className="font-semibold text-opportunity">{leadPct}%</span>{" "}
                  of all declined value sits in these {LEAD_N} jobs.
                </p>
                <a
                  href="#opportunities"
                  className="group mt-5 inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-opportunity transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-opportunity print:hidden"
                >
                  Review these jobs
                  <svg
                    aria-hidden
                    viewBox="0 0 16 16"
                    className="h-4 w-4 transition-transform duration-200 group-hover:translate-y-0.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M8 3v10M4 9l4 4 4-4" />
                  </svg>
                </a>
              </div>
            )}
          </div>
        </section>
      </Reveal>

      <div
        className={`grid grid-cols-2 gap-3 break-inside-avoid sm:gap-4 ${
          a.hasDates ? "lg:grid-cols-4" : "lg:grid-cols-3"
        }`}
      >
        <Reveal delay={220}>
          <Stat
            tone="neutral"
            label="Declined opportunities"
            value={a.count.toLocaleString("en-US")}
            note="Opportunities included in this analysis"
          />
        </Reveal>
        <Reveal delay={280}>
          <Stat
            tone="secondary"
            label="Average opportunity"
            value={formatAverage(a.average, a.showCents)}
            note="Per declined job"
          />
        </Reveal>
        <Reveal
          delay={340}
          className={a.hasDates ? "" : "col-span-2 lg:col-span-1"}
        >
          <Stat
            tone="amber"
            label="Highest-value opportunity"
            value={money(a.highest.amount)}
            note={a.highest.service}
          />
        </Reveal>
        {a.hasDates && (
          <Reveal delay={400}>
            <Stat
              tone="green"
              label={`Declined in last ${recency.thresholdDays} days`}
              value={money(recency.recent.value)}
              note={`${recentPct}% of dated declined value`}
              help={{
                label: "dated declined value",
                text: "Declined work that has a usable date. Opportunities without one count toward the total but can't be placed as recent or older.",
              }}
            />
          </Reveal>
        )}
      </div>

      <Reveal delay={200}>
        <Card
          flush
          id="opportunities"
          tour="opportunities"
          title="Highest-value opportunities"
          subtitle="The largest declined jobs in this report."
        >
          <OpportunityList
            items={a.ranked}
            format={money}
            hasDates={a.hasDates}
            undatedCount={a.undatedCount}
          />
        </Card>
      </Reveal>

      {a.hasDates && (
        <Reveal delay={240}>
          <Card
            tour="recency"
            title="How recently the work was declined"
            subtitle={`Split at ${recency.thresholdDays} days since the work was declined.`}
            className="break-inside-avoid"
          >
            <div className="flex h-3 gap-1 overflow-hidden rounded-full bg-slate-100">
              <FillBar percent={recentPct} className="bg-opportunity" />
              <FillBar
                percent={olderPct}
                className="bg-slate-300"
                delayMs={350}
              />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-4">
              {[
                { b: recency.recent, pct: recentPct, dot: "bg-opportunity", end: false },
                { b: recency.older, pct: olderPct, dot: "bg-slate-300", end: true },
              ].map(({ b, pct, dot, end }) => (
                <div key={b.label} className={end ? "text-right" : ""}>
                  <dt
                    className={`flex items-center gap-2 text-xs font-medium text-ink-2 ${
                      end ? "justify-end" : ""
                    }`}
                  >
                    <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
                    {b.label}
                  </dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-ink sm:text-3xl">
                    {money(b.value)}
                  </dd>
                  <dd className="mt-0.5 text-xs tabular-nums text-ink-3 sm:text-sm">
                    {b.count ? pct : 0}% of value ·{" "}
                    {plural(b.count, "opportunity", "opportunities")}
                  </dd>
                </div>
              ))}
            </dl>
            {a.undatedCount > 0 && (
              <p className="mt-4 border-t border-line pt-3 text-xs text-ink-3 sm:text-sm">
                {undatedSplitNote(a.undatedCount, a.undated.value, money)}
              </p>
            )}
          </Card>
        </Reveal>
      )}

      {a.hasDates && (
        <Reveal delay={280}>
          <Card
            title="When the work was declined"
            subtitle="Declined value by days since the estimate."
            className="break-inside-avoid"
          >
            <BarBreakdown
              layout="rows"
              buckets={a.ageBuckets}
              unknown={a.undated}
              format={money}
              barClass={(_, i) => AGE_BAR[i] ?? "bg-slate-300"}
            />
          </Card>
        </Reveal>
      )}

      <Reveal delay={a.hasDates ? 320 : 240}>
        <Card
          tour="categories"
          title="Where declined value is concentrated"
          subtitle="Grouped by service category."
          className="break-inside-avoid"
        >
          <BarBreakdown
            layout="columns"
            buckets={a.categories}
            format={money}
            barClass={(_, i) => CATEGORY_TONE(i)}
            dotClass={(_, i) => CATEGORY_TONE(i)}
          />
        </Card>
      </Reveal>

      <Reveal delay={100}>
        <details
          className="group rounded-xl border border-line bg-surface/70 text-sm text-ink-2"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-3.5 transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-navy sm:px-6 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2 font-medium text-ink">
              About this analysis
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="h-4 w-4 text-ink-3 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m4 6 4 4 4-4" />
              </svg>
            </span>
            <span className="text-xs text-ink-3">
              {notes.length === 0
                ? "No file-quality issues detected"
                : plural(notes.length, "file note", "file notes")}
            </span>
          </summary>
          <div className="border-t border-line px-5 py-4 sm:px-6">
            {notes.length === 0 ? (
              <p>No file-quality issues detected.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5">
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </Reveal>

      <Reveal delay={100} className="print:hidden">
        <section
          data-tour="exports"
          className="flex flex-col gap-4 rounded-2xl border border-navy/10 bg-navy/[0.03] px-5 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between"
        >
          <div>
            <h2 className="text-base font-semibold tracking-tight text-navy">
              Save or share this analysis
            </h2>
            <p className="mt-0.5 text-sm text-ink-3">
              A PDF summary and a CSV of every opportunity, created on this
              device. Nothing is uploaded.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:shrink-0 lg:flex-nowrap">
            <ActionButton
              onClick={downloadPdf}
              icon={ICONS.pdf}
              disabled={pdfBusy}
              title="PDF summary of this analysis"
            >
              Download report
            </ActionButton>
            <ActionButton
              onClick={exportCsv}
              icon={ICONS.csv}
              title="CSV of every opportunity"
            >
              Export opportunities
            </ActionButton>
            <ActionButton onClick={requestReset} icon={ICONS.upload} className="col-span-2">
              {uploadLabel}
            </ActionButton>
          </div>
        </section>
      </Reveal>

      {confirmReplace && (
        <Dialog
          title="Replace this report?"
          onClose={() => setConfirmReplace(false)}
          actions={
            <>
              <button
                type="button"
                data-autofocus
                onClick={() => setConfirmReplace(false)}
                className={dialogSecondary}
              >
                Cancel
              </button>
              <button type="button" onClick={onReset} className={dialogPrimary}>
                Replace report
              </button>
            </>
          }
        >
          This report only exists in your browser. Uploading another file will
          clear the current analysis.
        </Dialog>
      )}

      {tour === "prompt" && (
        <Dialog
          title="Want a 30-second tour of your report?"
          onClose={() => finishTour("dismissed")}
          actions={
            <>
              <button
                type="button"
                onClick={() => finishTour("dismissed")}
                className={dialogSecondary}
              >
                Not now
              </button>
              <button
                type="button"
                data-autofocus
                onClick={() => setTour("running")}
                className={dialogPrimary}
              >
                Show me
              </button>
            </>
          }
        >
          I&apos;ll show you where the most important insights are and what
          they mean.
        </Dialog>
      )}
      {tour === "running" && <ReportTour onFinish={finishTour} />}
    </div>
  );
}
