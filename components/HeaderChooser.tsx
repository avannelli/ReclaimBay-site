"use client";

import { useState } from "react";
import type { ParsedTable } from "@/lib/types";
import { button, size } from "./ui";
import PrivacyBadge from "./PrivacyBadge";

export default function HeaderChooser({ table, onConfirm, onCancel }: {
  table: ParsedTable;
  onConfirm: (index: number | null) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState("");
  const rows = table.pendingHeaderRows ?? [];
  return (
    <div className="mx-auto max-w-3xl">
      <PrivacyBadge />
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-navy">Choose the header row</h1>
      <p className="mt-3 text-ink-2">
        We couldn&apos;t safely identify the headers. All {rows.length} nonblank rows are still here.
        Choose the row containing column names, or keep every row if your file has no header.
        Rows above a chosen header are treated as titles and excluded.
      </p>
      <label htmlFor="header-row" className="mt-6 block font-semibold text-ink">Column names</label>
      <select id="header-row" value={choice} onChange={(event) => setChoice(event.target.value)}
        className="mt-2 h-11 w-full rounded-lg border border-slate-300 bg-surface px-3 text-sm text-ink">
        <option value="">Choose a header row...</option>
        <option value="none">No header — keep every row</option>
        {rows.slice(0, -1).map((row, index) => (
          <option key={index} value={index}>
            Row {index + 1}: {row.map((cell) => cell instanceof Date ? cell.toLocaleDateString("en-US") : String(cell ?? "")).join(" · ")}
          </option>
        ))}
      </select>
      <div className="mt-6 flex justify-between gap-3">
        <button type="button" onClick={onCancel} className={`${button.secondaryStrong} ${size.lg}`}>Upload a different file</button>
        <button type="button" disabled={!choice} onClick={() => onConfirm(choice === "none" ? null : Number(choice))}
          className={`${button.primary} ${size.lg}`}>Confirm header and map columns</button>
      </div>
    </div>
  );
}
