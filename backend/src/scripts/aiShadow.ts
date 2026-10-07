/*
 * The AI shadow job (collision/body fit), for Railway Cron or by hand: a
 * background job, never part of a web request. It records AI decisions for
 * evaluation and acts on none of them.
 *
 *   npm run ai:shadow                 (candidates the rules leave for a person to verify)
 *   npm run ai:shadow -- --labeled    (candidates a person already decided: measures agreement)
 *   npm run ai:shadow -- --cohort <id> (the candidates of one gold-set cohort, in labeling order)
 *
 * It does nothing unless AI_SHADOW_ENABLED=1, AI_PROVIDER and AI_API_KEY are
 * set, the model (AI_MODEL) has a known price, and AI_SHADOW_DAILY_BUDGET is
 * above 0; and nothing while another shadow run holds the lock. At most
 * AI_SHADOW_BATCH_LIMIT provider calls per run (default 5, at most 25). It
 * prints one summary line. Exit code 0 unless something unexpected failed.
 * It never changes a candidate, prospect, or anything in outreach.
 */
import { parseArgs } from "node:util";
import { acquireShadowLock } from "../ai/lock.js";
import { providerFromConfig } from "../ai/provider.js";
import { runAiShadow, shadowSummary } from "../ai/shadow.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { PoliteFetcher } from "../research/fetcher.js";

const { values } = parseArgs({ options: { labeled: { type: "boolean", default: false }, cohort: { type: "string" } } });
if (values.labeled && values.cohort) {
  console.error("--labeled and --cohort can't be combined.");
  process.exit(1);
}

const config = loadConfig();
let stop = false;
const onSignal = () => void (stop = true);
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
const db = createDb(config.databaseUrl);
try {
  const report = await runAiShadow(db, {
    enabled: config.ai.shadowEnabled,
    provider: providerFromConfig(config.ai),
    dailyBudgetUsd: config.ai.shadowDailyBudgetUsd,
    limit: config.ai.shadowBatchLimit,
    mode: values.cohort ? "cohort" : values.labeled ? "labeled" : "verify",
    cohortId: values.cohort,
    acquireLock: () => acquireShadowLock(config.databaseUrl),
    makeFetcher: () => new PoliteFetcher(),
    shouldStop: () => stop,
  });
  console.log(shadowSummary(report));
} catch (err) {
  // Never echo connection strings or keys.
  console.error(`AI shadow failed: ${(err instanceof Error ? err.message : "unknown error").replace(/\S+:\/\/\S+/g, "[url]").replace(/sk-[A-Za-z0-9_-]+/g, "[key]").slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
