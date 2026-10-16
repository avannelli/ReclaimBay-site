import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AUTONOMOUS_ATTRIBUTION, AUTONOMOUS_COMMERCIAL_MINIMUM, authorizationErrors, campaignState, policyVersions, type AuthorizationInput } from "../../src/discovery/autonomous.js";
import { commercialMeets } from "../../src/discovery/acquisition.js";
import { campaignOf, INTRO_TEMPLATE } from "../../src/outreach/compose.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";

const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const valid = (over: Partial<AuthorizationInput> = {}): AuthorizationInput => ({ name: "Ventura launch", prospectCap: 15, messageCap: 15, expiresAt: new Date(NOW.getTime() + 7 * DAY), reason: "Bounded first autonomous run.", confirm: true, via: "admin", ...over });

describe("M1 autonomous campaign rules (pure)", () => {
  test("a complete authorization is accepted and normalized", () => {
    const r = authorizationErrors(valid({ name: "  Ventura launch  ", prospectCap: "15" }), NOW);
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.name, "Ventura launch"); assert.equal(r.value.prospectCap, 15);
  });
  const refusals: [string, Partial<AuthorizationInput>, RegExp][] = [
    ["no name", { name: " " }, /name is required/],
    ["prospect cap 0", { prospectCap: 0 }, /Prospect cap/],
    ["prospect cap above 100", { prospectCap: 101 }, /Prospect cap/],
    ["fractional cap", { prospectCap: 2.5 }, /Prospect cap/],
    ["message cap above 250", { messageCap: 251 }, /Message cap/],
    ["expiry in the past", { expiresAt: new Date(NOW.getTime() - 1) }, /future/],
    ["expiry beyond 30 days", { expiresAt: new Date(NOW.getTime() + 31 * DAY) }, /within 30 days/],
    ["unparseable expiry", { expiresAt: "soon" }, /Expiry is required/],
    ["no reason", { reason: "" }, /reason is required/],
    ["no confirmation", { confirm: false }, /explicitly confirm/],
  ];
  for (const [name, over, message] of refusals) test(`refused: ${name}`, () => assert.match(authorizationErrors(valid(over), NOW).errors.join(" "), message));

  test("campaign state: stopped beats expired beats exhausted", () => {
    const base = { mode: "autonomous" as const, stoppedAt: null, expiresAt: new Date(NOW.getTime() + DAY), prospectCap: 2 };
    assert.equal(campaignState(base, 1, NOW), "active");
    assert.equal(campaignState(base, 2, NOW), "exhausted");
    assert.equal(campaignState({ ...base, expiresAt: NOW }, 0, NOW), "expired", "expiry is exclusive: at the instant it is over");
    assert.equal(campaignState({ ...base, stoppedAt: NOW, expiresAt: NOW }, 2, NOW), "stopped");
  });
  test("medium is the autonomous minimum; review and exclude never meet any minimum", () => {
    assert.equal(AUTONOMOUS_COMMERCIAL_MINIMUM, "medium");
    assert.equal(commercialMeets({ disposition: "fit", confidence: "medium" }, "medium"), true);
    assert.equal(commercialMeets({ disposition: "fit", confidence: "high" }, "medium"), true);
    assert.equal(commercialMeets({ disposition: "fit", confidence: "medium" }, "high"), false);
    assert.equal(commercialMeets({ disposition: "fit", confidence: "low" }, "medium"), false);
    for (const disposition of ["review", "exclude"]) for (const confidence of ["low", "medium", "high"]) assert.equal(commercialMeets({ disposition, confidence }, "medium"), false);
  });
  test("attribution matches the first message's campaign; policy versions are the current rules", () => {
    assert.equal(AUTONOMOUS_ATTRIBUTION, campaignOf(INTRO_TEMPLATE));
    assert.deepEqual(policyVersions(), { research: RESEARCH_VERSION, automation: "discovery@d2", commercial: "reclaimbay.commercial@v1", acquisition: "reclaimbay.acquisition@v1" });
  });
});
