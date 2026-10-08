import { analyze } from "./analyze";
import { detectColumns, normalizeRows } from "./normalize";
import type { ParsedTable } from "./types";

export const DEMO_SHOP = "Juniper Auto Care";
export const DEMO_DATE = new Date("2026-09-30T12:00:00Z");

/** Fictional, coherent source data. The demonstration uses the real pipeline. */
export function buildDemoTable(): ParsedTable {
  return {
    fileName: "Juniper Auto Care — sample declined work.csv",
    headers: ["Customer Name", "Vehicle", "Declined Service", "Estimate Total", "Declined Date", "Record ID"],
    rows: [
      ["Riley Chen", "2014 Ford F-150", "Timing belt and water pump", 1285, "2026-09-18", "JAC-001"],
      ["Morgan Diaz", "2012 Chevrolet Silverado", "Front struts and mounts", 1140, "2026-08-20", "JAC-002"],
      ["Jordan Patel", "2013 Honda Accord", "Radiator replacement", 920, "2026-06-26", "JAC-003"],
      ["Casey Rivera", "2016 Toyota Camry", "Front brake pads and rotors", 612.50, "2026-09-22", "JAC-004"],
      ["Alex Morgan", "2018 Honda CR-V", "Brake fluid flush", 149.99, "2026-09-24", "JAC-005"],
      ["Taylor Brooks", "2019 Subaru Outback", "Battery replacement", 219.99, "2026-09-25", "JAC-006"],
    ],
  };
}

export function demoAnalysis() {
  const table = buildDemoTable();
  const data = normalizeRows(table, detectColumns(table).mapping, DEMO_DATE);
  const analysis = analyze(data.opportunities, data.quality);
  if (!analysis) throw new Error("The synthetic demo must contain opportunities.");
  return { table, analysis };
}
