/*
 * Recomputes cached prospect scores with the current scoring.ts.
 * Safe to run any time: it only rewrites score, scoreVersion, and scoredAt.
 *
 *   npm run prospects:rescore           # rows scored by an older version
 *   npm run prospects:rescore -- --all  # every row
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { rescoreProspects } from "../prospects.js";
import { SCORING_VERSION } from "../scoring.js";

const { values } = parseArgs({ options: { all: { type: "boolean", default: false } } });

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const updated = await rescoreProspects(db, { all: values.all });
  console.log(`Rescored ${updated} prospect(s) with scoring ${SCORING_VERSION}.`);
} finally {
  await db.$disconnect();
}
