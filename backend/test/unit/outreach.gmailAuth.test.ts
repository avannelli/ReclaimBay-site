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
import { ACCOUNT, CLIENT_ID, FakeGoogle, MAILBOX, aliasGoogle, authorizedConfig, gmailTestConfig } from "../fixtures/fakeGmail.js";

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
    assert.equal(cfg.sender, MAILBOX);
    assert.equal(cfg.redirectUri, "https://api.reclaimbay.example/oauth/gmail/callback");
    assert.equal((gmailOAuthConfig({ ...gmailTestConfig(), publicApiUrl: null }) as GmailOAuthConfig).redirectUri, null);
  });

  test("without an authorization, or with one that can't be read, there are no credentials", () => {
    assert.match(problem(gmailCredentialsFromConfig(gmailTestConfig())), /isn't authorized yet: authorize sending as hello@reclaimbay\.example in the admin/);
    assert.match(problem(gmailCredentialsFromConfig(gmailTestConfig({ sealedRefreshToken: "v2.garbage" }))), /can't be read/);
    const google = new FakeGoogle();
    const config = authorizedConfig(google);
    // The same sealed value with another key, another OAuth client, or another sender: refused.
    assert.match(problem(gmailCredentialsFromConfig({ ...config, gmailOAuth: { ...config.gmailOAuth, tokenKey: randomBytes(32).toString("base64") } })), /can't be read/);
    assert.match(problem(gmailCredentialsFromConfig({ ...config, gmailOAuth: { ...config.gmailOAuth, clientId: "other.apps.googleusercontent.com" } })), /can't be read/);
    assert.match(problem(gmailCredentialsFromConfig({ ...config, outreachSender: { ...config.outreachSender, email: "other@reclaimbay.example" } })), /can't be read/);
    const same = gmailCredentialsFromConfig(config, google.fetch) as GmailCredentials;
    assert.deepEqual([same.account, same.sender], [MAILBOX, MAILBOX]);

    // Authorized as another account that sends as the configured sender: both identities are kept apart.
    const alias = gmailCredentialsFromConfig(authorizedConfig(aliasGoogle()), google.fetch) as GmailCredentials;
    assert.deepEqual([alias.account, alias.sender], [ACCOUNT, MAILBOX]);
  });
});

describe("the sealed refresh token", () => {
  test("round-trips with its account, never contains the token, and detects tampering", () => {
    const cfg = oauth();
    const token = `1//refresh-${randomBytes(16).toString("hex")}`;
    const auth = { account: ACCOUNT, refreshToken: token };
    const sealed = sealRefreshToken(auth, cfg);
    assert.match(sealed, /^v2\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(!sealed.includes(token) && !sealed.includes(Buffer.from(token).toString("base64url")));
    assert.notEqual(sealRefreshToken(auth, cfg), sealed, "a fresh IV every time");
    assert.deepEqual(openSealedToken(sealed, cfg), auth);
    const [v, iv, ct, tag] = sealed.split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    assert.equal(openSealedToken([v, iv, flipped.toString("base64url"), tag].join("."), cfg), null);
    assert.equal(openSealedToken(sealed, { ...cfg, key: randomBytes(32) }), null);
    assert.equal(openSealedToken(sealed.replace(/^v2\./, "v1."), cfg), null, "the older single-mailbox format isn't read");
  });
});

describe("the authorization request", () => {
  test("asks Google for exactly the two Gmail scopes, offline, for the sender's domain, with the state", () => {
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
    assert.equal(q.get("login_hint"), null, "the sender may be a Send As address, not an account to sign in as");
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
  test("the sender's own account: exchanges the code, verifies the account, and returns the refresh token sealed", async () => {
    const google = new FakeGoogle();
    const cfg = oauth();
    const { account, sender, sealed } = await completeAuthorization(cfg, "good-code", google.fetch);
    assert.deepEqual([account, sender], [MAILBOX, MAILBOX]);
    const opened = openSealedToken(sealed, cfg)!;
    assert.equal(opened.account, MAILBOX);
    assert.ok(google.validRefreshTokens.has(opened.refreshToken), "the sealed value holds the refresh token Google issued");
    assert.deepEqual(google.revoked, []);
    const exchange = google.tokenCalls[0]!;
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("redirect_uri"), cfg.redirectUri);
    assert.ok(google.calls.some((c) => c.url.endsWith("/users/me/profile")), "the account is checked with Gmail itself");
    assert.equal(google.sendAsCalls.length, 0, "an account sending as itself needs no Send As lookup");
  });

  test("another account with the sender as a verified Send As address is authorized, and sealed as that account", async () => {
    const google = aliasGoogle("accepted");
    const cfg = oauth();
    const { account, sender, sealed } = await completeAuthorization(cfg, "good-code", google.fetch);
    assert.deepEqual([account, sender], [ACCOUNT, MAILBOX]);
    assert.equal(openSealedToken(sealed, cfg)!.account, ACCOUNT);
    assert.deepEqual(
      google.sendAsCalls.map((c) => c.url),
      [`https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(MAILBOX)}`],
      "the exact sender is looked up in that account's Send As settings",
    );
    assert.deepEqual(google.revoked, []);

    // A Workspace alias, for which Gmail reports no verification status, is usable too.
    assert.equal((await completeAuthorization(cfg, "good-code", aliasGoogle(undefined).fetch)).account, ACCOUNT);
  });

  test("an account that can't send as the sender is refused and its access revoked at once", async () => {
    const refused = async (google: FakeGoogle, why: RegExp) => {
      await assert.rejects(completeAuthorization(oauth(), "good-code", google.fetch), (e: unknown) => e instanceof GmailError && e.kind === "auth" && why.test(e.message));
      assert.equal(google.revoked.length, 1, String(why));
      assert.equal(google.validRefreshTokens.size, 0, String(why));
      assert.equal(google.sendCalls.length, 0);
    };
    // The sender isn't among the account's Send As addresses.
    await refused(aliasGoogle(null), /That was alex@reclaimbay\.example, which can't send as hello@reclaimbay\.example: hello@reclaimbay\.example isn't a Send As address of alex@reclaimbay\.example in Gmail\. Its access was revoked/);
    // Still awaiting verification.
    await refused(aliasGoogle("pending"), /isn't ready to use \(Gmail says pending\)/);
    // Only an unrelated address is a Send As address.
    const unrelated = aliasGoogle(null);
    unrelated.sendAs = [{ sendAsEmail: "sales@reclaimbay.example", verificationStatus: "accepted" }];
    await refused(unrelated, /isn't a Send As address of alex@reclaimbay\.example/);
    // Another account entirely, with no matching alias.
    const stranger = new FakeGoogle();
    stranger.account = "someone@gmail.com";
    await refused(stranger, /That was someone@gmail\.com, which can't send as hello@reclaimbay\.example/);
  });

  test("a Send As lookup that fails is refused, never assumed", async () => {
    const google = aliasGoogle("accepted");
    const failing = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/settings/sendAs/") ? new Response("{}", { status: 503 }) : google.fetch(input, init)) as typeof fetch;
    await assert.rejects(completeAuthorization(oauth(), "good-code", failing), /can't send as hello@reclaimbay\.example: It couldn't be checked .*Its access was revoked/);
    assert.equal(google.revoked.length, 1);
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

  test("sending as a Send As address: the sender and the inbox reader verify it; once it's gone, both fail closed", async () => {
    const google = aliasGoogle("accepted");
    const config = authorizedConfig(google);
    const client = new GmailClient(gmailCredentialsFromConfig(config, google.fetch) as GmailCredentials, google.fetch);
    assert.deepEqual([client.account, client.sender], [ACCOUNT, MAILBOX]);
    const sender = gmailSender(client);
    assert.equal(await sender.check!(), null);
    assert.equal((await pollGmailInbox({} as Db, client, { apply: false })).checked, 0);
    assert.equal(google.sendAsCalls.length, 1, "verified once, shared by the sender and the reader");

    google.sendAs = []; // the alias is removed in Gmail
    assert.match((await sender.check!())!, /isn't a Send As address of alex@reclaimbay\.example/);
    const fresh = new GmailClient(gmailCredentialsFromConfig(config, google.fetch) as GmailCredentials, google.fetch);
    await assert.rejects(pollGmailInbox({} as Db, fresh, { apply: true }), (e: unknown) => e instanceof GmailError && e.kind === "auth");
    assert.equal(google.sendCalls.length, 0);
  });
});
