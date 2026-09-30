import { BRAND } from "./brand";
import { isoDate } from "./format";
import type { Opportunity } from "./types";

const HEADERS = [
  "Rank",
  "Service",
  "Category",
  "Customer",
  "Vehicle",
  "Phone",
  "Email",
  "Declined amount",
  "Declined date",
  "Age (days)",
  "Possible duplicate",
];

/**
 * Quotes a cell for CSV. Text that a spreadsheet would treat as a formula
 * (starting with = + - @) gets a leading apostrophe so it opens as plain text.
 */
function cell(value: string | number | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Builds a CSV of the opportunities, in the order given (largest first). */
export function buildOpportunitiesCsv(ranked: Opportunity[]): string {
  const rows = ranked.map((o, i) =>
    [
      i + 1,
      o.service,
      o.category,
      o.customer,
      o.vehicle,
      o.phone,
      o.email,
      o.amount.toFixed(2),
      o.date ? isoDate(o.date) : undefined,
      o.ageDays,
      o.possibleDuplicate ? "Yes" : "",
    ]
      .map(cell)
      .join(","),
  );
  return [HEADERS.join(","), ...rows].join("\r\n");
}

/** Turns an uploaded file name into a short, safe piece of a file name. */
const sourceSlug = (fileName: string) =>
  fileName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");

/**
 * "reclaimbay-report-oct-declined-2026-09-30.pdf". The source name is
 * included when something usable is left after cleaning.
 */
export function exportFileName(
  kind: "report" | "opportunities",
  ext: "pdf" | "csv",
  source: { fileName: string; isSample: boolean; date: Date },
) {
  const slug = source.isSample ? "sample" : sourceSlug(source.fileName);
  const parts = [BRAND.fileSlug, kind, slug, isoDate(source.date)].filter(Boolean);
  return `${parts.join("-")}.${ext}`;
}
