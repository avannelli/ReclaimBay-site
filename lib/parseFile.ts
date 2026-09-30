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
    throw new FileParseError(
      "We couldn't find any rows of data in that file. Open it in Excel and check that the first row has column names with your declined jobs listed below it, then upload it again.",
    );
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
    throw new FileParseError("We found column names but no jobs listed under them. Check that the export wasn't empty and upload it again.");
  }
  return { fileName, headers, rows: dataRows };
}

function parseCsv(file: File): Promise<RawCell[][]> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: "greedy",
      complete: (result) => resolve(result.data),
      error: () => reject(new FileParseError("We couldn't read that CSV file. Try opening it in Excel, saving it as a new CSV (or .xlsx) file, and uploading that.")),
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
        ? "Older Excel (.xls) files aren't supported. Open the file in Excel, choose File > Save As, pick \"Excel Workbook (.xlsx)\" or \"CSV\", and upload the new file."
        : "That file type isn't supported. Please upload a .csv or .xlsx file exported from your shop system.",
    );
  }
  if (file.size > MAX_BYTES) {
    throw new FileParseError("That file is larger than 15 MB. Export a shorter date range (for example, the last 12 months) and try again.");
  }

  try {
    if (isCsv) {
      return toTable(file.name, await parseCsv(file));
    }
    // The library's typings declare date cells as `typeof Date`; they're Date instances.
    const sheets = (await readXlsxFile(file)).map((s) => s.data as unknown as RawCell[][]);
    const data = sheets.find((rows) => rows.some((r) => r.some((c) => !isBlank(c))));
    if (!data) throw new FileParseError("That Excel file appears to be empty. Check that your declined work is on one of its sheets and try again.");
    return toTable(file.name, data);
  } catch (err) {
    if (err instanceof FileParseError) throw err;
    throw new FileParseError(
      isXlsx
        ? "We couldn't open that Excel file. It may be password-protected or damaged. Remove any password, re-save it as .xlsx or CSV, and try again."
        : "We couldn't read that file. Try re-saving it as a CSV and uploading it again.",
    );
  }
}
