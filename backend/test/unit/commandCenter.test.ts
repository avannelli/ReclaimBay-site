import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { groupByDay } from "../../src/admin/commandCenter.js";
import { providerCheckMemo, rememberedProvider, sendingVerdict } from "../../src/admin/sendingState.js";
import { rateText } from "../../src/admin/ui.js";

const now = new Date("2026-10-05T12:00:00Z");
const input = {
  sw: { enabled: true, at: new Date("2026-10-05T00:00:00Z") }, readiness: [],
  provider: { kind: "live" as const, problem: null }, capacity: { remaining: 1, limit: 1 },
  queued: 1, oldestQueuedAt: new Date("2026-10-05T00:00:00Z"), lastSentAt: null, now,
};
describe("Command Center authoritative presentation", () => {
  test("a live or remembered provider failure blocks an armed sending state", () => {
    for (const provider of [{ kind: "live" as const, problem: "Authorization revoked." }, { kind: "remembered" as const, at: now, problem: "Authorization revoked." }]) {
      const d = sendingVerdict({ ...input, provider });
      assert.equal(d.mode, "blocked"); assert.deepEqual(d.blockers, ["Authorization revoked."]);
      assert.equal(d.stale, false);
    }
  });
  test("OFF remains unmistakable even with provider failures or exhausted capacity", () => {
    const d = sendingVerdict({ ...input, sw: { enabled: false, at: now }, capacity: { remaining: 0, limit: 1 }, provider: { kind: "live", problem: "Authorization revoked." } });
    assert.equal(d.mode, "off"); assert.equal(d.stale, false);
  });
  test("capacity exhaustion pauses and an old waiting queue only warns when live", () => {
    assert.equal(sendingVerdict({ ...input, capacity: { remaining: 0, limit: 1 } }).mode, "paused");
    assert.equal(sendingVerdict(input).stale, true);
    assert.equal(sendingVerdict({ ...input, lastSentAt: now }).stale, false);
  });
  test("provider checks are isolated per app instance and retained with their timestamp", () => {
    const a = providerCheckMemo(), b = providerCheckMemo(); a.record("Revoked.", now);
    assert.deepEqual(rememberedProvider({ outreachProvider: "gmail" }, a), { kind: "remembered", problem: "Revoked.", at: now });
    assert.deepEqual(rememberedProvider({ outreachProvider: "gmail" }, b), { kind: "unchecked" });
    assert.deepEqual(rememberedProvider({ outreachProvider: null }, a), { kind: "not_applicable" });
  });
  test("small samples omit conversion rates and larger samples keep their denominator", () => {
    assert.equal(rateText(1, 1, "sent invitations"), "Too few to compare");
    assert.equal(rateText(0, 0, "sent invitations"), "Too few to compare");
    assert.equal(rateText(10, 20, "sent invitations"), "<b>50%</b> of sent invitations");
  });
  test("activity day boundaries use UTC and preserve separate recorded events", () => {
    const row = { key: "one", at: now, label: "Reply received", name: "Fixture", href: "/admin", kind: "outreach" as const, internal: false };
    const groups = groupByDay([row, { ...row, key: "two", at: new Date("2026-10-04T23:59:59Z") }], now);
    assert.deepEqual(groups.map(g => [g.label, g.events.length]), [["Today", 1], ["Yesterday", 1]]);
    assert.equal(groups[1]!.events[0]!.key, "two");
  });
});
