import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import type { Outreach, Prisma } from "../generated/prisma/client.js";
import { ProspectError } from "../prospects.js";
import type { ComplianceConfig } from "./compliance.js";
import { lockSendGate } from "./records.js";
import { appendSendingControlInTx, sendingPolicy } from "./policy.js";
import { queueBlockers, queueOutreachInTx } from "./service.js";

type Tx = Prisma.TransactionClient;
// Keep the explicit checkbox form within the existing 16 KB request limit.
export const MAX_CAMPAIGN_MESSAGES = 250;
export function approvedMessageHash(o: Pick<Outreach, "recipientEmail" | "subject" | "body" | "senderName" | "senderEmail" | "template" | "campaign">): string {
  return createHash("sha256").update(JSON.stringify([o.recipientEmail, o.subject, o.body, o.senderName, o.senderEmail, o.template, o.campaign])).digest("hex");
}

export async function campaignMessageErrors(tx: Db | Tx, o: Outreach): Promise<string[]> {
  const policy = await sendingPolicy(tx);
  if (!policy.activeCampaignId) return ["Approve and start a campaign before sending."];
  const member = await tx.outreachCampaignMessage.findUnique({
    where: { campaignId_outreachId: { campaignId: policy.activeCampaignId, outreachId: o.id } },
    include: { campaign: true },
  });
  if (!member || member.campaign.attributionCampaign !== o.campaign) return ["This message is outside the active approved campaign."];
  if (member.messageHash !== approvedMessageHash(o)) return ["The reviewed message changed after campaign approval. Approve a new selection before sending."];
  return [];
}

/** Fixed, explicit approval; never discovers or generates more messages. */
export async function startCampaign(db: Db, input: { name: unknown; messageIds: readonly string[]; confirm: boolean; reason: unknown }, cfg: ComplianceConfig, now = new Date()) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  const ids = [...new Set(input.messageIds)];
  if (!input.confirm || !name || name.length > 120 || !reason || !ids.length || ids.length > MAX_CAMPAIGN_MESSAGES || ids.length !== input.messageIds.length) {
    throw new ProspectError(["Name the campaign, choose 1–250 distinct existing messages, give a reason, and explicitly confirm approval."]);
  }
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    if ((await sendingPolicy(tx)).enabled) throw new ProspectError(["Switch sending OFF before starting or changing a campaign."]);
    const messages = await tx.outreach.findMany({ where: { id: { in: ids } }, include: { prospect: { include: { signals: true } } } });
    if (messages.length !== ids.length) throw new ProspectError(["A selected message no longer exists."]);
    const campaigns = new Set(messages.map(o => o.campaign));
    if (campaigns.size !== 1 || !messages[0]!.campaign) throw new ProspectError(["Choose messages from exactly one attribution campaign."]);
    if (new Set(messages.map(o => o.recipientEmail.trim().toLowerCase())).size !== messages.length) {
      throw new ProspectError(["A recipient appears more than once in this campaign."]);
    }
    const queued = await tx.outreach.findMany({ where: { status: "queued" }, select: { id: true } });
    if (queued.some(o => !ids.includes(o.id))) throw new ProspectError(["Resolve queued messages outside this selection before starting the campaign."]);
    for (const o of messages) {
      // Include an already-sent initial message for historical counts; never queue it again.
      if (o.sentAt) continue;
      if (!["draft", "queued"].includes(o.status) || o.sendStartedAt || o.sendAttempts) {
        throw new ProspectError(["Select unsent drafts or queued messages without an attempt. Failed and uncertain sends cannot be restarted here."]);
      }
      const errors = await queueBlockers(tx, o, cfg);
      if (errors.length) throw new ProspectError(errors);
    }
    const campaign = await tx.outreachCampaign.create({ data: {
      name, attributionCampaign: messages[0]!.campaign!, startedAt: now,
      messages: { create: messages.map(o => ({ outreachId: o.id, messageHash: approvedMessageHash(o) })) },
    } });
    await appendSendingControlInTx(tx, { activeCampaignId: campaign.id }, reason, now);
    for (const o of messages) if (!o.sentAt && o.status === "draft") await queueOutreachInTx(tx, o.id, cfg, now);
    return campaign;
  }, { timeout: 30_000 });
}

/** Read-only selection UI; saving a limit never queues these messages. */
export async function campaignControls(db: Db) {
  const policy = await sendingPolicy(db);
  const active = policy.activeCampaignId ? await db.outreachCampaign.findUnique({
    where: { id: policy.activeCampaignId }, include: { messages: { include: { outreach: true } } },
  }) : null;
  const selectable = await db.outreach.findMany({
    where: { OR: [{ status: "draft" }, { sentAt: { not: null }, kind: "initial" }] },
    orderBy: [{ status: "asc" }, { campaign: "asc" }, { createdAt: "asc" }, { id: "asc" }], take: MAX_CAMPAIGN_MESSAGES,
    select: { id: true, campaign: true, status: true, sentAt: true, recipientEmail: true, subject: true, prospect: { select: { businessName: true, internalTest: true } } },
  });
  const members = active?.messages.map(m => m.outreach) ?? [];
  return { policy, active: active ? { id: active.id, name: active.name, approved: members.length,
    drafts: members.filter(o => o.status === "draft").length, sent: members.filter(o => o.sentAt).length,
    remaining: members.filter(o => !o.sentAt && ["draft", "queued"].includes(o.status)).length } : null, selectable };
}
