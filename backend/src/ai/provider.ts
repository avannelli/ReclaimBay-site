/*
 * The AI provider boundary: one call, structured output, nothing else. The
 * model gets no tools and no browsing; it answers one request from the
 * input it is given. Swappable: anything with `complete()` is a provider
 * (tests use a fake).
 *
 * The Anthropic adapter calls the Messages API over fetch, as the Gmail
 * integration does, so the project takes no SDK dependency. It never logs
 * or returns the API key, and its errors carry fixed, short messages.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  /** JSON Schema the answer must follow (structured output). */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface Completion {
  /** The answer's text: JSON, to be validated by the caller. */
  text: string;
  /** The model that answered, as the provider reports it. */
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type ProviderFailure = "timeout" | "network" | "http" | "refusal" | "truncated" | "invalid_response";

export class AiProviderError extends Error {
  constructor(readonly failure: ProviderFailure, message: string) {
    super(message.slice(0, 200));
    this.name = "AiProviderError";
  }
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<Completion>;
}

/** Published prices per million tokens (input, output), US dollars. A model not listed has no known price: nothing runs on it. */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Estimated cost in millionths of a dollar, or null when the model's price isn't known. */
export function costMicroUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICES[model];
  return p ? Math.ceil(inputTokens * p.input + outputTokens * p.output) : null;
}

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** Per request. A slow answer is an error, recorded, never retried in a loop. */
export const PROVIDER_TIMEOUT_MS = 90_000;

type Fetch = typeof fetch;

/** The Anthropic Messages API, with the answer constrained to `schema` (output_config.format). */
export function anthropicProvider(opts: { apiKey: string; model: string; fetch?: Fetch; timeoutMs?: number; effort?: "low" | "medium" | "high" }): AiProvider {
  const doFetch = opts.fetch ?? fetch;
  return {
    name: "anthropic",
    model: opts.model,
    async complete(req) {
      let res: Response;
      try {
        res = await doFetch(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: req.maxTokens,
            // Thinking stays adaptive (the model's default); effort is set explicitly.
            output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema: req.schema } },
            system: req.system,
            messages: [{ role: "user", content: req.user }],
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? PROVIDER_TIMEOUT_MS),
        });
      } catch (err) {
        const name = (err as { name?: string })?.name ?? "";
        if (name === "TimeoutError" || name === "AbortError") throw new AiProviderError("timeout", "The provider did not answer in time.");
        throw new AiProviderError("network", "The provider could not be reached.");
      }
      if (!res.ok) throw new AiProviderError("http", `The provider answered HTTP ${res.status}.`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AiProviderError("invalid_response", "The provider's response was not JSON.");
      }
      const m = body as { model?: unknown; stop_reason?: unknown; content?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
      // The stop reason first: a refusal or a cut-off answer is never parsed as one.
      if (m.stop_reason === "refusal") throw new AiProviderError("refusal", "The model declined to answer.");
      if (m.stop_reason === "max_tokens") throw new AiProviderError("truncated", "The answer was cut off at the token limit.");
      if (!Array.isArray(m.content)) throw new AiProviderError("invalid_response", "The provider's response had no content.");
      const text = m.content
        .filter((b): b is { type: "text"; text: string } => (b as { type?: unknown })?.type === "text" && typeof (b as { text?: unknown }).text === "string")
        .map((b) => b.text)
        .join("");
      if (!text) throw new AiProviderError("invalid_response", "The provider's response had no text answer.");
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
      return {
        text,
        model: typeof m.model === "string" ? m.model.slice(0, 80) : opts.model,
        inputTokens: num(m.usage?.input_tokens),
        outputTokens: num(m.usage?.output_tokens),
      };
    },
  };
}

/** The configured provider, or null when AI isn't configured (no provider, unknown provider, or no key). */
export function providerFromConfig(ai: { provider: string | null; apiKey: string | null; model: string }): AiProvider | null {
  if (ai.provider !== "anthropic" || !ai.apiKey) return null;
  return anthropicProvider({ apiKey: ai.apiKey, model: ai.model });
}
