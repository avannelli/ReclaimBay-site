/*
 * The seam an email provider plugs into. Selected by OUTREACH_PROVIDER; with
 * it unset (the default) the only sender refuses to send, and dispatch.ts
 * never calls a sender that isn't enabled. The one adapter is Google
 * Workspace (gmail.ts), authorized by Google OAuth (gmailAuth.ts).
 * Transactional providers checked (Resend, SendGrid,
 * Amazon SES) forbid cold outreach in their acceptable-use policies.
 *
 * A provider adapter must:
 *   - read its credentials from the environment, never the database;
 *   - make a retry of the same message unable to send it twice: pass
 *     `idempotencyKey` to the provider, or verify that an earlier attempt
 *     didn't go out (`attempt` > 1) before sending again;
 *   - never throw: report every outcome as a SendResult. "uncertain" means
 *     the provider may have sent it (a timeout, a 5xx, a dropped
 *     connection); "unavailable" means it certainly wasn't sent and the
 *     provider can't send right now (authentication, configuration, quota).
 * Delivery events and replies feed applyProviderEvent() and
 * recordInboundReply() in service.ts.
 */

import type { Config } from "../config.js";
import { GmailClient, gmailSender } from "./gmail.js";
import { gmailCredentialsFromConfig } from "./gmailAuth.js";

export interface OutgoingMessage {
  outreachId: string;
  /** Stable per message: the same key on every attempt. */
  idempotencyKey: string;
  /** 1 for the first attempt; more only when an earlier one was uncertain. */
  attempt: number;
  /** When the first attempt started: how far back a retry must verify. */
  firstAttemptAt: Date;
  to: string;
  from: { name: string; email: string };
  replyTo: string;
  subject: string;
  /** Plain text, exactly as reviewed. */
  text: string;
  /** List-Unsubscribe and List-Unsubscribe-Post (RFC 8058). */
  headers: Record<string, string>;
}

export type SendResult =
  | { status: "accepted"; providerMessageId: string }
  /** Definitely not sent. `invalidRecipient` suppresses the address. */
  | { status: "rejected"; reason: string; invalidRecipient?: boolean }
  /** May or may not have been sent. */
  | { status: "uncertain"; reason: string }
  /** Definitely not sent, and the provider can't send now: the message stays queued and the batch stops. */
  | { status: "unavailable"; reason: string };

/** Read-only verification of one claimed message, never authorization to resend. */
export interface SentMessageQuery {
  outreachId: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  startedAt: Date;
  checkedAt: Date;
}

export type SentMessageLookup =
  | { status: "found"; providerMessageId: string; sentAt: Date }
  | { status: "not_found" | "ambiguous" | "unavailable" };

export interface OutreachSender {
  /** Recorded as Outreach.provider. */
  readonly name: string;
  readonly enabled: boolean;
  /**
   * Whether the provider honours `idempotencyKey`. The dispatcher never
   * retries an "uncertain" send automatically, whatever this says: it waits
   * for a person (dispatch.ts stuckMessages).
   */
  readonly supportsIdempotency: boolean;
  /** Why a configured provider is disabled (a configuration error), for the admin. */
  readonly problem?: string;
  /** A live check that the provider can send now (credentials, account): null when it can, else why not. */
  check?(): Promise<string | null>;
  lookupSent?(query: SentMessageQuery): Promise<SentMessageLookup>;
  send(message: OutgoingMessage): Promise<SendResult>;
}

export class SendingDisabledError extends Error {
  constructor() {
    super("Sending is disabled: no email provider is configured.");
  }
}

/** The sender when no provider is configured (OUTREACH_PROVIDER unset): it refuses every send. */
export const disabledSender: OutreachSender = {
  name: "disabled",
  enabled: false,
  supportsIdempotency: false,
  async send() {
    throw new SendingDisabledError();
  },
};

/** A sender that can't run because its configuration is wrong; it says why. */
export const misconfiguredSender = (name: string, problem: string): OutreachSender => ({ ...disabledSender, name, problem });

/**
 * The sender the app uses, from OUTREACH_PROVIDER. Unset: disabled. A
 * provider whose configuration or authorization is incomplete is disabled
 * too, with the reason. `fetchImpl` carries every provider call (tests pass a fake).
 */
export function senderFromConfig(
  config: Pick<Config, "outreachProvider" | "gmailOAuth" | "outreachSender" | "publicApiUrl">,
  fetchImpl: typeof fetch = globalThis.fetch,
): OutreachSender {
  const provider = config.outreachProvider;
  if (!provider) return disabledSender;
  if (provider === "gmail") {
    const credentials = gmailCredentialsFromConfig(config, fetchImpl);
    return "problem" in credentials ? misconfiguredSender("gmail", credentials.problem) : gmailSender(new GmailClient(credentials, fetchImpl));
  }
  return misconfiguredSender(provider.slice(0, 40), `Unknown OUTREACH_PROVIDER "${provider.slice(0, 40)}"; the only provider is "gmail".`);
}
