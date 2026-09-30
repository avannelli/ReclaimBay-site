"use client";

import { useState } from "react";
import { FIELD_DEFS, MAPPER_FIELDS } from "@/lib/normalize";
import type { ColumnMapping, FieldKey, ParsedTable } from "@/lib/types";
import PrivacyBadge from "./PrivacyBadge";

interface Props {
  table: ParsedTable;
  initial: ColumnMapping;
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

export default function ColumnMapper({
  table,
  initial,
  error,
  onConfirm,
  onCancel,
}: Props) {
  const [mapping, setMapping] = useState<ColumnMapping>(initial);

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

  return (
    <div className="mx-auto max-w-3xl">
      <PrivacyBadge />
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-navy">
        Help us read your columns
      </h1>
      <p className="mt-3 text-ink-2">
        We weren&apos;t fully sure which columns in{" "}
        <span className="font-medium text-ink">{table.fileName}</span>{" "}
        hold what. Confirm the matches below. Only the dollar amount and
        service are required.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-danger/25 border-l-4 border-l-danger bg-danger-soft px-4 py-3 text-sm text-ink"
        >
          {error}
        </p>
      )}

      <div className="mt-8 divide-y divide-line rounded-2xl border border-line bg-surface shadow-card">
        {MAPPER_FIELDS.map((field) => {
          const def = FIELD_DEFS[field];
          const value = mapping[field];
          return (
            <div
              key={field}
              className="grid gap-2 p-4 sm:grid-cols-2 sm:items-center sm:p-5"
            >
              <div>
                <label
                  htmlFor={`map-${field}`}
                  className="font-semibold text-ink"
                >
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
        })}
      </div>

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="h-12 rounded-lg border border-slate-300 bg-surface px-6 font-semibold text-navy transition hover:border-slate-400 hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
        >
          Upload a different file
        </button>
        <button
          type="button"
          disabled={missingRequired.length > 0}
          onClick={() => onConfirm(mapping)}
          className="h-12 rounded-lg bg-opportunity px-6 font-semibold text-navy-deep shadow-sm transition hover:bg-opportunity-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy disabled:cursor-not-allowed disabled:opacity-50"
        >
          Scan for declined revenue
        </button>
      </div>
    </div>
  );
}
