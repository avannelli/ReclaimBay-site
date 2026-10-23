import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFollowUps, GROUPING_RULE, tierRule } from "../lib/followUps";
import type { Opportunity } from "../lib/types";

let next = 0;
const line = (o: Partial<Opportunity> & { amount: number }): Opportunity => ({
  id: next++,
  service: "Brake pads",
  category: "Brakes",
  ...o,
});

test("lines combine only for the same customer and the same vehicle", () => {
  next = 0;
  const plan = buildFollowUps([
    line({ customer: "Ana Ruiz", vehicle: "2016 Toyota Camry", amount: 400, ageDays: 10, phone: "805-555-0101" }),
    line({ customer: "  ana  RUIZ ", vehicle: "2016 toyota camry", amount: 250, ageDays: 40 }),
    line({ customer: "Ana Ruiz", vehicle: "2019 Honda Pilot", amount: 900, ageDays: 5, phone: "805-555-0101" }),
  ]);
  assert.equal(plan.basis, "customer");
  assert.equal(plan.followUps.length, 2, "a second vehicle is a separate follow-up");
  const camry = plan.followUps.find((f) => f.vehicle === "2016 Toyota Camry")!;
  assert.equal(camry.items.length, 2);
  assert.equal(camry.total, 650);
  assert.equal(camry.latestAgeDays, 10);
  assert.equal(camry.phone, "805-555-0101", "contact comes from a real cell in the group");
  assert.equal(plan.combinedFollowUps, 1);
});

test("the same name never combines on a name alone, a missing vehicle, or conflicting contact", () => {
  next = 0;
  const plan = buildFollowUps([
    line({ customer: "Sam Lee", amount: 100, ageDays: 5 }),
    line({ customer: "Sam Lee", amount: 200, ageDays: 6 }),
    line({ customer: "Sam Lee", vehicle: "2015 Ford F-150", amount: 300, ageDays: 7 }),
    line({ customer: "Chris Park", vehicle: "2012 Honda Civic", phone: "555-0111", amount: 50, ageDays: 8 }),
    line({ customer: "Chris Park", vehicle: "2012 Honda Civic", phone: "555-0199", amount: 60, ageDays: 9 }),
    line({ customer: "Chris Park", vehicle: "2012 Honda Civic", email: "a@example.com", amount: 70, ageDays: 9 }),
    line({ customer: "Chris Park", vehicle: "2012 Honda Civic", email: "b@example.com", amount: 80, ageDays: 9 }),
  ]);
  const sam = plan.followUps.filter((f) => f.customer === "Sam Lee");
  assert.equal(sam.length, 3, "no vehicle and no contact: never combined");
  const chris = plan.followUps.filter((f) => f.customer === "Chris Park");
  // Two phones make two people; each email-only line could belong to either, so it is ambiguous and stays alone.
  assert.deepEqual(chris.map((f) => f.items.length), [1, 1, 1, 1]);
  for (const f of chris) {
    const phones = new Set(f.items.map((o) => o.phone).filter(Boolean));
    const emails = new Set(f.items.map((o) => o.email).filter(Boolean));
    assert.ok(phones.size <= 1 && emails.size <= 1, "no follow-up mixes two phones or two emails");
  }
});

test("without a vehicle, matching phone or email corroborates the name; normalized US numbers match", () => {
  next = 0;
  const plan = buildFollowUps([
    line({ customer: "Pat Kim", phone: "(805) 555-0142", amount: 100, ageDays: 20 }),
    line({ customer: "Pat Kim", phone: "+1 805.555.0142", amount: 150, ageDays: 30 }),
    line({ customer: "Pat Kim", email: "pat@example.com", amount: 70, ageDays: 30 }),
  ]);
  assert.equal(plan.followUps.length, 2);
  assert.equal(plan.followUps[0].items.length, 2);
});

test("lines without customer names stay separate and the plan falls back to line basis", () => {
  next = 0;
  const plan = buildFollowUps([
    line({ amount: 100, ageDays: 3, phone: "555-0101" }),
    line({ amount: 100, ageDays: 3, phone: "555-0101" }),
  ]);
  assert.equal(plan.basis, "line");
  assert.equal(plan.followUps.length, 2);
  assert.equal(plan.unnamedLines, 2);
  assert.equal(plan.combinedFollowUps, 0);
});

test("tiers follow the stated recency and contact rule, ordered by combined value", () => {
  next = 0;
  const plan = buildFollowUps([
    line({ customer: "A", vehicle: "V1", phone: "555-0101", amount: 100, ageDays: 89 }),
    line({ customer: "B", vehicle: "V2", email: "b@example.com", amount: 500, ageDays: 30 }),
    line({ customer: "C", vehicle: "V3", phone: "555-0103", amount: 900, ageDays: 91 }),
    line({ customer: "D", vehicle: "V4", phone: "555-0104", amount: 800, ageDays: 400 }),
    line({ customer: "E", vehicle: "V5", amount: 5000, ageDays: 2 }),
    line({ customer: "F", vehicle: "V6", phone: "555-0106", amount: 60 }),
  ]);
  assert.deepEqual(
    plan.followUps.map((f) => `${f.customer}:${f.tier}`),
    ["B:call_first", "A:call_first", "C:next", "E:review", "D:review", "F:review"],
  );
  assert.deepEqual(plan.tiers.call_first, { tier: "call_first", count: 2, value: 600 });
  assert.deepEqual(plan.contact.none, { count: 1, value: 5000 });
  assert.deepEqual(plan.contact.emailOnly, { count: 1, value: 500 });
});

test("without any dates, tiers use contact details only and say so", () => {
  next = 0;
  const plan = buildFollowUps([
    line({ customer: "A", vehicle: "V1", phone: "555-0101", amount: 100 }),
    line({ customer: "B", vehicle: "V2", amount: 200 }),
  ]);
  assert.equal(plan.hasDates, false);
  assert.deepEqual(plan.followUps.map((f) => f.tier), ["call_first", "review"]);
  assert.match(tierRule(false), /No usable dates/);
  assert.match(tierRule(true), /not a prediction/);
  assert.match(GROUPING_RULE, /never combined/);
});

test("grouping is deterministic regardless of input order and preserves every line once", () => {
  next = 0;
  const lines = [
    line({ customer: "Ana", vehicle: "Camry", amount: 10, ageDays: 1, phone: "555-0101" }),
    line({ customer: "Ana", vehicle: "Camry", amount: 20, ageDays: 2 }),
    line({ customer: "Bo", amount: 30, ageDays: 3 }),
  ];
  const a = buildFollowUps(lines), b = buildFollowUps([...lines].reverse());
  assert.deepEqual(a.followUps.map((f) => f.items.map((o) => o.id)), b.followUps.map((f) => f.items.map((o) => o.id)));
  assert.equal(a.followUps.reduce((n, f) => n + f.items.length, 0), lines.length);
});
