"use client";

import { useRef, useState, type ReactNode } from "react";
import { LockIcon } from "./PrivacyBadge";

interface Props {
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
    body: "Get the total value, the largest jobs, and where the money is concentrated.",
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
  ["Average value", "$1,186", "text-white"],
  ["Last 90 days", "$8,920", "text-positive-bright"],
];

export default function UploadPanel({ onFile, onSample, busy, error }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file && !busy) onFile(file);
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mx-auto max-w-3xl text-center">
        <p className="eyebrow text-ink-2">For independent auto repair shops</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance text-navy sm:text-5xl lg:text-[3.4rem] lg:leading-[1.06]">
          See how much{" "}
          <span className="highlight whitespace-nowrap px-[0.06em]">
            declined work
          </span>{" "}
          is sitting in your shop.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-pretty text-ink-2">
          Upload your declined-work report and instantly see the total value,
          highest-value opportunities, and where the money is concentrated.
        </p>
      </div>

      <div className="mx-auto mt-10 max-w-3xl rounded-3xl border border-line bg-surface p-2.5 shadow-lift sm:p-3">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files);
          }}
          className={`rounded-2xl border-2 border-dashed px-5 py-10 text-center transition-colors duration-200 sm:px-10 sm:py-12 ${
            dragging
              ? "border-opportunity bg-opportunity-soft/70"
              : "border-slate-300/80 bg-canvas/60"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx"
            className="sr-only"
            aria-label="Upload declined-work report"
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = "";
            }}
          />
          <div
            className={`mx-auto grid h-16 w-16 place-items-center rounded-2xl ring-1 ring-inset transition duration-200 ${
              dragging
                ? "scale-110 bg-opportunity-soft text-opportunity-ink ring-opportunity/40"
                : "bg-navy/5 text-navy ring-navy/10"
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
              <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
            </svg>
          </div>
          <p className="mt-5 text-lg font-semibold tracking-tight text-ink sm:text-xl">
            {busy
              ? "Reading your file…"
              : dragging
                ? "Drop to scan your report"
                : "Drop your declined-work report here"}
          </p>
          <p className="mt-1 text-sm text-ink-3">
            or choose a file from your computer
          </p>

          <div className="mt-7 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="inline-flex h-12 items-center justify-center rounded-lg bg-opportunity px-6 text-[15px] font-semibold text-navy-deep shadow-sm shadow-opportunity/30 transition hover:-translate-y-px hover:bg-opportunity-hover hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy disabled:opacity-60"
            >
              Upload declined-work report
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onSample}
              className="inline-flex h-12 items-center justify-center rounded-lg border border-slate-300 bg-surface px-6 text-[15px] font-semibold text-navy transition hover:border-slate-400 hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy disabled:opacity-60"
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
              className="h-4 w-4 text-positive"
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

      <section className="mt-20">
        <h2 className="eyebrow text-center text-ink-2">How it works</h2>
        {/* Two across with the last step centered beneath; one row on desktop. */}
        <ol className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="rounded-2xl border border-line bg-surface/70 p-4 last:col-span-2 last:w-[calc(50%-0.375rem)] last:justify-self-center sm:p-5 sm:last:w-[calc(50%-0.5rem)] lg:last:col-span-1 lg:last:w-auto"
            >
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-canvas text-navy ring-1 ring-inset ring-line">
                  {s.icon}
                </span>
                <span className="text-xs font-semibold tabular-nums text-ink-3">
                  0{i + 1}
                </span>
              </div>
              <p className="mt-4 font-semibold text-ink">{s.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
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
          className="mx-auto mt-8 max-w-4xl select-none rounded-3xl border border-line bg-surface p-2.5 shadow-lift sm:p-3"
        >
          <div className="flex items-center justify-between gap-3 px-2 pb-3 pt-1 sm:px-3">
            <div className="min-w-0">
              <p className="eyebrow text-ink-3">Scan results</p>
              <p className="truncate text-sm font-semibold text-ink">
                declined-work-export.xlsx
              </p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-positive-soft px-2.5 py-1 text-xs font-medium text-positive-ink ring-1 ring-inset ring-positive/20">
              <LockIcon className="h-3.5 w-3.5" />
              Processed locally
            </span>
          </div>
          <div className="relative overflow-hidden rounded-2xl bg-navy-deep px-6 py-8 text-white sm:px-10 sm:py-10">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_0%_0%,var(--color-navy)_0%,transparent_60%)]"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-slate-400/10 blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-opportunity/60 to-transparent"
            />
            <span className="relative mb-4 inline-block rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-slate-200 ring-1 ring-inset ring-white/15 sm:absolute sm:right-4 sm:top-4 sm:mb-0">
              Example
            </span>
            <div className="relative">
              <p className="eyebrow text-opportunity">Declined work identified</p>
              <p className="mt-3 text-5xl font-semibold tracking-tight tabular-nums sm:text-6xl">
                $42,680
              </p>
              <dl className="mt-8 grid gap-px overflow-hidden rounded-xl bg-white/10 ring-1 ring-inset ring-white/10 sm:grid-cols-3">
                {EXAMPLE_STATS.map(([label, value, tone]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-3 bg-navy-deep px-4 py-3 sm:block sm:px-5 sm:py-4"
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
          <ol className="divide-y divide-line px-2 pt-2 sm:px-4">
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

      <section className="mx-auto mt-16 max-w-2xl text-center">
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-positive-soft text-positive-ink ring-1 ring-inset ring-positive/20">
          <LockIcon className="h-5 w-5" />
        </span>
        <h2 className="mt-4 text-lg font-semibold tracking-tight text-navy">
          Your customer data stays on your computer
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Your report is read inside this browser tab and is never sent to a
          server or saved. There&apos;s no account to create, and closing or
          refreshing the page clears everything.
        </p>
      </section>
    </div>
  );
}
