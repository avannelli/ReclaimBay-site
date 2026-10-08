import Papa from "papaparse";
import readXlsxFile from "read-excel-file/browser";
import type { ParsedTable, RawCell } from "./types";
import { hasRequiredHeaderLabels } from "./headerLabels";

const MAX_BYTES = 15 * 1024 * 1024;
const HEADER_SCAN_ROWS = 10;

export class FileParseError extends Error {}

const isBlank = (c: RawCell) => c === null || (typeof c === "string" && c.trim() === "");

const labelFor = (cell: RawCell | undefined) =>
  cell == null ? "" : String(cell).replace(/^\uFEFF/, "").trim();

/** Explicit selection is the only way uncertain rows may be discarded. */
export function confirmHeader(table: ParsedTable, index: number | null): ParsedTable {
  const rows = table.pendingHeaderRows;
  if (!rows) throw new FileParseError("The header has already been established.");
  if (index !== null && (!Number.isInteger(index) || index < 0 || index >= rows.length - 1)) {
    throw new FileParseError("Choose a header with data rows below it.");
  }
  return {
    fileName: table.fileName,
    headers: table.headers.map((_, col) =>
      index === null ? `Column ${col + 1}` : labelFor(rows[index][col]) || `Column ${col + 1}`),
    rows: index === null ? rows : rows.slice(index + 1),
    headerSource: index === null ? "none" : "confirmed",
  };
}

function toTable(fileName: string, matrix: RawCell[][]): ParsedTable {
  const rows = matrix.filter((r) => r.some((c) => !isBlank(c)));
  if (rows.length === 0) {
    throw new FileParseError("This file doesn't contain any rows to analyze.");
  }
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
  const candidates = rows.slice(0, HEADER_SCAN_ROWS)
    .flatMap((row, index) => hasRequiredHeaderLabels(row.map(labelFor)) ? [index] : []);
  if (rows.length === 1 && candidates.length === 1) {
    throw new FileParseError(
      "This file has column names but no rows to analyze. Check that the export includes your declined jobs.",
    );
  }
  const pending: ParsedTable = {
    fileName,
    headers: Array.from({ length: width }, (_, i) => `Column ${i + 1}`),
    rows: padded,
    pendingHeaderRows: padded,
  };
  if (candidates.length !== 1 || candidates[0] === rows.length - 1) return pending;
  // Numeric preamble cells might be transactions. Keep them for confirmation.
  if (rows.slice(0, candidates[0]).some((row) => row.some((cell) =>
    typeof cell === "number" || cell instanceof Date || (typeof cell === "string" && /\d/.test(cell))))) return pending;
  return { ...confirmHeader(pending, candidates[0]), headerSource: "detected" };
}

function parseCsv(file: File): Promise<RawCell[][]> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: "greedy",
      complete: (result) => result.errors.some((error) => error.type === "Quotes")
        ? reject(new FileParseError("We couldn't read this CSV file. Check its quoted cells and export it again."))
        : resolve(result.data),
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
