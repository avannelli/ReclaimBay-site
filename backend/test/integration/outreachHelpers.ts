/*
 * Outreach test fixtures. The mock provider records every message it is
 * handed and answers from a script; it never touches the network. There is
 * no real provider in the codebase to call by mistake.
 */
import assert from "node:assert/strict";
import type { Db } from "../../src/db.js";
import { hashInvitationToken } from "../../src/invitations/tokens.js";
import { campaignOf } from "../../src/outreach/compose.js";
import { dispatchQueued, setSendingSwitch, type SendingConfig } from "../../src/outreach/dispatch.js";
import type { OutgoingMessage, OutreachSender, SendResult } from "../../src/outreach/sender.js";
import { queueOutreach } from "../../src/outreach/service.js";
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

export const switchOn = (db: Db, sender: OutreachSender) => setSendingSwitch(db, true, "Integration test.", CFG, sender);

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
  await switchOn(db, sender);
  return dispatchQueued(db, { config: CFG, sender });
}
