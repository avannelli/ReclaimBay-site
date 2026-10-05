/*
 * Google Workspace (Gmail API) provider: sending, and the mailbox reads that
 * stand in for an ESP's events (see gmailInbox.ts).
 *
 * Authentication comes from GmailCredentials (gmailAuth.ts): Google OAuth 2.0
 * user authorization of a Workspace account, with access tokens refreshed
 * automatically. No password, no SMTP, no service-account key. Before its
 * first call the client confirms, from Gmail itself, that the credentials
 * belong to the authorized account and that the configured sender is that
 * account or one of its ready Send As addresses; anything else fails closed,
 * so Gmail is never left to substitute the account's own address in From.
 *
 * Scopes: gmail.send (send) and gmail.readonly (verify the sender and
 * retries, read bounces and replies). Nothing here modifies or deletes mail.
 *
 * What Gmail does and doesn't give us:
 *   - sending: the API returns Gmail's message id. Gmail replaces any
 *     Message-ID we set, but keeps custom headers, so every message carries
 *     X-ReclaimBay-Outreach: <outreach id>;
 *   - no idempotency key: a retry (attempt > 1) first searches Sent for that
 *     header since the first attempt, and sends only if it isn't there;
 *   - no delivery receipts, no complaint events: never reported.
 */
import { GMAIL_SCOPES, GmailError, gmailProfileEmail, verifySendAs, type GmailCredentials } from "./gmailAuth.js";
import type { OutgoingMessage, OutreachSender, SendResult, SentMessageQuery, SentMessageLookup } from "./sender.js";

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

  /** The authorized Google account: whose mailbox is read and whose Sent is checked. */
  get account() {
    return this.credentials.account;
  }

  /** The only From address this client sends as: the account, or one of its Send As addresses. */
  get sender() {
    return this.credentials.sender;
  }

  /**
   * Confirms with Gmail that the credentials belong to the authorized account
   * and that the account may send as the sender (once per client; again after
   * a failure). Throws GmailError("auth") otherwise.
   */
  verifyIdentity(): Promise<void> {
    this.verified ??= (async () => {
      const token = await this.credentials.accessToken();
      const account = await gmailProfileEmail(this.fetchImpl, token);
      if (account !== this.account) {
        throw new GmailError("auth", `Gmail is authorized as ${account}, not ${this.account}, the account that was authorized. Reauthorize in the admin.`);
      }
      await verifySendAs(this.fetchImpl, token, account, this.sender);
    })().catch((err) => {
      this.verified = null;
      throw err;
    });
    return this.verified;
  }

  /**
   * A live check for the admin: a fresh access token from the stored
   * authorization, and the account and sender re-verified with Gmail. Nothing cached.
   */
  recheck(): Promise<void> {
    this.verified = null;
    this.credentials.invalidate();
    return this.verifyIdentity();
  }

  /** One Gmail API call; errors become GmailError by kind. A stale access token is refreshed once. */
  async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    await this.verifyIdentity();
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

/** Exactly one mailbox address; lists and additional recipients cannot match. */
function singleAddress(value: string | null): string | null {
  if (!value) return null;
  const prefix = value.includes("<") ? value.slice(0, value.indexOf("<")).trim() : "";
  if (prefix && !/^"[^"]*"$/.test(prefix) && /[,@;<>]/.test(prefix)) return null;
  const address = /^(?:[^<>]*<([^<>]+)>|([^<>\s,;]+))$/.exec(value.trim());
  return (address?.[1] ?? address?.[2])?.trim().toLowerCase() ?? null;
}

/**
 * Strong, read-only recovery evidence. Scan every page before accepting one
 * marker: a second copy is ambiguous even if its content differs. Incomplete
 * searches fail closed. No body, token, or provider diagnostic leaves here.
 */
export async function lookupSentMessage(client: GmailClient, query: SentMessageQuery): Promise<SentMessageLookup> {
  const slack = 10 * 60 * 1000;
  if (client.sender !== query.fromEmail.toLowerCase()) return { status: "unavailable" };
  await client.recheck();
  const candidates = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await client.listMessages({ labelIds: "SENT", q: `after:${Math.floor((query.startedAt.getTime() - slack) / 1000)}`, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
    for (const { id } of list.messages ?? []) {
      const m = await client.getMessage(id, "metadata", [OUTREACH_HEADER]);
      if (m.id === id && m.payload?.headers?.some((h) => h.name.toLowerCase() === OUTREACH_HEADER.toLowerCase() && h.value.trim() === query.outreachId)) candidates.add(id);
      if (candidates.size > 1) return { status: "ambiguous" };
    }
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  if (pageToken) return { status: "unavailable" };
  const [id] = candidates;
  if (!id) return { status: "not_found" };
  const m = await client.getMessage(id, "full");
  const uniqueHeaders = [OUTREACH_HEADER, "From", "To", "Subject"].every((name) =>
    m.payload?.headers?.filter((h) => h.name.toLowerCase() === name.toLowerCase()).length === 1);
  const at = m.internalDate && /^\d+$/.test(m.internalDate) ? new Date(Number(m.internalDate)) : null;
  const subject = headerOf(m, "Subject");
  const normalizedSubject = noBreaks(query.subject);
  const normalizeLines = (text: string) => text.replace(/\r\n/g, "\n");
  let body: string | null = null;
  try {
    const data = m.payload?.body?.data;
    if (m.payload?.mimeType === "text/plain" && !m.payload.parts?.length && typeof data === "string" && /^[A-Za-z0-9_-]*={0,2}$/.test(data)) {
      body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data, "base64url"));
    }
  } catch { /* Malformed provider content is not evidence. */ }
  if (!uniqueHeaders || m.id !== id || id.length > 200 || !/^[A-Za-z0-9_-]+$/.test(id) || !m.labelIds?.includes("SENT") ||
      headerOf(m, OUTREACH_HEADER)?.trim() !== query.outreachId ||
      singleAddress(headerOf(m, "From")) !== query.fromEmail.toLowerCase() ||
      singleAddress(headerOf(m, "To")) !== query.to.toLowerCase() ||
      headerOf(m, "Cc") || headerOf(m, "Bcc") ||
      (subject !== normalizedSubject && subject !== encodeWord(normalizedSubject)) ||
      body === null || normalizeLines(body) !== normalizeLines(query.text) ||
      !at || !Number.isFinite(at.getTime()) || at.getTime() < query.startedAt.getTime() - slack || at.getTime() > query.checkedAt.getTime() + slack) {
    return { status: "not_found" };
  }
  return { status: "found", providerMessageId: id, sentAt: at };
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
    lookupSent: (query) => lookupSentMessage(client, query),
    async check() {
      try {
        await client.recheck();
        return null;
      } catch (err) {
        return err instanceof GmailError ? err.message : `Gmail can't be reached: ${(err as Error).message}`;
      }
    },
    async send(m) {
      // Exactly the configured sender: not another Send As address, and not the account's own.
      if (m.from.email.toLowerCase() !== client.sender) {
        return { status: "unavailable", reason: `The sender ${m.from.email} isn't the configured Gmail sender.` };
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
