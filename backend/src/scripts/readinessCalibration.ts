/*
 * Read-only readiness calibration (R16.2). Never fetches, queues, approves, rejects or writes
 * to the database; only writes the report files it is asked for.
 *
 *   npm run discovery:calibrate -- --snapshot <ready-audit.json> [--out result.json] [--markdown report.md]
 *   npm run discovery:calibrate -- [--ids <id,id,...> | --ids-from <ready-audit.json>] [--out ...] [--markdown ...]
 *
 * Without --snapshot it reads DATABASE_URL inside a READ ONLY transaction. Pointing it at
 * production is a separate, explicitly authorized read-only step.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { calibrateReadiness, calibrateSnapshot, type ReadySnapshot } from "../discovery/calibration.js";
import { calibrationMarkdown } from "../discovery/calibrationReport.js";

globalThis.fetch = async () => { throw new Error("Calibration is offline: network access is disabled."); };

const { values } = parseArgs({ options: { snapshot: { type: "string" }, ids: { type: "string" }, "ids-from": { type: "string" }, now: { type: "string" }, out: { type: "string" }, markdown: { type: "string" }, title: { type: "string" } } });
const readSnapshot = async (path: string) => JSON.parse(await readFile(path, "utf8")) as ReadySnapshot;

let result;
if (values.snapshot) result = calibrateSnapshot(await readSnapshot(values.snapshot));
else {
  const { loadConfig } = await import("../config.js");
  const { createDb } = await import("../db.js");
  const ids = values.ids ? values.ids.split(",").map((s) => s.trim()).filter(Boolean) : values["ids-from"] ? (await readSnapshot(values["ids-from"])).candidates.map((c) => c.id) : undefined;
  if (ids?.some((id) => !/^[0-9a-f-]{36}$/.test(id))) throw new Error("Candidate IDs must be UUIDs.");
  const db = createDb(loadConfig().databaseUrl);
  try {
    result = await calibrateReadiness(db, { ids, now: values.now ? new Date(values.now) : undefined });
  } finally {
    await db.$disconnect();
  }
}
if (values.out) await writeFile(values.out, JSON.stringify(result, null, 2) + "\n");
if (values.markdown) await writeFile(values.markdown, calibrationMarkdown(result, values.title));
console.log(JSON.stringify({ source: result.source, asOf: result.asOf, readOnly: result.readOnly, summary: result.summary }, null, 2));
