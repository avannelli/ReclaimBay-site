/*
 * Automated research from the command line: a background job, never part
 * of a web request. Queues research and processes the queue, one website
 * at a time.
 *
 *   npm run discovery:research -- --candidate <id> [--candidate <id> ...]
 *   npm run discovery:research -- --limit 5 [--tier core] [--city Oxnard] [--status discovered]
 *   npm run discovery:research -- --process        (only process what is already queued)
 *   npm run discovery:research -- --auto [--limit 10]  (the automatic worker, for Railway Cron)
 *
 * After each completed run the automatic-approval rule may approve a clean,
 * high-confidence lead; the output says which.
 *
 * --limit picks candidates that have never been researched, newest first,
 * skips any the category check puts outside the target category, and is
 * capped at 25 so a run stays a small, observable batch. --candidate
 * researches exactly the candidates named, whatever their category.
 *
 * --auto is one run of the automatic worker (runAutoResearch): it does
 * nothing unless RESEARCH_AUTORUN_ENABLED=1, and nothing while another
 * automatic run holds the lock. It releases interrupted runs, queues
 * never-researched candidates and then eligible retries ("scheduled"),
 * researches up to --limit (default 10) one at a time, starts nothing new
 * after 10 minutes, and on SIGTERM finishes the candidate in progress and
 * exits. It prints one summary line. Exit code 0 unless something
 * unexpected failed (1). It never sends anything.
 *
 * After the research pass, in the same armed, locked run (3 minutes of the budget are kept for it), it
 * advances the launched autonomous campaign, if any (runAutonomousCampaign): creates prospects for
 * eligible candidates within the caps, and prepares and queues their first messages as campaign members.
 * The sender job (outreach:send) remains the only thing that sends.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { isAutoApproved } from "../discovery/autoApproval.js";
import { listCandidates } from "../discovery/service.js";
import { autoResearchIds, enqueueResearch, processQueuedResearch, runAutoResearch, type AutoResearchReport } from "../research/service.js";
import { runAutonomousCampaign, type AutonomousRunReport } from "../outreach/autonomousCampaign.js";

/** Of the worker's time budget, what is kept for the autonomous campaign step after research. */
const AUTONOMOUS_RESERVE_MS = 3 * 60 * 1000;

const MAX_CLI = 25;

const { values } = parseArgs({
  options: {
    candidate: { type: "string", multiple: true },
    limit: { type: "string" },
    tier: { type: "string" },
    city: { type: "string" },
    status: { type: "string" },
    process: { type: "boolean", default: false },
    auto: { type: "boolean", default: false },
  },
});

const config = loadConfig();
if (values.auto) await auto();
else await manual();

/** One line, counts and ids only (never an address or message content). */
function campaignSummary(r: AutonomousRunReport) {
  if (r.outcome === "no_campaign") return "Autonomous campaign: none active; nothing done.";
  if (r.outcome === "not_launched") return `Autonomous campaign ${r.campaignId}: authorized but not launched; nothing done.`;
  const p = r.prepare;
  return `Autonomous campaign ${r.campaignId}: created ${r.created.length} prospect(s), held ${r.held.length}, failed ${r.failed.length}, deferred ${r.deferred.length}; ` +
    `messages committed ${p?.committed.length ?? 0}, skipped ${p?.skipped.length ?? 0}${p?.stoppedBecause ? ` (${p.stoppedBecause})` : ""}; ${r.outcome.replace("_", " ")}.` +
    (r.failed.length ? ` Failed candidates: ${r.failed.map((f) => f.candidateId).join(", ")}.` : "");
}

function summary(r: AutoResearchReport) {
  if (r.outcome === "disabled") return "Automatic research: off (RESEARCH_AUTORUN_ENABLED is not 1); nothing done.";
  if (r.outcome === "locked") return "Automatic research: another automatic run holds the lock; nothing done.";
  const stopped = { done: "nothing left", limit: "limit reached", budget: "time budget reached", signal: "stopped by signal" }[r.outcome];
  return (
    `Automatic research: queued ${r.queuedFresh} new, ${r.queuedRetries} retr${r.queuedRetries === 1 ? "y" : "ies"}; ` +
    `researched ${r.completed} (${r.approved} approved, ${r.rejected} rejected, ${r.review} for review), ${r.failed} failed; ` +
    `${r.reclaimed} interrupted run(s) released; ${stopped}; ${Math.round(r.elapsedMs / 1000)}s.`
  );
}

async function auto() {
  if (values.candidate?.length || values.process || values.tier || values.city || values.status) {
    console.error("--auto takes only --limit.");
    process.exitCode = 1;
    return;
  }
  let stop = false;
  const onSignal = () => void (stop = true);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const db = createDb(config.databaseUrl);
  try {
    let campaign: AutonomousRunReport | null = null;
    const report = await runAutoResearch(db, {
      enabled: config.researchAutorunEnabled,
      databaseUrl: config.databaseUrl,
      limit: Math.max(1, Number(values.limit ?? 10) || 10),
      shouldStop: () => stop,
      // Then the active autonomous campaign, if one was launched: create prospects, prepare and commit their outreach.
      reserveMs: AUTONOMOUS_RESERVE_MS,
      afterResearch: async ({ shouldStop, deadline }) => {
        campaign = await runAutonomousCampaign(db, { draft: { siteUrl: config.publicSiteUrl, sender: config.outreachSender }, compliance: config, shouldStop, deadline });
      },
    });
    console.log(summary(report));
    if (campaign) console.log(campaignSummary(campaign));
  } catch (err) {
    // Never echo connection strings.
    console.error(`Automatic research failed: ${(err instanceof Error ? err.message : "unknown error").replace(/\S+:\/\/\S+/g, "[url]").slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

async function manual() {
  const db = createDb(config.databaseUrl);
  try {
    let ids: string[] = values.candidate ?? [];
    if (!ids.length && values.limit) {
      const limit = Math.min(MAX_CLI, Math.max(1, Number(values.limit) || 1));
      const list = await listCandidates(db, { tier: values.tier, city: values.city, status: values.status, sort: "discovered" });
      ids = autoResearchIds(list.rows, limit);
    }
    if (ids.length) {
      const q = await enqueueResearch(db, ids, "cli", MAX_CLI);
      console.log(`Queued ${q.queued.length} candidate(s).${q.skipped.length ? ` Skipped: ${q.skipped.map((s) => `${s.candidateId} (${s.reason})`).join(", ")}` : ""}`);
    } else if (!values.process) {
      console.error("Nothing to do: pass --candidate <id>, --limit <n>, or --process.");
      process.exitCode = 1;
    }
    const { reclaimed, processed } = await processQueuedResearch(db, { limit: MAX_CLI });
    if (reclaimed) console.log(`Marked ${reclaimed} interrupted run(s) as failed.`);
    for (const r of processed) {
      if (!r) continue;
      const c = await db.discoveryCandidate.findUnique({ where: { id: r.candidateId }, select: { status: true, decisionReason: true } });
      const approval = c && isAutoApproved(c) ? " -> approved automatically" : "";
      console.log(`  ${r.candidateId} ${r.status}: ${r.outcome ?? "-"} (${r.pagesFetched} page(s))${r.error ? ` ${r.error}` : ""}${approval}`);
    }
  } finally {
    await db.$disconnect();
  }
}
