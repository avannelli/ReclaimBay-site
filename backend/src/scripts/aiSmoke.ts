/*
 * The AI provider smoke test: one real call for one candidate, recorded
 * nowhere (src/ai/smoke.ts). Run by hand only, never on a schedule.
 *
 *   AI_SMOKE_ENABLED=1 npm run ai:smoke -- --candidate <id>
 *
 * It needs AI_PROVIDER, AI_API_KEY, a model with a known price, and a daily
 * budget (AI_SHADOW_DAILY_BUDGET), and refuses a call whose worst case could
 * exceed $0.25. It never writes to the database, prints no secret, and exits
 * 0 only when the provider answered and the answer passed validation.
 */
import { providerFromConfig } from "../ai/provider.js";
import { parseSmokeArgs, runAiSmoke, smokeSummary } from "../ai/smoke.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { PoliteFetcher } from "../research/fetcher.js";

const args = parseSmokeArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(1);
}
const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const report = await runAiSmoke(db, {
    enabled: config.ai.smokeEnabled,
    provider: providerFromConfig(config.ai),
    dailyBudgetUsd: config.ai.shadowDailyBudgetUsd,
    candidateId: args.candidateId,
    makeFetcher: () => new PoliteFetcher(),
  });
  console.log(smokeSummary(report));
  if (report.outcome !== "valid") process.exitCode = 1;
} catch (err) {
  // Never echo connection strings or keys.
  console.error(`AI smoke test failed: ${(err instanceof Error ? err.message : "unknown error").replace(/\S+:\/\/\S+/g, "[url]").replace(/sk-[A-Za-z0-9_-]+/g, "[key]").slice(0, 300)}`);
  console.error("SMOKE TEST: NO DATABASE WRITE");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
