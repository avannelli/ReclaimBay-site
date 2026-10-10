/*
 * The contact form's client side: which fields exist, how they're checked,
 * and the one request that sends them (to the Cloudflare Pages Function in
 * functions/api/contact.js, which checks everything again).
 *
 * The request body is built here from the form's own fields and nothing
 * else: no report, page, or analytics state can reach it.
 */

export const CONTACT_ENDPOINT = "/api/contact";

export const CONTACT_FIELDS = ["name", "shopName", "email", "shopSoftware", "message"] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];
export type ContactDraft = Record<ContactField, string>;

/** Longest accepted value per field; the function enforces the same limits. */
export const CONTACT_LIMITS: Record<ContactField, number> = { name: 100, shopName: 120, email: 254, shopSoftware: 120, message: 5000 };

/** The hidden field people never see and spam bots fill in. */
export const HONEYPOT_FIELD = "website";

export const emptyDraft = (): ContactDraft => ({ name: "", shopName: "", email: "", shopSoftware: "", message: "" });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why the email can't be sent as entered, or null when it's fine. */
export function emailProblem(email: string): string | null {
  const value = email.trim();
  if (!value) return "Enter your email address.";
  if (value.length > CONTACT_LIMITS.email || !EMAIL.test(value)) return "Enter a valid email address.";
  return null;
}

/** Exactly the form's fields, trimmed, plus the honeypot. Nothing else is ever added. */
export function contactPayload(draft: ContactDraft, honeypot: string) {
  return {
    name: draft.name.trim(),
    shopName: draft.shopName.trim(),
    email: draft.email.trim(),
    shopSoftware: draft.shopSoftware.trim(),
    message: draft.message.trim(),
    [HONEYPOT_FIELD]: honeypot.trim(),
  };
}

/** Sends the message. Any failure (network, timeout, or a refusal) is just "failed": details stay server-side. */
export async function sendContact(payload: ReturnType<typeof contactPayload>, fetchImpl: typeof fetch = globalThis.fetch): Promise<"sent" | "failed"> {
  try {
    const res = await fetchImpl(CONTACT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin",
      signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15_000) : undefined,
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
