import Papa from "papaparse";
import readXlsxFile from "read-excel-file/browser";
import type { ParsedTable, RawCell } from "./types";

const MAX_BYTES = 15 * 1024 * 1024;
const HEADER_SCAN_ROWS = 10;

export class FileParseError extends Error {}

const isBlank = (c: RawCell) => c === null || (typeof c === "string" && c.trim() === "");

/**
 * Exports often start with title/summary rows. Pick the row (within the first
 * few) with the most filled cells; the earliest wins ties.
 */
function findHeaderRow(rows: RawCell[][]): number {
  let best = 0;
  let bestCount = -1;
  rows.slice(0, HEADER_SCAN_ROWS).forEach((row, i) => {
    const filled = row.filter((c) => !isBlank(c)).length;
    if (filled > bestCount) {
      best = i;
      bestCount = filled;
    }
  });
  return best;
}

function toTable(fileName: string, matrix: RawCell[][]): ParsedTable {
  const rows = matrix.filter((r) => r.some((c) => !isBlank(c)));
  if (rows.length < 2) {
    throw new FileParseError("This file doesn't contain any rows to analyze.");
  }
  const headerIdx = findHeaderRow(rows);
  const width = Math.max(...rows.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => {
    const h = rows[headerIdx][i];
    const label = isBlank(h ?? null)
      ? ""
      : String(h).replace(/^\uFEFF/, "").trim();
    return label || `Column ${i + 1}`;
  });
  const dataRows = rows
    .slice(headerIdx + 1)
    .map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
  if (dataRows.length === 0) {
    throw new FileParseError(
      "This file has column names but no rows to analyze. Check that the export includes your declined jobs.",
    );
  }
  return { fileName, headers, rows: dataRows };
}

function parseCsv(file: File): Promise<RawCell[][]> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: "greedy",
      complete: (result) => resolve(result.data),
      error: () =>
        reject(
          new FileParseError(
            "We couldn't read this CSV file. Try exporting it again from your shop software.",
          ),
        ),
    });
  });
}

/** Parses a CSV or XLSX file entirely in the browser; nothing is uploaded. */
export async function parseFile(file: File): Promise<ParsedTable> {
  const name = file.name.toLowerCase();
  const isCsv = name.endsWith(".csv");
  const isXlsx = name.endsWith(".xlsx");
  if (!isCsv && !isXlsx) {
    throw new FileParseError(
      name.endsWith(".xls")
        ? "Older .xls files aren't supported. In Excel, use File > Save As to save it as .xlsx or CSV, then upload that."
        : "This file type isn't supported. Upload a CSV or XLSX report.",
    );
  }
  if (file.size > MAX_BYTES) {
    throw new FileParseError(
      "This file is larger than 15 MB. Export a shorter date range (for example, the last 12 months) and try again.",
    );
  }
  if (file.size === 0) {
    throw new FileParseError("This file doesn't contain any rows to analyze.");
  }

  try {
    if (isCsv) {
      return toTable(file.name, await parseCsv(file));
    }
    // The library's typings declare date cells as `typeof Date`; they're Date instances.
    const sheets = (await readXlsxFile(file)).map((s) => s.data as unknown as RawCell[][]);
    const data = sheets.find((rows) => rows.some((r) => r.some((c) => !isBlank(c))));
    if (!data) throw new FileParseError("This spreadsheet doesn't contain any rows to analyze.");
    return toTable(file.name, data);
  } catch (err) {
    if (err instanceof FileParseError) throw err;
    throw new FileParseError(
      isXlsx
        ? "We couldn't read this spreadsheet. It may be damaged or password-protected. Try exporting it again from your shop software."
        : "We couldn't read this file. Try exporting it again from your shop software.",
    );
  }
}
