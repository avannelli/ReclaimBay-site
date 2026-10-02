/*
 * A fake Google for Gmail tests: the OAuth 2.0 endpoints the official
 * google-auth-library calls (code exchange, refresh, revoke), Gmail's
 * profile and Send As settings, and the Gmail endpoints the adapter uses. Nothing here reaches
 * the network, and no real credential exists anywhere in the repository:
 * the client secret is a placeholder, and the encryption key and refresh
 * token are made fresh for each test.
 */
import { randomBytes } from "node:crypto";
import type { Config } from "../../src/config.js";
import { GmailClient, type GmailMessage, type GmailPart } from "../../src/outreach/gmail.js";
import { GMAIL_SCOPES, gmailCredentialsFromConfig, gmailOAuthConfig, sealRefreshToken, type GmailCredentials, type GmailOAuthConfig } from "../../src/outreach/gmailAuth.js";

/** The configured sender (OUTREACH_SENDER_EMAIL). */
export const MAILBOX = "hello@reclaimbay.example";
/** A Workspace user who can have MAILBOX as a Send As address. */
export const ACCOUNT = "alex@reclaimbay.example";
export const CLIENT_ID = "test-client.apps.googleusercontent.com";

/** A Send As address as Gmail's users.settings.sendAs resource describes it. */
export interface FakeSendAs {
  sendAsEmail: string;
  /** Absent for Workspace aliases; "accepted" or "pending" for custom From addresses. */
  verificationStatus?: string;
}

export interface FakeCall {
  url: string;
  method: string;
  body: string;
}

type Answer = { status: number; body: unknown } | "network";

/** An inbound message, built from headers and text parts. */
export function inbound(id: string, threadId: string, headers: Record<string, string>, parts: { mimeType: string; text: string }[] = [], snippet = ""): GmailMessage {
  const toPart = (p: { mimeType: string; text: string }): GmailPart => ({ mimeType: p.mimeType, body: { data: Buffer.from(p.text).toString("base64url") } });
  return {
    id,
    threadId,
    internalDate: String(Date.parse("2026-10-05T12:00:00Z")),
    snippet,
    payload: {
      mimeType: parts.length > 1 ? "multipart/report" : (parts[0]?.mimeType ?? "text/plain"),
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      parts: parts.map(toPart),
    },
  };
}

const bodyText = (body: unknown) => (body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : "");

export class FakeGoogle {
  readonly calls: FakeCall[] = [];
  readonly sent: { id: string; threadId: string; raw: string; marker: string | null }[] = [];
  readonly inbox: GmailMessage[] = [];
  readonly revoked: string[] = [];
  /** Answers for the next send calls, in order; default: success. */
  sendAnswers: Answer[] = [];
  /** Overrides every token-endpoint answer (refresh and code exchange). */
  tokenAnswer: Answer | null = null;
  listAnswer: Answer | null = null;
  /** The Google account the consent screen and Gmail's profile report. */
  account = MAILBOX;
  /** The account's Send As addresses besides its own (which Gmail always lists, as primary). */
  sendAs: FakeSendAs[] = [];
  /** What the code exchange grants. */
  grantedScopes: string[] = [...GMAIL_SCOPES];
  issueRefreshToken = true;
  /** Seconds an access token lives. */
  accessTokenLifetime = 3600;
  /** Refresh tokens Google accepts; revoking one (or clearing this) makes it invalid_grant. */
  readonly validRefreshTokens = new Set<string>();
  private readonly validAccessTokens = new Set<string>();
  private seq = 0;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = bodyText(init?.body);
    this.calls.push({ url, method, body });
    const reply = (a: Answer) => {
      if (a === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    };
    const header = (name: string) => new Headers(init?.headers).get(name);

    if (url === "https://oauth2.googleapis.com/token") {
      if (this.tokenAnswer) return reply(this.tokenAnswer);
      const form = new URLSearchParams(body);
      if (form.get("client_id") !== CLIENT_ID) return reply({ status: 401, body: { error: "invalid_client" } });
      const access = `access-${++this.seq}`;
      this.validAccessTokens.add(access);
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good-code") return reply({ status: 400, body: { error: "invalid_grant" } });
        const refresh = `refresh-${randomBytes(8).toString("hex")}`;
        if (this.issueRefreshToken) this.validRefreshTokens.add(refresh);
        return reply({
          status: 200,
          body: { access_token: access, expires_in: this.accessTokenLifetime, scope: this.grantedScopes.join(" "), token_type: "Bearer", ...(this.issueRefreshToken ? { refresh_token: refresh } : {}) },
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (!this.validRefreshTokens.has(form.get("refresh_token") ?? "")) return reply({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
        return reply({ status: 200, body: { access_token: access, expires_in: this.accessTokenLifetime, scope: GMAIL_SCOPES.join(" "), token_type: "Bearer" } });
      }
      return reply({ status: 400, body: { error: "unsupported_grant_type" } });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      const token = new URL(url).searchParams.get("token") ?? "";
      this.revoked.push(token);
      this.validRefreshTokens.delete(token);
      this.validAccessTokens.delete(token);
      return reply({ status: 200, body: {} });
    }

    const api = "https://gmail.googleapis.com/gmail/v1/users/me";
    if (!url.startsWith(api)) throw new Error(`unexpected request to ${url}`);
    const bearer = header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.validAccessTokens.has(bearer)) return reply({ status: 401, body: { error: { message: "Invalid Credentials", errors: [{ reason: "authError" }] } } });
    const path = url.slice(api.length);
    if (path === "/profile") return reply({ status: 200, body: { emailAddress: this.account } });
    if (path.startsWith("/settings/sendAs/") && method === "GET") {
      const email = decodeURIComponent(path.slice("/settings/sendAs/".length)).toLowerCase();
      if (email === this.account) return reply({ status: 200, body: { sendAsEmail: this.account, isPrimary: true, isDefault: true } });
      const alias = this.sendAs.find((a) => a.sendAsEmail.toLowerCase() === email);
      if (!alias) return reply({ status: 404, body: { error: { code: 404, message: "Requested entity was not found.", errors: [{ reason: "notFound" }] } } });
      return reply({ status: 200, body: { ...alias, isPrimary: false, treatAsAlias: true } });
    }
    if (path === "/messages/send" && method === "POST") {
      const answer = this.sendAnswers.shift();
      const raw = JSON.parse(body).raw as string;
      const decoded = Buffer.from(raw, "base64url").toString();
      const marker = /^X-ReclaimBay-Outreach: (.+)$/m.exec(decoded)?.[1]?.trim() ?? null;
      if (answer && answer !== "network" && answer.status >= 400) return reply(answer);
      // A "network" answer models a send that went through but whose response was lost.
      const id = `gm-${++this.seq}`;
      this.sent.push({ id, threadId: `th-${id}`, raw, marker });
      if (answer === "network") throw new TypeError("socket hang up");
      if (answer) return reply(answer);
      return reply({ status: 200, body: { id, threadId: `th-${id}` } });
    }
    if (path.startsWith("/messages?")) {
      if (this.listAnswer) return reply(this.listAnswer);
      const params = new URLSearchParams(path.slice("/messages?".length));
      const messages =
        params.get("labelIds") === "SENT" ? this.sent.map((s) => ({ id: s.id, threadId: s.threadId })) : this.inbox.map((m) => ({ id: m.id, threadId: m.threadId }));
      return reply({ status: 200, body: { messages } });
    }
    const msg = /^\/messages\/([^?]+)\?/.exec(path)?.[1];
    if (msg) {
      const sent = this.sent.find((s) => s.id === msg);
      if (sent) return reply({ status: 200, body: { id: sent.id, threadId: sent.threadId, payload: { headers: sent.marker ? [{ name: "X-ReclaimBay-Outreach", value: sent.marker }] : [] } } });
      const m = this.inbox.find((x) => x.id === msg);
      return m ? reply({ status: 200, body: m }) : reply({ status: 404, body: { error: { message: "Not Found" } } });
    }
    const thread = /^\/threads\/([^?]+)\?/.exec(path)?.[1];
    if (thread) {
      const ids = [...this.sent.filter((s) => s.threadId === thread).map((s) => s.id), ...this.inbox.filter((m) => m.threadId === thread).map((m) => m.id)];
      return reply({ status: 200, body: { id: thread, messages: ids.map((id) => ({ id })) } });
    }
    throw new Error(`unexpected Gmail call ${method} ${path}`);
  }) as typeof fetch;

  /** Every access token issued so far stops working (as after expiry). */
  expireAccessTokens() {
    this.validAccessTokens.clear();
  }

  get sendCalls() {
    return this.calls.filter((c) => c.url.endsWith("/messages/send"));
  }
  get sendAsCalls() {
    return this.calls.filter((c) => c.url.includes("/settings/sendAs/"));
  }
  get tokenCalls() {
    return this.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token");
  }
  get refreshCalls() {
    return this.tokenCalls.filter((c) => new URLSearchParams(c.body).get("grant_type") === "refresh_token");
  }
}

export type GmailTestConfig = Pick<Config, "outreachProvider" | "gmailOAuth" | "outreachSender" | "publicApiUrl">;

/** A configuration like production's, with a fresh key and no authorization yet. */
export function gmailTestConfig(over: Partial<GmailTestConfig["gmailOAuth"]> = {}): GmailTestConfig {
  return {
    outreachProvider: "gmail",
    outreachSender: { name: "Alex Rivera", email: MAILBOX, postalAddress: "1 Main St, Ventura, CA 93001" },
    publicApiUrl: "https://api.reclaimbay.example",
    gmailOAuth: { clientId: CLIENT_ID, clientSecret: "test-client-secret", tokenKey: randomBytes(32).toString("base64"), sealedRefreshToken: null, ...over },
  };
}

/**
 * A fake Google whose signed-in account is ACCOUNT, with MAILBOX as a Send As
 * address: Gmail's status for it, or none (a Workspace alias). Null: no alias.
 */
export function aliasGoogle(verificationStatus: string | null | undefined = "accepted"): FakeGoogle {
  const google = new FakeGoogle();
  google.account = ACCOUNT;
  if (verificationStatus !== null) google.sendAs = [{ sendAsEmail: MAILBOX, ...(verificationStatus ? { verificationStatus } : {}) }];
  return google;
}

/** An authorized configuration: a refresh token Google accepts for its current account, sealed as the admin flow would. */
export function authorizedConfig(google: FakeGoogle): GmailTestConfig {
  const config = gmailTestConfig();
  const refresh = `refresh-${randomBytes(8).toString("hex")}`;
  google.validRefreshTokens.add(refresh);
  config.gmailOAuth.sealedRefreshToken = sealRefreshToken({ account: google.account, refreshToken: refresh }, gmailOAuthConfig(config) as GmailOAuthConfig);
  return config;
}

/** A Gmail client and its fake Google, configured and authorized like production. */
export function fakeGmail(google = new FakeGoogle()) {
  const config = authorizedConfig(google);
  const credentials = gmailCredentialsFromConfig(config, google.fetch) as GmailCredentials;
  return { google, config, credentials, client: new GmailClient(credentials, google.fetch) };
}
