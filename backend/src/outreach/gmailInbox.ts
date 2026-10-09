/*
 * Reading the outreach mailbox: what Gmail gives us instead of an ESP's
 * delivery webhooks. Read-only on the Gmail side (gmail.readonly).
 *
 * Gmail sends no delivery receipts and no complaint reports. What reaches the
 * mailbox, and what this does with it:
 *
 *   bounce (DSN, status 5.x.x)   -> applyProviderEvent(bounced): suppressed
 *   delay (DSN, status 4.x.x)    -> nothing; the message is still on its way
 *   bounce of unknown kind       -> listed for a person, nothing recorded
 *   auto-reply / out of office   -> nothing (not a reply)
 *   "unsubscribe" email          -> strict attribution, then opt-out or durable unassigned review
 *   anything else from them      -> recordInboundReply, unclassified
 *
 * Attribution collects thread candidates, sender/DSN identities, quoted
 * outreach markers and verified SMTP parents. Evidence must identify one
 * outbound without contradictions; thread membership alone is insufficient.
 * Unresolved mail is only reported. Permanent emailed opt-outs retain their
 * separate all-candidate/sender/time decision.
 *
 * It keeps no cursor: each run looks back a few days, and every write is
 * idempotent (bounces carry an event id; replies keep the authorized account
 * and actual inbound Gmail message id), so re-reading is harmless.
 * Gmail push (Pub/Sub watch) could trigger a run sooner; it isn't needed at
 * this volume.
 */
import type { Db } from "../db.js";
import { GmailError, OUTREACH_HEADER, headerOf, type GmailClient, type GmailMessage, type GmailPart } from "./gmail.js";
import { normalizeEmail } from "./lifecycle.js";
import { applyProviderEvent, recordInboundReply } from "./service.js";
import { ingestEmailedUnsubscribe } from "./emailedUnsubscribe.js";
import { resolveInboxAttribution, type InboxEvidence, type InboxAttribution } from "./inboxAttribution.js";

export type InboundKind = "bounce" | "delay" | "bounce_unknown" | "auto_reply" | "unsubscribe" | "reply" | "own";

export interface Classified {
  kind: InboundKind;
  from: string;
  reason: string | null;
  /** The outreach id quoted in a bounced message's headers, if present. */
  markerOutreachId: string | null;
}

const decode = (data?: string) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

/** The decoded text of every readable part (text, delivery status, returned headers). */
export function messageText(part: GmailPart | undefined): string {
  if (!part) return "";
  const own = /^(text\/plain|message\/delivery-status|text\/rfc822-headers|message\/rfc822)/i.test(part.mimeType ?? "") ? decode(part.body?.data) : "";
  return [own, ...(part.parts ?? []).map(messageText)].filter(Boolean).join("\n");
}

const address = (from: string) => normalizeEmail(/<([^>]+)>/.exec(from)?.[1] ?? from);

function singleUnsubscribeAddress(value: string): string | null {
  const raw = value.trim();
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  const prefix = raw.includes("<") ? raw.slice(0, raw.indexOf("<")).trim() : "";
  if (prefix && !/^"[^"]*"$/.test(prefix) && /[,@;<>]/.test(prefix)) return null;
  const match = /^(?:[^<>]*<([^<>]+)>|([^<>\s,;]+))$/.exec(raw);
  const email = normalizeEmail((match?.[1] ?? match?.[2])?.trim() ?? "");
  if (email.length > 254 || !/^[^@\s,;<>:"\\]+@[^@\s,;<>:"\\]+$/.test(email)) return null;
  return email;
}

/** Permanent opt-outs require one well-formed From identity, never a list or duplicate header. */
export function unsubscribeSender(m: GmailMessage): string | null {
  const headers = m.payload?.headers?.filter((h) => h.name.toLowerCase() === "from") ?? [];
  if (headers.length !== 1) return null;
  const email = singleUnsubscribeAddress(headers[0]!.value);
  if (!email) return null;
  const senders = m.payload?.headers?.filter((h) => h.name.toLowerCase() === "sender") ?? [];
  if (senders.length > 1 || (senders.length === 1 && singleUnsubscribeAddress(senders[0]!.value) !== email)) return null;
  return email;
}

/** A reply's Sender header may legitimately differ for a mail alias/delegate. */
export function inboxSender(m: GmailMessage): string | null {
  const headers = m.payload?.headers?.filter((h) => h.name.toLowerCase() === "from") ?? [];
  return headers.length === 1 ? singleUnsubscribeAddress(headers[0]!.value) : null;
}
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Forwarded opt-outs can quote several messages: never retain only the first marker. */
export function unsubscribeMarkers(m: GmailMessage): string[] {
  const markers = messageText(m.payload).matchAll(new RegExp(`${OUTREACH_HEADER}:\\s*(${UUID.source})`, "gi"));
  return [...new Set([...markers].map((match) => match[1]!.toLowerCase()))];
}

/** What an inbound message is. Pure: headers and text only. `own` is our address, or addresses (the account and its sender). */
export function classifyInbound(m: GmailMessage, own: string | readonly string[]): Classified {
  const fromHeader = headerOf(m, "From") ?? "";
  const from = address(fromHeader);
  const subject = headerOf(m, "Subject") ?? "";
  const contentType = headerOf(m, "Content-Type") ?? m.payload?.mimeType ?? "";
  const text = messageText(m.payload);
  const marker = new RegExp(`${OUTREACH_HEADER}:\\s*(${UUID.source})`, "i").exec(text)?.[1]?.toLowerCase() ?? null;
  const base = { from, markerOutreachId: marker };
  if ((typeof own === "string" ? [own] : own).some((a) => from === normalizeEmail(a))) return { ...base, kind: "own", reason: null };

  const isDsn =
    /^(mailer-daemon|postmaster)@/i.test(from) ||
    /report-type=["']?delivery-status/i.test(contentType) ||
    (/mail delivery (subsystem|system)/i.test(fromHeader) && /delivery status notification|undeliverable|undelivered|returned mail|address not found|failure/i.test(subject));
  if (isDsn) {
    const status = /^\s*Status:\s*([245])\.\d{1,3}\.\d{1,3}/im.exec(text)?.[1];
    const action = /^\s*Action:\s*(failed|delayed)/im.exec(text)?.[1]?.toLowerCase();
    const diagnostic = /^\s*Diagnostic-Code:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null;
    const reason = (diagnostic ?? subject).slice(0, 400);
    if (status === "4" || action === "delayed" || /\(delay\)/i.test(subject)) return { ...base, kind: "delay", reason };
    if (status === "5" || action === "failed" || /\(failure\)|address not found/i.test(subject)) return { ...base, kind: "bounce", reason };
    return { ...base, kind: "bounce_unknown", reason };
  }

  const auto = headerOf(m, "Auto-Submitted");
  const precedence = headerOf(m, "Precedence") ?? "";
  if (
    (auto && !/^no$/i.test(auto.trim())) ||
    headerOf(m, "X-Autoreply") ||
    headerOf(m, "X-Autorespond") ||
    /^(auto_reply|bulk|junk|list)$/i.test(precedence.trim()) ||
    /^(automatic reply|auto[- ]?reply|autoreply|out of (the )?office)/i.test(subject.trim())
  ) {
    return { ...base, kind: "auto_reply", reason: null };
  }
  if (/^\s*(re:\s*)?unsubscribe\s*$/i.test(subject)) return { ...base, kind: "unsubscribe", reason: null };
  return { ...base, kind: "reply", reason: null };
}

export interface InboxItem {
  gmailId: string;
  kind: InboundKind;
  from: string;
  subject: string;
  outreachId: string | null;
  result: string;
  attribution?: InboxAttribution;
}

export interface InboxReport {
  checked: number;
  items: InboxItem[];
  /** Messages whose Gmail thread couldn't be read: each left for a person, nothing recorded. */
  unreadableThreads?: number;
}

/**
 * The other messages in a message's thread, or null when Gmail refuses this one
 * thread (a 4xx such as failedPrecondition, or a thread gone since the listing).
 * Authorization, quota, server and network failures aren't about one thread:
 * they still throw and end the run.
 */
async function otherThreadMessages(client: GmailClient, m: GmailMessage): Promise<string[] | null> {
  try {
    const thread = await client.getThread(m.threadId);
    return (thread.messages ?? []).map((x) => x.id).filter((id) => id !== m.id);
  } catch (err) {
    if (err instanceof GmailError && err.kind === "invalid") return null;
    throw err;
  }
}

/** Without its thread, a message can't be attributed: the existing fail-closed review result, nothing recorded. */
const unreadableThread = (): InboxAttribution => ({ status: "unresolved", reason: "invalid_identity", outreachId: null, candidateOutreachIds: [] });

/** SMTP parent identity is not Gmail's API message ID. Resolve it against provider metadata. */
async function inboxEvidence(db: Db, client: GmailClient, m: GmailMessage, kind: "reply" | "bounce", receivedAt: Date | null, threadMessageIds: string[] | null): Promise<InboxEvidence> {
  const text = messageText(m.payload);
  const recipientEmails = kind === "bounce" ? [...new Set([...text.matchAll(/^[ \t]*(?:Final|Original)-Recipient:[ \t]*([^\r\n]*)/gim)].map((v) => {
    const value = /^rfc822;[ \t]*(.+)$/i.exec(v[1]!);
    return value ? singleUnsubscribeAddress(value[1]!) ?? "" : "";
  }))] : [];
  const parents = m.payload?.headers?.filter((h) => h.name.toLowerCase() === "in-reply-to") ?? [];
  const references = m.payload?.headers?.filter((h) => h.name.toLowerCase() === "references") ?? [];
  const returnedIds = kind === "bounce" ? [...text.matchAll(/^[ \t]*Message-ID:[ \t]*([^\r\n]*)/gim)].map((v) => v[1]!) : [];
  const parentValues = [...parents.map((h) => h.value), ...returnedIds];
  const referenceValues = references.map((h) => h.value);
  const idsOf = (values: string[]) => [...new Set(values.flatMap((v) => [...v.matchAll(/<[^<>\s]+>/g)].map((match) => match[0])))];
  const malformedIds = [...parentValues, ...referenceValues].some((v) => !v.trim() || Boolean(v.replace(/<[^<>\s]+>/g, "").trim()));
  const rfcIds = idsOf(parentValues);
  const evidence: InboxEvidence = { kind, receivedAt, fromEmail: inboxSender(m), recipientEmails: recipientEmails.filter(Boolean),
    threadMessageIds: threadMessageIds ?? [], markerOutreachIds: unsubscribeMarkers(m),
    relatedProviderMessageIds: [], invalidEvidence: threadMessageIds === null || recipientEmails.includes("") || parents.length > 1 || references.length > 1 || malformedIds };
  const ancestors = idsOf(referenceValues);
  const allIds = [...new Set([...rfcIds, ...ancestors])];
  // Bound work and prevent mailbox-query syntax from entering an opaque message ID.
  if (evidence.invalidEvidence || allIds.length > 20 || allIds.some((v) => v.length > 254 || !/^<[A-Za-z0-9.!#$%&'*+\/=\?^_`{|}~@-]+>$/.test(v))) {
    evidence.invalidEvidence = true;
    return evidence;
  }
  const lookup = async (ids: string[]) => {
    for (const rfcId of ids) {
      const list = await client.listMessages({ labelIds: "SENT", q: `rfc822msgid:${rfcId}`, maxResults: "100" });
      if (list.nextPageToken) { evidence.invalidEvidence = true; return; }
      for (const { id } of list.messages ?? []) {
        const provider = await client.getMessage(id, "metadata", ["Message-ID"]);
        const headers = provider.payload?.headers?.filter((h) => h.name.toLowerCase() === "message-id") ?? [];
        if (provider.id === id && provider.labelIds?.includes("SENT") && headers.length === 1 && headers[0]!.value.trim() === rfcId) evidence.relatedProviderMessageIds.push(id);
      }
    }
  };
  try {
    await lookup(rfcIds);
    // The immediate parent can be a manual Gmail reply with no Outreach row.
    // In that case consider its known ancestors, without guessing the newest.
    const known = evidence.relatedProviderMessageIds.length ? await db.outreach.count({ where: { providerMessageId: { in: evidence.relatedProviderMessageIds } } }) : 0;
    if (!known && !evidence.invalidEvidence) await lookup(ancestors.filter((id) => !rfcIds.includes(id)));
  } catch { evidence.invalidEvidence = true; /* Fixed review result, never a provider diagnostic. */ }
  evidence.relatedProviderMessageIds = [...new Set(evidence.relatedProviderMessageIds)];
  return evidence;
}

/**
 * Reads the last `lookbackDays` of the mailbox and records bounces, replies,
 * and emailed unsubscribes. With `apply: false` it only reports what it
 * would do. Safe to repeat.
 */
export async function pollGmailInbox(
  db: Db,
  client: GmailClient,
  opts: { apply: boolean; lookbackDays?: number; max?: number; now?: () => Date },
): Promise<InboxReport> {
  // Mail from the account itself or from its Send As address is ours, never a reply.
  const own = [client.sender, client.account];
  const max = opts.max ?? 200;
  const report: InboxReport = { checked: 0, items: [], unreadableThreads: 0 };
  let pageToken: string | undefined;
  do {
    const list = await client.listMessages({ q: `newer_than:${opts.lookbackDays ?? 7}d -from:me -in:chats`, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
    for (const { id } of list.messages ?? []) {
      if (report.checked >= max) break;
      report.checked++;
      const m = await client.getMessage(id, "full");
      const c = classifyInbound(m, own);
      // When Gmail received it (internalDate, epoch ms). Null when Gmail didn't say.
      const candidateAt = m.internalDate ? new Date(Number(m.internalDate)) : null;
      const receivedAt = candidateAt && Number.isFinite(candidateAt.getTime()) ? candidateAt : null;
      const at = receivedAt ?? (opts.now?.() ?? new Date());
      const item: InboxItem = { gmailId: id, kind: c.kind, from: c.from, subject: (headerOf(m, "Subject") ?? "").slice(0, 200), outreachId: null, result: "ignored" };
      report.items.push(item);
      if (c.kind === "own" || c.kind === "auto_reply" || c.kind === "delay") continue;

      // One thread Gmail won't return affects only its message; the run goes on.
      const threadMessageIds = await otherThreadMessages(client, m);
      if (threadMessageIds === null) report.unreadableThreads = (report.unreadableThreads ?? 0) + 1;

      if (c.kind === "unsubscribe") {
        // Its candidates can't all be known: no opt-out is inferred from partial evidence.
        if (threadMessageIds === null) {
          item.result = "unresolved";
          item.attribution = unreadableThread();
          continue;
        }
        // Gmail reads remain outside the gate; this operation rechecks all DB candidates under it.
        const result = await ingestEmailedUnsubscribe(db, { mailboxAccount: client.account, gmailMessageId: m.id,
          senderEmail: unsubscribeSender(m), receivedAt, markerOutreachIds: unsubscribeMarkers(m),
          threadMessageIds }, opts.apply, at);
        item.result = result.result;
        item.outreachId = result.outreachId;
        continue;
      }

      const evidence = await inboxEvidence(db, client, m, c.kind === "reply" ? "reply" : "bounce", receivedAt, threadMessageIds);
      const attribution = await resolveInboxAttribution(db, evidence);
      const { identity, ...safeAttribution } = attribution;
      item.attribution = safeAttribution;
      if (attribution.status !== "matched") {
        item.result = attribution.status;
        continue;
      }
      evidence.selectedIdentity = identity;
      const o = { id: attribution.outreachId!, providerMessageId: identity!.providerMessageId };
      item.outreachId = o.id;
      if (c.kind === "bounce_unknown") {
        item.result = "needs a person";
        continue;
      }
      if (!opts.apply) {
        item.result = "would record";
        continue;
      }
      if (c.kind === "bounce") {
        const r = await applyProviderEvent(db, {
          provider: "gmail",
          type: "bounced",
          providerEventId: `gmail:${id}`,
          providerMessageId: o.providerMessageId,
          outreachId: o.id,
          reason: c.reason,
          permanent: true,
          at,
          inboxEvidence: evidence,
        });
        item.result = r.result;
        item.outreachId = r.outreachId;
        if (r.attribution) item.attribution = r.attribution;
      } else {
        const r = await recordInboundReply(db, { fromEmail: c.from, outreachId: o.id, mailboxAccount: client.account, gmailMessageId: m.id, summary: m.snippet?.slice(0, 500) ?? null, at, inboxEvidence: evidence });
        item.result = r.result;
        item.outreachId = r.outreachId;
        if ("attribution" in r && r.attribution) item.attribution = r.attribution;
      }
    }
    pageToken = list.nextPageToken;
  } while (pageToken && report.checked < max);
  return report;
}
