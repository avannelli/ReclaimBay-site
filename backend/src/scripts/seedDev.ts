/*
 * Seeds a few example prospects into a LOCAL development database.
 * Refuses to run in production or on Railway. Never runs automatically.
 *
 *   npm run seed:dev
 */
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createProspect, referralUrl } from "../prospects.js";

const DEV_PROSPECTS = [
  { businessName: "Smith Auto", website: "https://example.com/smith-auto" },
  { businessName: "Ace Automotive", website: "https://example.com/ace-automotive" },
  { businessName: "Valley Motors", website: null },
];

if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) {
  console.error("seed:dev refuses to run in production / on Railway.");
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  for (const input of DEV_PROSPECTS) {
    const existing = await db.prospect.findFirst({ where: { businessName: input.businessName } });
    const prospect = existing ?? (await createProspect(db, input));
    const note = existing ? "exists " : "created";
    console.log(`${note}  ${prospect.businessName?.padEnd(16)} ${referralUrl(config.publicSiteUrl, prospect.referralCode)}`);
  }
} finally {
  await db.$disconnect();
}
