import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { GmailClient, gmailSender } from "../../src/outreach/gmail.js";
import {
  GMAIL_SCOPES,
  GmailError,
  authorizationUrl,
  completeAuthorization,
  gmailCredentialsFromConfig,
  gmailOAuthConfig,
  newOAuthState,
  openSealedToken,
  sealRefreshToken,
  verifyOAuthState,
  type GmailCredentials,
  type GmailOAuthConfig,
} from "../../src/outreach/gmailAuth.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { CLIENT_ID, FakeGoogle, MAILBOX, authorizedConfig, gmailTestConfig } from "../fixtures/fakeGmail.js";

/*
 * Google OAuth for the outreach mailbox, against a fake Google. The real
 * global fetch is replaced: any real network call fails the test.
 */

let realCalls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  realCalls = [];
  globalThis.fetch = (async (url: unknown) => {
    realCalls.push(String(url));
    throw new Error("real network call");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(realCalls, [], "no real network call");
});

const oauth = (over: Parameters<typeof gmailTestConfig>[0] = {}) => gmailOAuthConfig(gmailTestConfig(over)) as GmailOAuthConfig;
const problem = (v: unknown) => (v as { problem: string }).problem;

describe("Gmail OAuth configuration", () => {
  test("reports exactly which settings are missing, and a malformed key", () => {
    assert.match(problem(gmailOAuthConfig(gmailTestConfig({ clientId: null, clientSecret: null }))), /GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET are missing/);
    assert.match(problem(gmailOAuthConfig(gmailTestConfig({ tokenKey: null }))), /GMAIL_TOKEN_ENCRYPTION_KEY is missing/);
    assert.match(problem(gmailOAuthConfig({ ...gmailTestConfig(), outreachSender: { name: "A", email: null, postalAddress: null } })), /OUTREACH_SENDER_EMAIL is missing/);
    assert.match(problem(gmailOAuthConfig(gmailTestConfig({ tokenKey: Buffer.from("short").toString("base64") }))), /must be 32 random bytes/);
    const cfg = oauth();
    assert.equal(cfg.mailbox, MAILBOX);
    assert.equal(cfg.redirectUri, "https://api.reclaimbay.example/oauth/gmail/callback");
    assert.equal((gmailOAuthConfig({ ...gmailTestConfig(), publicApiUrl: null }) as GmailOAuthConfig).redirectUri, null);
  });

  test("without an authorization, or with one that can't be read, there are no credentials", () => {
    assert.match(problem(gmailCredentialsFromConfig(gmailTestConfig())), /isn't authorized yet: authorize hello@reclaimbay\.example in the admin/);
    assert.match(problem(gmailCredentialsFromConfig(gmailTestConfig({ sealedRefreshToken: "v1.garbage" }))), /can't be read/);
    const google = new FakeGoogle();
    const config = authorizedConfig(google);
    // The same sealed value with another key, another OAuth client, or another mailbox: refused.
    assert.match(problem(gmailCredentialsFromConfig({ ...config, gmailOAuth: { ...config.gmailOAuth, tokenKey: randomBytes(32).toString("base64") } })), /can't be read/);
    assert.match(problem(gmailCredentialsFromConfig({ ...config, gmailOAuth: { ...config.gmailOAuth, clientId: "other.apps.googleusercontent.com" } })), /can't be read/);
    assert.match(problem(gmailCredentialsFromConfig({ ...config, outreachSender: { ...config.outreachSender, email: "other@reclaimbay.example" } })), /can't be read/);
    assert.equal((gmailCredentialsFromConfig(config, google.fetch) as GmailCredentials).mailbox, MAILBOX);
  });
});

describe("the sealed refresh token", () => {
  test("round-trips, never contains the token, and detects tampering", () => {
    const cfg = oauth();
    const token = `1//refresh-${randomBytes(16).toString("hex")}`;
    const sealed = sealRefreshToken(token, cfg);
    assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(!sealed.includes(token) && !sealed.includes(Buffer.from(token).toString("base64url")));
    assert.notEqual(sealRefreshToken(token, cfg), sealed, "a fresh IV every time");
    assert.equal(openSealedToken(sealed, cfg), token);
    const [v, iv, ct, tag] = sealed.split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    assert.equal(openSealedToken([v, iv, flipped.toString("base64url"), tag].join("."), cfg), null);
    assert.equal(openSealedToken(sealed, { ...cfg, key: randomBytes(32) }), null);
  });
});

describe("the authorization request", () => {
  test("asks Google for exactly the two Gmail scopes, offline, for this mailbox, with the state", () => {
    const cfg = oauth();
    const { state } = newOAuthState("admin-secret-0123456789abcdef");
    const url = new URL(authorizationUrl(cfg, state));
    assert.equal(`${url.origin}${url.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    assert.equal(q.get("access_type"), "offline");
    assert.equal(q.get("prompt"), "consent");
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("client_id"), CLIENT_ID);
    assert.equal(q.get("redirect_uri"), "https://api.reclaimbay.example/oauth/gmail/callback");
    assert.deepEqual(q.get("scope")!.split(" ").sort(), [...GMAIL_SCOPES].sort());
    assert.equal(q.get("state"), state);
    assert.equal(q.get("login_hint"), MAILBOX);
    assert.equal(q.get("hd"), "reclaimbay.example");
    assert.notEqual(q.get("include_granted_scopes"), "true");
    assert.ok(!url.toString().includes("test-client-secret"), "the client secret never leaves the server");
    assert.throws(() => authorizationUrl({ ...cfg, redirectUri: null }, state), /PUBLIC_API_URL/);
  });

  test("the state: random, signed, short-lived, and compared exactly", () => {
    const secret = "admin-secret-0123456789abcdef";
    const a = newOAuthState(secret, 1_000);
    const b = newOAuthState(secret, 1_000);
    assert.notEqual(a.state, b.state);
    assert.ok(Buffer.from(a.state, "base64url").length >= 32);
    assert.equal(verifyOAuthState(secret, a.cookie, a.state, 2_000), true);
    assert.equal(verifyOAuthState(secret, a.cookie, b.state, 2_000), false, "another state");
    assert.equal(verifyOAuthState(secret, b.cookie, a.state, 2_000), false, "another browser's cookie");
    assert.equal(verifyOAuthState("another-secret-0123456789abc", a.cookie, a.state, 2_000), false, "not signed by this admin");
    assert.equal(verifyOAuthState(secret, a.cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")), a.state, 2_000), false, "tampered");
    assert.equal(verifyOAuthState(secret, a.cookie, a.state, 1_000 + 11 * 60 * 1000), false, "expired after ten minutes");
    assert.equal(verifyOAuthState(secret, undefined, a.state), false);
    assert.equal(verifyOAuthState(secret, a.cookie, undefined), false);
  });
});

describe("completing the authorization", () => {
  test("exchanges the code, verifies the account, and returns the refresh token sealed", async () => {
    const google = new FakeGoogle();
    const cfg = oauth();
    const { account, sealed } = await completeAuthorization(cfg, "good-code", google.fetch);
    assert.equal(account, MAILBOX);
    const refresh = openSealedToken(sealed, cfg)!;
    assert.ok(google.validRefreshTokens.has(refresh), "the sealed value holds the refresh token Google issued");
    assert.deepEqual(google.revoked, []);
    const exchange = google.tokenCalls[0]!;
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("redirect_uri"), cfg.redirectUri);
    assert.ok(google.calls.some((c) => c.url.endsWith("/users/me/profile")), "the account is checked with Gmail itself");
  });

  test("the wrong Google account is refused and its access revoked at once", async () => {
    const google = new FakeGoogle();
    google.account = "someone@gmail.com";
    await assert.rejects(completeAuthorization(oauth(), "good-code", google.fetch), /That was someone@gmail\.com, not hello@reclaimbay\.example\. Its access was revoked/);
    assert.equal(google.revoked.length, 1);
    assert.equal(google.validRefreshTokens.size, 0);
  });

  test("a missing permission, no offline access, or a bad code are refused", async () => {
    const partial = new FakeGoogle();
    partial.grantedScopes = [GMAIL_SCOPES[0]];
    await assert.rejects(completeAuthorization(oauth(), "good-code", partial.fetch), /Both Gmail permissions/);
    assert.equal(partial.revoked.length, 1);

    const online = new FakeGoogle();
    online.issueRefreshToken = false;
    await assert.rejects(completeAuthorization(oauth(), "good-code", online.fetch), /didn't return offline access/);

    const bad = new FakeGoogle();
    await assert.rejects(completeAuthorization(oauth(), "stolen-code", bad.fetch), (e: unknown) => e instanceof GmailError && /refused the authorization code \(invalid_grant\)/.test(e.message));
  });
});

describe("at run time", () => {
  test("the sender and the inbox reader share one credential layer; revocation fails both closed", async () => {
    const google = new FakeGoogle();
    const config = authorizedConfig(google);
    const credentials = gmailCredentialsFromConfig(config, google.fetch) as GmailCredentials;
    const client = new GmailClient(credentials, google.fetch);
    const sender = gmailSender(client);
    assert.equal(await sender.check!(), null);
    const read = await pollGmailInbox({} as Db, client, { apply: false });
    assert.equal(read.checked, 0);
    assert.equal(google.refreshCalls.length, 1, "one access token, shared");

    google.validRefreshTokens.clear(); // revoked in the Google account
    google.expireAccessTokens();
    assert.match((await sender.check!())!, /revoked or has expired: reauthorize/);
    await assert.rejects(pollGmailInbox({} as Db, client, { apply: true }), (e: unknown) => e instanceof GmailError && e.kind === "auth");
    assert.equal(google.sendCalls.length, 0);
  });
});
