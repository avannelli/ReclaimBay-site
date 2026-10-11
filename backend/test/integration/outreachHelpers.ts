/*
 * Outreach test fixtures. The mock provider records every message it is
 * handed and answers from a script; it never touches the network. There is
 * no real provider in the codebase to call by mistake.
 */
import assert from "node:assert/strict";
import type { Db } from "../../src/db.js";
import { hashInvitationToken } from "../../src/invitations/tokens.js";
import { campaignOf } from "../../src/outreach/compose.js";
import { dispatchQueued as dispatchOriginal, setSendingSwitch, type SendingConfig, type DispatchOptions } from "../../src/outreach/dispatch.js";
import type { OutgoingMessage, OutreachSender, SendResult } from "../../src/outreach/sender.js";
import { queueOutreach } from "../../src/outreach/service.js";
import { approvedMessageHash } from "../../src/outreach/campaigns.js";
import { appendSendingControlInTx, sendingPolicy } from "../../src/outreach/policy.js";
import { lockSendGate } from "../../src/outreach/records.js";
import { referralUrl } from "../../src/prospects.js";

/** A complete, compliant sender configuration. */
export const CFG: SendingConfig = {
  outreachSender: { name: "Alex Rivera", email: "hello@reclaimbay.example", postalAddress: "1 Main St, Ventura, CA 93001" },
  publicApiUrl: "https://api.reclaimbay.example",
  outreachSendingArmed: true,
};
export const OPTS = { siteUrl: "https://reclaimbay.com", sender: CFG.outreachSender };

export interface MockSender extends OutreachSender {
  calls: OutgoingMessage[];
}

/** A provider stand-in. By default it accepts everything with id "msg-<outreach id>". */
export function mockSender(answer: (m: OutgoingMessage, call: number) => SendResult | Promise<SendResult> = (m) => ({ status: "accepted", providerMessageId: `msg-${m.outreachId}` }), supportsIdempotency = true): MockSender {
  const calls: OutgoingMessage[] = [];
  return {
    name: "mock",
    enabled: true,
    supportsIdempotency,
    calls,
    async send(m) {
      calls.push(m);
      return answer(m, calls.length);
    },
  };
}

/** Fixtures deliberately establish prior approval, including malformed rows
 * used to test send-time rechecks. Campaign approval itself has separate tests. */
export async function approveFixtureSelection(db: Db, messageIds?: string[]) {
  await db.$transaction(async tx => {
    await lockSendGate(tx);
    const rows = await tx.outreach.findMany({ where: { status: "queued", ...(messageIds ? { id: { in: messageIds } } : {}) } });
    const campaign = await tx.outreachCampaign.create({ data: { name: "Reviewed test selection", attributionCampaign: rows[0]?.campaign ?? "outreach-intro-t4",
      messages: { create: rows.map(o => ({ outreachId: o.id, messageHash: approvedMessageHash(o) })) } } });
    await appendSendingControlInTx(tx, { activeCampaignId: campaign.id }, "Test fixture approval", new Date());
  });
}

/** Older workflow tests assume prior human approval; keep that prerequisite
 * explicit in their fixtures. The new campaign suite exercises the raw dispatcher. */
export async function dispatchFixture(db: Db, opts: DispatchOptions) {
  const policy = await sendingPolicy(db);
  const queued = await db.outreach.findMany({ where: { status: "queued" }, include: { campaignMemberships: true } });
  if (!policy.activeCampaignId || queued.some(o => !o.campaignMemberships.some(m => m.campaignId === policy.activeCampaignId && m.messageHash === approvedMessageHash(o)))) {
    await approveFixtureSelection(db);
  }
  return dispatchOriginal(db, opts);
}

export async function switchOn(db: Db, sender: OutreachSender) {
  await approveFixtureSelection(db);
  // Separate fixture turns model the required minute passing. Keep older
  // interrupted claims old, and retain every claim/attempt so retries stay blocked.
  const elapsed = new Date(Date.now() - 61_000);
  await db.outreach.updateMany({ where: { sendStartedAt: { gt: elapsed } }, data: { sendStartedAt: elapsed } });
  return setSendingSwitch(db, true, "Integration test.", CFG, sender);
}

/** Simulated elapsed time for multi-message fixture jobs, not a production bypass. */
export async function pacedFixtureClock(db: Db) {
  const latest = await db.outreach.findFirst({ where: { sendStartedAt: { not: null } }, orderBy: { sendStartedAt: "desc" } });
  let at = Math.max(Date.now() - 60 * 60_000, latest?.sendStartedAt?.getTime() ?? 0);
  return () => new Date(at += 61_000);
}

/**
 * A drafted first message's own invitation. Drafting makes it (Stage 4D), so
 * this takes the token the message links and checks it against the stored
 * hash, rather than making another (which, rightly, returns created: false).
 */
export async function draftedInvitation(db: Db, outreach: { id: string; body: string }) {
  const token = /\/invite#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(outreach.body)?.[1];
  assert.ok(token, "the drafted first message links its invitation");
  const invitation = await db.invitation.findUniqueOrThrow({ where: { outreachId: outreach.id } });
  assert.equal(invitation.tokenHash, hashInvitationToken(token), "the link's token is the invitation's");
  return { token, invitation };
}

/**
 * A first message without an invitation, as drafted before Stage 4D: for tests
 * of createInvitationForOutreach itself, and of a message that has none.
 * Restore the legacy template and referral link too: deleting only the
 * invitation would leave a current message with a dead link.
 */
export const withoutInvitation = (db: Db, outreachId: string) => db.$transaction(async (tx) => {
  const o = await tx.outreach.findUniqueOrThrow({ where: { id: outreachId }, include: { prospect: true } });
  const template = "intro@t1";
  const campaign = campaignOf(template);
  const body = o.body.replace(/https?:\/\/\S+?\/invite#[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, referralUrl(OPTS.siteUrl, o.prospect.referralCode, campaign));
  await tx.invitation.deleteMany({ where: { outreachId } });
  return tx.outreach.update({ where: { id: outreachId }, data: { template, campaign, body } });
});

/** Queues a draft and sends it through the real dispatcher with the mock provider. */
export async function queueAndSend(db: Db, outreachId: string, sender: MockSender = mockSender()) {
  await queueOutreach(db, outreachId, CFG);
  await approveFixtureSelection(db, [outreachId]);
  await setSendingSwitch(db, true, "Integration test.", CFG, sender);
  // These helpers represent separate operator/job turns separated by pacing time.
  await db.outreach.updateMany({ where: { OR: [{ sentAt: { not: null } }, { status: "failed" }], sendStartedAt: { not: null } }, data: { sendStartedAt: new Date(Date.now() - 61_000) } });
  return dispatchOriginal(db, { config: CFG, sender });
}
