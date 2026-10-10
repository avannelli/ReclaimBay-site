"use client";

import { useEffect, useRef, useState } from "react";
import { analyze } from "@/lib/analyze";
import { trackEvent, trackLandingView } from "@/lib/analytics";
import { detectColumns, normalizeRows } from "@/lib/normalize";
import { confirmHeader, FileParseError, parseFile } from "@/lib/parseFile";
import { applyRememberedMappings, rememberConfirmedMappings } from "@/lib/prefs";
import { prefersReducedMotion, scrollPageTo, scrollToElement } from "@/lib/scroll";
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
import HeaderChooser from "./HeaderChooser";
import Dashboard from "./Dashboard";
import EmptyResult from "./EmptyResult";
import { buildDemoTable } from "@/lib/demoReport";
import UploadPanel from "./UploadPanel";
import { useReportHistory } from "./useReportHistory";

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
  | { name: "header"; table: ParsedTable }
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
  const mainRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards against a second file starting while one is still being read.
  const processing = useRef(false);

  // Set when a report is cleared, so the upload button takes focus again.
  const [focusUpload, setFocusUpload] = useState(false);

  // Anonymous and best effort; see lib/analytics.ts for what is sent.
  useEffect(() => trackLandingView(), []);

  // Back and Forward move between the landing page and the report workspace
  // (lib/navigation.ts). The last workspace screen stays in memory for Forward.
  const inWorkspace = stage.name !== "upload" && stage.name !== "parsing";
  const workspace = useRef<Stage | null>(null);
  useEffect(() => { if (inWorkspace) workspace.current = stage; }, [inWorkspace, stage]);
  // Where a screen brought back by Back or Forward should open.
  const pendingScroll = useRef<{ section: string } | { y: number } | null>(null);
  const navigation = useReportHistory(inWorkspace, (destination) => {
    pendingScroll.current = destination.scroll ?? null;
    if (destination.view === "report") {
      if (workspace.current) setStage(workspace.current);
      return;
    }
    setError(null);
    setFocusUpload(false);
    setStage({ name: "upload" });
  });

  // Starting over or cancelling clears the report; only Back and links keep it for Forward.
  const reset = () => {
    if (inWorkspace) {
      workspace.current = null;
      navigation.clearingReport();
    }
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
    const pending = pendingScroll.current;
    if (pending) {
      // Back or Forward: where the visitor left that screen, or the section a link named.
      pendingScroll.current = null;
      const section = "section" in pending ? document.getElementById(pending.section) : null;
      if (section) scrollToElement(section, 24, { instant: true });
      else scrollPageTo("y" in pending ? pending.y : 0, { instant: true });
      return;
    }
    if (stage.name === "upload" && (focusUpload || error)) {
      const target = mainRef.current?.querySelector<HTMLElement>(error ? "[role=alert]" : "#scan");
      if (target) {
        scrollToElement(target, 24, { instant: true });
        if (error) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
      }
    } else if (stage.name !== "parsing") scrollPageTo(0, { instant: true });
  }, [stage.name, focusUpload, error]);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // "in" while the branded transition plays; "out" while it fades away.
  const [transition, setTransition] = useState<"in" | "out" | null>(null);
  useEffect(() => {
    if (transition || stage.name === "parsing") return;
    const target = stage.name === "upload"
      ? error ? mainRef.current?.querySelector<HTMLElement>("[role=alert]") : null
      : mainRef.current?.querySelector("h1");
    if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, [stage.name, transition, error]);

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
        rememberConfirmedMappings(table, mapping, matching.detection);
      }
      trackEvent("scan_completed", isSample);
      return {
        name: "results",
        fileName: table.fileName,
        analysis,
        isSample,
        analyzedAt: new Date(),
      };
    } catch {
      setError(
        "We couldn\u2019t review this report. Try exporting it again from your shop software, or save it as CSV.",
      );
      return { name: "upload" };
    }
  };

  /** Guards every scan so a second one can't start mid-transition. */
  const startScan = async (compute: () => Stage | Promise<Stage>) => {
    if (processing.current) return;
    processing.current = true;
    if (!inWorkspace) navigation.leavingHome();
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
      const table = buildDemoTable();
      const detection = detectColumns(table);
      return analyzeToStage({ table, detection, remembered: 0 }, detection.mapping, {
        isSample: true,
      });
    });

  const handleFile = (file: File) =>
    startScan(async () => {
      setStage({ name: "parsing" });
      trackEvent("upload_started");
      try {
        const table = await parseFile(file);
        if (table.pendingHeaderRows) return { name: "header", table };
        const detection = detectColumns(table);
        const { mapping, applied } = applyRememberedMappings(table, detection);
        const matching = { table, detection, remembered: applied };
        return detection.confident
          ? analyzeToStage(matching, mapping)
          : { name: "mapping", matching, suggested: mapping };
      } catch (err) {
        setError(
          err instanceof FileParseError
            ? err.message
            : "We couldn\u2019t read this report. Try exporting it again from your shop software.",
        );
        return { name: "upload" };
      }
    });

  return (
    <main ref={mainRef} id="main" className={`scanner-main ${stage.name === "upload" || stage.name === "parsing" ? "" : "scanner-workspace"}`}>
        {transition && <BrandTransition leaving={transition === "out"} />}
        <div inert={transition !== null} aria-busy={stage.name === "parsing"}>
        {stage.name !== "upload" && stage.name !== "parsing" && (
          <ol className="scan-progress" aria-label="Report progress">
            <li aria-current={stage.name === "mapping" || stage.name === "header" ? "step" : undefined}>01 <span>Match your report</span></li>
            <li aria-current={stage.name === "results" || stage.name === "empty" ? "step" : undefined}>02 <span>Review declined work</span></li>
          </ol>
        )}
        {stage.name === "header" && (
          <HeaderChooser table={stage.table} onCancel={reset} onConfirm={(index) => {
            const table = confirmHeader(stage.table, index);
            const detection = detectColumns(table);
            const { mapping, applied } = applyRememberedMappings(table, detection);
            setStage({ name: "mapping", matching: { table, detection, remembered: applied }, suggested: mapping });
          }} />
        )}
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
        </div>
    </main>
  );
}
