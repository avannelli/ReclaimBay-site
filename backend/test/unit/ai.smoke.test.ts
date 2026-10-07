import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { costMicroUsd } from "../../src/ai/provider.js";
import { SMOKE_MAX_CALL_MICRO_USD, parseSmokeArgs, smokeCeiling, smokeSummary, type SmokeReport } from "../../src/ai/smoke.js";
import { SHADOW_MAX_TOKENS } from "../../src/ai/shadow.js";
import { loadConfig } from "../../src/config.js";

const ID = "11111111-2222-4333-8444-555555555555";

describe("ai:smoke command line", () => {
  test("exactly one candidate is required", () => {
    assert.deepEqual(parseSmokeArgs(["--candidate", ID]), { candidateId: ID });
    assert.deepEqual(parseSmokeArgs([`--candidate=${ID}`]), { candidateId: ID });
    assert.match((parseSmokeArgs([]) as { error: string }).error, /exactly one/);
    assert.match((parseSmokeArgs(["--candidate", ID, "--candidate", ID]) as { error: string }).error, /exactly one/);
    assert.match((parseSmokeArgs(["--candidate"]) as { error: string }).error, /Unexpected argument/);
    assert.match((parseSmokeArgs(["--candidate", ID, "--limit", "5"]) as { error: string }).error, /Unexpected argument/);
    assert.match((parseSmokeArgs(["--cohort", ID]) as { error: string }).error, /Unexpected argument/);
  });

  test("an invalid candidate id is refused before anything runs", () => {
    for (const bad of ["abc", "1; DROP TABLE x", "' OR 1=1", `${ID}x`]) assert.match((parseSmokeArgs(["--candidate", bad]) as { error: string }).error, /must be a UUID/);
  });
});

describe("ai:smoke cost ceiling", () => {
  test("a fixed $0.25 ceiling on the worst case: an ordinary prompt passes, an oversized one is refused", () => {
    assert.equal(SMOKE_MAX_CALL_MICRO_USD, 250_000);
    const ordinary = smokeCeiling("claude-opus-5-5", 12_000);
    assert.deepEqual(ordinary, { worstMicroUsd: costMicroUsd("claude-opus-5-5", 6_000, SHADOW_MAX_TOKENS), allowed: true });
    assert.ok(ordinary.worstMicroUsd! < SMOKE_MAX_CALL_MICRO_USD);
    const oversized = smokeCeiling("claude-opus-5-5", 200_000);
    assert.equal(oversized.allowed, false);
    assert.ok(oversized.worstMicroUsd! > SMOKE_MAX_CALL_MICRO_USD);
    assert.deepEqual(smokeCeiling("unpriced-model", 10), { worstMicroUsd: null, allowed: false }, "an unknown price is refused");
  });
});

describe("ai:smoke summary and configuration", () => {
  const report = (over: Partial<SmokeReport> = {}): SmokeReport => ({
    outcome: "valid", candidateId: ID, provider: "anthropic", model: "claude-opus-5-5", call: "ok", decision: "collision_primary", confidence: 0.9, validationErrors: [], evidenceItems: 1,
    inputTokens: 3000, outputTokens: 400, costMicroUsd: 20_000, worstMicroUsd: 172_000, latencyMs: 4200, databaseWrite: false, message: "ok", ...over,
  });

  test("the summary states the result and ends with the write guarantee", () => {
    const s = smokeSummary(report());
    assert.match(s, /candidate: 11111111-2222-4333-8444-555555555555/);
    assert.match(s, /provider: anthropic; model: claude-opus-5-5/);
    assert.match(s, /validation: PASS/);
    assert.match(s, /estimated cost: \$0\.0200 \(worst case \$0\.1720, ceiling \$0\.2500\)/);
    assert.equal(s.split("\n").at(-1), "SMOKE TEST: NO DATABASE WRITE");
    const failed = smokeSummary(report({ outcome: "invalid", validationErrors: ["evidence 1: the quote is not word for word in the supplied excerpts for its source URL."] }));
    assert.match(failed, /validation: FAIL\n {4}- evidence 1/);
    assert.equal(failed.split("\n").at(-1), "SMOKE TEST: NO DATABASE WRITE");
  });

  test("the smoke arm is separate from the shadow arm and off by default", () => {
    const base = { DATABASE_URL: "postgresql://localhost/x" };
    assert.equal(loadConfig(base).ai.smokeEnabled, false);
    assert.equal(loadConfig({ ...base, AI_SMOKE_ENABLED: "true" }).ai.smokeEnabled, false, "only 1 arms it");
    const armed = loadConfig({ ...base, AI_SMOKE_ENABLED: "1" }).ai;
    assert.deepEqual([armed.smokeEnabled, armed.shadowEnabled], [true, false], "arming the smoke test never arms shadow runs");
  });
});
