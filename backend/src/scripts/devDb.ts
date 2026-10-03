/*
 * The local development database, after the local-only checks (localDev.ts):
 *
 *   npm run dev:db -- migrate   apply committed migrations (creates nothing else)
 *   npm run dev:db -- reset     drop and recreate the local database, then apply
 *                               every migration: all local data is deleted
 *
 * Refuses production, Railway, and any database that isn't on this computer.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireLocalDev } from "../localDev.js";

const action = process.argv[2];
if (action !== "migrate" && action !== "reset") {
  console.error("Usage: npm run dev:db -- migrate | reset");
  process.exit(1);
}
requireLocalDev(process.env, `dev:db ${action}`);

// backend/, from src/scripts or dist/scripts.
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const prisma = path.join(backendRoot, "node_modules", "prisma", "build", "index.js");
const args = action === "migrate" ? ["migrate", "deploy"] : ["migrate", "reset", "--force"];
try {
  execFileSync(process.execPath, [prisma, ...args], { cwd: backendRoot, stdio: "inherit" });
} catch {
  if (action === "migrate") {
    console.error("\nMigrations didn't apply. If the local database doesn't exist yet, `npm run dev:admin:reset` creates it (and empties it if it does).");
  }
  process.exit(1);
}
