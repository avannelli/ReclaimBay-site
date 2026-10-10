import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { jsPDF } from "jspdf";
import {
  createSummaryPdf,
  downloadSummaryPdf,
  type SummaryInput,
} from "../lib/pdfReport";
import { demoAnalysis, DEMO_DATE } from "../lib/demoReport";
import { analyze } from "../lib/analyze";
import { detectColumns, normalizeRows } from "../lib/normalize";
import { buildOpportunitiesCsv, exportFileName } from "../lib/exportCsv";
import type { ParsedTable } from "../lib/types";

/* Read actual jsPDF page-text streams with Node's zlib; no PDF test framework. */
function pageTexts(doc: jsPDF): string[][] {
  const pages: string[][] = [];
  for (const match of doc
    .output()
    .matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let stream: string;
    try {
      stream = inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue;
    } // Logo image streams do not contain PDF text operators.
    const text = [...stream.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)].map((m) =>
      m[1].replace(/\\([\\()])/g, "$1"),
    );
    if (text.length) pages.push(text);
  }
  assert.equal(
    pages.length,
    doc.getNumberOfPages(),
    "each actual PDF page must expose text",
  );
  return pages;
}

const sample = (): SummaryInput => {
  const { analysis, table } = demoAnalysis();
  return {
    analysis,
    fileName: table.fileName,
    isSample: true,
    notes: [],
    analyzedAt: DEMO_DATE,
  };
};

test("the actual sample PDF leads with existing totals and jobs, then the complete list and honest source/methodology notes", async () => {
  const input = sample();
  const before = structuredClone(input);
  const csv = buildOpportunitiesCsv(input.analysis.ranked);
  const doc = await createSummaryPdf(input);
  const pages = pageTexts(doc);
  assert.equal(pages.length, 2, "the six-job sample stays concise");
  assert.equal(
    Buffer.from(doc.output("arraybuffer")).subarray(0, 5).toString(),
    "%PDF-",
  );
  assert.ok(pages[0].includes("$4,327.48"));
  assert.ok(pages[0].includes("6"));
  assert.ok(pages[0].includes("OPPORTUNITIES TO REVIEW"));
  for (const job of input.analysis.ranked.slice(0, 3))
    assert.ok(pages[0].includes(job.service));
  for (const job of input.analysis.ranked)
    assert.ok(pages[1].includes(job.service));
  const text = pages.flat().join(" ");
  assert.match(
    text,
    /Original row numbers, raw cells and record IDs are not retained/,
  );
  assert.match(text, /job numbers refer to this ranked list/);
  assert.match(text, /Readable, positive declined amounts are totaled/);
  assert.match(text, /unique record ID are counted once/);
  assert.match(text, /without a unique ID remain in the total/);
  assert.match(text, /not recovered revenue/);
  assert.doesNotMatch(
    text,
    /recovered revenue[: ]+\$|guarantee|verified revenue|AI-powered|integration|contacted customers/i,
  );
  assert.doesNotMatch(text, /JAC-001|Source row 1|SOURCE ROW/);
  pages.forEach((page, i) => {
    assert.ok(page.includes("SAMPLE REPORT · FICTIONAL DATA"));
    assert.ok(page.includes(`Page ${i + 1} of ${pages.length}`));
  });
  assert.deepEqual(
    input,
    before,
    "PDF layout must not mutate analysis or report state",
  );
  assert.equal(
    buildOpportunitiesCsv(input.analysis.ranked),
    csv,
    "CSV bytes remain identical",
  );
});

test("all jobs beyond the former 25-row cap survive pagination, with repeated headers and intact ordinary rows", async () => {
  const input = sample();
  const jobs = Array.from({ length: 37 }, (_, i) => ({
    ...input.analysis.ranked[i % 6],
    id: i,
    service: `Complete job ${String(i).padStart(2, "0")}`,
    amount: 10000 - i,
  }));
  input.analysis = analyze(jobs, input.analysis.quality)!;
  input.isSample = false;
  const pages = pageTexts(await createSummaryPdf(input));
  assert.ok(pages.length > 2);
  const listPages = pages.slice(1);
  const text = listPages.flat().join(" ");
  for (const job of jobs)
    assert.equal(
      listPages.filter((page) => page.includes(job.service)).length,
      1,
      job.service,
    );
  assert.match(text, /Complete job 36/);
  assert.doesNotMatch(text, /largest of|CSV for the full list|Same job/);
  for (const page of listPages.filter((p) =>
    p.some((text) => text.startsWith("Complete job")),
  )) {
    assert.ok(page.includes("SERVICE / CUSTOMER / VEHICLE"));
    assert.ok(page.includes("REPORTED"));
  }
  const printed = listPages
    .flat()
    .filter((text) => text.startsWith("Complete job"));
  assert.deepEqual(
    printed,
    input.analysis.ranked.map((job) => job.service),
  );
});

test("missing customer/vehicle/date details and whole-dollar amounts are stated without invented fields", async () => {
  const input = sample();
  input.analysis = analyze(
    input.analysis.ranked.slice(0, 2).map((job) => ({
      ...job,
      customer: undefined,
      vehicle: undefined,
      date: undefined,
      ageDays: undefined,
      amount: 100,
    })),
    input.analysis.quality,
  )!;
  input.isSample = false;
  const text = pageTexts(await createSummaryPdf(input))
    .flat()
    .join(" ");
  assert.match(text, /Customer \/ vehicle not provided/);
  assert.match(text, /Date not provided/);
  assert.match(text, /\$200\b/);
  assert.doesNotMatch(
    text,
    /\$200\.00|Riley Chen|SAMPLE REPORT|0%|NaN|undefined/,
  );
});

test("the existing duplicate and exclusion calculations remain visible and unchanged", async () => {
  const table: ParsedTable = {
    fileName: "checks.csv",
    headerSource: "detected",
    headers: ["Customer", "Service", "Amount", "Record ID"],
    rows: [
      ["Pat", "Brake service", 100, "A"],
      ["Pat", "Brake service", 100, "A"],
      ["Alex", "Cooling system", 200, null],
      ["Alex", "Cooling system", 200, null],
      ["Riley", "Battery", -1, "C"],
    ],
  };
  // A user-confirmed record-ID mapping enables confirmed duplicate removal.
  const normalized = normalizeRows(
    table,
    { ...detectColumns(table).mapping, recordId: 3 },
    DEMO_DATE,
  );
  const analysis = analyze(normalized.opportunities, normalized.quality)!;
  assert.equal(analysis.total, 500);
  assert.equal(analysis.count, 3);
  assert.equal(analysis.quality.skippedRows, 1);
  assert.equal(analysis.quality.confirmedDuplicateRows, 1);
  assert.equal(analysis.quality.possibleDuplicateRows, 1);
  const before = structuredClone(analysis);
  const text = pageTexts(
    await createSummaryPdf({
      ...sample(),
      analysis,
      isSample: false,
      notes: [],
    }),
  )
    .flat()
    .join(" ");
  assert.match(text, /\$500\b/);
  assert.match(
    text,
    /excluded amount rows 1; confirmed duplicates removed 1; extra matching rows retained 1/,
  );
  assert.match(text, /Possible duplicate/);
  assert.deepEqual(analysis, before);
  const notes = [
    "1 possible duplicate preserved ($200). Review it in the list below.",
  ];
  const printedNotes = pageTexts(
    await createSummaryPdf({ ...sample(), analysis, isSample: false, notes }),
  )
    .flat()
    .join(" ");
  assert.match(printedNotes, /Review it in the opportunity list\./);
  assert.doesNotMatch(printedNotes, /list below/);
  assert.deepEqual(notes, [
    "1 possible duplicate preserved ($200). Review it in the list below.",
  ]);
});

test("an exceptionally long job continues explicitly and retains the end of its description", async () => {
  const input = sample();
  const long = {
    ...input.analysis.highest,
    service:
      "Detailed cooling-system inspection. ".repeat(240) + "END_OF_LONG_JOB",
  };
  input.analysis = analyze([long], input.analysis.quality)!;
  const pages = pageTexts(await createSummaryPdf(input));
  const text = pages.flat().join(" ");
  assert.ok(pages.length > 2);
  assert.match(text, /Same job/);
  assert.match(text, /END_OF_LONG_JOB/);
  assert.equal(input.analysis.count, 1);
});

test("the existing PDF download saves locally with the unchanged filename and makes no data requests", async () => {
  const input = sample();
  const name = exportFileName("report", "pdf", {
    fileName: input.fileName,
    isSample: true,
    date: DEMO_DATE,
  });
  const api = jsPDF.API as typeof jsPDF.API & {
    save?: (this: jsPDF, filename?: string) => jsPDF;
  };
  const originalSave = api.save;
  const originalFetch = globalThis.fetch;
  let saved: string | undefined;
  let requests = 0;
  api.save = function (this: jsPDF, filename?: string) {
    saved = filename;
    return this;
  };
  globalThis.fetch = async () => {
    requests++;
    throw new Error("PDF generation must remain local");
  };
  try {
    await downloadSummaryPdf(input, name);
    assert.equal(saved, name);
    assert.equal(requests, 0);
    assert.match(name, /^reclaimbay-report-sample-\d{4}-\d{2}-\d{2}\.pdf$/);
  } finally {
    if (originalSave) api.save = originalSave;
    else delete api.save;
    globalThis.fetch = originalFetch;
  }
});
