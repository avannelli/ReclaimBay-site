/*
 * What must be true before any email can leave. Pure rules; dispatch.ts and
 * the queue step enforce them.
 *
 *   Sender identity   a name, a valid email, and a postal address
 *   Opt-out           the message says how to opt out, and carries a
 *                     one-click List-Unsubscribe link (RFC 8058)
 *   The message       the postal address is in the text that was reviewed,
 *                     and it is signed for the sender it will be sent as
 */
import type { Config } from "../config.js";
import { OPT_OUT_INSTRUCTION } from "./compose.js";
import { isValidEmail } from "./lifecycle.js";

export type ComplianceConfig = Pick<Config, "outreachSender" | "publicApiUrl">;

/** Why the configured sender can't send yet (empty when it can). */
export function senderIdentityErrors(cfg: ComplianceConfig): string[] {
  const s = cfg.outreachSender;
  const errors: string[] = [];
  if (!s.name) errors.push("The sender's name isn't configured (OUTREACH_SENDER_NAME).");
  if (!s.email) errors.push("The sender's email isn't configured (OUTREACH_SENDER_EMAIL).");
  else if (!isValidEmail(s.email)) errors.push(`The sender's email ${s.email} isn't a valid address.`);
  if (!s.postalAddress) errors.push("The sender's postal address isn't configured (OUTREACH_POSTAL_ADDRESS); commercial email must include one.");
  if (!cfg.publicApiUrl) errors.push("The backend's public URL isn't configured (PUBLIC_API_URL), so there is no unsubscribe link.");
  return errors;
}

export interface MessageForCompliance {
  body: string;
  recipientEmail: string;
  senderName: string | null;
  senderEmail: string | null;
  unsubscribeToken: string | null;
}

/** Why this stored message can't be sent as it is (empty when it can). */
export function messageComplianceErrors(m: MessageForCompliance, cfg: ComplianceConfig): string[] {
  const errors: string[] = [];
  const s = cfg.outreachSender;
  if (!isValidEmail(m.recipientEmail)) errors.push(`The recipient ${m.recipientEmail} isn't a valid address.`);
  if (!m.body.includes(OPT_OUT_INSTRUCTION)) errors.push("The message doesn't say how to opt out.");
  if (s.postalAddress && !m.body.includes(s.postalAddress)) {
    errors.push("The message doesn't include the sender's postal address. Discard it and prepare it again.");
  }
  if (s.name && m.senderName !== s.name) errors.push("The message was signed for a different sender name. Discard it and prepare it again.");
  if (s.email && m.senderEmail !== s.email) errors.push("The message was prepared for a different sender email. Discard it and prepare it again.");
  if (!m.unsubscribeToken) errors.push("The message has no unsubscribe link. Discard it and prepare it again.");
  return errors;
}

export const unsubscribeUrl = (publicApiUrl: string, token: string) => `${publicApiUrl}/u/${encodeURIComponent(token)}`;

/** One-click unsubscribe headers (RFC 2369 and RFC 8058). */
export const listUnsubscribeHeaders = (url: string, senderEmail: string): Record<string, string> => ({
  "List-Unsubscribe": `<${url}>, <mailto:${senderEmail}?subject=unsubscribe>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});
