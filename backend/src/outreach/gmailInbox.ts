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
 *   "unsubscribe" email          -> unsubscribeOutreach (the List-Unsubscribe mailto)
 *   anything else from them      -> recordInboundReply, unclassified
 *
 * Mail is matched to a message by Gmail thread (Gmail threads replies and
 * bounces with what they answer), then by the X-ReclaimBay-Outreach marker
 * quoted in a bounce, then by sender address. Nothing is guessed: unmatched
 * mail is only reported.
 *
 * It keeps no cursor: each run looks back a few days, and every write is
 * idempotent (a bounce carries Gmail's message id as its event id; a second
 * reply to a replied message is a duplicate), so re-reading is harmless.
 * Gmail push (Pub/Sub watch) could trigger a run sooner; it isn't needed at
 * this volume.
 */
import type { Db } from "../db.js";
import { OUTREACH_HEADER, headerOf, type GmailClient, type GmailMessage, type GmailPart } from "./gmail.js";
import { ATTEMPTED_STATUSES, normalizeEmail } from "./lifecycle.js";
import { applyProviderEvent, recordInboundReply, unsubscribeOutreach } from "./service.js";

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
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** What an inbound message is. Pure: headers and text only. */
export function classifyInbound(m: GmailMessage, mailbox: string): Classified {
  const fromHeader = headerOf(m, "From") ?? "";
  const from = address(fromHeader);
  const subject = headerOf(m, "Subject") ?? "";
  const contentType = headerOf(m, "Content-Type") ?? m.payload?.mimeType ?? "";
  const text = messageText(m.payload);
  const marker = new RegExp(`${OUTREACH_HEADER}:\\s*(${UUID.source})`, "i").exec(text)?.[1]?.toLowerCase() ?? null;
  const base = { from, markerOutreachId: marker };
  if (from === normalizeEmail(mailbox)) return { ...base, kind: "own", reason: null };

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
}

export interface InboxReport {
  checked: number;
  items: InboxItem[];
}

/** Our sent message this mail answers: same Gmail thread, or the quoted marker. */
async function matchByThread(db: Db, client: GmailClient, m: GmailMessage, marker: string | null) {
  const thread = await client.getThread(m.threadId);
  const ids = (thread.messages ?? []).map((x) => x.id).filter((id) => id !== m.id);
  const byThread = ids.length
    ? await db.outreach.findFirst({ where: { providerMessageId: { in: ids } }, orderBy: { sentAt: "desc" } })
    : null;
  if (byThread) return byThread;
  return marker ? db.outreach.findUnique({ where: { id: marker } }) : null;
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
  const mailbox = client.mailbox;
  const max = opts.max ?? 200;
  const report: InboxReport = { checked: 0, items: [] };
  let pageToken: string | undefined;
  do {
    const list = await client.listMessages({ q: `newer_than:${opts.lookbackDays ?? 7}d -from:me -in:chats`, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
    for (const { id } of list.messages ?? []) {
      if (report.checked >= max) break;
      report.checked++;
      const m = await client.getMessage(id, "full");
      const c = classifyInbound(m, mailbox);
      const at = m.internalDate ? new Date(Number(m.internalDate)) : (opts.now?.() ?? new Date());
      const item: InboxItem = { gmailId: id, kind: c.kind, from: c.from, subject: (headerOf(m, "Subject") ?? "").slice(0, 200), outreachId: null, result: "ignored" };
      report.items.push(item);
      if (c.kind === "own" || c.kind === "auto_reply" || c.kind === "delay") continue;

      let o = await matchByThread(db, client, m, c.markerOutreachId);
      // An emailed unsubscribe or a reply from a new thread: the latest message sent to that address.
      if (!o && (c.kind === "unsubscribe" || c.kind === "reply")) {
        o = await db.outreach.findFirst({
          where: { recipientEmail: { equals: c.from, mode: "insensitive" }, status: { in: [...ATTEMPTED_STATUSES] } },
          orderBy: { sentAt: "desc" },
        });
      }
      item.outreachId = o?.id ?? null;
      if (!o) {
        item.result = "unmatched";
        continue;
      }
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
        });
        item.result = r.result;
      } else if (c.kind === "unsubscribe") {
        item.result = (await unsubscribeOutreach(db, o.id, "by an emailed unsubscribe request", at)).result;
      } else {
        const r = await recordInboundReply(db, { fromEmail: c.from, inReplyToProviderMessageId: o.providerMessageId, summary: m.snippet?.slice(0, 500) ?? null, at });
        item.result = r.result;
      }
    }
    pageToken = list.nextPageToken;
  } while (pageToken && report.checked < max);
  return report;
}
