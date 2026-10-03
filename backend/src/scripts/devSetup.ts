/*
 * One-time local setup: creates the git-ignored backend/.env from
 * .env.example, with a freshly generated ADMIN_SECRET (the local admin
 * password) and a local database URL. Never overwrites an existing .env.
 *
 *   npm run dev:admin:setup
 *   npm run dev:admin:setup -- --database-url=postgresql://USER:PASSWORD@localhost:5432/reclaimbay_dev
 *
 * The secret is written to the file only, never printed. Nothing here is
 * used in production, whose variables live in Railway.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDevErrors } from "../localDev.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = path.join(backendRoot, ".env");
const PLACEHOLDER_DB = "postgresql://USER:PASSWORD@localhost:5432/reclaimbay_dev";

if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) {
  console.error("dev:setup is for local development only.");
  process.exit(1);
}
if (existsSync(target)) {
  console.log("backend/.env already exists; it was left unchanged.");
  process.exit(0);
}

const given = process.argv.find((a) => a.startsWith("--database-url="))?.slice("--database-url=".length).trim();
const databaseUrl = given || PLACEHOLDER_DB;
const dbErrors = given ? localDevErrors({ DATABASE_URL: given }) : [];
if (dbErrors.length) {
  console.error(dbErrors.join("\n"));
  process.exit(1);
}

const template = readFileSync(path.join(backendRoot, ".env.example"), "utf8");
const env = template
  .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${databaseUrl}`)
  .replace(/^ADMIN_SECRET=.*$/m, `ADMIN_SECRET=${randomBytes(32).toString("base64url")}`);
writeFileSync(target, `${env.trimEnd()}\n\n# Local development: this computer only, nothing in front of it.\nHOST=localhost\nTRUST_PROXY_HOPS=0\n`, { flag: "wx" });

console.log("Created backend/.env with a new local ADMIN_SECRET (your admin password; read it from that file).");
if (!given) console.log(`Next: set DATABASE_URL in backend/.env to your local Postgres (it is ${PLACEHOLDER_DB}).`);
console.log("Then: npm run dev:admin:reset (creates the local database), npm run dev:admin:seed, npm run dev:admin.");
