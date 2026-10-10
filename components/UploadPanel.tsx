"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { button, size } from "./ui";
import { LockIcon } from "./PrivacyBadge";
import ProductDemo from "./ProductDemo";
import ContactLink from "./ContactLink";
import { buildDemoTable } from "@/lib/demoReport";
import { moneyFormat } from "@/lib/format";

const evidenceTable = buildDemoTable();
const evidenceRow = evidenceTable.rows[3];
/** The export columns the opportunity's service and amount are read from (the record ID labels the row). */
const EVIDENCE_USED = new Set([2, 3]);

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
          <p className="hero-description">ReclaimBay turns your shop’s declined and <span className="whitespace-nowrap">deferred-work</span> export into a prioritized list of jobs worth another look. See the reported value, start with the largest opportunities, and inspect the source details behind each one.</p>
          <div className="hero-actions"><a href="#scan" className={`${button.primary} ${size.lg}`}>Analyze my report <span aria-hidden>↓</span></a><button type="button" onClick={onSample} disabled={busy} className="text-action">See an example <span aria-hidden>→</span></button></div>
          <p className="hero-trust"><LockIcon className="h-4 w-4" /> Your file stays on your device. No account needed.</p>
        </div>
        <ProductDemo onOpen={onSample} />
      </section>

      <section id="how-it-works" className="method-strip" aria-label="How ReclaimBay works">
        <p className="eyebrow method-label">From export to a second look</p>
        <ol>
          {[
            ["01", "Choose your export", "Open a CSV or Excel export of the declined or deferred work your shop already tracks."],
            ["02", "ReclaimBay organizes it", "Your report is turned into a prioritized list of opportunities, starting with the jobs carrying the most reported value."],
            ["03", "Review what deserves another look", "Inspect the jobs and their source details, then decide which ones are worth following up on."],
          ].map(([n, title, copy]) => <li key={n}><div className="method-stage"><span className="method-number">{n}</span></div><h2>{title}</h2><p>{copy}</p></li>)}
        </ol>
      </section>

      <section className="evidence-story" aria-labelledby="evidence-heading">
        <div className="evidence-intro"><p className="eyebrow">Where the numbers come from</p><h2 id="evidence-heading">Every opportunity has <em>a source.</em></h2><p>ReclaimBay ties each included opportunity back to the row it came from, so you can inspect the original details before deciding what deserves a second look.</p></div>
        <figure className="evidence-trace" aria-label="Fictional example: one review opportunity and the source row behind it">
          <div className="evidence-opportunity"><p className="eyebrow">Review opportunity</p><p><span>{String(evidenceRow[2])}</span><strong>{moneyFormat(true)(Number(evidenceRow[3]))}</strong></p></div>
          <p className="evidence-link"><span aria-hidden>↓</span> Source row {String(evidenceRow[5])}</p>
          <dl className="evidence-row">{evidenceTable.headers.slice(0, 5).map((header, column) => <div key={header} data-used={EVIDENCE_USED.has(column) || undefined}><dt>{header}</dt><dd>{String(evidenceRow[column])}</dd></div>)}</dl>
          <figcaption>Fictional example. This is reported declined work, not recovered revenue.</figcaption>
        </figure>
      </section>

      <section id="privacy" className="privacy-section" aria-labelledby="privacy-heading">
        <div className="privacy-intro">
          <p className="eyebrow">What happens to your report</p>
          <h2 id="privacy-heading">Your report stays <em>yours.</em></h2>
          <p>Your file is read in your browser and is not uploaded to ReclaimBay’s servers for analysis.</p>
          <dl className="privacy-facts">
            <div><dt>Local</dt><dd>Read and analyzed in this tab.</dd></div>
            <div><dt>Private</dt><dd>Report contents are not sent to us.</dd></div>
            <div><dt>Exports</dt><dd>PDF and CSV files are made locally.</dd></div>
            <div><dt>No account</dt><dd>No sign-up. Just open a report.</dd></div>
          </dl>
          <p className="privacy-note">The site may collect basic usage analytics, such as visits and completed scans. They never include your report’s contents.</p>
          <ContactLink className="mt-6 inline-block text-navy" />
        </div>
        <div className="home-faq">
          <details><summary>What file types can I use?</summary><p>Use a CSV or Excel (.xlsx) export, up to 15 MB. Each job needs a service description and an amount. Older .xls files need to be re-saved as .xlsx or CSV.</p></details>
          <details><summary>Does my report leave my computer?</summary><p>No. Your report is read and analyzed in your browser and is not sent to ReclaimBay’s servers for analysis. Basic site analytics may still be collected, but they do not include your report’s contents.</p></details>
          <details><summary>What does ReclaimBay remember?</summary><p>Not your report. The browser may remember confirmed column matches, tour completion, and an anonymous analytics ID, plus a referral code if your link included one. Your report itself is not stored.</p></details>
          <details><summary>How are the numbers calculated?</summary><p>The reported value is the total of the readable, positive declined amounts in your report. Those rows become opportunities, ranked by value and grouped by service and available dates. Report checks explain exclusions and duplicate handling.</p></details>
          <details><summary>Does this show recovered revenue?</summary><p>No. This is reported declined value. You verify job status, customer interest, and any recovery. ReclaimBay does not track recovered revenue or contact your customers.</p></details>
        </div>
      </section>

      <section id="scan" className="upload-section" aria-labelledby="upload-heading">
        <div className="upload-intro"><p className="eyebrow">Start here</p><h2 id="upload-heading">Put your own<br />numbers in view.</h2><p>Works with CSV or Excel (.xlsx) exports of declined or deferred work. Include a service description and an amount.</p><p className="upload-access">Free analysis. No account needed.</p><p className="upload-privacy"><LockIcon className="h-4 w-4" /> Read in this browser. Never uploaded.</p></div>
        <div className={`upload-drop ${drag}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDrag(dragStateOf(event)); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrag("idle"); }} onDrop={(event) => { event.preventDefault(); setDrag("idle"); pick(event.dataTransfer.files); }}>
          <input ref={inputRef} type="file" accept=".csv,.xlsx" className="hidden" tabIndex={-1} aria-hidden onChange={(event) => { pick(event.target.files); event.target.value = ""; }} />
          <svg aria-hidden viewBox="0 0 40 40" className="upload-glyph" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M12 5h12l7 7v23H9V5h3M24 5v8h7M20 28V17m-5 5 5-5 5 5" /></svg>
          <h3>{drag === "invalid" ? "Choose a CSV or Excel report" : <><span className="upload-desktop-instruction">Drop your report here</span><span className="upload-mobile-instruction">Export on your shop computer? Try the example first.</span></>}</h3>
          <p>CSV or XLSX · Up to 15 MB</p>
          <button ref={uploadRef} type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={`${button.primary} ${size.lg}`}>{busy ? "Reviewing your report…" : "Analyze my report"}</button>
          <button type="button" disabled={busy} onClick={onSample} className="text-action">See an example</button>
          {error && <p role="alert" className="upload-error">{error}</p>}
          <p className="upload-hint">Different column names are fine. You&apos;ll match them in the next step.</p>
          <p>Not sure which report to export? <ContactLink unstyled label="Talk to ReclaimBay" className="cursor-pointer whitespace-nowrap rounded-md text-white underline decoration-1 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4" /></p>
        </div>
      </section>
      <div className="home-close"><div className="home-close-copy"><p>Ready to take <em>a second look?</em></p><p>Bring your declined or deferred-work export and see which jobs are worth reviewing.</p></div></div>
    </div>
  );
}
