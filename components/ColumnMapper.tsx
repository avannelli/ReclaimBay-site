"use client";

import { useState } from "react";
import { FIELD_DEFS, MAPPER_FIELDS, REQUIRED_FIELDS } from "@/lib/normalize";
import type { ColumnMapping, FieldKey, ParsedTable } from "@/lib/types";
import PrivacyBadge from "./PrivacyBadge";
import { button, size } from "./ui";

interface Props {
  table: ParsedTable;
  initial: ColumnMapping;
  /** How many fields were prefilled from matches confirmed on earlier uploads. */
  remembered: number;
  error: string | null;
  onConfirm: (mapping: ColumnMapping) => void;
  onCancel: () => void;
}

const sampleFor = (table: ParsedTable, col: number) => {
  const values = table.rows
    .map((r) => r[col])
    .filter((v) => v !== null && v !== "")
    .slice(0, 3)
    .map((v) => (v instanceof Date ? v.toLocaleDateString("en-US") : String(v)));
  return values.join(" · ");
};

/** Typical header names, shown under the required fields. */
const HEADER_EXAMPLES: Partial<Record<FieldKey, string>> = {
  amount: "Estimate Total, Amount, Declined Value",
  service: "Service, Job, Recommended Work",
};

const secondaryButton = `${button.secondaryStrong} ${size.lg}`;
const primaryButton = `${button.primary} ${size.lg}`;

export default function ColumnMapper({
  table,
  initial,
  remembered,
  error,
  onConfirm,
  onCancel,
}: Props) {
  const [mapping, setMapping] = useState<ColumnMapping>(initial);

  // Judged from the auto-detected suggestions, so the notice doesn't change
  // while the user maps columns by hand.
  const requiredFound = REQUIRED_FIELDS.filter(
    (f) => initial[f] !== undefined,
  ).length;
  const fieldsFound = Object.keys(initial).length;
  const autoMatched = MAPPER_FIELDS.filter((f) => initial[f] !== undefined).length;
  const unlikelyReport = requiredFound < REQUIRED_FIELDS.length;
  const veryUnlikely = requiredFound === 0 && fieldsFound <= 1;

  const missingRequired = MAPPER_FIELDS.filter(
    (f) => FIELD_DEFS[f].required && mapping[f] === undefined,
  );

  const update = (field: FieldKey, value: string) =>
    setMapping((m) => {
      const next = { ...m };
      if (value === "") delete next[field];
      else next[field] = Number(value);
      return next;
    });

  const renderField = (field: FieldKey) => {
    const def = FIELD_DEFS[field];
    const value = mapping[field];
    return (
      <div
        key={field}
        className="grid gap-2 p-4 sm:grid-cols-2 sm:items-center sm:p-5"
      >
        <div>
          <label htmlFor={`map-${field}`} className="font-semibold text-ink">
            {def.label}
            {def.required ? (
              <span className="ml-2 rounded-md bg-opportunity-soft px-1.5 py-0.5 text-xs font-medium text-opportunity-ink ring-1 ring-inset ring-opportunity/25">
                Required
              </span>
            ) : (
              <span className="ml-2 text-xs font-normal text-ink-3">
                Optional
              </span>
            )}
          </label>
          {HEADER_EXAMPLES[field] && (
            <p className="mt-1 text-xs text-ink-3">
              Often called: {HEADER_EXAMPLES[field]}
            </p>
          )}
          {value !== undefined && (
            <p className="mt-1 truncate text-xs text-ink-3">
              e.g. {sampleFor(table, value) || "(empty)"}
            </p>
          )}
        </div>
        <select
          id={`map-${field}`}
          value={value ?? ""}
          onChange={(e) => update(field, e.target.value)}
          className="h-11 w-full rounded-lg border border-slate-300 bg-surface px-3 text-sm text-ink transition-colors hover:border-slate-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy"
        >
          <option value="">
            {def.required ? "Select a column…" : "Not in my file"}
          </option>
          {table.headers.map((h, i) => (
            <option key={i} value={i}>
              {h}
            </option>
          ))}
        </select>
      </div>
    );
  };

  const card =
    "divide-y divide-line rounded-md border border-line bg-surface";
  const optionalFields = MAPPER_FIELDS.filter((f) => !FIELD_DEFS[f].required);

  return (
    <div className="mapping-sheet mx-auto max-w-3xl">
      <PrivacyBadge />
      {veryUnlikely ? (
        <>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-navy">
            We couldn&apos;t identify this as a declined-work report.
          </h1>
          <p className="mt-3 text-ink-2">
            Upload the correct report, or map the columns manually if this
            file uses unusual headers.
          </p>
        </>
      ) : (
        <>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-navy">
            Match your report to the review
          </h1>
          <p className="mt-3 text-ink-2">
            {/* After a failed scan, `initial` is the user's own mapping. */}
            {autoMatched > 0 && !error ? (
              <>
                We matched {autoMatched} of {MAPPER_FIELDS.length} fields in{" "}
                <span className="font-medium text-ink">{table.fileName}</span>{" "}
                automatically. Check the matches below and fill in anything
                missing. Only the declined amount and service are required.
              </>
            ) : (
              <>
                We weren&apos;t sure which columns in{" "}
                <span className="font-medium text-ink">{table.fileName}</span>{" "}
                hold what. Match them below. Only the declined amount and
                service are required.
              </>
            )}
          </p>
        </>
      )}

      {remembered > 0 && !error && (
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-navy/[0.05] px-2.5 py-1 text-sm text-navy ring-1 ring-inset ring-navy/10">
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="h-4 w-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m3.5 8.5 3 3 6-7" />
          </svg>
          Prefilled {remembered === 1 ? "a column match" : `${remembered} column matches`}{" "}
          you confirmed before, saved in this browser.
        </p>
      )}

      {unlikelyReport && (
        <div
          role="status"
          className="mt-6 flex flex-col gap-4 rounded-xl border border-opportunity/30 border-l-4 border-l-opportunity bg-opportunity-soft px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
        >
          <div>
            <p className="font-semibold text-ink">
              This file doesn&apos;t look like a declined-work export.
            </p>
            <p className="mt-1 text-sm text-ink-2">
              You can map the columns manually below, or upload the correct
              report.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className={`shrink-0 ${veryUnlikely ? primaryButton : secondaryButton}`}
          >
            Upload a different file
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-danger/25 border-l-4 border-l-danger bg-danger-soft px-4 py-3 text-sm text-ink"
        >
          {error}
        </p>
      )}

      {veryUnlikely ? (
        <>
          <h2 className="mt-8 text-sm font-semibold text-ink-2">
            Or map the columns manually
          </h2>
          <div className={`mt-3 ${card}`}>{REQUIRED_FIELDS.map(renderField)}</div>
          <details className="group mt-3 rounded-2xl border border-line bg-surface/70">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-sm font-medium text-ink transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-navy sm:px-5 [&::-webkit-details-marker]:hidden">
              Optional fields
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
            </summary>
            <div className="divide-y divide-line border-t border-line">
              {optionalFields.map(renderField)}
            </div>
          </details>
        </>
      ) : (
        <div className={`mt-8 ${card}`}>{MAPPER_FIELDS.map(renderField)}</div>
      )}

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <button type="button" onClick={onCancel} className={secondaryButton}>
          Upload a different file
        </button>
        <button
          type="button"
          disabled={missingRequired.length > 0}
          onClick={() => onConfirm(mapping)}
          className={primaryButton}
        >
          Scan for declined revenue
        </button>
      </div>
    </div>
  );
}
