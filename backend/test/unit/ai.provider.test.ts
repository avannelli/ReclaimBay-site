import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AiProviderError, ANTHROPIC_MESSAGES_URL, MODEL_PRICES, anthropicProvider, costMicroUsd, providerFromConfig } from "../../src/ai/provider.js";
import { loadConfig } from "../../src/config.js";

const KEY = "sk-ant-test-secret-key-0123456789";
const REQ = { system: "sys", user: "usr", schema: { type: "object" }, maxTokens: 100 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchReturning = (make: () => Response | Promise<Response>, seen: { url: string; init: RequestInit }[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! });
    return make();
  }) as typeof fetch;
const failure = (f: string) => (e: unknown) => e instanceof AiProviderError && e.failure === f && !e.message.includes(KEY);

describe("AI provider: Anthropic adapter over fetch", () => {
  test("sends one Messages API request with structured output, and returns the text and usage", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const p = anthropicProvider({ apiKey: KEY, model: "claude-opus-5-5", fetch: fetchReturning(() => json({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":1}' }], usage: { input_tokens: 1200, output_tokens: 300 } }), seen) });
    const out = await p.complete(REQ);
    assert.deepEqual(out, { text: '{"a":1}', model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 300 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, ANTHROPIC_MESSAGES_URL);
    const headers = seen[0]!.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], KEY);
    assert.equal(headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(String(seen[0]!.init.body));
    assert.equal(body.model, "claude-opus-5-5");
    assert.deepEqual(body.output_config.format, { type: "json_schema", schema: { type: "object" } });
    assert.equal(body.output_config.effort, "medium");
    assert.equal(body.tools, undefined, "no tools: the model can't browse or act");
    assert.equal(body.thinking, undefined, "thinking stays the model's adaptive default");
    assert.deepEqual(body.messages, [{ role: "user", content: "usr" }]);
  });

  test("timeout, network failure, HTTP error, and invalid responses are typed failures with no secret in them", async () => {
    const timeout = anthropicProvider({ apiKey: KEY, model: "m", fetch: (async () => { throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }); }) as typeof fetch });
    await assert.rejects(timeout.complete(REQ), failure("timeout"));
    const net = anthropicProvider({ apiKey: KEY, model: "m", fetch: (async () => { throw new TypeError(`fetch failed ${KEY}`); }) as typeof fetch });
    await assert.rejects(net.complete(REQ), failure("network"));
    const http = anthropicProvider({ apiKey: KEY, model: "m", fetch: fetchReturning(() => json({ error: { message: `bad key ${KEY}` } }, 401)) });
    await assert.rejects(http.complete(REQ), failure("http"));
    const notJson = anthropicProvider({ apiKey: KEY, model: "m", fetch: fetchReturning(() => new Response("<html>oops</html>")) });
    await assert.rejects(notJson.complete(REQ), failure("invalid_response"));
    const noText = anthropicProvider({ apiKey: KEY, model: "m", fetch: fetchReturning(() => json({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }] })) });
    await assert.rejects(noText.complete(REQ), failure("invalid_response"));
    const noContent = anthropicProvider({ apiKey: KEY, model: "m", fetch: fetchReturning(() => json({ stop_reason: "end_turn" })) });
    await assert.rejects(noContent.complete(REQ), failure("invalid_response"));
  });

  test("a refusal or a cut-off answer is never parsed as an answer", async () => {
    const refusal = anthropicProvider({ apiKey: KEY, model: "m", fetch: fetchReturning(() => json({ stop_reason: "refusal", content: [{ type: "text", text: '{"decision":"collision_primary"}' }] })) });
    await assert.rejects(refusal.complete(REQ), failure("refusal"));
    const cut = anthropicProvider({ apiKey: KEY, model: "m", fetch: fetchReturning(() => json({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"decision":' }] })) });
    await assert.rejects(cut.complete(REQ), failure("truncated"));
  });

  test("missing usage is reported as unknown, not zero", async () => {
    const p = anthropicProvider({ apiKey: KEY, model: "m", fetch: fetchReturning(() => json({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] })) });
    const out = await p.complete(REQ);
    assert.equal(out.inputTokens, null);
    assert.equal(out.outputTokens, null);
  });
});

describe("AI configuration", () => {
  const base = { DATABASE_URL: "postgresql://localhost/x" };
  test("off by default: no provider, shadow disarmed, no budget", () => {
    const c = loadConfig(base);
    assert.deepEqual(c.ai, { provider: null, apiKey: null, model: "claude-opus-5-5", shadowEnabled: false, smokeEnabled: false, shadowBatchLimit: 5, shadowDailyBudgetUsd: 0 });
    assert.equal(providerFromConfig(c.ai), null);
  });

  test("bounded values; a provider needs a key", () => {
    const c = loadConfig({ ...base, AI_PROVIDER: "Anthropic", AI_API_KEY: KEY, AI_MODEL: "claude-sonnet-5-5", AI_SHADOW_ENABLED: "1", AI_SHADOW_BATCH_LIMIT: "999", AI_SHADOW_DAILY_BUDGET: "2.5" });
    assert.deepEqual({ ...c.ai, apiKey: c.ai.apiKey ? "set" : null }, { provider: "anthropic", apiKey: "set", model: "claude-sonnet-5-5", shadowEnabled: true, smokeEnabled: false, shadowBatchLimit: 25, shadowDailyBudgetUsd: 2.5 });
    assert.equal(providerFromConfig(c.ai)?.model, "claude-sonnet-5-5");
    assert.equal(providerFromConfig({ ...c.ai, apiKey: null }), null);
    assert.equal(providerFromConfig({ ...c.ai, provider: "other" }), null);
    for (const b of ["-1", "abc", "0", ""]) assert.equal(loadConfig({ ...base, AI_SHADOW_DAILY_BUDGET: b }).ai.shadowDailyBudgetUsd, 0);
    assert.equal(loadConfig({ ...base, AI_SHADOW_ENABLED: "true" }).ai.shadowEnabled, false, "only 1 arms it");
  });

  test("cost is estimated from published prices; an unknown model has none", () => {
    assert.equal(costMicroUsd("claude-opus-5-5", 1_000_000, 0), 4_000_000);
    assert.equal(costMicroUsd("claude-opus-5-5", 1000, 500), 4000 * 1 + 10000);
    assert.equal(costMicroUsd("some-unknown-model", 10, 10), null);
    assert.ok(Object.keys(MODEL_PRICES).includes("claude-opus-5-5"));
  });
});
