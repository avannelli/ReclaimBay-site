/*
 * Read-only views of recorded AI decisions, for the admin. Nothing here
 * writes. Metrics are computed from the records as they stand; where an
 * honest figure doesn't exist yet (no human decision to compare with), the
 * result says so instead of reporting zero.
 */
import type { Db } from "../db.js";
import { COLLISION_FIT_KIND, agreementWithHuman, type CollisionDecision, type HumanFit } from "./collisionFitJudge.js";

type ReadDb = { aiDecision: Pick<Db["aiDecision"], "findMany">; discoveryCandidate: Pick<Db["discoveryCandidate"], "findMany"> };

/** The newest decisions for one candidate, newest first. */
export function candidateAiDecisions(db: { aiDecision: Pick<Db["aiDecision"], "findMany"> }, candidateId: string, take = 3) {
  return db.aiDecision.findMany({ where: { kind: COLLISION_FIT_KIND, subjectType: "candidate", subjectId: candidateId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
}
export type AiDecisionRow = Awaited<ReturnType<typeof candidateAiDecisions>>[number];

/** The most rows the evaluation reads; it says so when there are more. */
export const EVALUATION_ROWS = 5_000;

export interface AiEvaluation {
  rows: number;
  truncated: boolean;
  calls: number;
  reused: number;
  byStatus: Record<string, number>;
  /** Latest valid decision per candidate, prompt, and model. */
  judged: number;
  byDecision: Record<string, number>;
  averageConfidence: number | null;
  topValidationErrors: { error: string; count: number }[];
  rule: { agree: number; disagree: number; notComparable: number };
  /** Against a person's recorded collision decision (at the time, or since). Null: no human decision to compare with yet. */
  human: { compared: number; agree: number; disagree: number; abstained: number; disagreements: { subjectId: string; decision: string; human: HumanFit }[] } | null;
  costMicroUsd: number;
  costLast24hMicroUsd: number;
  averageLatencyMs: number | null;
  versions: { model: string; promptVersion: string; count: number }[];
  recent: { id: string; subjectId: string; status: string; decision: string | null; confidence: number | null; agreement: string | null; model: string; promptVersion: string; createdAt: Date }[];
}

export async function aiEvaluation(db: ReadDb, now = new Date()): Promise<AiEvaluation> {
  const all = await db.aiDecision.findMany({ where: { kind: COLLISION_FIT_KIND }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: EVALUATION_ROWS + 1 });
  const truncated = all.length > EVALUATION_ROWS;
  const rows = all.slice(0, EVALUATION_ROWS);
  const count = <K extends string>(xs: K[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  const isReuse = (r: (typeof rows)[number]) => r.latencyMs === 0 && r.inputTokens === 0;
  const calls = rows.filter((r) => (r.latencyMs ?? 0) > 0 || (r.inputTokens ?? 0) > 0).length;

  // One judgment per candidate, prompt, and model: the newest.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.status === "valid" && !latest.has(`${r.subjectId}|${r.promptVersion}|${r.model}`)) latest.set(`${r.subjectId}|${r.promptVersion}|${r.model}`, r);
  const judged = [...latest.values()];
  const conf = judged.map((r) => r.confidence).filter((c): c is number => c !== null);

  const errorCounts = new Map<string, number>();
  for (const r of rows) if (r.status === "invalid" && Array.isArray(r.validationErrors)) {
    for (const e of r.validationErrors) if (typeof e === "string") {
      const key = e.replace(/^evidence \d+: /, "evidence: ").slice(0, 120);
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    }
  }

  // A person's decision: recorded with the AI decision, or recorded on the candidate since.
  const undecided = judged.filter((r) => !r.humanDecision).map((r) => r.subjectId);
  const later = undecided.length
    ? await db.discoveryCandidate.findMany({ where: { id: { in: [...new Set(undecided)] } }, select: { id: true, signals: { where: { key: "collision_repair_services", origin: "manual", value: { in: ["yes", "no"] } }, select: { value: true } } } })
    : [];
  const laterHuman = new Map(later.filter((c) => c.signals[0]).map((c) => [c.id, c.signals[0]!.value === "yes" ? "collision_yes" : "collision_no"] as const));
  const human = { compared: 0, agree: 0, disagree: 0, abstained: 0, disagreements: [] as { subjectId: string; decision: string; human: HumanFit }[] };
  for (const r of judged) {
    const h = (r.humanDecision as HumanFit | null) ?? laterHuman.get(r.subjectId) ?? null;
    if (!h || !r.decision) continue;
    human.compared++;
    const a = agreementWithHuman(r.decision as CollisionDecision, h);
    human[a === "agree" ? "agree" : a === "disagree" ? "disagree" : "abstained"]++;
    if (a === "disagree" && human.disagreements.length < 25) human.disagreements.push({ subjectId: r.subjectId, decision: r.decision, human: h });
  }

  const latencies = rows.filter((r) => (r.latencyMs ?? 0) > 0).map((r) => r.latencyMs!);
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  const versions = new Map<string, { model: string; promptVersion: string; count: number }>();
  for (const r of rows) {
    const k = `${r.model}|${r.promptVersion}`;
    versions.set(k, { model: r.model, promptVersion: r.promptVersion, count: (versions.get(k)?.count ?? 0) + 1 });
  }
  return {
    rows: rows.length,
    truncated,
    calls,
    reused: rows.filter(isReuse).length,
    byStatus: count(rows.map((r) => r.status)),
    judged: judged.length,
    byDecision: count(judged.map((r) => r.decision ?? "none")),
    averageConfidence: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null,
    topValidationErrors: [...errorCounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([error, n]) => ({ error, count: n })),
    rule: {
      agree: judged.filter((r) => r.agreement === "agree").length,
      disagree: judged.filter((r) => r.agreement === "disagree").length,
      notComparable: judged.filter((r) => r.agreement !== "agree" && r.agreement !== "disagree").length,
    },
    human: human.compared ? human : null,
    costMicroUsd: rows.reduce((s, r) => s + (r.costMicroUsd ?? 0), 0),
    costLast24hMicroUsd: rows.filter((r) => r.createdAt.getTime() >= since).reduce((s, r) => s + (r.costMicroUsd ?? 0), 0),
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    versions: [...versions.values()].sort((a, b) => b.count - a.count),
    recent: rows.slice(0, 25).map((r) => ({ id: r.id, subjectId: r.subjectId, status: r.status, decision: r.decision, confidence: r.confidence, agreement: r.agreement, model: r.model, promptVersion: r.promptVersion, createdAt: r.createdAt })),
  };
}
