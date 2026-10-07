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
  /** The public site's base URL, for the links built here: referral links and invitation links. */
  publicSiteUrl: string;
  secureCookies: boolean;
  /**
   * Whether the synthetic "fixture" discovery provider is offered. Off in
   * production unless ENABLE_FIXTURE_DISCOVERY=1, so fake businesses can't
   * end up in the real database by accident.
   */
  enableFixtureDiscovery: boolean;
  /**
   * Who outreach is signed by. A name, email, and postal address are all
   * required before anything can be sent (the address by law).
   */
  outreachSender: { name: string | null; email: string | null; postalAddress: string | null };
  /**
   * Deployment-level arm for sending (OUTREACH_SENDING_ENABLED=1). Sending
   * also needs the admin's global switch on and a configured provider.
   */
  outreachSendingArmed: boolean;
  /**
   * Arm for the automatic research worker (RESEARCH_AUTORUN_ENABLED=1):
   * without it `discovery:research --auto` exits at once.
   */
  researchAutorunEnabled: boolean;
  /** This backend's public base URL, for one-click unsubscribe links. */
  publicApiUrl: string | null;
  /** New outreach sends per rolling 24 hours (OUTREACH_DAILY_LIMIT, 1-500; default 20). */
  outreachDailyLimit: number;
  /** The outreach email provider (OUTREACH_PROVIDER). Null: sending disabled. */
  outreachProvider: string | null;
  /**
   * Google OAuth for the Gmail provider. Secrets: never logged or rendered.
   * The authorized mailbox is outreachSender.email.
   */
  gmailOAuth: {
    clientId: string | null;
    clientSecret: string | null;
    /** GMAIL_TOKEN_ENCRYPTION_KEY: 32 random bytes, base64. */
    tokenKey: string | null;
    /** GMAIL_REFRESH_TOKEN_SEALED: the encrypted refresh token from the admin's authorization. */
    sealedRefreshToken: string | null;
  };
  /**
   * The AI shadow layer (src/ai). Shadow only: decisions are recorded for
   * evaluation and never acted on. The API key is a secret: never logged or
   * rendered.
   */
  ai: {
    /** AI_PROVIDER: "anthropic", or null (no AI provider). */
    provider: string | null;
    apiKey: string | null;
    /** AI_MODEL (default claude-opus-5-5). */
    model: string;
    /** Arm for `ai:shadow` (AI_SHADOW_ENABLED=1): without it the job exits at once. */
    shadowEnabled: boolean;
    /** Provider calls per `ai:shadow` run (AI_SHADOW_BATCH_LIMIT, 1-25; default 5). */
    shadowBatchLimit: number;
    /** Estimated spend allowed per rolling 24 hours, in US dollars (AI_SHADOW_DAILY_BUDGET; default 0: nothing runs). */
    shadowDailyBudgetUsd: number;
  };
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

  const secureCookies = env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT);

  return {
    port: Number.parseInt(env.PORT ?? "8080", 10),
    host: env.HOST?.trim() || "::",
    databaseUrl,
    allowedOrigins,
    adminSecret,
    trustProxyHops: Number.isFinite(hops) && hops >= 0 ? hops : 1,
    publicSiteUrl: (env.PUBLIC_SITE_URL?.trim() || "https://reclaimbay.com").replace(/\/+$/, ""),
    secureCookies,
    enableFixtureDiscovery: env.ENABLE_FIXTURE_DISCOVERY === "1" || !secureCookies,
    outreachSender: {
      name: env.OUTREACH_SENDER_NAME?.trim().slice(0, 120) || null,
      email: env.OUTREACH_SENDER_EMAIL?.trim().toLowerCase().slice(0, 254) || null,
      postalAddress: env.OUTREACH_POSTAL_ADDRESS?.trim().slice(0, 300) || null,
    },
    outreachSendingArmed: env.OUTREACH_SENDING_ENABLED === "1",
    researchAutorunEnabled: env.RESEARCH_AUTORUN_ENABLED === "1",
    publicApiUrl: env.PUBLIC_API_URL?.trim().replace(/\/+$/, "") || null,
    outreachDailyLimit: Math.min(500, Math.max(1, Number.parseInt(env.OUTREACH_DAILY_LIMIT ?? "20", 10) || 20)),
    outreachProvider: env.OUTREACH_PROVIDER?.trim() || null,
    gmailOAuth: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID?.trim() || null,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || null,
      tokenKey: env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim() || null,
      sealedRefreshToken: env.GMAIL_REFRESH_TOKEN_SEALED?.trim() || null,
    },
    ai: {
      provider: env.AI_PROVIDER?.trim().toLowerCase() || null,
      apiKey: env.AI_API_KEY?.trim() || null,
      model: env.AI_MODEL?.trim() || "claude-opus-5-5",
      shadowEnabled: env.AI_SHADOW_ENABLED === "1",
      shadowBatchLimit: Math.min(25, Math.max(1, Number.parseInt(env.AI_SHADOW_BATCH_LIMIT ?? "5", 10) || 5)),
      shadowDailyBudgetUsd: budget(env.AI_SHADOW_DAILY_BUDGET),
    },
  };
}

/** A non-negative dollar amount, at most $100 a day; anything else is 0 (nothing runs). */
function budget(raw: string | undefined): number {
  const n = Number(raw?.trim() ?? "");
  return Number.isFinite(n) && n > 0 ? Math.min(100, n) : 0;
}
