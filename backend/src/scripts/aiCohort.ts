/*
 * Builds a gold-set cohort for blind AI evaluation (src/ai/goldSet.ts): a
 * background job, never part of a web request. Dry run by default.
 *
 *   npm run ai:cohort -- --seed gold-2026-10                 (shows the stratified plan; writes nothing)
 *   npm run ai:cohort -- --seed gold-2026-10 --name "Gold set 1" --apply
 *   npm run ai:cohort -- --seed s --name "Manual" --candidates ids.txt --apply   (an explicit list, one candidate id per line)
 *
 * It reads candidates and their research, never AI output, and writes only
 * the cohort and its cases. It changes no candidate, prospect, or outreach
 * record, and uses whichever database DATABASE_URL points to.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AiEvalError, STRATUM_LABELS, createCohort, planCohort, type Stratum } from "../ai/goldSet.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";

const { values } = parseArgs({ options: { seed: { type: "string" }, name: { type: "string" }, candidates: { type: "string" }, apply: { type: "boolean", default: false } } });
if (!values.seed) {
  console.error("--seed is required.");
  process.exit(1);
}
const candidateIds = values.candidates ? readFileSync(values.candidates, "utf8").split(/\s+/).filter(Boolean) : undefined;
const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const plan = await planCohort(db, { seed: values.seed, candidateIds });
  for (const [s, v] of Object.entries(plan.strata)) console.log(`  ${STRATUM_LABELS[s as Stratum] ?? s}: ${v.chosen} of ${v.available} available (quota ${v.quota})`);
  console.log(`Plan: ${plan.picks.length} case(s).`);
  if (!values.apply) console.log("Dry run: nothing written. Add --name and --apply to create the cohort.");
  else if (!values.name) {
    console.error("--name is required with --apply.");
    process.exitCode = 1;
  } else {
    const c = await createCohort(db, { name: values.name, seed: values.seed, candidateIds });
    console.log(`Created cohort "${c.name}" (${c.id}) with ${c._count.cases} case(s).`);
  }
} catch (err) {
  console.error(err instanceof AiEvalError ? err.messages.join(" ") : `Failed: ${(err instanceof Error ? err.message : "unknown error").replace(/\S+:\/\/\S+/g, "[url]").slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
