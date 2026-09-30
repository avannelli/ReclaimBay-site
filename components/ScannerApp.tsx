"use client";

import { useState } from "react";
import { analyze } from "@/lib/analyze";
import { detectColumns, normalizeRows } from "@/lib/normalize";
import { FileParseError, parseFile } from "@/lib/parseFile";
import type { Analysis, ColumnMapping, ParsedTable } from "@/lib/types";
import ColumnMapper from "./ColumnMapper";
import Dashboard from "./Dashboard";
import { buildSampleTable } from "@/lib/sampleData";
import UploadPanel from "./UploadPanel";

type Stage =
  | { name: "upload" }
  | { name: "parsing" }
  | { name: "mapping"; table: ParsedTable; suggested: ColumnMapping }
  | { name: "results"; fileName: string; analysis: Analysis; isSample: boolean };

/**
 * Owns the whole flow. Uploaded data lives only in this component's state,
 * so it disappears on reset or page refresh; nothing is sent or stored.
 */
export default function ScannerApp() {
  const [stage, setStage] = useState<Stage>({ name: "upload" });
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setError(null);
    setStage({ name: "upload" });
  };

  const runAnalysis = (
    table: ParsedTable,
    mapping: ColumnMapping,
    isSample = false,
  ) => {
    try {
      const { opportunities, quality } = normalizeRows(table, mapping);
      const analysis = analyze(opportunities, quality);
      if (!analysis) {
        setError(
          "None of the rows had a dollar amount greater than $0 in the \"Declined amount\" column you selected. Check that this column holds the price of each declined job (not a date, ID, or quantity), or pick a different column.",
        );
        setStage({ name: "mapping", table, suggested: mapping });
        return;
      }
      setError(null);
      setStage({ name: "results", fileName: table.fileName, analysis, isSample });
    } catch {
      setError(
        "We ran into a problem analyzing that file. Try re-saving it as a CSV and uploading it again.",
      );
      setStage({ name: "upload" });
    }
  };

  const handleSample = () => {
    const table = buildSampleTable();
    runAnalysis(table, detectColumns(table).mapping, true);
  };

  const handleFile = async (file: File) => {
    setError(null);
    setStage({ name: "parsing" });
    try {
      const table = await parseFile(file);
      const { mapping, confident } = detectColumns(table);
      if (confident) {
        runAnalysis(table, mapping);
      } else {
        setStage({ name: "mapping", table, suggested: mapping });
      }
    } catch (err) {
      setError(
        err instanceof FileParseError
          ? err.message
          : "Something went wrong reading that file. Try re-saving it as a CSV and uploading it again.",
      );
      setStage({ name: "upload" });
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-300 items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="grid h-8 w-8 place-items-center rounded-lg bg-navy text-opportunity"
            >
              <svg
                viewBox="0 0 20 20"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 14.5 8 9.5l3 3 6-6.5M13 6h4v4" />
              </svg>
            </span>
            <span className="text-[17px] font-semibold tracking-tight text-navy">
              AutoRev
            </span>
          </div>
          <span className="hidden text-sm text-ink-2 sm:block">
            Declined-work analysis for repair shops
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-300 flex-1 px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        {(stage.name === "upload" || stage.name === "parsing") && (
          <UploadPanel
            onFile={handleFile}
            onSample={handleSample}
            busy={stage.name === "parsing"}
            error={error}
          />
        )}
        {stage.name === "mapping" && (
          <ColumnMapper
            table={stage.table}
            initial={stage.suggested}
            error={error}
            onConfirm={(m) => runAnalysis(stage.table, m)}
            onCancel={reset}
          />
        )}
        {stage.name === "results" && (
          <Dashboard
            fileName={stage.fileName}
            analysis={stage.analysis}
            isSample={stage.isSample}
            onReset={reset}
          />
        )}
      </main>

      <footer className="border-t border-line py-6 text-center text-xs text-ink-2">
        AutoRev · Files are analyzed locally in your browser.
      </footer>
    </div>
  );
}
