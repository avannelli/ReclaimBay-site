import { BRAND } from "./brand";
import { isoDate } from "./format";
import { TIER_LABEL, type FollowUp } from "./followUps";
import type { Opportunity } from "./types";

const HEADERS = [
  "Rank",
  "Service",
  "Category",
  "Customer",
  "Vehicle",
  "Phone",
  "Email",
  "Reported declined value",
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

const FOLLOW_UP_HEADERS = [
  "Call order",
  "Group",
  "Customer",
  "Vehicle",
  "Phone",
  "Email",
  "Declined jobs",
  "Declined work",
  "Total declined value",
  "Most recent decline",
  "Days since decline",
  "Reached",
  "Booked",
  "Notes",
];

/**
 * One row per customer and vehicle, in call order, for a texting or email
 * tool or a working spreadsheet. Contact cells are exactly as exported; the
 * Reached, Booked and Notes columns are left blank for the shop to fill in.
 */
export function buildFollowUpsCsv(followUps: FollowUp[]): string {
  const rows = followUps.map((f, i) =>
    [
      i + 1,
      TIER_LABEL[f.tier],
      f.customer,
      f.vehicle,
      f.phone,
      f.email,
      f.items.length,
      f.items.map((o) => `${o.service} (${o.amount.toFixed(2)})`).join("; "),
      f.total.toFixed(2),
      f.latestDate ? isoDate(f.latestDate) : undefined,
      f.latestAgeDays,
      "",
      "",
      "",
    ]
      .map(cell)
      .join(","),
  );
  return [FOLLOW_UP_HEADERS.join(","), ...rows].join("\r\n");
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
  kind: "report" | "opportunities" | "call-list" | "call-sheet",
  ext: "pdf" | "csv",
  source: { fileName: string; isSample: boolean; date: Date },
) {
  const slug = source.isSample ? "sample" : sourceSlug(source.fileName);
  const parts = [BRAND.fileSlug, kind, slug, isoDate(source.date)].filter(Boolean);
  return `${parts.join("-")}.${ext}`;
}
