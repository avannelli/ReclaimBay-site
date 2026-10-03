import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { INVITATION_STATUSES, INVITATION_STATUS_LABELS, INVITATION_STATUS_MEANINGS, invitationStatus } from "../../src/invitations/status.js";
import { HIDDEN_TOKEN, INVITATION_TOKEN_BYTES, hashInvitationToken, hideInvitationTokens, invitationUrl, isInvitationToken, newInvitationToken } from "../../src/invitations/tokens.js";

/*
 * Invitation tokens: unguessable, URL-fragment safe, stored only as a hash,
 * and the link carries nothing but the token.
 */

describe("invitation tokens", () => {
  test("256 random bits, as 43 URL-safe characters, never repeating", () => {
    assert.equal(INVITATION_TOKEN_BYTES, 32);
    const tokens = Array.from({ length: 2000 }, newInvitationToken);
    for (const t of tokens) {
      assert.match(t, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(t, "base64url").length, 32);
    }
    assert.equal(new Set(tokens).size, tokens.length);
    // No shared prefix or order to enumerate: the first character is spread across the alphabet.
    assert.ok(new Set(tokens.map((t) => t[0])).size > 50);
  });

  test("only well-formed tokens are ever looked up", () => {
    assert.ok(isInvitationToken(newInvitationToken()));
    for (const bad of [undefined, null, 42, "", "short", "x".repeat(42), "x".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`, `${"a".repeat(42)} `, "<script>alert(1)</script>".padEnd(43, "a")]) {
      assert.equal(isInvitationToken(bad), false, String(bad));
    }
  });

  test("stored as SHA-256: fixed length, deterministic, and not the token", () => {
    const t = newInvitationToken();
    const h = hashInvitationToken(t);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(hashInvitationToken(t), h);
    assert.notEqual(hashInvitationToken(newInvitationToken()), h);
    assert.ok(!h.includes(t));
    // A known vector, so the stored form can't drift unnoticed.
    assert.equal(hashInvitationToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("the link puts the token in the fragment, and carries nothing else", () => {
    const t = newInvitationToken();
    assert.equal(invitationUrl("https://reclaimbay.com", t), `https://reclaimbay.com/invite#${t}`);
    assert.equal(invitationUrl("https://reclaimbay.com/", t), `https://reclaimbay.com/invite#${t}`);
    const u = new URL(invitationUrl("https://reclaimbay.com", t));
    assert.equal(u.search, "", "no query string: nothing reaches a server's logs");
    assert.equal(u.hash, `#${t}`);
  });

  test("a message shown in the admin keeps its invitation links' place and shape, but never their tokens", () => {
    const [t1, t2] = [newInvitationToken(), newInvitationToken()];
    const body = `Get your free report: ${invitationUrl("https://reclaimbay.com", t1)}
Again: ${invitationUrl("http://localhost:3000", t2)}
reply "no thanks"`;
    const shown = hideInvitationTokens(body);
    assert.equal(shown, `Get your free report: https://reclaimbay.com/invite#${HIDDEN_TOKEN}
Again: http://localhost:3000/invite#${HIDDEN_TOKEN}
reply "no thanks"`);
    assert.ok(!shown.includes(t1) && !shown.includes(t2));
    assert.equal(hideInvitationTokens(shown), shown, "applying it again changes nothing");
    const plain = "See https://reclaimbay.com/?ref=rb_abcdefghijkl and #section";
    assert.equal(hideInvitationTokens(plain), plain, "text without an invitation link is untouched");
  });

  test("the service never logs, and the token is never written to the database", () => {
    const service = readFileSync(new URL("../../src/invitations/service.ts", import.meta.url), "utf8");
    assert.doesNotMatch(service, /console\.|\.log\.|logger/, "no logging in the invitation service");
    // No data object has a field named `token` (written as `token:` or the shorthand `token,` / `token }`).
    assert.doesNotMatch(service, /data:\s*\{(?:[^}]*,)?\s*token\s*[:,}]/, "only tokenHash is stored");
    assert.match(service, /tokenHash: hashInvitationToken\(token\)/);
  });
});

describe("invitation status (what the admin shows)", () => {
  const t = new Date("2026-10-10T10:00:00Z");
  test("not opened, then opened, then activated; revoked ends it whatever came before", () => {
    assert.equal(invitationStatus({ revokedAt: null, firstOpenedAt: null }, null), "not_opened");
    assert.equal(invitationStatus({ revokedAt: null, firstOpenedAt: t }, null), "opened");
    assert.equal(invitationStatus({ revokedAt: null, firstOpenedAt: t }, t), "activated");
    assert.equal(invitationStatus({ revokedAt: t, firstOpenedAt: null }, null), "revoked");
    assert.equal(invitationStatus({ revokedAt: t, firstOpenedAt: t }, t), "revoked", "a revoked link says so, even if it was activated");
  });

  test("every status has a label and a plain meaning", () => {
    assert.deepEqual([...INVITATION_STATUSES], ["not_opened", "opened", "activated", "revoked"]);
    assert.deepEqual(INVITATION_STATUSES.map((s) => INVITATION_STATUS_LABELS[s]), ["Not opened", "Opened", "Activated", "Revoked"]);
    for (const s of INVITATION_STATUSES) assert.ok(INVITATION_STATUS_MEANINGS[s].length > 10);
  });
});
