import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import type { GoldDb } from "../../src/ai/goldSet.js";
import { AUTO_APPROVED_REASON, AUTO_REJECTED_REASON } from "../../src/ai/goldSet.js";
import type { ShadowDb } from "../../src/ai/shadow.js";
import { AUTO_APPROVED_PREFIX, AUTO_REJECTED_PREFIX } from "../../src/discovery/autoApproval.js";

/*
 * The AI shadow layer is isolated by construction:
 *   - it imports only the database client, the shared URL/name normalizer,
 *     and the research fetcher, HTML reader, page picker, and collision
 *     classifier: never the sending, outreach, suppression, discovery, or
 *     research services;
 *   - its only database write is appending an AiDecision row;
 *   - nothing that decides anything (discovery, research, prospects,
 *     outreach, invitations) imports it; only read-only admin views do.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const rel = (abs: string) => path.relative(SRC, abs).split(path.sep).join("/");
const read = (r: string) => readFileSync(path.join(SRC, r), "utf8");
const files = (dir: string): string[] =>
  readdirSync(path.join(SRC, dir)).flatMap((f) => {
    const r = dir ? `${dir}/${f}` : f;
    if (statSync(path.join(SRC, r)).isDirectory()) return f === "generated" ? [] : files(r);
    return f.endsWith(".ts") ? [r] : [];
  });
const AI = files("ai");

/** Runtime imports (type-only imports are erased) of one source file, as src-relative paths or bare specifiers. */
function runtimeImports(r: string): string[] {
  const src = read(r);
  const out: string[] = [];
  for (const m of src.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
    if (m[1]) continue;
    const spec = m[2]!;
    if (!spec.startsWith(".")) {
      out.push(spec);
      continue;
    }
    const abs = path.resolve(path.dirname(path.join(SRC, r)), spec.replace(/\.js$/, ".ts"));
    out.push(existsSync(abs) ? rel(abs) : spec);
  }
  return out;
}

function closure(starts: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length) {
    const r = queue.pop()!;
    if (seen.has(r) || !r.endsWith(".ts") || r.startsWith("generated/")) continue;
    seen.add(r);
    queue.push(...runtimeImports(r).filter((x) => x.endsWith(".ts")));
  }
  return seen;
}

describe("AI shadow layer: isolation", () => {
  test("AI modules import only the allowed foundations", () => {
    const allowed = new Set(["node:crypto", "db.ts", "discovery/normalize.ts", "research/collisionFit.ts", "research/fetcher.ts", "research/html.ts", "research/researcher.ts", ...AI]);
    for (const f of AI) for (const i of runtimeImports(f)) assert.ok(allowed.has(i), `${f} imports ${i}`);
    for (const i of runtimeImports("scripts/aiShadow.ts")) assert.ok(["node:util", "config.ts", "db.ts", "research/fetcher.ts", ...AI].includes(i), `scripts/aiShadow.ts imports ${i}`);
    for (const i of runtimeImports("scripts/aiCohort.ts")) assert.ok(["node:fs", "node:util", "config.ts", "db.ts", ...AI].includes(i), `scripts/aiCohort.ts imports ${i}`);
  });

  test("nothing that sends, dispatches, queues, suppresses, or decides is reachable from the AI layer", () => {
    const reach = closure([...AI, "scripts/aiShadow.ts", "scripts/aiCohort.ts"]);
    const forbidden = [
      "outreach/dispatch.ts", "outreach/sender.ts", "outreach/gmail.ts", "outreach/gmailAuth.ts", "outreach/gmailInbox.ts", "outreach/service.ts",
      "outreach/prepare.ts", "outreach/eligibility.ts", "outreach/emailedUnsubscribe.ts", "outreach/reconcile.ts", "outreach/inboxAttribution.ts",
      "invitations/service.ts", "discovery/service.ts", "discovery/autoApproval.ts", "discovery/approval.ts", "research/service.ts",
    ];
    for (const f of forbidden) assert.ok(!reach.has(f), `${f} must not be reachable from src/ai`);
    for (const f of reach) assert.ok(!f.startsWith("routes/") && !f.startsWith("admin/"), `${f} must not be reachable from src/ai`);
  });

  test("AI code never names a state-changing function; each file writes only its own append-only records", () => {
    // The only writes in src/ai, by file: the shadow runner appends decisions; the gold set appends cohorts and labels.
    const allowedWrites: Record<string, string[]> = { "ai/shadow.ts": ["aiDecision.create"], "ai/goldSet.ts": ["aiEvalCohort.create", "aiLabel.create"] };
    const changers = /\b(suppressEmail|lockSendGate|cancelOpenOutreach|changeStatus\w*|updateProspect|createProspect|insertProspect|addEvidence|approveCandidate|autoDecideCandidate|autoApproveCandidate|autoRejectCandidate|updateCandidate|queueOutreach|createOutreachDraft|dispatchQueued|recordSentInTx|unsubscribeOutreachInTx|enqueueResearch|processResearch)\b/;
    for (const f of AI) {
      const src = read(f);
      assert.equal(changers.exec(src)?.[0], undefined, `${f} names a state-changing function`);
      // Prisma model calls look like db.<model>.<operation>(.
      for (const m of src.matchAll(/\b\w+\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)) {
        assert.ok((allowedWrites[f] ?? []).includes(`${m[1]}.${m[2]}`), `${f}: ${m[0]}`);
      }
      assert.equal(/\$executeRaw|\$transaction/.exec(src)?.[0], undefined, `${f} uses raw writes or transactions`);
      for (const m of src.matchAll(/\$queryRaw/g)) assert.match(src.slice(m.index!, m.index! + 60), /pg_try_advisory_lock|pg_advisory_unlock/, `${f}: raw SQL only for the advisory lock`);
    }
  });

  test("nothing that decides anything imports the AI layer; only read-only admin views do", () => {
    const importers = files("").filter((f) => !f.startsWith("ai/") && /from ["'][./]+(?:\.\.\/)?ai\//.test(read(f)));
    assert.deepEqual(importers.sort(), ["admin/aiLabelViews.ts", "admin/aiViews.ts", "admin/discoveryViews.ts", "routes/adminAi.ts", "routes/adminDiscovery.ts", "scripts/aiCohort.ts", "scripts/aiShadow.ts"]);
    // The AI-output views have no forms or buttons; the only POST routes write gold-set cohorts and human labels.
    assert.doesNotMatch(read("admin/aiViews.ts"), /<form|<button|method="post"/i);
    const posts = [...read("routes/adminAi.ts").matchAll(/app\.(post|put|patch|delete)<[^>]*>\("([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(posts.sort(), ["post /admin/ai/cohorts", "post /admin/ai/label/:caseId", "post /admin/ai/label/:caseId/adjudicate"]);
    assert.doesNotMatch(read("admin/discoveryViews.ts"), /from ["']\.\.\/ai\/(?!records\.js)/, "discovery views use only the read helpers' types");
    assert.doesNotMatch(read("routes/adminDiscovery.ts"), /from ["']\.\.\/ai\/(?!records\.js|goldSet\.js)/, "the candidate route only reads");
  });

  test("blind labeling never sees AI output: the gold-set module and the labeling views don't touch AI decisions", () => {
    for (const f of ["ai/goldSet.ts", "admin/aiLabelViews.ts"]) {
      const src = read(f);
      assert.equal(/aiDecision|AiDecision|collisionFitJudge|records\.js|evaluation\.js|shadow\.js|provider\.js/.exec(src)?.[0], undefined, `${f} must not reference AI decisions`);
    }
    assert.deepEqual(runtimeImports("admin/aiLabelViews.ts").filter((i) => i.startsWith("ai/")), ["ai/goldSet.ts"]);
    // The strata read the automatic decision reasons by their recorded prefixes; keep them in step.
    assert.equal(AUTO_APPROVED_REASON, AUTO_APPROVED_PREFIX);
    assert.equal(AUTO_REJECTED_REASON, AUTO_REJECTED_PREFIX);
  });

  test("the gold-set handle can't read AI decisions or change any candidate (compile-time)", () => {
    const unreachable = (db: GoldDb) => {
      // @ts-expect-error no AI decisions on the labeling side
      void db.aiDecision;
      // @ts-expect-error a candidate can't be updated
      void db.discoveryCandidate.update;
      // @ts-expect-error a label is never updated
      void db.aiLabel.update;
      // @ts-expect-error a label is never deleted
      void db.aiLabel.delete;
      // @ts-expect-error a cohort's cases are never changed
      void db.aiEvalCase.update;
      // @ts-expect-error nor added to
      void db.aiEvalCase.create;
      // @ts-expect-error no prospects
      void db.prospect;
    };
    assert.equal(typeof unreachable, "function");
  });

  test("the runner's database handle can't change anything but AiDecision (compile-time)", () => {
    // These lines never run; the typecheck fails if the handle ever grows write access.
    const unreachable = (db: ShadowDb) => {
      // @ts-expect-error a candidate can't be updated
      void db.discoveryCandidate.update;
      // @ts-expect-error a candidate can't be created
      void db.discoveryCandidate.create;
      // @ts-expect-error cohorts are read, never changed, by the runner
      void db.aiEvalCase.create;
      // @ts-expect-error an AI decision is never updated
      void db.aiDecision.update;
      // @ts-expect-error an AI decision is never deleted
      void db.aiDecision.delete;
      // @ts-expect-error no prospects
      void db.prospect;
      // @ts-expect-error no outreach
      void db.outreach;
      // @ts-expect-error no suppression
      void db.emailSuppression;
      // @ts-expect-error no raw SQL
      void db.$executeRaw;
      // @ts-expect-error no transactions
      void db.$transaction;
    };
    assert.equal(typeof unreachable, "function");
  });
});
