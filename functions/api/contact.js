/*
 * POST /api/contact: the "Talk to ReclaimBay" form, delivered by Resend to the
 * public contact inbox. A Cloudflare Pages Function deployed with the static
 * site; independent of the Railway backend, Gmail, outreach, and any database.
 *
 * It accepts exactly the form's fields (see lib/contactForm.ts) and refuses
 * anything else, so nothing from a report can be sent through it. Every check
 * is repeated here; the client's checks are a convenience only.
 *
 * Needs, in the Pages project: the RESEND_API_KEY secret and a KV namespace
 * bound as CONTACT_RATE_LIMIT. Without either it answers 503 and sends nothing.
 */

const RECIPIENT = "hello@reclaimbay.com";
const FROM = "ReclaimBay Website <contact@reclaimbay.com>";
const WINDOW_SECONDS = 600;
const MAX_REQUESTS = 5;
const MAX_BYTES = 12000;
const LIMITS = { name: 100, shopName: 120, email: 254, shopSoftware: 120, message: 5000 };
const HONEYPOT = "website";
const ALLOWED = new Set([...Object.keys(LIMITS), HONEYPOT]);
const LINE_BREAK_OR_CONTROL = /[\r\n\x00-\x1f\x7f]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (status, data) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

/** The cleaned fields, or null when anything is missing, malformed, too long, or not one of ours. */
export function cleanContact(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => !ALLOWED.has(key))) return null;
  const out = {};
  for (const [key, limit] of Object.entries(LIMITS)) {
    const value = input[key] ?? "";
    if (typeof value !== "string") return null;
    const clean = value.trim();
    if (clean.length > limit) return null;
    if (key === "message" ? /\x00/.test(clean) : LINE_BREAK_OR_CONTROL.test(clean)) return null;
    out[key] = clean;
  }
  if (!out.email || !EMAIL.test(out.email)) return null;
  if ((out.message.match(/https?:\/\//gi) || []).length > 3) return null;
  return out;
}

/** The email to the contact inbox: only what the visitor supplied, labelled. */
export function contactEmail(c) {
  const who = c.shopName || c.name || c.email;
  const lines = [
    "New message from the ReclaimBay website.",
    "",
    ...(c.name ? [`Name: ${c.name}`] : []),
    ...(c.shopName ? [`Shop name: ${c.shopName}`] : []),
    `Email: ${c.email}`,
    ...(c.shopSoftware ? [`Shop software: ${c.shopSoftware}`] : []),
    "",
    c.message ? `Message:\n\n${c.message}` : "(No message.)",
  ];
  return { from: FROM, to: [RECIPIENT], reply_to: c.email, subject: `ReclaimBay contact — ${who}`, text: lines.join("\n") };
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, { error: "Forbidden" });
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json(415, { error: "Expected JSON" });
  if (Number(request.headers.get("Content-Length")) > MAX_BYTES) return json(413, { error: "Message too large" });
  if (!env.RESEND_API_KEY || !env.CONTACT_RATE_LIMIT) return json(503, { error: "Contact form unavailable" });

  let input;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BYTES) return json(413, { error: "Message too large" });
    input = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid request" });
  }
  // A filled honeypot is a bot: answer like a success, send nothing.
  if (input && typeof input === "object" && typeof input[HONEYPOT] === "string" && input[HONEYPOT].trim()) return json(200, { ok: true });
  const contact = cleanContact(input);
  if (!contact) return json(400, { error: "Please check your email and message" });

  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return json(503, { error: "Contact form unavailable" });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const key = `contact:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  try {
    const count = Number(await env.CONTACT_RATE_LIMIT.get(key)) || 0;
    if (count >= MAX_REQUESTS) return json(429, { error: "Please wait before sending another message" });
    await env.CONTACT_RATE_LIMIT.put(key, String(count + 1), { expirationTtl: WINDOW_SECONDS });
  } catch {
    return json(503, { error: "Contact form unavailable" });
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(contactEmail(contact)),
    });
    if (!response.ok) return json(502, { error: "Message could not be sent" });
    return json(200, { ok: true });
  } catch {
    return json(502, { error: "Message could not be sent" });
  }
}
