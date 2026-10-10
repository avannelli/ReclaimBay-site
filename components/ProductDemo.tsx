"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DEMO_SHOP, demoAnalysis } from "@/lib/demoReport";
import { moneyFormat } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/scroll";
import { CountUp } from "./motion";

/** The source columns shown for a job: exactly as they appear in the fictional export. */
const SOURCE_COLUMNS = [2, 3, 4] as const;

/**
 * A product specimen: the reported value, where to start, and the export row
 * behind each amount. A staged demonstration of the real calculation, using
 * fictional data only.
 */
export default function ProductDemo({ onOpen }: { onOpen: () => void }) {
  const [report, setReport] = useState(demoAnalysis);
  const [view, setView] = useState<"report" | "source" | "processing">("report");
  const [replayed, setReplayed] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(0);
  const evidenceId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const money = moneyFormat(report.analysis.showCents);
  const jobs = report.analysis.ranked.slice(0, 3);
  const { headers, rows } = report.table;
  const run = () => {
    const calculated = demoAnalysis();
    if (prefersReducedMotion()) {
      setReport(calculated); setView("report"); setReplayed(true); return;
    }
    setView("processing");
    timer.current = setTimeout(() => {
      setReport(calculated); setView("report"); setReplayed(true);
    }, 420);
  };
  return (
    <section className="product-demo" aria-label="Interactive fictional report demonstration">
      <header className="demo-header">
        <span className="sr-only">PRODUCT WALKTHROUGH</span>
        <div><p className="eyebrow">September review</p><h2>{DEMO_SHOP}</h2></div>
        <div className="demo-caption"><p><span className="demo-light" aria-hidden /> Fictional data</p><span className="demo-file">6 declined jobs</span></div>
      </header>
      <div className="demo-tabs" role="group" aria-label="Demonstration view">
        <button type="button" aria-pressed={view === "source"} disabled={view === "processing"} onClick={() => setView("source")}>01 / Source export</button>
        <button type="button" aria-pressed={view === "report"} disabled={view === "processing"} onClick={() => setView("report")}>02 / Jobs to review</button>
      </div>
      {view === "source" ? (
        <div className="demo-source">
          <p className="demo-note">The six jobs behind the total. Each amount comes from this export.</p>
          <table><caption className="sr-only">Fictional declined-work export</caption><thead><tr><th scope="col">Service</th><th scope="col">Amount</th></tr></thead><tbody>{rows.map((row) => <tr key={String(row[5])}><td>{String(row[2])}<span>{String(row[5])} · {String(row[0])}</span></td><td>{money(Number(row[3]))}</td></tr>)}</tbody></table>
        </div>
      ) : (
        <div className="demo-result" aria-busy={view === "processing"}>
          <div className="demo-total"><p className="eyebrow">Reported declined value</p><p className="demo-number">{replayed && view !== "processing" ? <CountUp value={report.analysis.total} format={money} durationMs={450} /> : money(report.analysis.total)}</p><p>6 opportunities to review · not recovered revenue</p></div>
          <div className="demo-findings">
            <p className="eyebrow">Largest jobs first</p>
            {jobs.map((job, index) => (
              <button className="demo-job" type="button" key={job.id}
                aria-pressed={selectedId === job.id} aria-controls={evidenceId}
                disabled={view === "processing"}
                onClick={() => setSelectedId(selectedId === job.id ? null : job.id)}>
                <span className="demo-rank">0{index + 1}</span>
                <span className="demo-job-main">{job.service}<small>{job.customer} · {job.vehicle}</small><span className="sr-only"> — Inspect evidence</span></span>
                <strong>{money(job.amount)}</strong>
                <span className="demo-inspect" aria-hidden><span className="demo-inspect-label">Source </span>↓</span>
              </button>
            ))}
          </div>
          {/* Overlapping grid panels reserve the tallest detail at every width.
              Inactive content still sizes the region but is neither visible nor accessible. */}
          <div className="demo-evidence" id={evidenceId} role="region" aria-label="Selected opportunity evidence" aria-live="polite" aria-atomic="true">
            {jobs.map((job) => (
              <div className="demo-evidence-panel" key={job.id} data-active={selectedId === job.id} aria-hidden={selectedId !== job.id} inert={selectedId !== job.id}>
                <p className="demo-evidence-heading">Source row in the export <span><span className="sr-only">Report reference </span>{String(rows[job.id][5])}</span></p>
                <dl className="demo-source-row">
                  {SOURCE_COLUMNS.map((column) => <div key={column} data-amount={column === 3 || undefined}><dt>{headers[column]}</dt><dd>{String(rows[job.id][column])}</dd></div>)}
                </dl>
                <p className="demo-why"><strong>Why it appears:</strong> A positive declined estimate, ranked by value.</p>
              </div>
            ))}
            <div className="demo-evidence-panel demo-evidence-empty" data-active={selectedId === null} aria-hidden={selectedId !== null} inert={selectedId !== null}>
              <p className="demo-evidence-heading">Source row in the export</p><p>Select a job to see the row in the export behind its amount.</p>
            </div>
          </div>
          {view === "processing" && <div className="demo-processing" role="status"><span className="processing-line" />Reviewing the sample report…</div>}
        </div>
      )}
      <footer className="demo-footer"><button type="button" className="demo-replay" onClick={run} disabled={view === "processing"}>Run sample analysis <span aria-hidden>↻</span></button><button type="button" className="demo-open" onClick={onOpen} disabled={view === "processing"}>Open full report <span aria-hidden>→</span></button></footer>
    </section>
  );
}
