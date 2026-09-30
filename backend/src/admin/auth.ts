import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/*
 * Stateless admin session: the cookie holds an expiry signed with
 * ADMIN_SECRET, so rotating the secret signs everyone out.
 */

export const ADMIN_COOKIE = "rb_admin";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const sign = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(`reclaimbay-admin:${payload}`).digest("base64url");

/** Constant-time string comparison that doesn't leak length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function issueToken(secret: string, now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS);
  return `${exp}.${sign(secret, exp)}`;
}

export function verifyToken(secret: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [exp, sig, extra] = token.split(".");
  if (!exp || !sig || extra !== undefined || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now) return false;
  return safeEqual(sig, sign(secret, exp));
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=${token}`,
    "Path=/admin",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedCookie(secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=`,
    "Path=/admin",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
