import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { FastifyBaseLogger, FastifyInstance, FastifyLoggerOptions, FastifyRequest } from "fastify";

export const LOG_REDACTED = "[redacted]";
type Policy = "http" | "content";
const requestSecrets = new WeakMap<object, Set<string>>();
const requestContext = new AsyncLocalStorage<Set<string>>();
const tokenKey = (key: string) => /token$/i.test(key.replace(/[-_]/g, ""));

/** Canonicalize for matching only; harmless output retains its original spelling. */
function canonical(text: string): string | null {
  const decode = (value: string) => value
    .replace(/%([0-7][0-9a-f])|\\+(?:u00|x)([0-7][0-9a-f])/gi, (escape: string, percent: string | undefined, unicode: string | undefined) => {
      const char = String.fromCharCode(Number.parseInt((percent ?? unicode)!, 16));
      // Encoded backslashes expose Unicode escapes on the next bounded pass.
      // This is matching-only; never introduce console control characters.
      return /[A-Za-z0-9_:/?#%&="'\\-]/.test(char) ? char : escape;
    })
    .replace(/\\+([/"'])/g, "$1");
  for (let i = 0; i < 8; i++) {
    const decoded = decode(text);
    if (decoded === text) return text;
    text = decoded;
  }
  return decode(text) === text ? text : null;
}

function addSecret(secrets: Set<string>, value: string) {
  const decoded = canonical(value);
  if (decoded && decoded !== ":token" && decoded !== LOG_REDACTED) secrets.add(decoded);
}

function textSecrets(text: string, secrets: Set<string>) {
  const decoded = canonical(text);
  if (decoded === null) return;
  // Identify tokens by source, never by UUID or identifier shape.
  for (const match of decoded.matchAll(/\/(?:u|invite)\/([A-Za-z0-9_-]+)/gi)) addSecret(secrets, match[1]!);
  for (const match of decoded.matchAll(/\/invite\/?#([A-Za-z0-9_-]+)/gi)) addSecret(secrets, match[1]!);
  for (const match of decoded.matchAll(/(?:[?&](?:invitation[-_]?token|unsubscribe[-_]?token|token)=|\b(?:invitation[-_]?token|unsubscribe[-_]?token|token)["']?\s*\)?\s*[:=]\s*["'(]?)([A-Za-z0-9_-]+)/gi)) addSecret(secrets, match[1]!);
}

function collectSecrets(value: unknown, secrets: Set<string>, seen = new WeakSet<object>()) {
  if (typeof value === "string") { textSecrets(value, secrets); return; }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Error) {
    textSecrets(value.message, secrets);
    textSecrets(value.stack ?? "", secrets);
    collectSecrets(value.cause, secrets, seen);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (tokenKey(key) && typeof entry === "string") addSecret(secrets, entry);
    collectSecrets(entry, secrets, seen);
  }
}

/**
 * Content policy preserves safe URLs/identifiers. HTTP policy also strips
 * queries/fragments from URL text. Explicit secrets are removed as substrings,
 * including next to UUID suffixes or other identifier characters.
 */
export function sanitizeLogText(text: string, tokens: Iterable<string> = [], policy: Policy = "content"): string {
  const decoded = canonical(text);
  if (decoded === null) return LOG_REDACTED;
  const secrets = new Set<string>();
  for (const token of tokens) addSecret(secrets, token);
  textSecrets(decoded, secrets);
  let result = decoded;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join(LOG_REDACTED);
  result = result
    .replace(/(\/(?:u|invite)\/)([^\s"'<>?#]+)/gi, (_, prefix: string, segment: string) => `${prefix}${segment === ":token" ? segment : LOG_REDACTED}`)
    .replace(/([?&](?:invitation[-_]?token|unsubscribe[-_]?token|token)=)[^&#\s"'<>]*/gi, `$1${LOG_REDACTED}`);
  if (policy === "http") {
    result = result.replace(/(?:https?:\/\/|\/)[^\s"'<>]+/gi, (url) => url.replace(/[?#].*$/, LOG_REDACTED));
  }
  // Avoid rewriting percent-encoded safe URLs, backslashes, or normal formatting.
  return result === decoded ? text : result;
}

function sanitizeValue(value: unknown, secrets: Set<string>, policy: Policy = "http", seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeLogText(value, secrets, policy);
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, secrets, policy, seen));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      sanitizeLogText(key, secrets, policy), tokenKey(key) ? LOG_REDACTED : sanitizeValue(entry, secrets, policy, seen),
    ]));
  }
  return value;
}

/** Pino's final output hook: after serializers/bindings, before destination.write. */
export function sanitizeLogLine(line: string, tokens: Iterable<string> = []): string {
  try {
    const value: unknown = JSON.parse(line);
    const secrets = new Set(tokens);
    collectSecrets(value, secrets);
    return `${JSON.stringify(sanitizeValue(value, secrets))}\n`;
  } catch {
    return '{"level":50,"msg":"log entry omitted: sanitization failed"}\n';
  }
}

export function registerRequestLogSanitization(app: FastifyInstance) {
  // Fastify creates the child BEFORE logging arrival. Secrets stay in a
  // WeakMap, never in bindings/serialized records, and survive context loss.
  app.setChildLoggerFactory((logger, bindings, opts, raw) => {
    const child = logger.child(bindings, opts);
    const secrets = new Set<string>();
    textSecrets(raw.url ?? "", secrets);
    requestSecrets.set(child, secrets);
    return child;
  });
  app.addHook("onRequest", (req, _reply, done) => {
    requestContext.run(requestSecrets.get(req.log) ?? new Set<string>(), done);
  });
  app.addHook("preValidation", (req, _reply, done) => {
    const secrets = requestSecrets.get(req.log)!;
    collectSecrets(req.body, secrets);
    collectSecrets(req.params, secrets);
    collectSecrets(req.query, secrets);
    done();
  });
}

export function applicationLogger(stream?: FastifyLoggerOptions["stream"]) {
  let activeSecrets: Set<string> | undefined;
  return {
    level: process.env.LOG_LEVEL ?? "info",
    ...(stream ? { stream } : {}),
    serializers: {
      req: (req: FastifyRequest) => ({ method: req.method, url: req.routeOptions?.url ?? "[unmatched]", remoteAddress: req.ip }),
    },
    onChild(this: FastifyBaseLogger, child: FastifyBaseLogger) {
      const secrets = requestSecrets.get(this);
      if (secrets) requestSecrets.set(child, secrets);
    },
    hooks: {
      // Pino log calls and streamWrite are synchronous. Restore context even
      // for reentrant logging; no secrets need to enter output metadata.
      logMethod(this: FastifyBaseLogger, args: unknown[], method: (...args: unknown[]) => void) {
        const previous = activeSecrets;
        activeSecrets = requestSecrets.get(this) ?? requestContext.getStore();
        try { method.apply(this, args); } finally { activeSecrets = previous; }
      },
      streamWrite: (line: string) => sanitizeLogLine(line, activeSecrets),
    },
  };
}

/** Explicit outreach content boundary. No process handlers or shape guessing. */
export const safeConsole = {
  log: (...args: unknown[]) => console.log(contentText(args)),
  error: (...args: unknown[]) => console.error(contentText(args)),
};

function contentText(args: unknown[], tokens: Iterable<string> = []): string {
  try {
    const secrets = new Set(tokens);
    collectSecrets(args, secrets);
    return sanitizeLogText(format(...args), secrets);
  } catch { return "log entry omitted: sanitization failed"; }
}

/** Terminal CLI diagnostic copy: rethrowing retains Node's default fatal exit. */
export function sanitizeCliError(error: unknown, tokens: Iterable<string> = []): unknown {
  if (!(error instanceof Error)) return contentText([error], tokens);
  const secrets = new Set(tokens);
  collectSecrets(error, secrets);
  const copies = new WeakMap<Error, Error>();
  const diagnostic = (source: Error): Error => {
    const existing = copies.get(source);
    if (existing) return existing;
    const copy = new Error(sanitizeLogText(source.message, secrets));
    copies.set(source, copy);
    copy.name = sanitizeLogText(source.name, secrets);
    copy.stack = sanitizeLogText(source.stack ?? "", secrets);
    Object.assign(copy, sanitizeValue({ ...source }, secrets, "content"));
    if (source.cause !== undefined) copy.cause = source.cause instanceof Error ? diagnostic(source.cause) : sanitizeValue(source.cause, secrets, "content");
    return copy;
  };
  return diagnostic(error);
}

/** Finite job context: outgoing message tokens protect even unlabeled provider echoes. */
export function createContentLogger() {
  const secrets = new Set<string>();
  let failed = false;
  return {
    remember(value: unknown) {
      try { collectSecrets(value, secrets); } catch { failed = true; }
    },
    console: {
      log: (...args: unknown[]) => console.log(failed ? "log entry omitted: sanitization failed" : contentText(args, secrets)),
      error: (...args: unknown[]) => console.error(failed ? "log entry omitted: sanitization failed" : contentText(args, secrets)),
    },
    error: (error: unknown) => failed ? new Error("diagnostic omitted: sanitization failed") : sanitizeCliError(error, secrets),
  };
}
