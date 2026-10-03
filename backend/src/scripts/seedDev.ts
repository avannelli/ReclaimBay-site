/*
 * Seeds a few example prospects into a LOCAL development database.
 * Refuses to run in production, on Railway, or against a database that isn't
 * on this computer (localDev.ts). Never runs automatically. Repeating it is
 * harmless: existing examples are kept.
 *
 *   npm run dev:admin:seed   (repo root)   or   npm run seed:dev   (backend/, after a build)
 */
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { requireLocalDev } from "../localDev.js";
import { addEvidence, createProspect, referralUrl } from "../prospects.js";

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
  // Qualified, with a published email and evidence: eligible for an outreach draft.
  {
    businessName: "Harbor Lane Auto",
    website: "https://example.com/harbor-lane-auto",
    city: "Ventura",
    state: "CA",
    phone: "(555) 010-0200",
    phoneSourceUrl: "https://example.com/harbor-lane-auto/contact",
    email: "service@example.com",
    emailSourceUrl: "https://example.com/harbor-lane-auto/contact",
    signal_independent_shop: "yes",
    signal_general_repair_services: "yes",
  },
];

/** Evidence for the example that should qualify, so its criteria are confirmed. */
const DEV_EVIDENCE: Record<string, { signalKey: string; sourceUrl: string; excerpt: string }[]> = {
  "Harbor Lane Auto": [
    { signalKey: "independent_shop", sourceUrl: "https://example.com/harbor-lane-auto/about", excerpt: "Family owned and operated since 1998." },
    { signalKey: "general_repair_services", sourceUrl: "https://example.com/harbor-lane-auto/services", excerpt: "Brakes, engine diagnostics, and general repair." },
  ],
};

requireLocalDev(process.env, "seed:dev");

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  for (const input of DEV_PROSPECTS) {
    const existing = await db.prospect.findFirst({ where: { businessName: input.businessName } });
    const prospect = existing ?? (await createProspect(db, input));
    if (!existing) for (const e of DEV_EVIDENCE[input.businessName] ?? []) await addEvidence(db, prospect.id, e);
    const note = existing ? "exists " : "created";
    console.log(`${note}  ${prospect.businessName?.padEnd(16)} ${referralUrl(config.publicSiteUrl, prospect.referralCode)}`);
  }
} finally {
  await db.$disconnect();
}
