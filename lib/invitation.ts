/*
 * Invitation links: https://reclaimbay.com/invite#<token>.
 *
 * The token travels in the URL fragment, which browsers never send to a
 * server, so it stays out of request logs and Referer headers. This module
 * reads it, asks the backend whether it's active (which records the open and
 * links this browser's anonymous analytics session to it), and returns only
 * what the page shows. The token is never rendered, stored, or sent anywhere
 * else.
 */
import { analyticsSessionId } from "./analytics";

// The same backend as analytics. `next dev` falls back to the local backend.
const API_URL =
  (process.env.NEXT_PUBLIC_ANALYTICS_API_URL ?? "").trim().replace(/\/+$/, "") ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8080" : "");
const TIMEOUT_MS = 8000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_NAME = 120;

export type InvitationState =
  | { kind: "loading" }
  /** No usable token, or one the backend says isn't active: the page says the same thing for all of them. */
  | { kind: "unavailable" }
  /** The backend couldn't be reached or answered unexpectedly: never treated as a valid invitation. */
  | { kind: "error" }
  | { kind: "active"; businessName: string | null };

/** The token from a location hash, or null when there isn't a well-formed one. */
export function tokenFromHash(hash: string): string | null {
  const token = hash.replace(/^#/, "");
  return TOKEN_RE.test(token) ? token : null;
}

/** Only the two shapes the backend sends are believed; anything else is an error. */
export function readAnswer(body: unknown): InvitationState {
  if (!body || typeof body !== "object") return { kind: "error" };
  const { active, businessName } = body as Record<string, unknown>;
  if (active === false) return { kind: "unavailable" };
  if (active !== true) return { kind: "error" };
  const name = typeof businessName === "string" ? businessName.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
  return { kind: "active", businessName: name || null };
}

export async function openInvitation(token: string): Promise<InvitationState> {
  if (!API_URL) return { kind: "error" };
  try {
    const sessionId = analyticsSessionId();
    const res = await fetch(`${API_URL}/api/invitations/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionId ? { token, sessionId } : { token }),
      credentials: "omit",
      cache: "no-store",
      signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    });
    if (!res.ok) return { kind: "error" };
    return readAnswer(await res.json());
  } catch {
    return { kind: "error" };
  }
}
