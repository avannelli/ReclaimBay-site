/*
 * Google Workspace (Gmail API) provider: sending, and the mailbox reads that
 * stand in for an ESP's events (see gmailInbox.ts).
 *
 * Authentication comes from GmailCredentials (gmailAuth.ts): Google OAuth 2.0
 * user authorization of the outreach mailbox, with access tokens refreshed
 * automatically. No password, no SMTP, no service-account key. Before its
 * first call the client confirms, from Gmail's own profile, that the
 * credentials belong to the configured mailbox; any other account fails
 * closed.
 *
 * Scopes: gmail.send (send) and gmail.readonly (verify retries, read
 * bounces and replies). Nothing here modifies or deletes mail.
 *
 * What Gmail does and doesn't give us:
 *   - sending: the API returns Gmail's message id. Gmail replaces any
 *     Message-ID we set, but keeps custom headers, so every message carries
 *     X-ReclaimBay-Outreach: <outreach id>;
 *   - no idempotency key: a retry (attempt > 1) first searches Sent for that
 *     header since the first attempt, and sends only if it isn't there;
 *   - no delivery receipts, no complaint events: never reported.
 */
import { GMAIL_SCOPES, GmailError, gmailProfileEmail, type GmailCredentials } from "./gmailAuth.js";
import type { OutgoingMessage, OutreachSender, SendResult } from "./sender.js";

export { GMAIL_SCOPES, GmailError };
export const OUTREACH_HEADER = "X-ReclaimBay-Outreach";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TIMEOUT_MS = 30_000;

/** A minimal Gmail REST client over any GmailCredentials: send and read-only lookups. */
export class GmailClient {
  private verified: Promise<void> | null = null;

  constructor(
    readonly credentials: GmailCredentials,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  get mailbox() {
    return this.credentials.mailbox;
  }

  /**
   * Confirms the credentials belong to the configured mailbox (once per
   * client; again after a failure). Throws GmailError("auth") otherwise.
   */
  verifyAccount(): Promise<void> {
    this.verified ??= (async () => {
      const account = await gmailProfileEmail(this.fetchImpl, await this.credentials.accessToken());
      if (account !== this.mailbox) {
        throw new GmailError("auth", `Gmail is authorized as ${account}, not the configured mailbox ${this.mailbox}. Reauthorize as ${this.mailbox}.`);
      }
    })().catch((err) => {
      this.verified = null;
      throw err;
    });
    return this.verified;
  }

  /**
   * A live check for the admin: a fresh access token from the stored
   * authorization, and the account re-verified with Gmail. Nothing cached.
   */
  recheck(): Promise<void> {
    this.verified = null;
    this.credentials.invalidate();
    return this.verifyAccount();
  }

  /** One Gmail API call; errors become GmailError by kind. A stale access token is refreshed once. */
  async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    await this.verifyAccount();
    for (let attempt = 1; ; attempt++) {
      const token = await this.credentials.accessToken();
      let res: Response;
      try {
        res = await this.fetchImpl(`${API}${path}`, {
          method: init.method ?? "GET",
          headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new GmailError("network", `Gmail request failed: ${(err as Error).message}`);
      }
      if (res.ok) return (await res.json()) as T;
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
      const reason = body.error?.errors?.[0]?.reason ?? "";
      const message = `Gmail ${res.status}${reason ? ` ${reason}` : ""}: ${body.error?.message ?? res.statusText}`.slice(0, 400);
      if (res.status === 401) {
        // Google rejected the token before doing anything, so one retry with a fresh token is safe.
        this.credentials.invalidate();
        if (attempt === 1) continue;
        throw new GmailError("auth", message, res.status);
      }
      if (res.status === 403 || res.status === 429) throw new GmailError(res.status === 403 && reason === "domainPolicy" ? "auth" : "quota", message, res.status);
      if (res.status >= 500) throw new GmailError("server", message, res.status);
      throw new GmailError("invalid", message, res.status);
    }
  }

  send(raw: string) {
    return this.call<{ id?: string; threadId?: string }>("/messages/send", { method: "POST", body: { raw } });
  }

  listMessages(params: Record<string, string>) {
    return this.call<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(`/messages?${new URLSearchParams(params)}`);
  }

  getMessage(id: string, format: "metadata" | "full", headers: string[] = []) {
    const q = new URLSearchParams({ format });
    for (const h of headers) q.append("metadataHeaders", h);
    return this.call<GmailMessage>(`/messages/${encodeURIComponent(id)}?${q}`);
  }

  getThread(id: string) {
    return this.call<{ id: string; messages?: { id: string }[] }>(`/threads/${encodeURIComponent(id)}?format=minimal`);
  }
}

export interface GmailPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

// ---------- the message ----------

const noBreaks = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
const encodeWord = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const displayName = (name: string) => (/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeWord(name));

/**
 * The RFC 5322 message, exactly as reviewed: plain text (UTF-8, base64), the
 * one-click unsubscribe headers, and the outreach marker. Header values can't
 * carry line breaks, so nothing can inject a header.
 */
export function buildRawMessage(m: OutgoingMessage): string {
  const headers: [string, string][] = [
    ["From", `${displayName(noBreaks(m.from.name))} <${noBreaks(m.from.email)}>`],
    ["To", noBreaks(m.to)],
    ["Reply-To", noBreaks(m.replyTo)],
    ["Subject", encodeWord(noBreaks(m.subject))],
    ["MIME-Version", "1.0"],
    ["Content-Type", 'text/plain; charset="UTF-8"'],
    ["Content-Transfer-Encoding", "base64"],
    [OUTREACH_HEADER, noBreaks(m.outreachId)],
    ...Object.entries(m.headers).map(([k, v]): [string, string] => [noBreaks(k).replace(/[^A-Za-z0-9-]/g, ""), noBreaks(v)]),
  ];
  const body = Buffer.from(m.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return Buffer.from(`${headers.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

export const headerOf = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/**
 * Whether an earlier attempt of this outreach is already in Sent: the
 * messages Gmail has sent since `since` that carry our marker. Returns the
 * Gmail id, or null if there is none.
 */
export async function findSentAttempt(client: GmailClient, outreachId: string, since: Date): Promise<string | null> {
  const after = Math.floor(since.getTime() / 1000) - 600;
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await client.listMessages({ labelIds: "SENT", q: `after:${after}`, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
    for (const { id } of list.messages ?? []) {
      const m = await client.getMessage(id, "metadata", [OUTREACH_HEADER]);
      if (headerOf(m, OUTREACH_HEADER)?.trim() === outreachId) return m.id;
    }
    pageToken = list.nextPageToken;
    if (!pageToken) return null;
  }
  // Too much mail to check fully: the caller must not assume it wasn't sent.
  throw new GmailError("server", "Too many sent messages to verify an earlier attempt.");
}

/** Gmail's errors in the dispatcher's terms. */
function resultOf(err: unknown, sending: boolean): SendResult {
  if (!(err instanceof GmailError)) return { status: "uncertain", reason: `Unexpected error: ${(err as Error).message}`.slice(0, 400) };
  switch (err.kind) {
    case "auth":
    case "quota":
      return { status: "unavailable", reason: err.message };
    case "invalid":
      // A 4xx on send: Gmail refused the message, so it wasn't sent.
      return sending
        ? { status: "rejected", reason: err.message, invalidRecipient: /recipient|to header|address/i.test(err.message) }
        : { status: "uncertain", reason: err.message };
    default:
      // A timeout or 5xx while sending may still have sent it.
      return sending ? { status: "uncertain", reason: err.message } : { status: "uncertain", reason: `Couldn't verify an earlier attempt: ${err.message}` };
  }
}

/** The Gmail sender behind the existing interface. */
export function gmailSender(client: GmailClient): OutreachSender {
  return {
    name: "gmail",
    enabled: true,
    // Safe retries: a retry verifies Sent first (findSentAttempt).
    supportsIdempotency: true,
    async check() {
      try {
        await client.recheck();
        return null;
      } catch (err) {
        return err instanceof GmailError ? err.message : `Gmail can't be reached: ${(err as Error).message}`;
      }
    },
    async send(m) {
      if (m.from.email.toLowerCase() !== client.mailbox) {
        return { status: "unavailable", reason: `The sender ${m.from.email} isn't the configured Gmail mailbox.` };
      }
      if (m.attempt > 1) {
        try {
          const existing = await findSentAttempt(client, m.outreachId, m.firstAttemptAt);
          if (existing) return { status: "accepted", providerMessageId: existing };
        } catch (err) {
          return resultOf(err, false);
        }
      }
      try {
        const sent = await client.send(buildRawMessage(m));
        return sent.id ? { status: "accepted", providerMessageId: sent.id } : { status: "uncertain", reason: "Gmail returned no message id." };
      } catch (err) {
        return resultOf(err, true);
      }
    },
  };
}
