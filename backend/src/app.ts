import Fastify from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { adminRoutes } from "./routes/admin.js";
import { brandIconRoutes } from "./routes/brandIcons.js";
import { eventRoutes } from "./routes/events.js";
import { senderFromConfig, type OutreachSender } from "./outreach/sender.js";
import type { ProcessDeps } from "./research/service.js";
import { gmailOAuthRoutes } from "./routes/gmailOAuth.js";
import { unsubscribeRoutes } from "./routes/unsubscribe.js";

/** Optional dependencies, injected by tests (production uses the defaults). */
export interface AppDeps {
  /** How automated research reaches the web (tests pass a fixture fetcher). */
  research?: ProcessDeps;
  /** The outreach email sender (tests pass a mock). Default: from the environment. */
  outreachSender?: OutreachSender;
  /** Carries every Google call (OAuth and Gmail); tests pass a fake. Default: the global fetch. */
  googleFetch?: typeof fetch;
}

const HEALTH_DB_TIMEOUT_MS = 2_000;

export async function buildApp(config: Config, db: Db, logger: boolean = true, deps: AppDeps = {}) {
  const hops = config.trustProxyHops;
  const app = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    // Trust exactly the proxy hops in front of us (Railway's edge), so rate
    // limits key on the real client address and can't be spoofed via headers.
    trustProxy: hops > 0 ? (_addr: string, hop: number) => hop < hops : false,
    bodyLimit: 16_384,
    ajv: {
      // Reject unknown fields and wrong types instead of silently fixing them.
      customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false },
    },
  });

  app.get("/health", async (_req, reply) => {
    let database = false;
    try {
      await Promise.race([
        db.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), HEALTH_DB_TIMEOUT_MS)),
      ]);
      database = true;
    } catch (err) {
      app.log.error({ err }, "health check: database unreachable");
    }
    return reply.code(database ? 200 : 503).send({ ok: database, database });
  });

  await app.register(eventRoutes, { config, db });
  const googleFetch = deps.googleFetch ?? globalThis.fetch;
  const sender = deps.outreachSender ?? senderFromConfig(config, googleFetch);
  await app.register(brandIconRoutes);
  await app.register(adminRoutes, { config, db, research: deps.research, sender, googleFetch });
  await app.register(unsubscribeRoutes, { db });
  await app.register(gmailOAuthRoutes, { config, fetchImpl: googleFetch });

  return app;
}
