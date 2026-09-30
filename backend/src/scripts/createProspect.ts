/*
 * Creates one prospect with an opaque referral code and prints its link.
 *
 *   npm run prospect:create -- --name "Smith Auto" --website smithauto.com \
 *     [--city Springfield --state IL] [--campaign launch-v1]
 *
 * Signals, contact details, and evidence are recorded in the admin.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { ProspectError, createProspect, referralUrl } from "../prospects.js";
import { CAMPAIGN_PATTERN } from "../validation.js";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    website: { type: "string" },
    city: { type: "string" },
    state: { type: "string" },
    campaign: { type: "string" },
  },
});

if (values.campaign && !new RegExp(CAMPAIGN_PATTERN).test(values.campaign)) {
  console.error("Campaign must be lowercase letters, digits, '.', '_' or '-' (max 64).");
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const prospect = await createProspect(db, {
    businessName: values.name,
    website: values.website,
    city: values.city,
    state: values.state,
  });
  console.log(`Created ${prospect.businessName ?? "prospect"} (${prospect.id})`);
  console.log(`Referral code: ${prospect.referralCode}`);
  console.log(`Link: ${referralUrl(config.publicSiteUrl, prospect.referralCode, values.campaign)}`);
} catch (err) {
  if (!(err instanceof ProspectError)) throw err;
  console.error(err.messages.join("\n"));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
