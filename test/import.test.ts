import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, beforeEach } from "node:test";
import { parseFile, confirmHeader, FileParseError } from "../lib/parseFile";
import { detectColumns, normalizeRows } from "../lib/normalize";
import { analyze } from "../lib/analyze";
import { buildSampleTable } from "../lib/sampleData";
import { buildOpportunitiesCsv } from "../lib/exportCsv";
import { applyRememberedMappings, rememberConfirmedMappings } from "../lib/prefs";
import { verifiedHeaderLabel } from "../lib/headerLabels";
import type { DetectionResult, ParsedTable } from "../lib/types";

// Exercise the real browser entry points, without changing frontend code.
class FileReaderFixture {
  result: string | ArrayBuffer | null = null;
  onload?: (event: { target: FileReaderFixture }) => void;
  onerror?: (error: unknown) => void;
  readAsText(blob: Blob) {
    blob.text().then((text) => { this.result = text; this.onload?.({ target: this }); }, (err) => this.onerror?.(err));
  }
  readAsArrayBuffer(blob: Blob) {
    blob.arrayBuffer().then((data) => { this.result = data; this.onload?.({ target: this }); }, (err) => this.onerror?.(err));
  }
}
Object.defineProperty(globalThis, "FileReader", { value: FileReaderFixture, configurable: true });
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", { value: { localStorage: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} }, configurable: true });
beforeEach(() => storage.clear());
const csv = (text: string) => parseFile(new File([text], "report.csv"));
const AUDIT = "Service,Amount,Customer,,\nBrake repair,100,Ada Example,2026-09-01,11\nTransmission,900,Bo Example,2026-09-02,12";
const weak: DetectionResult = { mapping: {}, confident: false, scores: {} };
const report = (table: ParsedTable) => {
  const normalized = normalizeRows(table, detectColumns(table).mapping);
  return analyze(normalized.opportunities, normalized.quality);
};

test("audit CSV keeps both opportunities, all headers and $1,000", async () => {
  const table = await csv(AUDIT);
  assert.deepEqual(table.headers, ["Service", "Amount", "Customer", "Column 4", "Column 5"]);
  assert.equal(table.headerSource, "detected");
  assert.equal(table.rows.length, 2);
  assert.equal(report(table)?.count, 2);
  assert.equal(report(table)?.total, 1000);
  assert.deepEqual(report(table)?.ranked.map((row) => row.customer), ["Bo Example", "Ada Example"]);
  const exported = buildOpportunitiesCsv(report(table)!.ranked);
  assert.equal(exported.split("\r\n").length, 3);
  assert.match(exported, /Ada Example/);
  assert.match(exported, /Bo Example/);
});
test("ordinary export and text title preambles retain every job", async () => {
  for (const prefix of ["", "Declined work report\nExport details\n"]) {
    const table = await csv(prefix + "Customer Name,Declined Service,Estimate Total,Declined Date\nAda Example,Brake repair,100,2026-09-01\nBo Example,Transmission,900,2026-09-02");
    assert.equal(table.pendingHeaderRows, undefined);
    assert.equal(report(table)?.count, 2);
    assert.equal(report(table)?.total, 1000);
  }
});
test("unknown headers preserve every row until explicit selection", async () => {
  const table = await csv("Person,Task detail,Balance\nAda Example,Brake repair,100\nBo Example,Transmission,900");
  assert.equal(table.rows.length, 3);
  assert.equal(table.pendingHeaderRows?.length, 3);
  assert.equal(detectColumns(table).confident, false);
  const selected = confirmHeader(table, 0);
  assert.equal(selected.rows.length, 2);
  assert.equal(selected.headerSource, "confirmed");
  const data = normalizeRows(selected, { customer: 0, service: 1, amount: 2 });
  assert.equal(analyze(data.opportunities, data.quality)?.total, 1000);
  assert.equal(table.rows.length, 3, "selection does not mutate retained input");
});
test("headerless, competing headers and numeric preambles require confirmation", async () => {
  for (const text of ["Brake repair,100\nTransmission,900", "Service,Amount\nService,Amount\nBrake repair,100", "Summary,100\nService,Amount\nBrake repair,100", "Brake repair,100\nService,Amount"]) {
    const table = await csv(text);
    assert.ok(table.pendingHeaderRows);
    const kept = confirmHeader(table, null);
    assert.equal(kept.rows.length, table.rows.length);
    assert.equal(kept.headerSource, "none");
    assert.throws(() => confirmHeader(table, table.rows.length - 1), FileParseError);
    assert.throws(() => confirmHeader(table, -1), FileParseError);
  }
  const single = await csv("Brake repair,100");
  assert.equal(confirmHeader(single, null).rows.length, 1);
});
test("confirmed known header mappings remain useful across uploads", async () => {
  const table = await csv("Service,Amount,Notes\nBrake repair,100,Ada Example\nTransmission,900,Bo Example");
  const detection = detectColumns(table);
  rememberConfirmedMappings(table, { ...detection.mapping, customer: 2 }, detection);
  assert.equal(storage.get("reclaimbay_column_mappings_v2"), '{"notes":"customer"}');
  const applied = applyRememberedMappings(table, detection);
  assert.equal(applied.mapping.customer, 2);
  assert.equal(applied.applied, 1);
  assert.equal(applied.mapping.amount, 1, "strong built-in matches stay intact");
  assert.equal(applied.mapping.service, 0);
});
test("customer values, placeholders and unestablished headers never persist", () => {
  for (const label of ["Ada Example", "$1,000", "100", "2026-09-01", "12345678", "Brake repair", "Column 1", "Ada Customer", "ada@example.com"]) {
    const table: ParsedTable = { fileName: "test.csv", headers: [label], rows: [[100]], headerSource: "confirmed" };
    rememberConfirmedMappings(table, { customer: 0 }, weak);
    assert.equal(storage.get("reclaimbay_column_mappings_v2"), "{}");
  }
  storage.clear();
  for (const table of [
    { fileName: "test.csv", headers: ["Notes"], rows: [[100]] },
    { fileName: "test.csv", headers: ["Notes"], rows: [[100]], pendingHeaderRows: [[100]] },
  ]) {
    rememberConfirmedMappings(table, { customer: 0 }, weak);
    assert.equal(storage.size, 0);
  }
});
test("legacy mappings are removed and suspicious v2 entries cannot influence matching", async () => {
  storage.set("reclaimbay_column_mappings_v1", '{"100":"amount","ada example":"customer","notes":"customer"}');
  const table = await csv("Service,Amount,Notes\nBrake repair,100,Ada Example");
  assert.equal(applyRememberedMappings(table, weak).applied, 0);
  assert.equal(storage.has("reclaimbay_column_mappings_v1"), false);
  for (const raw of ['{"ada example":"customer","100":"amount"}', '{"notes":"unknown"}', '[]', '{broken']) {
    storage.set("reclaimbay_column_mappings_v2", raw);
    assert.equal(applyRememberedMappings({ ...table, headers: ["Ada Example", "100", "Notes"] }, weak).applied, 0);
  }
});
test("empty, header-only, malformed and unsupported files fail clearly", async () => {
  for (const file of [new File([], "empty.csv"), new File(["\n,,\n"], "empty.csv"), new File(["Service,Amount"], "headers.csv"), new File(['Service,Amount\n"broken,100'], "broken.csv"), new File(["broken"], "broken.xlsx"), new File(["data"], "old.xls"), new File(["data"], "file.txt")]) {
    await assert.rejects(parseFile(file), FileParseError);
  }
});
test("XLSX browser importer has the same audit regression contract", async () => {
  const bytes = readFileSync(new URL("./fixtures/audit.xlsx", import.meta.url));
  const table = await parseFile(new File([bytes], "audit.xlsx"));
  assert.deepEqual(table.headers, ["Service", "Amount", "Customer", "Column 4", "Column 5"]);
  assert.equal(table.rows.length, 2);
  assert.equal(report(table)?.total, 1000);
  assert.equal(report(table)?.count, 2);
});
test("headerless XLSX retains both data rows until explicit confirmation", async () => {
  const bytes = readFileSync(new URL("./fixtures/headerless.xlsx", import.meta.url));
  const pending = await parseFile(new File([bytes], "headerless.xlsx"));
  assert.equal(pending.pendingHeaderRows?.length, 2);
  const table = confirmHeader(pending, null);
  const data = normalizeRows(table, { service: 0, amount: 1 });
  assert.equal(analyze(data.opportunities, data.quality)?.total, 1000);
  assert.equal(data.opportunities.length, 2);
});
test("explicitly choosing a data row as headers still cannot persist its values", async () => {
  const pending = await csv("Brake repair,100,Ada Example,2026-09-01,11\nTransmission,900,Bo Example,2026-09-02,12");
  const table = confirmHeader(pending, 0);
  rememberConfirmedMappings(table, { service: 0, amount: 1, customer: 2, date: 3, recordId: 4 }, weak);
  assert.equal(storage.get("reclaimbay_column_mappings_v2"), "{}");
});
test("existing demo report still analyzes all sample rows", () => {
  const table = buildSampleTable();
  assert.equal(report(table)?.count, table.rows.length);
  assert.equal(detectColumns(table).confident, true);
});

// Pass 20A export audit: a dollar column is never the service, and headers the
// matcher already understands don't need a header-row choice.
const LABOR_ROWS = "640,645,Timing belt and water pump,1285\n520,620,Front struts and mounts,1140\n310,610,Radiator replacement,920";
const services = (table: ParsedTable) => normalizeRows(table, detectColumns(table).mapping).opportunities.map((o) => o.service);
const serviceTable = (values: (string | number | null)[]): ParsedTable => ({
  fileName: "t.csv", headers: ["Service", "Amount"], rows: values.map((v, i) => [v, 100 + i]), headerSource: "detected",
});

test("a Labor dollar column is never matched as the service, even before the real service column", async () => {
  for (const header of ["Recommendation", "Description"]) {
    const table = await csv(`Labor,Parts,${header},Total\n${LABOR_ROWS}`);
    assert.equal(table.pendingHeaderRows, undefined);
    const detection = detectColumns(table);
    assert.equal(table.headers[detection.mapping.service!], header);
    assert.equal(table.headers[detection.mapping.amount!], "Total");
    assert.deepEqual(services(table), ["Timing belt and water pump", "Front struts and mounts", "Radiator replacement"]);
  }
  // With no text column at all, nothing is guessed: the person matches the columns.
  const laborOnly = await csv("Labor,Total\n640,1285\n520,1140");
  const detection = detectColumns(laborOnly);
  assert.equal(detection.confident, false);
  assert.equal(detection.mapping.service, undefined);
});

test("a service column must mostly read as descriptions; numbers inside one are fine", () => {
  // A: ordinary descriptions; B: descriptions with occasional numbers.
  for (const values of [["Front brake pads", "Timing belt and water pump", "Transmission service", "Oil leak diagnosis"], ["Brake service 2 axle", "Replace 4 tires", "Battery group 48 replacement"]]) {
    const detection = detectColumns(serviceTable(values));
    assert.equal(detection.confident, true, values.join(" | "));
    assert.equal(detection.mapping.service, 0);
  }
  // C: numbers or prices under a service header; E: half numbers. Never automatic.
  for (const values of [["640", "520", "$640.00", "$520.00", "640.00"], [640, 520], ["640", "Front brakes", "520", "Transmission service"], ["2026-09-18", "09/18/2026"]]) {
    const detection = detectColumns(serviceTable(values));
    assert.equal(detection.confident, false, values.join(" | "));
    assert.equal(detection.mapping.service, undefined);
  }
  // D: an entirely blank service column isn't trusted; a sparse one with real descriptions still is,
  // and its blank rows keep their existing "Unspecified service" handling.
  assert.equal(detectColumns(serviceTable([null, "", null])).confident, false);
  const sparse = serviceTable(["Front brakes", null, "", null]);
  assert.equal(detectColumns(sparse).confident, true);
  assert.deepEqual(services(sparse), ["Front brakes", "Unspecified service", "Unspecified service", "Unspecified service"]);
});

test("headers with currency marks, abbreviation dots, plurals and Job Total need no header-row choice", async () => {
  for (const [headers, amountHeader] of [
    ["Declined Service,Amount ($),Declined Date", "Amount ($)"],
    ["Declined Service,Est. Total,Declined Date", "Est. Total"],
    ["Declined Service,Total $,Declined Date", "Total $"],
    ["Declined Services,Estimate Total,Declined Date", "Estimate Total"],
    ["Job Description,Job Total", "Job Total"],
  ] as const) {
    const rows = headers.split(",").length === 3 ? "Brake repair,100,09/18/2026\nTransmission,900,08/20/2026" : "Brake repair,100\nTransmission,900";
    const table = await csv(`${headers}\n${rows}`);
    assert.equal(table.pendingHeaderRows, undefined, headers);
    assert.equal(table.headerSource, "detected");
    const detection = detectColumns(table);
    assert.equal(detection.confident, true, headers);
    assert.equal(table.headers[detection.mapping.amount!], amountHeader);
    assert.equal(report(table)?.total, 1000);
  }
});

test("dated, numeric, and prose title rows still can't pass as the header row", async () => {
  for (const title of ["September 18, 2026", "Report generated 09/18/2026", "Totals for 2026,100"]) {
    const table = await csv(`${title}\nService,Amount\nBrake repair,100\nTransmission,900`);
    assert.ok(table.pendingHeaderRows, title);
  }
  // Prose around label words, or label-like cells with digits or other punctuation, are not header labels.
  for (const row of ["Service total for the month,Amount owed by customers", "Service: brakes,Total: 100", "Service 2,Total (2026)", "Service & repair,Total!"]) {
    const table = await csv(`${row}\nBrake repair,100\nTransmission,900`);
    assert.ok(table.pendingHeaderRows, row);
  }
  // What may be remembered between uploads is unchanged: exact plain labels only.
  for (const label of ["Amount ($)", "Est. Total", "Total $", "Declined Services"]) assert.equal(verifiedHeaderLabel(label), null, label);
});
