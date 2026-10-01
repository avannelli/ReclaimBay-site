/*
 * Loads one provider release into staging. A background job: run it from a
 * shell or a scheduler, never from a web request.
 *
 *   npm run discovery:import -- --provider overture --release latest --scope US-CA --county "Ventura County"
 *   npm run discovery:import -- --provider fixture-staged --release 2026-10-fixture --scope US-CA
 *
 * --release  a release name, or "latest" where the importer supports it
 * --scope    the state, ISO 3166-2 style (US-CA)
 * --county   limit the import to one county (required for Overture)
 * --force    import again even if this release already completed for the scope
 * --keep     how many completed imports per scope keep their rows (default 2)
 *
 * Safe to rerun: an interrupted import is marked failed and pruned on the
 * next run, and a release already imported for the scope is skipped.
 * Only registered importers can run (see providerImporters).
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { providerImporters } from "../discovery/providers.js";
import { runImport } from "../discovery/staging.js";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    release: { type: "string" },
    scope: { type: "string" },
    county: { type: "string" },
    keep: { type: "string" },
    force: { type: "boolean", default: false },
  },
});

const config = loadConfig();
const importers = providerImporters(config);
const importer = importers.get(values.provider ?? "");
if (!importer) {
  console.error(`Unknown or unavailable importer "${values.provider ?? ""}". Available: ${[...importers.keys()].join(", ") || "none"}.`);
  process.exit(1);
}
if (!values.release || !values.scope) {
  console.error("--release and --scope (e.g. US-CA) are required.");
  process.exit(1);
}

const db = createDb(config.databaseUrl);
try {
  const started = Date.now();
  const result = await runImport(
    db,
    importer,
    values.release,
    { region: values.scope, county: values.county ?? null },
    {
      keep: values.keep ? Number(values.keep) : undefined,
      force: values.force,
      onBatch: (n) => console.log(`  staged ${n} record(s)`),
    },
  );
  if (result.status === "unchanged") {
    console.log(`Release ${result.release} is already imported for ${result.scope} (${result.recordCount} records). Use --force to import it again.`);
  } else {
    console.log(`${result.status}: ${result.recordCount} record(s) staged for ${result.scope} from release ${result.release} in ${Math.round((Date.now() - started) / 1000)}s.`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
