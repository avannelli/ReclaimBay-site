/*
 * Google Workspace (Gmail API) provider: sending, and the mailbox reads that
 * stand in for an ESP's events (see gmailInbox.ts).
 *
 * Authentication: a Google Cloud service account with domain-wide
 * delegation, impersonating the outreach mailbox (OUTREACH_SENDER_EMAIL). It
 * signs a JWT (RS256) and exchanges it for a one-hour access token
 * (developers.google.com/identity/protocols/oauth2/service-account). No
 * password, no SMTP, no stored refresh token. The key comes only from the
 * environment and never appears in logs or results.
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
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { OutgoingMessage, OutreachSender, SendResult } from "./sender.js";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];
export const OUTREACH_HEADER = "X-ReclaimBay-Outreach";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TIMEOUT_MS = 30_000;

export interface GmailConfig {
  serviceAccountEmail: string;
  privateKey: KeyObject;
  /** The Workspace mailbox to send from and read: OUTREACH_SENDER_EMAIL. */
  mailbox: string;
}

/**
 * OUTREACH_PROVIDER=gmail needs GMAIL_SERVICE_ACCOUNT_JSON (the service
 * account's JSON key, raw or base64) and OUTREACH_SENDER_EMAIL.
 */
export function gmailConfigFromEnv(env: NodeJS.ProcessEnv): GmailConfig | { problem: string } {
  const raw = env.GMAIL_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return { problem: "Gmail isn't configured: GMAIL_SERVICE_ACCOUNT_JSON is missing." };
  let key: { client_email?: unknown; private_key?: unknown };
  try {
    key = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return { problem: "Gmail isn't configured: GMAIL_SERVICE_ACCOUNT_JSON isn't a service account JSON key." };
  }
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    return { problem: "Gmail isn't configured: the service account key has no client_email or private_key." };
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(key.private_key);
  } catch {
    return { problem: "Gmail isn't configured: the service account's private_key can't be read." };
  }
  const mailbox = env.OUTREACH_SENDER_EMAIL?.trim().toLowerCase();
  if (!mailbox) return { problem: "Gmail isn't configured: OUTREACH_SENDER_EMAIL (the Workspace mailbox) is missing." };
  return { serviceAccountEmail: key.client_email, privateKey, mailbox };
}

/** A Gmail API failure, classified. Never carries credentials. */
export class GmailError extends Error {
  constructor(
    readonly kind: "auth" | "quota" | "invalid" | "server" | "network",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A minimal Gmail REST client: token, send, and read-only lookups. */
export class GmailClient {
  private token: { value: string; expires: number } | null = null;

  constructor(
    readonly config: GmailConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > this.clock() + 60_000) return this.token.value;
    const now = Math.floor(this.clock() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({ iss: this.config.serviceAccountEmail, sub: this.config.mailbox, scope: GMAIL_SCOPES.join(" "), aud: TOKEN_URL, iat: now, exp: now + 3600 }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(this.config.privateKey).toString("base64url");
    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Nothing was sent: there was no token to send with.
      throw new GmailError("auth", `Google token request failed: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      // e.g. unauthorized_client: domain-wide delegation isn't granted for these scopes.
      throw new GmailError("auth", `Google refused the service account (${body.error ?? res.status}). Check domain-wide delegation and scopes.`, res.status);
    }
    this.token = { value: body.access_token, expires: this.clock() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /** One Gmail API call; errors become GmailError by kind. */
  async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.accessToken();
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
      this.token = null;
      throw new GmailError("auth", message, res.status);
    }
    if (res.status === 403 || res.status === 429) throw new GmailError(res.status === 403 && reason === "domainPolicy" ? "auth" : "quota", message, res.status);
    if (res.status >= 500) throw new GmailError("server", message, res.status);
    throw new GmailError("invalid", message, res.status);
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
    async send(m) {
      if (m.from.email.toLowerCase() !== client.config.mailbox) {
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
