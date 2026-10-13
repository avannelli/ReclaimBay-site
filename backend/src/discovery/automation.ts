import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { ProspectError } from "../prospects.js";
import { RESEARCH_VERSION } from "../research/researcher.js";
import { lockCandidate } from "./service.js";
import { categoryFields } from "./categoryCheck.js";
import { AUTOMATION_RULES, assessDiscovery, automationInclude, type AutomationCandidate, type AutomationAssessment } from "./automationPolicy.js";
import { candidateProtection, protectionIndex } from "./protection.js";

export const AUTOMATION_BATCH_LIMIT = 25;
export const executable = (a: AutomationAssessment) => ["category", "link_duplicate", "qualify", "reject", "research"].includes(a.action);
/** Prisma raw row locks report serialization/deadlock SQLSTATEs as P2010. */
export function isDiscoveryConcurrencyConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010" || !("meta" in error) || !error.meta || typeof error.meta !== "object") return false;
  const meta = error.meta as { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  const sqlState = meta.code ?? meta.driverAdapterError?.cause?.originalCode;
  return sqlState === "40001" || sqlState === "40P01";
}
const fingerprint = (c: AutomationCandidate, protection: ReturnType<typeof candidateProtection>, assessment: AutomationAssessment) =>
  createHash("sha256").update(JSON.stringify({ rules: AUTOMATION_RULES, candidate: c, protection, assessment })).digest("hex");

/** Read-only. No fetches, queues, prospect creation, or decisions happen in preview. */
export async function discoveryAutomationPreview(db: Db, options: { recovery?: boolean; now?: Date } = {}) {
  const index = await protectionIndex(db);
  const candidates = await db.discoveryCandidate.findMany({ include: automationInclude, orderBy: [{ discoveredAt: "asc" }, { id: "asc" }] });
  const rows = candidates.map(candidate => {
    const protection = candidateProtection(candidate, index);
    const assessment = assessDiscovery(candidate, protection, options.now, options);
    const sources = candidate.evidence.filter(e => assessment.evidenceIds?.includes(e.id) || (assessment.action === "ready" && ["automotive_repair_services", "collision_repair_services"].includes(e.signalKey)))
      .map(e => ({ evidenceId: e.id, researchId: e.researchId, sourceUrl: e.sourceUrl, excerpt: e.excerpt }));
    return { id: candidate.id, name: candidate.businessName, status: candidate.status, assessment, protection, sources, rules: AUTOMATION_RULES, token: fingerprint(candidate, protection, assessment) };
  });
  const counts = rows.reduce<Record<string, number>>((out, r) => { out[r.assessment.action] = (out[r.assessment.action] ?? 0) + 1; return out; }, {});
  return { rows, counts, actionable: rows.filter(r => executable(r.assessment)).length, recovery: options.recovery === true };
}

/** Every apply is locked and re-assessed. A preview never supplies trusted mutation data. */
export async function applyDiscoveryAutomation(db: Db, id: string, options: { token?: string; recovery?: boolean; allowResearch?: boolean } = {}) {
  return db.$transaction(async tx => {
    await lockCandidate(tx, id);
    const c = await tx.discoveryCandidate.findUnique({ where: { id }, include: automationInclude });
    if (!c) throw new ProspectError(["Candidate not found."], "not_found");
    const protection = candidateProtection(c, await protectionIndex(tx));
    const a = assessDiscovery(c, protection, new Date(), options);
    if (options.token && options.token !== fingerprint(c, protection, a)) throw new ProspectError(["This candidate or its relationships changed. Preview the batch again."], "conflict");
    if (!executable(a) || (a.action === "research" && !options.allowResearch)) return { id, assessment: a, applied: false };
    const now = new Date();
    if (a.action === "research") {
      await tx.candidateResearch.create({ data: { candidateId: id, version: RESEARCH_VERSION, trigger: a.researchKind === "recovery" ? "recovery" : "scheduled", candidateRevision: c.researchRevision, subjectWebsite: c.website } });
      return { id, assessment: a, applied: true };
    }
    // Annotation-only linking is the sole permitted operation on an indirectly protected identity.
    if (protection.protected && a.action !== "link_duplicate") return { id, assessment: a, applied: false };
    const data: Parameters<typeof tx.discoveryCandidate.update>[0]["data"] = { researchRevision: { increment: 1 } };
    if (a.action === "category") Object.assign(data, categoryFields(a.category!, now));
    if (a.action === "link_duplicate") Object.assign(data, {
      status: "duplicate", statusChangedAt: now, decidedAt: now, duplicateDecidedAt: now, duplicateHold: false,
      possibleDuplicateProspectId: a.canonicalProspectId,
      decisionReason: `Canonical prospect ${a.canonicalProspectId}. ${a.reason}`.slice(0, 500),
    });
    if (a.action === "qualify") {
      const sources = c.evidence.filter(e => a.evidenceIds!.includes(e.id));
      await tx.candidateSignal.upsert({ where: { candidateId_key: { candidateId: id, key: "automotive_repair_services" } },
        create: { candidateId: id, key: "automotive_repair_services", value: "yes", origin: "research", observedAt: now },
        update: {} });
      for (const e of sources) await tx.candidateEvidence.create({ data: { candidateId: id, signalKey: "automotive_repair_services", sourceUrl: e.sourceUrl, excerpt: e.excerpt, origin: "research", researchId: e.researchId, createdAt: e.createdAt } });
      if (c.categorySource !== "manual") Object.assign(data, { categoryVerdict: "in_target", categorySource: "website", categorySourceUrl: sources[0]!.sourceUrl,
        categoryReason: "Current repair rules confirm source-linked retained service evidence.", categoryRules: AUTOMATION_RULES, categoryCheckedAt: now });
    }
    if (a.action === "reject") Object.assign(data, { status: "rejected", statusChangedAt: now, decidedAt: now, decisionReason: `Automatically rejected (${AUTOMATION_RULES}): ${a.reason}` });
    await tx.discoveryCandidate.update({ where: { id }, data });
    await tx.candidateNote.create({ data: { candidateId: id, body: JSON.stringify({ rules: AUTOMATION_RULES, action: a.action, reason: a.reason,
      from: { status: c.status, category: c.categoryVerdict, categoryRules: c.categoryRules, categoryReason: c.categoryReason },
      evidenceIds: a.evidenceIds, canonicalProspectId: a.canonicalProspectId, researchId: c.research[0]?.id }).slice(0, 2000) } });
    return { id, assessment: a, applied: true };
  }, { isolationLevel: "Serializable", timeout: 30_000 });
}

export async function applyDiscoveryBatch(db: Db, selected: readonly { id: string; token: string }[], options: { recovery?: boolean } = {}) {
  if (!selected.length || selected.length > AUTOMATION_BATCH_LIMIT || new Set(selected.map(s => s.id)).size !== selected.length || selected.some(s => !/^[a-f0-9]{64}$/.test(s.token))) {
    throw new ProspectError([`Select between 1 and ${AUTOMATION_BATCH_LIMIT} distinct candidates from a fresh preview.`]);
  }
  const results: { id: string; applied: boolean; reason: string }[] = [];
  for (const item of selected) {
    try {
      const r = await applyDiscoveryAutomation(db, item.id, { ...options, token: item.token, allowResearch: true });
      results.push({ id: item.id, applied: r.applied, reason: r.assessment.reason });
    } catch (error) {
      if (error instanceof ProspectError) results.push({ id: item.id, applied: false, reason: error.messages.join(" ") });
      else if (isDiscoveryConcurrencyConflict(error)) results.push({ id: item.id, applied: false, reason: "A concurrent change prevented this action. Preview again." });
      else throw error;
    }
  }
  return results;
}
