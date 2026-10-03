/*
 * The local development server: the same app as production (server.ts),
 * started only after the local-only checks (localDev.ts), listening on this
 * computer only.
 *
 *   npm run dev            (backend/)     or     npm run dev:admin   (repo root)
 *
 * Production never runs this; it starts dist/server.js with `npm start`.
 */
import { localDevDefaults, requireLocalDev } from "../localDev.js";

requireLocalDev(process.env, "The local development server");
Object.assign(process.env, localDevDefaults(process.env));

await import("../server.js");

const port = process.env.PORT?.trim() || "8080";
console.log(`\nReclaimBay admin (local): http://localhost:${port}/admin  ·  sign in with ADMIN_SECRET from backend/.env  ·  Ctrl+C stops it\n`);
