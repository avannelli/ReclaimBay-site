import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ADMIN_DAILY_LIMIT, MIN_SEND_INTERVAL_MS, parseDailyLimit } from "../../src/outreach/policy.js";

test("admin daily ceiling defaults to 25 and accepts only bounded whole numbers", () => {
  assert.equal(DEFAULT_ADMIN_DAILY_LIMIT, 25);
  assert.equal(MIN_SEND_INTERVAL_MS, 60_000);
  for (const v of [1, 25, 500, "25"]) assert.equal(parseDailyLimit(v), Number(v));
  for (const v of [undefined, null, {}, "", "25x", "2.5", 0, -1, 501, Infinity, "1e2", " 25 "]) assert.throws(() => parseDailyLimit(v));
});
