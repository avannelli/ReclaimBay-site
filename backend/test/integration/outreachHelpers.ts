/*
 * Outreach test fixtures. The mock provider records every message it is
 * handed and answers from a script; it never touches the network. There is
 * no real provider in the codebase to call by mistake.
 */
import type { Db } from "../../src/db.js";
import { dispatchQueued, setSendingSwitch, type SendingConfig } from "../../src/outreach/dispatch.js";
import type { OutgoingMessage, OutreachSender, SendResult } from "../../src/outreach/sender.js";
import { queueOutreach } from "../../src/outreach/service.js";

/** A complete, compliant sender configuration. */
export const CFG: SendingConfig = {
  outreachSender: { name: "Alex Rivera", email: "alex@reclaimbay.example", postalAddress: "1 Main St, Ventura, CA 93001" },
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

/** Queues a draft and sends it through the real dispatcher with the mock provider. */
export async function queueAndSend(db: Db, outreachId: string, sender: MockSender = mockSender()) {
  await queueOutreach(db, outreachId, CFG);
  await switchOn(db, sender);
  return dispatchQueued(db, { config: CFG, sender });
}
