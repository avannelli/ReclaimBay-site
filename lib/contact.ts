/*
 * The public contact address, and the mailto fallback the contact form
 * (components/ContactDialog.tsx) offers beside it: a fixed subject and a
 * blank template the shop fills in. Everything here is a constant and
 * contactMailto() takes no arguments, so nothing from a report (totals,
 * opportunities, customers, vehicles, categories, the file name) or from an
 * invitation can ever reach the link. Nothing here is sent anywhere; the
 * shop's own mail app sends whatever they choose to write.
 */

/** The public customer contact address (never the outreach sender's). */
export const CONTACT_EMAIL = "hello@reclaimbay.com";

export const CONTACT_SUBJECT = "Talk to ReclaimBay";

export const CONTACT_BODY = [
  "Hi ReclaimBay,",
  "",
  "Shop name:",
  "Shop management system:",
  "Best phone or time to reach me:",
  "What I'd like help with:",
  "",
].join("\n");

/** mailto:hello@reclaimbay.com with the fixed subject and template. Takes no arguments by design. */
export function contactMailto(): string {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}&body=${encodeURIComponent(CONTACT_BODY)}`;
}
