/*
 * Invitation tokens: the public part of an invitation link,
 * https://reclaimbay.com/invite#<token>. Pure: no database.
 *
 *   - 32 random bytes (256 bits) from the operating system's CSPRNG, as
 *     base64url: 43 characters, safe in a URL fragment, unguessable, and in
 *     no order, so there is nothing to enumerate;
 *   - only its SHA-256 is stored, so the invitations table alone can't
 *     produce a working link, and a lookup compares hashes of the visitor's
 *     own input (no partial-match timing to learn from);
 *   - it travels in the fragment, which browsers never send to a server, so
 *     it stays out of request logs and Referer headers.
 */
import { createHash, randomBytes } from "node:crypto";

export const INVITATION_TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const newInvitationToken = () => randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");

/** Exactly the shape newInvitationToken() makes; anything else is never looked up. */
export const isInvitationToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);

export const hashInvitationToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** The public link. Carries the token and nothing else: no ids, names, or campaign. */
export const invitationUrl = (siteUrl: string, token: string) => `${siteUrl.replace(/\/+$/, "")}/invite#${token}`;

const LINKED_TOKEN_RE = /(\/invite#)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
export const HIDDEN_TOKEN = "[invitation link hidden]";

/**
 * A message's text for showing to a person in the admin: every invitation
 * link keeps its place and shape, without its token. The token stays only in
 * the stored message and the email, so it is never on an admin page, and an
 * operator can't open the link and be counted as the business's visit.
 */
export const hideInvitationTokens = (text: string) => text.replace(LINKED_TOKEN_RE, `$1${HIDDEN_TOKEN}`);
