import type { Db } from "../db.js";
import type { OutreachCampaign, Prisma } from "../generated/prisma/client.js";
import { ProspectError } from "../prospects.js";
import { RESEARCH_VERSION } from "../research/researcher.js";
import { COMMERCIAL_RULES } from "../policies/reclaimbay/commercial.js";
import { READY_OWNERSHIP, type OwnershipClass } from "../policies/reclaimbay/readiness.js";
import { ACQUISITION_RULES, assessAcquisition, type CommercialMinimum } from "./acquisition.js";
import { AUTOMATION_RULES, assessDiscovery, automationInclude } from "./automationPolicy.js";
import { candidateProtection, protectionIndex } from "./protection.js";
import { AUTONOMOUS_CREATED_PREFIX } from "./autoApproval.js";
import { createProspectFromCandidateInTx, lockAccountDomain, retryableConflict } from "./service.js";

/*
 * Bounded autonomous campaigns (M1). A person authorizes a campaign once, with a prospect cap, a
 * message cap, an expiry and a commercial minimum; within those bounds an eligible candidate becomes a
 * prospect without an individual approval. Nothing here drafts, queues or sends, or touches the sending
 * switch or the active message selection (OutreachControlChange).
 *
 * Eligible means all of, re-checked inside one Serializable transaction on the locked record:
 *   - the live Discovery decision is Ready (research r16, discovery@d2): this location's identity,
 *     quoted concrete services, allowed ownership, no duplicate question, commercial fit;
 *   - every acquisition gate (identity, technical, commercial at the campaign minimum, account,
 *     verified recipient, protection, lifecycle) passes;
 *   - the recorded ownership class is one Ready allows (never chain, dealership, possible
 *     dealership or manufacturer);
 *   - every safeguard of a person's approval (createProspectFromCandidateInTx).
 * A commercial review or exclusion is never created automatically, and has no automatic override.
 *
 * Lock order: campaign row → account domain → candidate. Stopping takes the campaign row, so a stop
 * lands wholly before or after any creation; a stopped or expired campaign creates nothing more.
 */

type Tx = Prisma.TransactionClient;
export const AUTONOMOUS_COMMERCIAL_MINIMUM: CommercialMinimum = "medium";
export const AUTONOMOUS_BOUNDS = { prospectCap: { min: 1, max: 100 }, messageCap: { min: 1, max: 250 }, maxDays: 30 } as const;
export const AUTONOMOUS_REASON_MAX = 500;
/** The first message's attribution campaign (campaignOf(INTRO_TEMPLATE); a unit test keeps them equal). Discovery never imports outreach drafting. */
export const AUTONOMOUS_ATTRIBUTION = "outreach-intro-t4";
const AUTHORIZATION_LOCK = "discovery-autonomous-campaign-authorization";

export const policyVersions = () => ({ research: RESEARCH_VERSION, automation: AUTOMATION_RULES, commercial: COMMERCIAL_RULES, acquisition: ACQUISITION_RULES });

export type CampaignState = "active" | "stopped" | "expired" | "exhausted";
export function campaignState(c: Pick<OutreachCampaign, "mode" | "stoppedAt" | "expiresAt" | "prospectCap">, created: number, now: Date): CampaignState {
  if (c.stoppedAt) return "stopped";
  if (!c.expiresAt || c.expiresAt.getTime() <= now.getTime()) return "expired";
  if (c.prospectCap === null || created >= c.prospectCap) return "exhausted";
  return "active";
}

export interface AuthorizationInput {
  name: unknown;
  prospectCap: unknown;
  messageCap: unknown;
  expiresAt: unknown;
  reason: unknown;
  confirm: boolean;
  via: "admin" | "cli" | "service";
}

const integer = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN);

/** Pure validation of an authorization; returns the normalized values or the reasons it is refused. */
export function authorizationErrors(input: AuthorizationInput, now: Date) {
  const errors: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const prospectCap = integer(input.prospectCap), messageCap = integer(input.messageCap);
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : typeof input.expiresAt === "string" ? new Date(input.expiresAt) : new Date(NaN);
  if (!name) errors.push("Campaign name is required.");
  else if (name.length > 120) errors.push("Campaign name is too long (max 120).");
  const { prospectCap: pc, messageCap: mc, maxDays } = AUTONOMOUS_BOUNDS;
  if (!Number.isInteger(prospectCap) || prospectCap < pc.min || prospectCap > pc.max) errors.push(`Prospect cap must be a whole number from ${pc.min} to ${pc.max}.`);
  if (!Number.isInteger(messageCap) || messageCap < mc.min || messageCap > mc.max) errors.push(`Message cap must be a whole number from ${mc.min} to ${mc.max}.`);
  if (Number.isNaN(expiresAt.getTime())) errors.push("Expiry is required.");
  else if (expiresAt.getTime() <= now.getTime()) errors.push("Expiry must be in the future.");
  else if (expiresAt.getTime() > now.getTime() + maxDays * 24 * 60 * 60 * 1000) errors.push(`Expiry must be within ${maxDays} days.`);
  if (!reason) errors.push("Authorization reason is required.");
  else if (reason.length > AUTONOMOUS_REASON_MAX) errors.push(`Authorization reason is too long (max ${AUTONOMOUS_REASON_MAX}).`);
  if (!input.confirm) errors.push("You must explicitly confirm automatic prospect creation within these bounds.");
  if (!["admin", "cli", "service"].includes(input.via)) errors.push("Unknown authorization channel.");
  return { errors, value: { name, reason, prospectCap, messageCap, expiresAt } };
}

/** One person's authorization. At most one autonomous campaign is active at a time. Sends nothing. */
export async function authorizeAutonomousCampaign(db: Db, input: AuthorizationInput, now = new Date()) {
  return db.$transaction((tx) => authorizeAutonomousCampaignInTx(tx, input, now), { isolationLevel: "Serializable", timeout: 30_000 }).catch(retryableConflict);
}

/** The authorization inside a caller's transaction (the outreach launch holds the send gate around it). */
export async function authorizeAutonomousCampaignInTx(tx: Tx, input: AuthorizationInput, now: Date) {
  const { errors, value } = authorizationErrors(input, now);
  if (errors.length) throw new ProspectError(errors);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${AUTHORIZATION_LOCK}, 0))::text`;
  const open = await activeAutonomousCampaign(tx, now);
  if (open) throw new ProspectError([`Autonomous campaign "${open.name}" is still active. Stop it before authorizing another.`], "conflict");
  return tx.outreachCampaign.create({ data: {
    name: value.name, attributionCampaign: AUTONOMOUS_ATTRIBUTION, startedAt: now, mode: "autonomous",
    prospectCap: value.prospectCap, messageCap: value.messageCap, expiresAt: value.expiresAt, commercialMinimum: AUTONOMOUS_COMMERCIAL_MINIMUM,
    authorizedAt: now, authorizedReason: value.reason, authorizedVia: input.via, policyVersions: policyVersions(),
  } });
}

/** The one autonomous campaign that is neither stopped nor expired, if any. */
export const activeAutonomousCampaign = (db: Db | Tx, now: Date) =>
  db.outreachCampaign.findFirst({ where: { mode: "autonomous", stoppedAt: null, expiresAt: { gt: now } } });

export async function lockCampaign(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "OutreachCampaign" WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.outreachCampaign.findUnique({ where: { id } });
}

/** Stops a campaign for good: no further automatic creation. Idempotent; the first stop's reason is kept. */
export async function stopAutonomousCampaign(db: Db, id: string, reason: unknown, now = new Date()) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) throw new ProspectError(["A stop reason is required."]);
  if (why.length > AUTONOMOUS_REASON_MAX) throw new ProspectError([`Stop reason is too long (max ${AUTONOMOUS_REASON_MAX}).`]);
  return db.$transaction(async (tx) => {
    const campaign = await lockCampaign(tx, id);
    if (!campaign) throw new ProspectError(["Campaign not found."], "not_found");
    if (campaign.mode !== "autonomous") throw new ProspectError(["Only an autonomous campaign can be stopped here."]);
    if (campaign.stoppedAt) return campaign;
    return tx.outreachCampaign.update({ where: { id }, data: { stoppedAt: now, stopReason: why } });
  }, { timeout: 30_000 });
}

/** The campaign's state and what it has created (read-only). */
export async function autonomousCampaignStatus(db: Db | Tx, id: string, now = new Date()) {
  const campaign = await db.outreachCampaign.findUnique({ where: { id } });
  if (!campaign || campaign.mode !== "autonomous") return null;
  const created = await db.outreachCampaignProspect.count({ where: { campaignId: id } });
  return { campaign, created, remaining: Math.max(0, (campaign.prospectCap ?? 0) - created), state: campaignState(campaign, created, now) };
}

/** Reasons this record may not be created automatically, beyond a person's approval checks. */
function eligibility(now: Date): Extract<Parameters<typeof createProspectFromCandidateInTx>[2], { kind: "automatic" }>["eligibilityErrors"] {
  return (c, protection, acquisition) => {
    const errors: string[] = [];
    const decision = assessDiscovery(c, protection, now);
    if (decision.action !== "ready") errors.push(`Not Ready under ${AUTOMATION_RULES} (${decision.code}): ${decision.reason}`);
    for (const gate of Object.values(acquisition.gates)) if (!gate.pass) errors.push(`Acquisition gate ${gate.code}: ${gate.reason}`);
    const ownership = c.research[0]?.facts.find((f) => f.field === "ownership_class")?.value ?? null;
    if (!READY_OWNERSHIP.includes(ownership as OwnershipClass)) errors.push(`Ownership "${ownership ?? "not recorded"}" is not eligible for automatic creation.`);
    return errors;
  };
}

/**
 * Researched candidates that pass the automatic-creation gate right now (read-only; never creates).
 * The same eligibility createProspectAutonomously re-checks inside its transaction, at the given minimum;
 * the approval-only checks (category, evidence gates, existing-prospect matches) are re-run at creation.
 */
export async function autonomousCandidates(db: Db | Tx, now: Date, commercialMinimum: CommercialMinimum = AUTONOMOUS_COMMERCIAL_MINIMUM, opts: { campaignId?: string } = {}) {
  const index = await protectionIndex(db);
  const rows = await db.discoveryCandidate.findMany({
    where: { status: "researched", prospectId: null, autonomousCreation: null },
    include: automationInclude, orderBy: [{ discoveredAt: "asc" }, { id: "asc" }],
  });
  const check = eligibility(now);
  return rows.flatMap((c) => {
    // Refused by this campaign and unchanged since: a person (or a re-read) has to change it first.
    if (opts.campaignId && refusals(c.notes).some((r) => r.campaignId === opts.campaignId && r.researchRevision === c.researchRevision)) return [];
    const protection = candidateProtection(c, index);
    if (protection.protected) return [];
    return check(c, protection, assessAcquisition(c, protection, { commercialMinimum })).length ? [] : [c.id];
  });
}

/** An append-only record that a campaign tried and refused (or failed) to create this candidate. */
export interface AutonomousRefusal { type: "autonomous_refusal"; campaignId: string; researchRevision: number; kind: "refused" | "error"; reasons: string[]; at: string }
const REFUSAL_MARK = '"type":"autonomous_refusal"';
export function refusals(notes: readonly { body: string }[]): AutonomousRefusal[] {
  return notes.flatMap((n) => {
    if (!n.body.includes(REFUSAL_MARK)) return [];
    try {
      return [JSON.parse(n.body) as AutonomousRefusal];
    } catch {
      return [];
    }
  });
}

/**
 * Records a refusal as a candidate note, so later runs skip the candidate until it changes (its research
 * revision moves on an edit or a re-read): one attempt per campaign and candidate state, never a retry loop.
 */
export async function recordAutonomousRefusal(db: Db, candidateId: string, campaignId: string, kind: AutonomousRefusal["kind"], reasons: readonly string[], now = new Date()) {
  const c = await db.discoveryCandidate.findUnique({ where: { id: candidateId }, select: { researchRevision: true } });
  if (!c) return;
  const body: AutonomousRefusal = { type: "autonomous_refusal", campaignId, researchRevision: c.researchRevision, kind, reasons: reasons.map((r) => r.slice(0, 300)).slice(0, 5), at: now.toISOString() };
  await db.candidateNote.create({ data: { candidateId, body: JSON.stringify(body).slice(0, 2000) } });
}

/**
 * Creates one prospect under an authorized autonomous campaign, or refuses with the reasons. Campaign
 * authorization, expiry, the prospect cap and the candidate's eligibility are all checked in the same
 * Serializable transaction that creates it. Creates no outreach.
 */
export async function createProspectAutonomously(db: Db, candidateId: string, campaignId: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    const campaign = await lockCampaign(tx, campaignId);
    if (!campaign) throw new ProspectError(["Campaign not found."], "not_found");
    if (campaign.mode !== "autonomous" || !campaign.authorizedAt || !campaign.commercialMinimum) throw new ProspectError(["This campaign does not authorize automatic prospect creation."]);
    const created = await tx.outreachCampaignProspect.count({ where: { campaignId } });
    const state = campaignState(campaign, created, now);
    if (state !== "active") {
      throw new ProspectError([state === "stopped" ? `The campaign was stopped: ${campaign.stopReason}` : state === "expired" ? "The campaign has expired." : `The campaign's prospect cap (${campaign.prospectCap}) is reached.`], "conflict");
    }
    const earlier = await tx.outreachCampaignProspect.findUnique({ where: { candidateId }, select: { campaignId: true } });
    if (earlier) throw new ProspectError(["This candidate was already created automatically."], "conflict");
    await lockAccountDomain(tx, candidateId);
    const versions = policyVersions();
    const minimum = campaign.commercialMinimum as CommercialMinimum;
    const result = await createProspectFromCandidateInTx(tx, candidateId, {
      kind: "automatic",
      commercialMinimum: minimum,
      label: `autonomous campaign "${campaign.name}" ${campaign.id}; ${AUTOMATION_RULES}, research ${RESEARCH_VERSION}, ${COMMERCIAL_RULES} minimum ${minimum}`,
      decisionReason: `${AUTONOMOUS_CREATED_PREFIX} "${campaign.name}" (${campaign.id}; ${AUTOMATION_RULES}, research ${RESEARCH_VERSION}, ${COMMERCIAL_RULES} minimum ${minimum}).`,
      eligibilityErrors: eligibility(now),
      provenance: { type: "autonomous_creation", campaignId: campaign.id, campaignName: campaign.name, authorizedAt: campaign.authorizedAt.toISOString(),
        authorizedVia: campaign.authorizedVia, policyVersions: versions },
    }, now);
    await tx.outreachCampaignProspect.create({ data: {
      campaignId, candidateId, prospectId: result.prospect.id, researchId: result.researchId ?? null, createdAt: now, policyVersions: versions,
      commercialDisposition: result.commercial.disposition, commercialConfidence: result.commercial.confidence,
    } });
    return { prospect: result.prospect, candidateId, campaignId };
  }, { isolationLevel: "Serializable", timeout: 30_000 }).catch((error: unknown) => {
    // A concurrent creation of the same candidate or prospect lost the race on a unique key.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ProspectError(["This candidate was already created automatically."], "conflict");
    return retryableConflict(error);
  });
}
