/*
 * Creates one prospect with an opaque referral code and prints its link.
 *
 *   npm run prospect:create -- --name "Smith Auto" --website smithauto.com [--campaign launch-v1]
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { cleanProspectInput, createProspect, referralUrl } from "../prospects.js";
import { CAMPAIGN_PATTERN } from "../validation.js";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    website: { type: "string" },
    campaign: { type: "string" },
  },
});

const cleaned = cleanProspectInput({ businessName: values.name, website: values.website });
if (typeof cleaned === "string") {
  console.error(cleaned);
  process.exit(1);
}
if (values.campaign && !new RegExp(CAMPAIGN_PATTERN).test(values.campaign)) {
  console.error("Campaign must be lowercase letters, digits, '.', '_' or '-' (max 64).");
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const prospect = await createProspect(db, cleaned);
  console.log(`Created ${prospect.businessName ?? "prospect"} (${prospect.id})`);
  console.log(`Referral code: ${prospect.referralCode}`);
  console.log(`Link: ${referralUrl(config.publicSiteUrl, prospect.referralCode, values.campaign)}`);
} finally {
  await db.$disconnect();
}
