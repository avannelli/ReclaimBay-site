/*
 * Environment configuration. Read once at startup; nothing here is ever
 * echoed back in a response.
 */

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** Exact origins allowed to POST analytics (ALLOWED_ORIGIN, comma-separated). */
  allowedOrigins: string[];
  /** Null disables the admin area entirely. */
  adminSecret: string | null;
  /** Number of reverse-proxy hops in front of the app (Railway: 1). */
  trustProxyHops: number;
  /** Base URL used to build referral links shown in the admin. */
  publicSiteUrl: string;
  secureCookies: boolean;
}

/** Shorter admin secrets are refused so a weak value can't be deployed by accident. */
export const MIN_ADMIN_SECRET_LENGTH = 24;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const allowedOrigins = (env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const secret = env.ADMIN_SECRET?.trim() ?? "";
  const adminSecret = secret.length >= MIN_ADMIN_SECRET_LENGTH ? secret : null;

  const hops = Number.parseInt(env.TRUST_PROXY_HOPS ?? "1", 10);

  return {
    port: Number.parseInt(env.PORT ?? "8080", 10),
    host: env.HOST?.trim() || "::",
    databaseUrl,
    allowedOrigins,
    adminSecret,
    trustProxyHops: Number.isFinite(hops) && hops >= 0 ? hops : 1,
    publicSiteUrl: (env.PUBLIC_SITE_URL?.trim() || "https://reclaimbay.com").replace(/\/+$/, ""),
    secureCookies: env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT),
  };
}
