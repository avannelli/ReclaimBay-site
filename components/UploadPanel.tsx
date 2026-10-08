"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { button, size } from "./ui";
import { LockIcon } from "./PrivacyBadge";
import ProductDemo from "./ProductDemo";
import ContactLink from "./ContactLink";
import { buildDemoTable } from "@/lib/demoReport";
import { moneyFormat } from "@/lib/format";

const evidenceRow = buildDemoTable().rows[3];

interface Props {
  focusOnMount?: boolean;
  onFile: (file: File) => void;
  onSample: () => void;
  busy: boolean;
  error: string | null;
}

const SPREADSHEET_TYPES = new Set(["", "text/csv", "text/plain", "application/csv", "text/x-csv", "text/comma-separated-values", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
function dragStateOf(event: DragEvent) {
  const file = [...event.dataTransfer.items].find((item) => item.kind === "file");
  return !file ? "idle" : SPREADSHEET_TYPES.has(file.type) ? "valid" : "invalid";
}

export default function UploadPanel({ focusOnMount = false, onFile, onSample, busy, error }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const [drag, setDrag] = useState("idle");
  useEffect(() => { if (focusOnMount) uploadRef.current?.focus({ preventScroll: true }); }, [focusOnMount]);
  const pick = (files: FileList | null) => { if (files?.[0] && !busy) onFile(files[0]); };
  return (
    <div className="customer-home">
      <section className="home-hero" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="eyebrow hero-kicker"><span aria-hidden /> For independent repair shops</p>
          <h1 id="hero-heading">Find the value<br />in work <em>left undone.</em></h1>
          <p className="hero-description">Upload your declined-work report. See the reported value, inspect the largest jobs, and decide what deserves another look.</p>
          <div className="hero-actions"><a href="#scan" className={`${button.primary} ${size.lg}`}>Analyze your report <span aria-hidden>↓</span></a><button type="button" onClick={onSample} disabled={busy} className="text-action">Explore a sample <span aria-hidden>→</span></button></div>
          <p className="hero-trust"><LockIcon className="h-4 w-4" /> Your file stays on your device. No account needed.</p>
        </div>
        <ProductDemo onOpen={onSample} />
      </section>

      <section id="how-it-works" className="method-strip" aria-label="How ReclaimBay works">
        <p className="eyebrow method-label">From export to a second look</p>
        <ol>
          {[
            ["01", "Report", "Start with what you have.", "Your shop's declined or deferred-work export."],
            ["02", "Interpretation", "See what adds up.", "Jobs organized by value, service, and available dates."],
            ["03", "Review list", "Decide what to revisit.", "Check the evidence. You choose the next conversation."],
          ].map(([n, stage, title, copy]) => <li key={n}><div className="method-stage"><span className="method-number">{n}</span><span>{stage}</span></div><h2>{title}</h2><p>{copy}</p></li>)}
        </ol>
      </section>

      <section className="evidence-story" aria-labelledby="evidence-heading">
        <div><p className="eyebrow">A number you can investigate</p><h2 id="evidence-heading">The total is just<br />the <em>starting point.</em></h2></div>
        <div className="evidence-copy">
          <p>Every included amount starts with a row in your report. Inspect the record, then decide what still needs attention.</p>
          <figure className="evidence-fragment">
            <figcaption><span>Source report / {String(evidenceRow[5])}</span><span>Fictional example</span></figcaption>
            <dl><div className="evidence-job"><dt>Declined job</dt><dd>{String(evidenceRow[2])}</dd></div><div className="evidence-value"><dt>Reported value</dt><dd>{moneyFormat(true)(Number(evidenceRow[3]))}</dd></div></dl>
            <p className="evidence-inclusion"><span>Basis for inclusion</span>Positive declined estimate in the source report.</p>
          </figure>
          <p className="evidence-decision"><strong>Your decision</strong> Is the work still needed? Has it been done? Is a conversation worthwhile?</p>
          <p className="evidence-boundary">Reported opportunity, not a promise of recovery.</p>
        </div>
      </section>

      <section id="scan" className="upload-section" aria-labelledby="upload-heading">
        <div className="upload-intro"><p className="eyebrow">Your report. Your opportunity.</p><h2 id="upload-heading">Put your own<br />numbers in view.</h2><p>Works with CSV or Excel (.xlsx) exports of declined or deferred work. Include a service description and an amount.</p><p className="upload-access">Free to get started. No account needed.</p><p className="upload-privacy"><LockIcon className="h-4 w-4" /> Read in this browser. Never uploaded.</p></div>
        <div className={`upload-drop ${drag}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDrag(dragStateOf(event)); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrag("idle"); }} onDrop={(event) => { event.preventDefault(); setDrag("idle"); pick(event.dataTransfer.files); }}>
          <input ref={inputRef} type="file" accept=".csv,.xlsx" className="hidden" tabIndex={-1} aria-hidden onChange={(event) => { pick(event.target.files); event.target.value = ""; }} />
          <svg aria-hidden viewBox="0 0 40 40" className="upload-glyph" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M12 5h12l7 7v23H9V5h3M24 5v8h7M20 28V17m-5 5 5-5 5 5" /></svg>
          <h3>{drag === "invalid" ? "Choose a CSV or Excel report" : "Drop your report here"}</h3>
          <p>CSV or XLSX · Up to 15 MB</p>
          <button ref={uploadRef} type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={`${button.primary} ${size.lg}`}>{busy ? "Reading your report…" : "Choose a report"}</button>
          <button type="button" disabled={busy} onClick={onSample} className="text-action">Explore a sample</button>
          {error && <p role="alert" className="upload-error">{error}</p>}
          <p className="upload-hint">Unusual headers? Match the columns before analyzing.</p>
        </div>
      </section>

      <section id="privacy" className="privacy-section" aria-labelledby="privacy-heading">
        <div className="privacy-intro"><p className="eyebrow">Control stays with you</p><h2 id="privacy-heading">Your file never leaves<br /><em>this browser.</em></h2><ContactLink className="mt-6 inline-block text-navy" /></div>
        <dl className="privacy-facts">
          <div><dt>Local</dt><dd>Analyzed in this tab.</dd></div>
          <div><dt>Private</dt><dd>Report contents stay on your device.</dd></div>
          <div><dt>No account</dt><dd>Open a report. Start reviewing.</dd></div>
        </dl>
        <div className="home-faq">
          <details open><summary>What happens to my report?</summary><p>Your file, customer details, and results are never uploaded to ReclaimBay. Refreshing or closing this tab clears the report. Save a PDF or CSV locally to keep it.</p></details>
          <details><summary>How are the numbers calculated?</summary><p>Readable, positive declined amounts are totaled and ranked by value, then grouped by service and available dates. File-quality notes explain exclusions and duplicate handling.</p></details>
          <details><summary>Does this show recovered revenue?</summary><p>No. This is reported declined value. You verify job status, customer interest, and any recovery. ReclaimBay does not track recovered revenue or contact your customers.</p></details>
          <details><summary>What is remembered between visits?</summary><p>This browser may remember recognized column mappings and report-tour completion. Limited usage events measure visits, scans, and exports; they never contain report contents.</p></details>
        </div>
      </section>
      <div className="home-close"><p>Some opportunities deserve<br /><em>a second look.</em></p><a href="#scan" className={`${button.primary} ${size.lg}`}>Analyze your report <span aria-hidden>↑</span></a></div>
    </div>
  );
}
