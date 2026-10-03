/*
 * Local development only: the checks behind `npm run dev:admin` and the other
 * dev:* scripts. Production never imports this; it starts with `npm start`
 * (dist/server.js) and its own environment.
 *
 *   - refuses production and Railway;
 *   - refuses a DATABASE_URL that isn't on this computer, so a local run can
 *     never touch the production database;
 *   - listens on this computer only, with no proxy trusted in front of it.
 *
 * Signing in to the local admin is the same as in production: ADMIN_SECRET,
 * here a value generated into the git-ignored backend/.env.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Why this environment must not run the local development tools (empty when it may). */
export function localDevErrors(env: NodeJS.ProcessEnv): string[] {
  const errors: string[] = [];
  if (env.NODE_ENV === "production") errors.push("NODE_ENV is production. The dev:* scripts are for local development only.");
  if (env.RAILWAY_ENVIRONMENT) errors.push("This is a Railway environment. The dev:* scripts are for local development only.");
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    errors.push("DATABASE_URL isn't set. Run `npm run dev:admin:setup`, then point DATABASE_URL in backend/.env at a local database.");
  } else {
    let host: string | null = null;
    try {
      host = new URL(url).hostname;
    } catch {
      errors.push("DATABASE_URL isn't a valid connection URL.");
    }
    if (host !== null && !LOCAL_HOSTS.has(host)) {
      errors.push(`DATABASE_URL points at ${host}, not this computer. Local development only ever uses a local database, never production's.`);
    }
  }
  return errors;
}

/** Things worth knowing that don't stop a local run. */
export function localDevWarnings(env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  const url = env.DATABASE_URL?.trim();
  if (url && url === env.TEST_DATABASE_URL?.trim()) {
    warnings.push(
      "DATABASE_URL is the integration-test database. The tests empty it, and refuse to run while backend/.env points at it. Use a separate local database (e.g. reclaimbay_dev) on the same server.",
    );
  }
  if ((env.ADMIN_SECRET?.trim().length ?? 0) < 24) {
    warnings.push("ADMIN_SECRET is missing or shorter than 24 characters, so /admin is disabled. Run `npm run dev:admin:setup` to generate one.");
  }
  return warnings;
}

/** Safe local defaults, applied only where backend/.env doesn't say otherwise. */
export function localDevDefaults(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    // This computer only (IPv4 and IPv6), never the network.
    HOST: env.HOST?.trim() || "localhost",
    // Nothing sits in front of a local server, so no forwarded header is trusted.
    TRUST_PROXY_HOPS: env.TRUST_PROXY_HOPS?.trim() || "0",
  };
}

/** Exits with the reasons when this isn't a safe local environment; prints warnings otherwise. */
export function requireLocalDev(env: NodeJS.ProcessEnv = process.env, what = "This script") {
  const errors = localDevErrors(env);
  if (errors.length) {
    console.error(`${what} refuses to run:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
  for (const w of localDevWarnings(env)) console.warn(`Note: ${w}`);
}
