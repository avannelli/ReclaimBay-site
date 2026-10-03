"use client";

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { LockIcon } from "./PrivacyBadge";
import { button, size } from "./ui";

interface Props {
  /** Focus the upload button on arrival (after clearing a report). */
  focusOnMount?: boolean;
  onFile: (file: File) => void;
  onSample: () => void;
  busy: boolean;
  error: string | null;
}

const icon = (d: string) => (
  <svg
    aria-hidden
    viewBox="0 0 24 24"
    className="h-5 w-5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

const STEPS: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "Export",
    body: "Run the declined or deferred work report in your shop management system.",
    icon: icon("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14l3 3 3-3"),
  },
  {
    title: "Upload",
    body: "Drop the CSV or Excel file here. It never leaves your browser.",
    icon: icon("M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"),
  },
  {
    title: "See the opportunity",
    body: "Get the total value, the largest jobs, and where the opportunity is concentrated.",
    icon: icon("M4 20V10M10 20V4M16 20v-7M22 20H2"),
  },
];

const TRUST = ["Private by design", "Browser-only analysis", "No account required"];

const EXAMPLE_ROWS: [string, string, string, string][] = [
  ["Timing belt and water pump", "2014 Ford F-150", "12 days ago", "$1,285"],
  ["Front struts and mounts", "2012 Chevrolet Silverado", "41 days ago", "$1,140"],
  ["Radiator replacement", "2013 Honda Accord", "96 days ago", "$920"],
];

const EXAMPLE_STATS: [string, string, string][] = [
  ["Opportunities", "36", "text-white"],
  ["Average value", "$1,185", "text-white"],
  ["Last 90 days", "$8,920", "text-positive-bright"],
];

/** The raw export the example starts from; matches EXAMPLE_ROWS. */
const EXAMPLE_RAW: [string, string, string, string, string][] = [
  ["10482", "R. OKAFOR", "TIMING BELT AND WATER PUMP", "1285.00", "09/18/26"],
  ["10417", "M. DIAZ", "FRONT STRUTS AND MOUNTS", "1140.00", "08/20/26"],
  ["10251", "J. PATEL", "RADIATOR REPLACEMENT", "920.00", "06/26/26"],
];

/**
 * A numbered step in the example. `thread` draws a short line up from its
 * number to the block above, so export, result, and jobs read as one flow.
 */
const stepLabel = (n: number, text: string, thread?: "h-3" | "h-4") => (
  <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
    <span className="relative grid h-4 w-4 place-items-center rounded-full bg-surface text-[10px] tracking-normal text-navy ring-1 ring-inset ring-navy/20">
      {thread && (
        <span aria-hidden className={`absolute bottom-full left-1/2 w-px -translate-x-1/2 bg-navy/15 ${thread}`} />
      )}
      {n}
    </span>
    {text}
  </p>
);

/*
 * While dragging, browsers expose only a MIME type, not the file name. CSVs
 * often arrive as Excel's type or with no type at all, so anything in this
 * set (or blank) looks valid; the name is checked for real on drop.
 */
const SPREADSHEET_TYPES = new Set([
  "",
  "text/csv",
  "text/plain",
  "application/csv",
  "text/x-csv",
  "text/comma-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

type DragState = "idle" | "valid" | "invalid";

function dragStateOf(e: DragEvent): DragState {
  const files = [...e.dataTransfer.items].filter((i) => i.kind === "file");
  if (files.length === 0) return "idle";
  return SPREADSHEET_TYPES.has(files[0].type) ? "valid" : "invalid";
}

export default function UploadPanel({
  focusOnMount = false,
  onFile,
  onSample,
  busy,
  error,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const [drag, setDrag] = useState<DragState>("idle");

  useEffect(() => {
    if (focusOnMount) uploadRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file && !busy) onFile(file);
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mx-auto max-w-3xl text-center">
        <p className="eyebrow text-ink-2">For independent repair shops</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance text-navy sm:text-5xl lg:text-[3.4rem] lg:leading-[1.06]">
          See how much{" "}
          <span className="highlight whitespace-nowrap px-[0.06em]">
            declined work
          </span>{" "}
          is sitting in your shop.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-pretty text-ink-2">
          Upload your declined-work report and instantly see the total value,
          highest-value jobs, and where the opportunity is concentrated.
        </p>
      </div>

      <div className="mx-auto mt-10 max-w-3xl rounded-3xl border border-line bg-surface p-2.5 shadow-lift sm:p-3">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            const next = busy ? "idle" : dragStateOf(e);
            if (next !== drag) setDrag(next);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDrag("idle");
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDrag("idle");
            pick(e.dataTransfer.files);
          }}
          aria-busy={busy}
          className={`rounded-2xl border-2 border-dashed px-5 py-10 text-center transition-colors duration-150 sm:px-10 sm:py-12 ${
            drag === "valid"
              ? "border-opportunity bg-opportunity-soft/40"
              : drag === "invalid"
                ? "border-danger/50 bg-danger-soft/70"
                : "border-navy/15 bg-canvas/70 hover:border-navy/25"
          }`}
        >
          {/* Opened by the upload button, so it stays out of the tab order. */}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = "";
            }}
          />
          {/* The logo's language at rest: a navy tile with a gold arrow rising out of the tray. */}
          <div
            className={`mx-auto grid h-16 w-16 place-items-center rounded-2xl ring-1 ring-inset transition duration-150 motion-reduce:transition-none ${
              drag === "valid"
                ? "scale-105 bg-opportunity-soft text-opportunity-ink ring-opportunity/50"
                : drag === "invalid"
                  ? "bg-danger-soft text-danger ring-danger/30"
                  : "bg-linear-to-b from-navy-2 to-navy text-white ring-white/10 shadow-[0_10px_22px_-12px_rgb(11_34_56/0.7)]"
            } ${busy ? "motion-safe:animate-pulse" : ""}`}
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-8 w-8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
              <path
                d="M12 15V4M7.5 8.5 12 4l4.5 4.5"
                className={drag === "idle" ? "text-opportunity" : ""}
              />
            </svg>
          </div>
          <p
            aria-live="polite"
            className="mt-5 text-lg font-semibold tracking-tight text-balance text-ink sm:text-xl"
          >
            {busy
              ? "Analyzing declined work…"
              : drag === "valid"
                ? "Drop file to scan"
                : drag === "invalid"
                  ? "This file type isn’t supported"
                  : (
                    // Kept whole, so narrow screens never break it as "declined- / work".
                    <>
                      Drop your <span className="whitespace-nowrap">declined-work</span> report here
                    </>
                  )}
          </p>
          <p className="mt-1 text-sm text-ink-3">
            {drag === "invalid"
              ? "Upload a CSV or XLSX report."
              : busy
                ? "This happens in your browser and only takes a moment."
                : "or choose a file from your computer"}
          </p>

          <div className="mt-7 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <button
              ref={uploadRef}
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className={`${button.primary} ${size.lg}`}
            >
              Upload declined-work report
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onSample}
              className={`${button.secondary} ${size.lg}`}
            >
              Try a sample report
            </button>
          </div>

          <p className="mt-6 flex flex-wrap items-center justify-center gap-2 text-xs text-ink-3">
            <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono font-medium text-ink-2 ring-1 ring-inset ring-line">
              .CSV
            </span>
            <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono font-medium text-ink-2 ring-1 ring-inset ring-line">
              .XLSX
            </span>
            <span>Up to 15 MB</span>
          </p>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mx-auto mt-4 max-w-3xl rounded-xl border border-danger/25 border-l-4 border-l-danger bg-danger-soft px-4 py-3 text-sm text-ink"
        >
          {error}
        </p>
      )}

      <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-ink-2">
        {TRUST.map((t) => (
          <li key={t} className="inline-flex items-center gap-1.5">
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="h-4 w-4 text-navy"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m3.5 8.5 3 3 6-7" />
            </svg>
            {t}
          </li>
        ))}
      </ul>

      <section className="mx-auto mt-20 max-w-4xl">
        <h2 className="eyebrow text-center text-ink-2">How it works</h2>
        {/*
         * One path from your data to the result, not three separate cards:
         * a line runs through the steps and warms to amber at the outcome.
         * A vertical path on phones; one row from tablet width up.
         */}
        <div className="relative mx-auto mt-8 max-w-md sm:mt-10 sm:max-w-none">
          <div
            aria-hidden
            className="pointer-events-none absolute top-6 right-[calc(100%/6-8px)] left-[calc(100%/6-8px)] hidden h-px bg-linear-to-r from-navy/15 via-navy/25 to-opportunity sm:block"
          />
          {["left-[calc(100%/3-4px)]", "left-[calc(200%/3+4px)]"].map((pos) => (
            <svg
              key={pos}
              aria-hidden
              viewBox="0 0 16 16"
              className={`pointer-events-none absolute top-6 hidden h-4 w-4 -translate-1/2 bg-canvas text-navy/35 sm:block ${pos}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 4 4 4-4 4" />
            </svg>
          ))}
          <ol className="relative grid sm:grid-cols-3 sm:gap-6">
            {STEPS.map((s, i) => {
              const outcome = i === STEPS.length - 1;
              return (
                <li
                  key={s.title}
                  className="relative flex gap-4 pb-8 last:pb-0 sm:flex-col sm:items-center sm:gap-0 sm:pb-0 sm:text-center"
                >
                  {!outcome && (
                    <span
                      aria-hidden
                      className="absolute top-12 bottom-0 left-6 w-px bg-linear-to-b from-navy/20 to-navy/10 sm:hidden"
                    />
                  )}
                  <span
                    className={`relative grid h-12 w-12 shrink-0 place-items-center rounded-xl ${
                      outcome
                        ? "bg-linear-to-b from-navy-2 to-navy text-opportunity shadow-[0_10px_22px_-12px_rgb(11_34_56/0.7)]"
                        : "bg-surface text-navy shadow-card ring-1 ring-inset ring-line"
                    }`}
                  >
                    {s.icon}
                  </span>
                  <div className="min-w-0 pt-0.5 sm:mt-5 sm:pt-0">
                    <p
                      className={`text-[11px] font-semibold tracking-[0.12em] tabular-nums ${
                        outcome ? "text-opportunity-ink" : "text-ink-3"
                      }`}
                    >
                      0{i + 1}
                    </p>
                    <p className="mt-1 font-semibold text-ink">{s.title}</p>
                    <p className="mt-1 text-sm leading-relaxed text-pretty text-ink-2 sm:mx-auto sm:max-w-60">
                      {s.body}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="mt-20">
        <div className="text-center">
          <p className="eyebrow text-ink-2">Example results</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-navy sm:text-3xl">
            What your scan will show
          </h2>
          <p className="mt-2 text-ink-2">
            Illustrative numbers. Your results come from your own report.
          </p>
        </div>

        <figure
          aria-label="Example results preview with illustrative numbers"
          className="mx-auto mt-8 max-w-4xl select-none rounded-3xl border border-line bg-surface p-2.5 shadow-card sm:p-3"
        >
          <div className="px-2 pb-3 pt-1 sm:px-3">
            <div className="flex items-center justify-between gap-3">
              {stepLabel(1, "Your export")}
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-navy/[0.05] px-2.5 py-1 text-xs font-medium text-navy ring-1 ring-inset ring-navy/10">
                <LockIcon className="h-3.5 w-3.5" />
                Processed locally
              </span>
            </div>
            <div className="mt-2.5 overflow-hidden rounded-lg border border-line font-mono text-[11px] leading-5 text-ink-3">
              <p className="truncate border-b border-line bg-canvas px-3 py-1 text-ink-2">
                declined-work-export.xlsx
                <span className="text-ink-3"> · 36 rows</span>
              </p>
              {EXAMPLE_RAW.map(([ro, customer, work, total, date]) => (
                <div
                  key={ro}
                  className="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-x-4 border-b border-line/70 px-3 py-0.5 last:border-b-0 sm:grid-cols-[3rem_6rem_minmax(0,1fr)_4.5rem_4.5rem]"
                >
                  <span className="hidden sm:block">{ro}</span>
                  <span className="hidden truncate sm:block">{customer}</span>
                  <span className="truncate">{work}</span>
                  <span className="text-right tabular-nums">{total}</span>
                  <span className="hidden text-right sm:block">{date}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="px-2 pb-2.5 sm:px-3">{stepLabel(2, "Your result", "h-3")}</div>
          {/* The signature surface: where the money is. Deep navy, lit from the top left, edged in gold. */}
          <div className="relative overflow-hidden rounded-2xl bg-navy-deep px-6 py-9 text-white shadow-[0_24px_48px_-30px_rgb(7_23_37/0.85)] ring-1 ring-inset ring-white/5 sm:px-10 sm:py-11">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_100%_at_0%_0%,var(--color-navy-2)_0%,var(--color-navy)_35%,transparent_75%)]"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-opportunity/70 to-transparent"
            />
            <span className="relative mb-4 inline-block rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-slate-200 ring-1 ring-inset ring-white/15 sm:absolute sm:right-4 sm:top-4 sm:mb-0">
              Example
            </span>
            <div className="relative">
              <p className="eyebrow text-opportunity">Declined work identified</p>
              <p className="mt-4 text-5xl leading-none font-semibold tracking-tight tabular-nums sm:text-6xl lg:text-7xl">
                $42,660
              </p>
              <dl className="mt-9 grid divide-y divide-white/10 rounded-xl bg-white/3 ring-1 ring-inset ring-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                {EXAMPLE_STATS.map(([label, value, tone]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-3 px-4 py-3 sm:block sm:px-5 sm:py-4"
                  >
                    <dt className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      {label}
                    </dt>
                    <dd
                      className={`text-lg font-semibold tabular-nums sm:mt-1 sm:text-2xl ${tone}`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
          <div className="px-2 pt-4 sm:px-3">{stepLabel(3, "The jobs behind it", "h-4")}</div>
          <ol className="divide-y divide-line px-2 pt-1 sm:px-4">
            {EXAMPLE_ROWS.map(([service, vehicle, age, amount], i) => (
              <li key={service} className="flex items-center gap-3 py-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-opportunity-soft text-xs font-semibold text-opportunity-ink ring-1 ring-inset ring-opportunity/30">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{service}</p>
                  <p className="text-xs text-ink-3">
                    {vehicle} · {age}
                  </p>
                </div>
                <p className="font-semibold tabular-nums text-ink">{amount}</p>
              </li>
            ))}
          </ol>
        </figure>
      </section>

      <section className="mx-auto mt-20 max-w-2xl text-center">
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-navy/[0.05] text-navy ring-1 ring-inset ring-navy/10">
          <LockIcon className="h-5 w-5" />
        </span>
        <h2 className="mt-4 text-lg font-semibold tracking-tight text-navy">
          Your customer data stays on your computer
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          ReclaimBay reads your report inside this browser tab. It is never
          sent to a server or saved. There&apos;s no account to create, and
          closing or refreshing the page clears everything.
        </p>
      </section>
    </div>
  );
}
