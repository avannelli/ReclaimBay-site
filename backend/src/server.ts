import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";

const config = loadConfig();
const db = createDb(config.databaseUrl);
const app = await buildApp(config, db);

if (config.allowedOrigins.length === 0) {
  app.log.warn("ALLOWED_ORIGIN is empty: browsers will be refused by CORS");
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    await db.$disconnect();
  } finally {
    process.exit(0);
  }
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error({ err }, "failed to start");
  await db.$disconnect();
  process.exit(1);
}
