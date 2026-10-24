/*
 * Supply replenishment from the command line (src/replenishment). It never sends, drafts or creates
 * prospects; it only adds prescreened businesses to Discovery.
 *
 *   npm run discovery:replenish -- --status
 *   npm run discovery:replenish -- --dry-run [--area la-west-sfv] [--limit 20] [--out report.json]
 *   npm run discovery:replenish -- --run                     (one live run: needs REPLENISHMENT_ENABLED=1 and the control on)
 *   npm run discovery:replenish -- --enable  --reason "..."  (also --disable, --pause, --resume)
 *   npm run discovery:replenish -- --configure '{"lowSupply":10}' --reason "..."   ({} returns to the defaults)
 *   npm run discovery:replenish -- --show-config
 *   npm run discovery:replenish -- --import-screened prior.json --reason "..."   (record an earlier prescreen's rejections)
 *
 * --dry-run sources and prescreens for real (provider and website reads within the same budgets) but
 * writes nothing to the database, whatever the control or arm say. The scheduled research worker
 * (discovery:research --auto) runs the live step on its own once both are on.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { changeControl, readControl, recordPriorScreening, replenishmentStatus, replenishmentSummary, runReplenishment, type ControlAction } from "../replenishment/service.js";

const { values } = parseArgs({
  options: {
    status: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    run: { type: "boolean", default: false },
    enable: { type: "boolean", default: false },
    disable: { type: "boolean", default: false },
    pause: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    configure: { type: "string" },
    "show-config": { type: "boolean", default: false },
    "import-screened": { type: "string" },
    reason: { type: "string" },
    area: { type: "string" },
    limit: { type: "string" },
    out: { type: "string" },
  },
});

const actions: [keyof typeof values, ControlAction][] = [["enable", "enable"], ["disable", "disable"], ["pause", "pause"], ["resume", "resume"]];
const chosen = [values.status, values["dry-run"], values.run, values["show-config"], values.configure !== undefined, values["import-screened"] !== undefined, ...actions.map(([k]) => values[k])].filter(Boolean).length;
const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  if (chosen !== 1) throw new Error("Choose exactly one of --status, --dry-run, --run, --enable, --disable, --pause, --resume, --configure, --import-screened or --show-config.");
  if (values.status) {
    console.log(JSON.stringify({ armed: config.replenishmentArmed, ...(await replenishmentStatus(db)) }, null, 2));
  } else if (values["show-config"]) {
    const c = await readControl(db);
    console.log(JSON.stringify({ enabled: c.enabled, paused: c.paused, configError: c.configError, stored: c.storedConfig, effective: c.config }, null, 2));
  } else if (values["import-screened"] !== undefined) {
    const r = await recordPriorScreening(db, JSON.parse(await readFile(values["import-screened"], "utf8")), values.reason);
    console.log(`Prior screening recorded: batch ${r.batchId}, ${r.recorded} record(s), ${r.alreadyPresent} already present.`);
  } else if (values["dry-run"] || values.run) {
    let stop = false;
    process.on("SIGINT", () => void (stop = true));
    process.on("SIGTERM", () => void (stop = true));
    const report = await runReplenishment(db, {
      armed: config.replenishmentArmed, dryRun: values["dry-run"], area: values.area,
      limit: values.limit ? Math.max(1, Number(values.limit) || 1) : undefined, shouldStop: () => stop,
    });
    console.log(replenishmentSummary(report));
    if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2) + "\n");
    if (report.outcome === "failed") process.exitCode = 1;
  } else {
    const action: ControlAction = values.configure !== undefined ? "configure" : actions.find(([k]) => values[k])![1];
    const next = await changeControl(db, action, values.reason, values.configure !== undefined ? JSON.parse(values.configure) : undefined);
    console.log(`Replenishment control: ${action}d. Now ${next.enabled ? "enabled" : "disabled"}${next.pausedAt ? ", paused" : ""}; the service arm REPLENISHMENT_ENABLED is ${config.replenishmentArmed ? "1" : "not 1"} here.`);
  }
} catch (err) {
  console.error(`Replenishment: ${(err instanceof Error ? err.message : "unknown error").replace(/\S+:\/\/\S+/g, "[url]").slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
