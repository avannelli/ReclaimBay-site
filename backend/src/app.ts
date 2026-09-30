import Fastify from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { adminRoutes } from "./routes/admin.js";
import { eventRoutes } from "./routes/events.js";

const HEALTH_DB_TIMEOUT_MS = 2_000;

export async function buildApp(config: Config, db: Db, logger: boolean = true) {
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
  await app.register(adminRoutes, { config, db });

  return app;
}
