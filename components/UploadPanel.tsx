"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { button, size } from "./ui";
import { LockIcon } from "./PrivacyBadge";
import ProductDemo from "./ProductDemo";
import ContactLink from "./ContactLink";

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
          <p className="hero-description">Your customers declined the work. See what it adds up to, which jobs deserve a second look, and where to start.</p>
          <div className="hero-actions"><a href="#scan" className={`${button.primary} ${size.lg}`}>Analyze your report <span aria-hidden>↗</span></a><button type="button" onClick={onSample} disabled={busy} className="text-action">Explore a sample <span aria-hidden>→</span></button></div>
          <p className="hero-trust"><LockIcon className="h-4 w-4" /> Your file stays on your device. No account needed.</p>
          <div className="hero-footnote"><span aria-hidden>01 —</span><p>A clearer view of declined work.<br /><strong>Built from the numbers you already have.</strong></p></div>
        </div>
        <ProductDemo onOpen={onSample} />
      </section>

      <section id="how-it-works" className="method-strip" aria-label="How ReclaimBay works">
        {[
          ["01", "Bring the report", "Export declined or deferred work from your shop management system."],
          ["02", "See what adds up", "Get the total, the largest jobs, and a breakdown by service and age."],
          ["03", "Decide what to revisit", "Check the job details and current customer situation before following up."],
        ].map(([n, title, copy]) => <div key={n}><span className="method-number">{n}</span><div><h2>{title}</h2><p>{copy}</p></div></div>)}
      </section>

      <section className="evidence-story" aria-labelledby="evidence-heading">
        <div><p className="eyebrow">A number you can investigate</p><h2 id="evidence-heading">The total is just<br />the <em>starting point.</em></h2></div>
        <div className="evidence-copy"><p>Every opportunity comes from a job in your report. See the service, amount, customer, vehicle, and decline date when your export includes them.</p><p>Start with the largest jobs. Then check what is still needed, what has already been done, and whether a conversation makes sense.</p><p className="evidence-boundary"><span aria-hidden>↳</span> Reported opportunity, not a promise of recovery. You make the final call.</p></div>
      </section>

      <section id="scan" className="upload-section" aria-labelledby="upload-heading">
        <div className="upload-intro"><p className="eyebrow">Your report. Your opportunity.</p><h2 id="upload-heading">Put your own<br />numbers in view.</h2><p>All you need is a declined-work export with a service description and an amount. Dates and customer details make the review more useful.</p><p className="upload-privacy"><LockIcon className="h-4 w-4" /> Read in this browser. Never uploaded.</p></div>
        <div className={`upload-drop ${drag}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDrag(dragStateOf(event)); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrag("idle"); }} onDrop={(event) => { event.preventDefault(); setDrag("idle"); pick(event.dataTransfer.files); }}>
          <input ref={inputRef} type="file" accept=".csv,.xlsx" className="hidden" tabIndex={-1} aria-hidden onChange={(event) => { pick(event.target.files); event.target.value = ""; }} />
          <svg aria-hidden viewBox="0 0 40 40" className="upload-glyph" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M12 5h12l7 7v23H9V5h3M24 5v8h7M20 28V17m-5 5 5-5 5 5" /></svg>
          <h3>{drag === "invalid" ? "Choose a CSV or Excel report" : "Drop your report here"}</h3>
          <p>CSV or XLSX · Up to 15 MB</p>
          <button ref={uploadRef} type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={`${button.primary} ${size.lg}`}>{busy ? "Reading your report…" : "Choose a report"} <span aria-hidden>↗</span></button>
          <button type="button" disabled={busy} onClick={onSample} className="text-action">No report handy? Try the sample</button>
          {error && <p role="alert" className="upload-error">{error}</p>}
          <p className="upload-hint">Unusual headers? We&apos;ll help you match the columns before analyzing.</p>
        </div>
      </section>

      <section id="privacy" className="privacy-section" aria-labelledby="privacy-heading">
        <div><p className="eyebrow">Control stays with you</p><h2 id="privacy-heading">Private by design.<br /><em>Clear by default.</em></h2><ContactLink className="mt-6 inline-block text-navy" /></div>
        <div className="home-faq">
          <details open><summary>What happens to my report?</summary><p>Your report is read and analyzed in this browser tab. The file, customer details, and results are never uploaded to ReclaimBay. Closing or refreshing the page clears the report. You can save a PDF summary or a CSV locally.</p></details>
          <details><summary>How are the numbers calculated?</summary><p>ReclaimBay totals readable, positive declined amounts and ranks the included jobs by value. It groups services into categories and uses available dates for age breakdowns. File-quality notes explain excluded rows and duplicate handling.</p></details>
          <details><summary>Does this show recovered revenue?</summary><p>No. It shows the value of declined work in your export. Current job status, customer interest, and any eventual recovery need your review. ReclaimBay does not track recovered revenue or contact your customers.</p></details>
          <details><summary>What is remembered between visits?</summary><p>Your report is cleared on refresh. This browser may remember recognized column mappings and whether you finished the report tour. Limited usage events help us understand visits, scans, and exports; they never contain report contents.</p></details>
        </div>
      </section>
      <div className="home-close"><p>Some opportunities deserve<br /><em>a second look.</em></p><a href="#scan" className={`${button.primary} ${size.lg}`}>Start with your report <span aria-hidden>↗</span></a></div>
    </div>
  );
}
