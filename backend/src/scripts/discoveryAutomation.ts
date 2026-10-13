/** Preview is read-only. Applying requires the IDs/tokens from a saved preview. */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { applyDiscoveryBatch, discoveryAutomationPreview } from "../discovery/automation.js";

const { values } = parseArgs({ options: { apply: { type: "string" }, recovery: { type: "boolean", default: false } } });
const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  if (!values.apply) console.log(JSON.stringify(await discoveryAutomationPreview(db, { recovery: values.recovery }), null, 2));
  else {
    const selected: unknown = JSON.parse(await readFile(values.apply, "utf8"));
    if (!Array.isArray(selected) || selected.some(row => !row || typeof row.id !== "string" || typeof row.token !== "string" || !/^[0-9a-f-]{36}$/.test(row.id))) throw new Error("Apply requires an array of { id, token } selections from a preview (maximum 25).");
    console.log(JSON.stringify(await applyDiscoveryBatch(db, selected, { recovery: values.recovery }), null, 2));
  }
} finally {
  await db.$disconnect();
}
