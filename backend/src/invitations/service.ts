/*
 * Invitations: the attribution layer between outreach and the product.
 *
 *   Prospect -> Outreach (first message) -> Invitation -> visits -> activation
 *
 * One invitation per outreach contact attempt: its first message (a
 * follow-up reuses that message's invitation). Making one sends and queues
 * nothing. A visitor who opens the link is linked to it the same way a ?ref=
 * link links them to a prospect: first touch, on their anonymous analytics
 * session. Activation is measured, not stored: the first real scan in such a
 * session. Accounts and signup are a later milestone.
 *
 * Lifecycle, by timestamps: createdAt -> firstOpenedAt (lastOpenedAt,
 * openCount) -> activation (from ProductEvent); revokedAt ends it, and the
 * record is kept.
 */
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { outreachEligibility } from "../outreach/eligibility.js";
import { OPEN_STATUSES, OUTREACH_STATUS_LABELS } from "../outreach/lifecycle.js";
import { isSuppressed, lockOutreach, lockSendGate } from "../outreach/records.js";
import { ProspectError } from "../prospects.js";
import { invitationStatus } from "./status.js";
import { hashInvitationToken, invitationUrl, isInvitationToken, newInvitationToken } from "./tokens.js";

type Tx = Prisma.TransactionClient;
type Invitation = Prisma.InvitationGetPayload<object>;

export type InvitationCreated =
  /** A new invitation: its public token and link, available only now (only the hash is stored). */
  | { created: true; invitation: Invitation; token: string; url: string }
  /** The message already has one; its token can't be recovered. */
  | { created: false; invitation: Invitation; token: null; url: null };

/**
 * Makes the invitation for an outreach contact attempt, idempotently. The
 * message must be a first message that hasn't been sent yet (draft or
 * queued), and the prospect must pass the same eligibility decision as
 * drafting (eligibility.ts): qualified, contactable, not suppressed, not
 * bounced, not already contacted.
 */
export async function createInvitationForOutreach(db: Db, outreachId: string, opts: { siteUrl: string; now?: Date }): Promise<InvitationCreated> {
  return db.$transaction((tx) => createInvitationInTx(tx, outreachId, opts.siteUrl, opts.now ?? new Date()));
}

/**
 * The same, inside the caller's transaction. Drafting passes the token it
 * wrote into the message's link, so the link and the stored hash match; it
 * must be one newInvitationToken() made.
 */
export async function createInvitationInTx(tx: Tx, outreachId: string, siteUrl: string, now: Date, token: string = newInvitationToken()): Promise<InvitationCreated> {
  if (!isInvitationToken(token)) throw new Error("Not an invitation token.");
  // One maker per message at a time; the unique outreachId is the backstop.
  await lockOutreach(tx, outreachId);
  const o = await tx.outreach.findUnique({ where: { id: outreachId }, include: { prospect: { include: { signals: true } }, invitation: true } });
  if (!o) throw new ProspectError(["Outreach not found."], "not_found");
  if (o.invitation) return { created: false, invitation: o.invitation, token: null, url: null };

  const errors: string[] = [];
  if (o.kind !== "initial") errors.push("Only a first message gets an invitation; a follow-up uses the first message's.");
  if (!OPEN_STATUSES.includes(o.status)) errors.push(`An invitation is made before its message is sent; this message is ${OUTREACH_STATUS_LABELS[o.status]}.`);
  errors.push(...(await outreachEligibility(tx, { stage: "prepare", kind: "initial", prospect: o.prospect })).errors);
  if (errors.length) throw new ProspectError([...new Set(errors)]);

  const invitation = await tx.invitation.create({
    data: { tokenHash: hashInvitationToken(token), prospectId: o.prospectId, outreachId, campaign: o.campaign, createdAt: now },
  });
  return { created: true, invitation, token, url: invitationUrl(siteUrl, token) };
}

const SENT_LINK_RE = /(https?:\/\/\S+?\/invite#([A-Za-z0-9_-]{43}))(?![A-Za-z0-9_-])/;

export type SentInvitationLink =
  /** The invitation link the message carried, exactly as sent: a follow-up reuses it. */
  | { kind: "link"; url: string }
  /** Its invitation was revoked: the link no longer works. */
  | { kind: "revoked" }
  /** The message carried no invitation link (made before invitations), so there is none to reuse. */
  | { kind: "none" };

/**
 * The invitation link a first message carried, for its follow-up. The token
 * itself is stored nowhere but in that message's text, so this reads it from
 * there and accepts it only when its hash is the invitation's: never a
 * guess, and never a new token.
 */
export async function sentInvitationLink(tx: Tx | Db, message: { id: string; body: string }): Promise<SentInvitationLink> {
  const inv = await tx.invitation.findUnique({ where: { outreachId: message.id }, select: { tokenHash: true, revokedAt: true } });
  if (!inv) return { kind: "none" };
  if (inv.revokedAt) return { kind: "revoked" };
  const m = SENT_LINK_RE.exec(message.body);
  if (!m || hashInvitationToken(m[2]!) !== inv.tokenHash) return { kind: "none" };
  return { kind: "link", url: m[1]! };
}

/** What a public caller learns from opening a link: whether it's active, and the business's own public name. */
export type InvitationOpen = { active: false } | { active: true; businessName: string | null };

const INACTIVE: InvitationOpen = { active: false };
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A visitor opened an invitation link. Public, untrusted input. A malformed,
 * unknown, or revoked token, or one for a business that asked not to be
 * contacted (Do not contact, or a suppressed address), all get the same
 * `{ active: false }` and change nothing. An active one counts the open and,
 * given the visitor's anonymous session id, links that session to it.
 */
export async function openInvitation(db: Db, input: { token: unknown; sessionId?: unknown }, now = new Date()): Promise<InvitationOpen> {
  if (!isInvitationToken(input.token)) return INACTIVE;
  const sessionId = typeof input.sessionId === "string" && SESSION_RE.test(input.sessionId) ? input.sessionId : null;
  const inv = await db.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(input.token) },
    select: {
      id: true,
      prospectId: true,
      revokedAt: true,
      prospect: { select: { status: true, businessName: true } },
      outreach: { select: { recipientEmail: true } },
    },
  });
  if (!inv || inv.revokedAt || inv.prospect.status === "do_not_contact") return INACTIVE;
  if (await isSuppressed(db, inv.outreach.recipientEmail)) return INACTIVE;

  const counted = await db.$transaction(async (tx) => {
    // Conditional on not revoked, so a revocation that lands meanwhile wins.
    const { count } = await tx.invitation.updateMany({ where: { id: inv.id, revokedAt: null }, data: { openCount: { increment: 1 }, lastOpenedAt: now } });
    if (count !== 1) return false;
    await tx.invitation.updateMany({ where: { id: inv.id, firstOpenedAt: null }, data: { firstOpenedAt: now } });
    if (sessionId) await attributeSession(tx, sessionId, inv, now);
    return true;
  });
  return counted ? { active: true, businessName: inv.prospect.businessName } : INACTIVE;
}

/**
 * First touch, as for a ?ref= link (routes/events.ts): a session keeps the
 * first prospect it was linked to. It is linked to the invitation only when
 * it belongs to the invitation's prospect and has no invitation yet, so a
 * browser that arrived through another business's link is never moved.
 */
async function attributeSession(tx: Tx, anonymousSessionId: string, inv: { id: string; prospectId: string }, now: Date) {
  const session = await tx.analyticsSession.upsert({
    where: { anonymousSessionId },
    create: { anonymousSessionId, prospectId: inv.prospectId, invitationId: inv.id, firstSeenAt: now, lastSeenAt: now },
    update: { lastSeenAt: now },
    select: { id: true },
  });
  await tx.analyticsSession.updateMany({ where: { id: session.id, prospectId: null }, data: { prospectId: inv.prospectId } });
  await tx.analyticsSession.updateMany({ where: { id: session.id, prospectId: inv.prospectId, invitationId: null }, data: { invitationId: inv.id } });
}

/**
 * Ends an invitation: its link stops working; the record and everything it
 * attributed stay. Repeating it changes nothing (the first reason is kept).
 * Under the send gate (outreach/records.ts), like everything that can stop a send.
 */
export async function revokeInvitation(db: Db, invitationId: string, reasonRaw?: unknown, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    return revokeInvitationInTx(tx, invitationId, reasonRaw, now);
  });
}

/** The revocation itself, inside the caller's gated transaction. */
async function revokeInvitationInTx(tx: Tx, invitationId: string, reasonRaw: unknown, now: Date) {
  const reason = (typeof reasonRaw === "string" ? reasonRaw.replace(/\s+/g, " ").trim() : "").slice(0, 200) || "Revoked by a person.";
  const { count } = await tx.invitation.updateMany({ where: { id: invitationId, revokedAt: null }, data: { revokedAt: now, revokeReason: reason } });
  if (count === 1) return { changed: true };
  if (!(await tx.invitation.findUnique({ where: { id: invitationId }, select: { id: true } }))) throw new ProspectError(["Invitation not found."], "not_found");
  return { changed: false };
}

/**
 * The invitation of an outreach message, for the admin: its timestamps,
 * activation (invitationActivations), and status (status.ts). Never the
 * token's hash. Null when the message has none.
 */
export async function invitationForOutreach(db: Db, outreachId: string) {
  const inv = await db.invitation.findUnique({
    where: { outreachId },
    select: { id: true, campaign: true, createdAt: true, revokedAt: true, revokeReason: true, firstOpenedAt: true, lastOpenedAt: true, openCount: true },
  });
  if (!inv) return null;
  const activatedAt = (await invitationActivations(db, [inv.id])).get(inv.id) ?? null;
  return { ...inv, activatedAt, status: invitationStatus(inv, activatedAt) };
}

/** Revokes the invitation of an outreach message (revokeInvitation); the message itself is untouched. */
export async function revokeInvitationForOutreach(db: Db, outreachId: string, reason: unknown, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockSendGate(tx);
    const inv = await tx.invitation.findUnique({ where: { outreachId }, select: { id: true } });
    if (!inv) throw new ProspectError(["This message has no invitation."]);
    return revokeInvitationInTx(tx, inv.id, reason, now);
  });
}

/**
 * When each invitation was activated: the first real (not sample) completed
 * scan in a session that arrived through it, at or after its first open
 * (anything earlier wasn't caused by it). Invitations not activated are
 * absent. The query boundary the admin's measurements use (4C).
 */
export async function invitationActivations(db: Db, invitationIds: readonly string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!invitationIds.length) return out;
  const sessions = await db.analyticsSession.findMany({
    where: { invitationId: { in: [...invitationIds] }, invitation: { firstOpenedAt: { not: null } } },
    select: {
      invitationId: true,
      invitation: { select: { firstOpenedAt: true } },
      events: { where: { eventType: "scan_completed", isSample: false }, orderBy: { createdAt: "asc" }, select: { createdAt: true } },
    },
  });
  for (const s of sessions) {
    const opened = s.invitation!.firstOpenedAt!;
    const first = s.events.find((e) => e.createdAt >= opened)?.createdAt;
    const id = s.invitationId!;
    if (first && (!out.has(id) || first < out.get(id)!)) out.set(id, first);
  }
  return out;
}
