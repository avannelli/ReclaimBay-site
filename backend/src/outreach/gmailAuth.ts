/*
 * Gmail credentials. The Gmail client (gmail.ts) and the mailbox reader only
 * see GmailCredentials: the authorized account, the From address, and a way
 * to get a current access token.
 *
 * The one implementation is Google OAuth 2.0 user authorization
 * (authorization-code flow, offline access) through Google's official
 * google-auth-library. Service-account keys aren't used: the organization
 * policy iam.disableServiceAccountKeyCreation forbids them, rightly.
 *
 * Two identities. The account is the Google Workspace user who signs in
 * (Gmail's own profile address). The sender is OUTREACH_SENDER_EMAIL, the
 * From address. They may differ only when the sender is one of the account's
 * Gmail Send As addresses that Gmail reports as ready to use
 * (verifySendAs); any other pairing fails closed.
 *
 *   1. An admin starts authorization (routes/adminOutreach.ts): a random
 *      state, kept in a signed, short-lived cookie, and Google's consent
 *      screen for exactly gmail.send and gmail.readonly, offline.
 *   2. Google redirects back (routes/gmailOAuth.ts). The state is checked,
 *      the code exchanged, both scopes verified, the account read from
 *      Gmail's profile, and the sender confirmed as that account or one of
 *      its Send As addresses. Any other grant is revoked at once.
 *   3. The refresh token and its account are sealed (AES-256-GCM, bound to
 *      this OAuth client and sender) with GMAIL_TOKEN_ENCRYPTION_KEY and shown
 *      once, sealed, to be stored as GMAIL_REFRESH_TOKEN_SEALED in the host's
 *      secret store. The plain token is never shown, logged, or stored
 *      anywhere else.
 *   4. At run time the library refreshes access tokens from it. A revoked or
 *      invalid refresh token fails closed: nothing is sent, and the admin
 *      shows that reauthorization is needed.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";

// gmail.readonly also covers users.settings.sendAs.get: no settings scope is needed.
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"] as const;
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
export const OAUTH_CALLBACK_PATH = "/oauth/gmail/callback";

/** A Gmail API or authorization failure, classified. Never carries a credential. */
export class GmailError extends Error {
  constructor(
    readonly kind: "auth" | "quota" | "invalid" | "server" | "network",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** What the Gmail client needs, wherever the credentials come from. */
export interface GmailCredentials {
  /** The Google account these credentials act as (Gmail's profile address). */
  readonly account: string;
  /** The From address: the account itself, or one of its Gmail Send As addresses. */
  readonly sender: string;
  /** A current access token; refreshed as needed. Throws GmailError("auth") when it can't be. */
  accessToken(): Promise<string>;
  /** Drops any cached access token (after a 401). */
  invalidate(): void;
}

export const REAUTHORIZE = "Gmail authorization was revoked or has expired: reauthorize the mailbox in the admin (Outreach page).";

// ---------- configuration ----------

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** OUTREACH_SENDER_EMAIL, lowercased: the From address the authorized account must be able to send as. */
  sender: string;
  key: Buffer;
  /** Where Google sends the admin back; null without PUBLIC_API_URL. */
  redirectUri: string | null;
}

/** The OAuth client configuration, or why it is incomplete. The refresh token isn't needed here. */
export function gmailOAuthConfig(config: Pick<Config, "gmailOAuth" | "outreachSender" | "publicApiUrl">): GmailOAuthConfig | { problem: string } {
  const g = config.gmailOAuth;
  const missing = [
    !g.clientId && "GOOGLE_OAUTH_CLIENT_ID",
    !g.clientSecret && "GOOGLE_OAUTH_CLIENT_SECRET",
    !g.tokenKey && "GMAIL_TOKEN_ENCRYPTION_KEY",
    !config.outreachSender.email && "OUTREACH_SENDER_EMAIL",
  ].filter(Boolean);
  if (missing.length) return { problem: `Gmail isn't configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.` };
  const key = Buffer.from(g.tokenKey!, "base64");
  if (key.length !== 32) return { problem: "Gmail isn't configured: GMAIL_TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded." };
  return {
    clientId: g.clientId!,
    clientSecret: g.clientSecret!,
    sender: config.outreachSender.email!.toLowerCase(),
    key,
    redirectUri: config.publicApiUrl ? `${config.publicApiUrl}${OAUTH_CALLBACK_PATH}` : null,
  };
}

// ---------- the sealed refresh token ----------

/** What the admin's authorization produced: the account Google signed in, and its refresh token. */
export interface SealedAuthorization {
  account: string;
  refreshToken: string;
}

/** Binds a sealed token to one OAuth client and one sender. */
const aad = (cfg: GmailOAuthConfig) => Buffer.from(`reclaimbay-gmail-v2|${cfg.clientId}|${cfg.sender}`);

/** AES-256-GCM over the account and refresh token: "v2.<iv>.<ciphertext>.<tag>", base64url. Useless without the key. */
export function sealRefreshToken(auth: SealedAuthorization, cfg: GmailOAuthConfig): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cfg.key, iv).setAAD(aad(cfg));
  const plain = JSON.stringify({ account: auth.account, refreshToken: auth.refreshToken });
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v2", iv, ct, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/**
 * The account and refresh token, or null when the value is malformed, tampered
 * with, sealed for another client or sender, or in an older format.
 */
export function openSealedToken(sealed: string, cfg: GmailOAuthConfig): SealedAuthorization | null {
  const [v, iv, ct, tag] = sealed.trim().split(".");
  if (v !== "v2" || !iv || !ct || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", cfg.key, Buffer.from(iv, "base64url")).setAAD(aad(cfg));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8")) as Partial<SealedAuthorization>;
    if (typeof plain.account !== "string" || !plain.account.includes("@") || typeof plain.refreshToken !== "string" || !plain.refreshToken) return null;
    return { account: plain.account.toLowerCase(), refreshToken: plain.refreshToken };
  } catch {
    return null;
  }
}

// ---------- the authorization flow ----------

export const oauthClient = (cfg: GmailOAuthConfig, fetchImpl: typeof fetch) =>
  new OAuth2Client({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri ?? undefined,
    // Every Google call goes through this fetch (tests pass a fake).
    transporterOptions: { fetchImplementation: fetchImpl },
  });

export const STATE_COOKIE = "rb_gmail_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;
const sign = (secret: string, value: string) => createHmac("sha256", secret).update(`gmail-oauth-state|${value}`).digest("base64url");

/** A fresh random state and the signed cookie value that carries it. */
export function newOAuthState(secret: string, now = Date.now()) {
  const state = randomBytes(32).toString("base64url");
  const body = `${state}.${now + STATE_TTL_MS}`;
  return { state, cookie: `${body}.${sign(secret, body)}` };
}

/** Whether the callback's state matches the signed, unexpired cookie the admin's browser got. */
export function verifyOAuthState(secret: string, cookie: string | null | undefined, state: string | null | undefined, now = Date.now()): boolean {
  if (!cookie || !state) return false;
  const [s, expires, mac] = cookie.split(".");
  if (!s || !expires || !mac) return false;
  const expected = Buffer.from(sign(secret, `${s}.${expires}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  if (!(Number(expires) > now)) return false;
  const a = Buffer.from(s);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Google's consent URL: the two Gmail scopes only, offline, for the sender's
 * domain. No login hint: the sender may be a Send As address, not an account
 * anyone signs in as.
 */
export function authorizationUrl(cfg: GmailOAuthConfig, state: string, fetchImpl: typeof fetch = globalThis.fetch): string {
  if (!cfg.redirectUri) throw new GmailError("auth", "PUBLIC_API_URL isn't configured, so Google has nowhere to send the authorization back.");
  return oauthClient(cfg, fetchImpl).generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
    state,
    hd: cfg.sender.split("@")[1],
    include_granted_scopes: false,
  });
}

/** The Gmail account an access token belongs to (needs gmail.readonly). */
export async function gmailProfileEmail(fetchImpl: typeof fetch, accessToken: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new GmailError("network", `Gmail profile request failed: ${(err as Error).message}`);
  }
  if (res.status === 401) throw new GmailError("auth", "Gmail refused the access token.", 401);
  if (!res.ok) throw new GmailError(res.status >= 500 ? "server" : "auth", `Gmail profile request failed (${res.status}).`, res.status);
  const body = (await res.json()) as { emailAddress?: string };
  if (!body.emailAddress) throw new GmailError("auth", "Gmail returned no account for the access token.");
  return body.emailAddress.toLowerCase();
}

/** Send As statuses that mean Gmail will use the address. Gmail reports none for an account's own address or a Workspace alias. */
const READY_SEND_AS = new Set(["accepted", "verificationStatusUnspecified"]);

/**
 * Confirms that `account` may send as `sender`: it is the account itself, or
 * Gmail lists it among the account's Send As addresses (users.settings.sendAs.get,
 * allowed by gmail.readonly) and doesn't report it as awaiting verification.
 * Gmail would otherwise put the account's own address in From, so this runs
 * before anything is sent. Throws GmailError("auth") when the sender isn't
 * usable; network and server failures throw too, so nothing is assumed.
 */
export async function verifySendAs(fetchImpl: typeof fetch, accessToken: string, account: string, sender: string): Promise<void> {
  if (sender === account) return;
  let res: Response;
  try {
    res = await fetchImpl(`${SEND_AS_URL}/${encodeURIComponent(sender)}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new GmailError("network", `Gmail Send As request failed: ${(err as Error).message}`);
  }
  const notAlias = `${sender} isn't a Send As address of ${account} in Gmail.`;
  if (res.status === 404) throw new GmailError("auth", notAlias, 404);
  if (res.status === 401) throw new GmailError("auth", "Gmail refused the access token.", 401);
  if (!res.ok) throw new GmailError(res.status >= 500 ? "server" : "auth", `Gmail Send As request failed (${res.status}).`, res.status);
  const body = (await res.json().catch(() => ({}))) as { sendAsEmail?: string; verificationStatus?: string };
  if (body.sendAsEmail?.toLowerCase() !== sender) throw new GmailError("auth", notAlias);
  const status = body.verificationStatus ?? "verificationStatusUnspecified";
  if (!READY_SEND_AS.has(status)) {
    throw new GmailError("auth", `${sender} is a Send As address of ${account} but isn't ready to use (Gmail says ${status.slice(0, 40)}). Finish verifying it in Gmail's settings.`);
  }
}

const googleError = (err: unknown) => {
  const e = err as { response?: { data?: { error?: unknown } }; message?: string };
  return String(e.response?.data?.error ?? e.message ?? "unknown error").slice(0, 80);
};

/**
 * Finishes the authorization: exchanges the code, checks both scopes were
 * granted, reads the account from Gmail's profile, confirms it can send as
 * the configured sender, and returns the account and refresh token sealed.
 * Any other grant is revoked at once.
 */
export async function completeAuthorization(cfg: GmailOAuthConfig, code: string, fetchImpl: typeof fetch = globalThis.fetch) {
  const client = oauthClient(cfg, fetchImpl);
  let tokens: { access_token?: string | null; refresh_token?: string | null; scope?: string | null };
  try {
    ({ tokens } = await client.getToken(code));
  } catch (err) {
    throw new GmailError("auth", `Google refused the authorization code (${googleError(err)}). Start again.`);
  }
  const revoke = async () => {
    const t = tokens.refresh_token ?? tokens.access_token;
    if (t) await client.revokeToken(t).catch(() => undefined);
  };
  const granted = new Set((tokens.scope ?? "").split(/\s+/));
  if (!tokens.access_token || !GMAIL_SCOPES.every((s) => granted.has(s))) {
    await revoke();
    throw new GmailError("auth", "Both Gmail permissions (send, and read) must be granted. Start again and allow both.");
  }
  if (!tokens.refresh_token) {
    await revoke();
    throw new GmailError("auth", "Google didn't return offline access. Start again.");
  }
  const account = await gmailProfileEmail(fetchImpl, tokens.access_token);
  try {
    await verifySendAs(fetchImpl, tokens.access_token, account, cfg.sender);
  } catch (err) {
    await revoke();
    const why = err instanceof GmailError && err.kind === "auth" ? err.message : `It couldn't be checked (${(err as Error).message}).`;
    throw new GmailError(
      "auth",
      `That was ${account}, which can't send as ${cfg.sender}: ${why} Its access was revoked; start again and choose ${cfg.sender}'s own account, or the account that has it as a verified Send As address.`,
    );
  }
  return { account, sender: cfg.sender, sealed: sealRefreshToken({ account, refreshToken: tokens.refresh_token }, cfg) };
}

// ---------- at run time ----------

/** GmailCredentials from a stored authorization; the library refreshes access tokens. */
export function oauthCredentials(cfg: GmailOAuthConfig, auth: SealedAuthorization, fetchImpl: typeof fetch): GmailCredentials {
  const { refreshToken } = auth;
  const client = oauthClient(cfg, fetchImpl);
  client.setCredentials({ refresh_token: refreshToken });
  return {
    account: auth.account,
    sender: cfg.sender,
    async accessToken() {
      try {
        const { token } = await client.getAccessToken();
        if (!token) throw new Error("no access token");
        return token;
      } catch (err) {
        const reason = googleError(err);
        // invalid_grant: revoked, expired, or the password changed. Nothing can be sent until reauthorized.
        if (/invalid_grant|invalid_client|unauthorized_client|no access token/i.test(reason)) throw new GmailError("auth", `${REAUTHORIZE} (${reason})`);
        throw new GmailError("auth", `Couldn't get a Gmail access token (${reason}).`);
      }
    },
    invalidate() {
      client.setCredentials({ refresh_token: refreshToken });
    },
  };
}

/**
 * The Gmail credentials the configuration describes, or why there are none:
 * incomplete configuration, no authorization yet, or an authorization that
 * can't be read (another key, client, or sender, or an older format).
 */
export function gmailCredentialsFromConfig(
  config: Pick<Config, "gmailOAuth" | "outreachSender" | "publicApiUrl">,
  fetchImpl: typeof fetch = globalThis.fetch,
): GmailCredentials | { problem: string } {
  const cfg = gmailOAuthConfig(config);
  if ("problem" in cfg) return cfg;
  if (!config.gmailOAuth.sealedRefreshToken) {
    return { problem: `Gmail isn't authorized yet: authorize sending as ${cfg.sender} in the admin (Outreach page), then set GMAIL_REFRESH_TOKEN_SEALED.` };
  }
  const auth = openSealedToken(config.gmailOAuth.sealedRefreshToken, cfg);
  if (!auth) {
    return { problem: `GMAIL_REFRESH_TOKEN_SEALED can't be read with this key for ${cfg.sender} and this OAuth client: reauthorize in the admin (Outreach page).` };
  }
  return oauthCredentials(cfg, auth, fetchImpl);
}
