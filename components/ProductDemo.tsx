"use client";

import { useEffect, useRef, useState } from "react";
import { DEMO_SHOP, demoAnalysis } from "@/lib/demoReport";
import { moneyFormat } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/scroll";
import { CountUp } from "./motion";

/** A staged demonstration of the real calculation, using fictional data only. */
export default function ProductDemo({ onOpen }: { onOpen: () => void }) {
  const [report, setReport] = useState(demoAnalysis);
  const [view, setView] = useState<"report" | "source" | "processing">("report");
  const [replayed, setReplayed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const money = moneyFormat(report.analysis.showCents);
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
      <div className="demo-caption"><span className="demo-light" aria-hidden /> PRODUCT WALKTHROUGH <span>Fictional data</span></div>
      <header className="demo-header"><div><p className="eyebrow">September review</p><h2>{DEMO_SHOP}</h2></div><span className="demo-file">6 source records</span></header>
      <div className="demo-tabs" role="group" aria-label="Demonstration view">
        <button type="button" aria-pressed={view === "source"} disabled={view === "processing"} onClick={() => setView("source")}>01 / Source report</button>
        <button type="button" aria-pressed={view === "report"} disabled={view === "processing"} onClick={() => setView("report")}>02 / Value to review</button>
      </div>
      {view === "source" ? (
        <div className="demo-source">
          <p className="demo-note">The six rows behind the total. Nothing invented between import and result.</p>
          <table><caption className="sr-only">Fictional declined-work export</caption><thead><tr><th scope="col">Service</th><th scope="col">Amount</th></tr></thead><tbody>{report.table.rows.map((row) => <tr key={String(row[5])}><td>{String(row[2])}<span>{String(row[5])} · {String(row[0])}</span></td><td>{money(Number(row[3]))}</td></tr>)}</tbody></table>
        </div>
      ) : (
        <div className="demo-result" aria-busy={view === "processing"}>
          <div className="demo-total"><p className="eyebrow">Reported declined value</p><p className="demo-number">{replayed && view !== "processing" ? <CountUp value={report.analysis.total} format={money} durationMs={450} /> : money(report.analysis.total)}</p><p>6 opportunities to review <span aria-hidden>↗</span></p></div>
          <div className="demo-findings">
            <p className="eyebrow">Largest jobs first</p>
            {report.analysis.ranked.slice(0, 3).map((job, index) => (
              <details className="demo-job" key={job.id}>
                <summary><span className="demo-rank">0{index + 1}</span><span>{job.service}<small>View report details <span aria-hidden>+</span></small></span><strong>{money(job.amount)}</strong></summary>
                <div className="demo-evidence"><p><strong>Why it appears:</strong> A positive declined estimate, ranked by value.</p><dl><div><dt>Customer</dt><dd>{job.customer}</dd></div><div><dt>Vehicle</dt><dd>{job.vehicle}</dd></div><div><dt>Source record</dt><dd>{String(report.table.rows[job.id][5])}</dd></div></dl><p>Reported in the fictional export. Current job status needs review.</p></div>
              </details>
            ))}
          </div>
          {view === "processing" && <div className="demo-processing" role="status"><span className="processing-line" />Calculating the sample report…</div>}
        </div>
      )}
      <footer className="demo-footer"><button type="button" onClick={run} disabled={view === "processing"}>Run sample analysis <span aria-hidden>↻</span></button><button type="button" onClick={onOpen} disabled={view === "processing"}>Open full report <span aria-hidden>↗</span></button></footer>
      <p className="demo-disclaimer">Potential work to revisit. This is not recovered revenue.</p>
    </section>
  );
}
