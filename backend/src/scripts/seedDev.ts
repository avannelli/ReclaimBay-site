/*
 * Seeds a few example prospects into a LOCAL development database.
 * Refuses to run in production or on Railway. Never runs automatically.
 *
 *   npm run seed:dev
 */
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createProspect, referralUrl } from "../prospects.js";

// example.com addresses only: these are not real shops.
const DEV_PROSPECTS = [
  {
    businessName: "Smith Auto",
    website: "https://example.com/smith-auto",
    city: "Springfield",
    state: "IL",
    phone: "(555) 010-0100",
    phoneSourceUrl: "https://example.com/smith-auto/contact",
    signal_independent_shop: "yes",
    signal_general_repair_services: "yes",
    signal_digital_inspections: "yes",
  },
  {
    businessName: "Ace Automotive",
    website: "https://example.com/ace-automotive",
    city: "Riverton",
    state: "WY",
    signal_general_repair_services: "yes",
    signal_website_not_https: "no",
  },
  { businessName: "Valley Motors", city: "Fresno", state: "CA", signal_has_website: "no" },
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
