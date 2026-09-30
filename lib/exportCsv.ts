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

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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

/** Turns an uploaded file name into a safe base for export file names. */
export const exportBaseName = (fileName: string) =>
  fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase() || "report";
