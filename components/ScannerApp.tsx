"use client";

import { useEffect, useRef, useState } from "react";
import { analyze } from "@/lib/analyze";
import { detectColumns, normalizeRows } from "@/lib/normalize";
import { FileParseError, parseFile } from "@/lib/parseFile";
import { applyRememberedMappings, rememberConfirmedMappings } from "@/lib/prefs";
import { prefersReducedMotion, scrollPageTo } from "@/lib/scroll";
import type {
  Analysis,
  ColumnMapping,
  DetectionResult,
  ParsedTable,
} from "@/lib/types";
import BrandTransition, {
  TRANSITION_HOLD_MS,
  TRANSITION_OUT_MS,
  TRANSITION_REDUCED_HOLD_MS,
  TRANSITION_SHORT_HOLD_MS,
} from "./BrandTransition";
import ColumnMapper from "./ColumnMapper";
import Dashboard from "./Dashboard";
import EmptyResult from "./EmptyResult";
import { buildSampleTable } from "@/lib/sampleData";
import UploadPanel from "./UploadPanel";

/** What the file's columns were matched to, and how. */
interface Matching {
  table: ParsedTable;
  detection: DetectionResult;
  /** Fields prefilled from mappings the user confirmed on an earlier upload. */
  remembered: number;
}

type Stage =
  | { name: "upload" }
  | { name: "parsing" }
  | { name: "mapping"; matching: Matching; suggested: ColumnMapping }
  | { name: "empty"; matching: Matching; mapping: ColumnMapping }
  | {
      name: "results";
      fileName: string;
      analysis: Analysis;
      isSample: boolean;
      analyzedAt: Date;
    };

/**
 * Owns the whole flow. Uploaded data lives only in this component's state,
 * so it disappears on reset or page refresh; nothing is sent or stored.
 * Only the column-header matches a user confirms are remembered locally.
 */
export default function ScannerApp() {
  const [stage, setStage] = useState<Stage>({ name: "upload" });
  const [error, setError] = useState<string | null>(null);
  // Guards against a second file starting while one is still being read.
  const processing = useRef(false);

  // Set when a report is cleared, so the upload button takes focus again.
  const [focusUpload, setFocusUpload] = useState(false);

  const reset = () => {
    setError(null);
    setFocusUpload(true);
    setStage({ name: "upload" });
  };

  // Every new screen starts at its top: the previous screen's scroll depth
  // means nothing once its content is replaced.
  const firstStage = useRef(true);
  useEffect(() => {
    if (firstStage.current) {
      firstStage.current = false;
      return;
    }
    if (stage.name !== "parsing") scrollPageTo(0, { instant: true });
  }, [stage.name]);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // "in" while the branded transition plays; "out" while it fades away.
  const [transition, setTransition] = useState<"in" | "out" | null>(null);

  /**
   * Plays the branded transition around a scan. A report is revealed only
   * after the full sequence, so a fast scan never flickers; a slow one just
   * holds on the logo. The mapper or an error follows a shorter pause.
   */
  const scanWithTransition = async (compute: () => Stage | Promise<Stage>) => {
    const reduce = prefersReducedMotion();
    const started = performance.now();
    setTransition("in");
    const next = await compute();
    const hold = reduce
      ? TRANSITION_REDUCED_HOLD_MS
      : next.name === "results"
        ? TRANSITION_HOLD_MS
        : TRANSITION_SHORT_HOLD_MS;
    const remaining = hold - (performance.now() - started);
    if (remaining > 0) await sleep(remaining);
    // The next screen mounts under the logo and animates in as it fades.
    setStage(next);
    if (reduce) {
      setTransition(null);
      return;
    }
    setTransition("out");
    await sleep(TRANSITION_OUT_MS);
    setTransition(null);
  };

  /** Runs the analysis and returns the screen that should follow it. */
  const analyzeToStage = (
    matching: Matching,
    mapping: ColumnMapping,
    { isSample = false, confirmedByUser = false } = {},
  ): Stage => {
    const { table } = matching;
    try {
      const { opportunities, quality } = normalizeRows(table, mapping);
      const analysis = analyze(opportunities, quality);
      setError(null);
      if (!analysis) return { name: "empty", matching, mapping };
      if (confirmedByUser) {
        rememberConfirmedMappings(table.headers, mapping, matching.detection);
      }
      return {
        name: "results",
        fileName: table.fileName,
        analysis,
        isSample,
        analyzedAt: new Date(),
      };
    } catch {
      setError(
        "We couldn\u2019t analyze this file. Try exporting it again from your shop software, or save it as CSV.",
      );
      return { name: "upload" };
    }
  };

  /** Guards every scan so a second one can't start mid-transition. */
  const startScan = async (compute: () => Stage | Promise<Stage>) => {
    if (processing.current) return;
    processing.current = true;
    setFocusUpload(false);
    setError(null);
    try {
      await scanWithTransition(compute);
    } finally {
      processing.current = false;
    }
  };

  const handleSample = () =>
    startScan(() => {
      const table = buildSampleTable();
      const detection = detectColumns(table);
      return analyzeToStage({ table, detection, remembered: 0 }, detection.mapping, {
        isSample: true,
      });
    });

  const handleFile = (file: File) =>
    startScan(async () => {
      setStage({ name: "parsing" });
      try {
        const table = await parseFile(file);
        const detection = detectColumns(table);
        const { mapping, applied } = applyRememberedMappings(table.headers, detection);
        const matching = { table, detection, remembered: applied };
        return detection.confident
          ? analyzeToStage(matching, mapping)
          : { name: "mapping", matching, suggested: mapping };
      } catch (err) {
        setError(
          err instanceof FileParseError
            ? err.message
            : "We couldn\u2019t read this file. Try exporting it again from your shop software.",
        );
        return { name: "upload" };
      }
    });

  return (
    <main className="mx-auto w-full max-w-300 flex-1 px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        {transition && <BrandTransition leaving={transition === "out"} />}
        {(stage.name === "upload" || stage.name === "parsing") && (
          <UploadPanel
            focusOnMount={focusUpload}
            onFile={handleFile}
            onSample={handleSample}
            busy={stage.name === "parsing"}
            error={error}
          />
        )}
        {stage.name === "mapping" && (
          <ColumnMapper
            table={stage.matching.table}
            initial={stage.suggested}
            remembered={stage.matching.remembered}
            error={error}
            onConfirm={(m) =>
              startScan(() =>
                analyzeToStage(stage.matching, m, { confirmedByUser: true }),
              )
            }
            onCancel={reset}
          />
        )}
        {stage.name === "empty" && (
          <EmptyResult
            fileName={stage.matching.table.fileName}
            rowCount={stage.matching.table.rows.length}
            amountHeader={
              stage.mapping.amount === undefined
                ? undefined
                : stage.matching.table.headers[stage.mapping.amount]
            }
            onReset={reset}
            onRemap={() => {
              const col = stage.mapping.amount;
              const header =
                col === undefined ? undefined : stage.matching.table.headers[col];
              setError(
                header
                  ? `None of the rows had a positive amount in \u201c${header}\u201d. Pick the column that holds each declined job\u2019s price.`
                  : "Pick the column that holds each declined job\u2019s price.",
              );
              setStage({
                name: "mapping",
                matching: stage.matching,
                suggested: stage.mapping,
              });
            }}
          />
        )}
        {stage.name === "results" && (
          <Dashboard
            fileName={stage.fileName}
            analysis={stage.analysis}
            isSample={stage.isSample}
            analyzedAt={stage.analyzedAt}
            onReset={reset}
          />
        )}
    </main>
  );
}
