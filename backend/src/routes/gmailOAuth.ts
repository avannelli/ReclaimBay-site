import type { FastifyInstance, FastifyReply } from "fastify";
import { readCookie } from "../admin/auth.js";
import type { Config } from "../config.js";
import { GmailError, OAUTH_CALLBACK_PATH, STATE_COOKIE, completeAuthorization, gmailOAuthConfig, verifyOAuthState } from "../outreach/gmailAuth.js";

/**
 * Google's redirect back after an admin authorizes the outreach mailbox.
 *
 * Public, because the admin session cookie is SameSite=Strict and isn't sent
 * on a redirect from Google; it is guarded instead by the state cookie that
 * only a signed-in admin can obtain (GET /admin/outreach/gmail/authorize):
 * random, HMAC-signed with ADMIN_SECRET, ten minutes, and compared with the
 * state Google returns. The page shows the refresh token only sealed, once.
 * Request logging is off here so the one-time code never reaches a log.
 */
export async function gmailOAuthRoutes(app: FastifyInstance, opts: { config: Config; fetchImpl?: typeof fetch }) {
  const { config } = opts;

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    return payload;
  });

  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const page = (reply: FastifyReply, code: number, title: string, body: string) => {
    // The state is single-use: clear it whatever the outcome.
    reply.header("Set-Cookie", `${STATE_COOKIE}=; Path=/oauth/gmail; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? "; Secure" : ""}`);
    return reply
      .code(code)
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 16px;color:#1d2433;background:#fff}textarea{width:100%;min-height:7rem;font:13px ui-monospace,monospace;word-break:break-all}code{background:#f1f3f7;padding:1px 4px;border-radius:4px}</style></head><body><h1>${esc(title)}</h1>${body}<p><a href="/admin/outreach">Back to Outreach</a></p></body></html>`,
      );
  };

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(OAUTH_CALLBACK_PATH, { logLevel: "warn" }, async (req, reply) => {
    const secret = config.adminSecret;
    if (!secret) return page(reply, 503, "Admin is disabled", "<p>ADMIN_SECRET isn't configured.</p>");
    if (!verifyOAuthState(secret, readCookie(req.headers.cookie, STATE_COOKIE), req.query.state)) {
      return page(reply, 400, "Authorization not accepted", "<p>This authorization link is invalid or has expired. Start again from the admin's Outreach page.</p>");
    }
    if (req.query.error || !req.query.code) {
      return page(reply, 400, "Authorization cancelled", "<p>Google didn't grant access. Nothing was changed. Start again from the admin's Outreach page.</p>");
    }
    const cfg = gmailOAuthConfig(config);
    if ("problem" in cfg) return page(reply, 503, "Gmail isn't configured", `<p>${esc(cfg.problem)}</p>`);
    try {
      const { account, sealed } = await completeAuthorization(cfg, req.query.code, opts.fetchImpl);
      req.log.warn({ account }, "gmail authorized; sealed refresh token issued");
      return page(
        reply,
        200,
        "Gmail authorized",
        `<p><b>${esc(account)}</b> is authorized for sending and reading outreach mail.</p>
<p>Store this value as <code>GMAIL_REFRESH_TOKEN_SEALED</code> in the host's secret store, then restart the service. It is encrypted with <code>GMAIL_TOKEN_ENCRYPTION_KEY</code> and only works for ${esc(account)} with this OAuth client. It isn't shown again.</p>
<textarea readonly aria-label="Sealed Gmail authorization">${esc(sealed)}</textarea>
<p>Sending stays off until <code>OUTREACH_SENDING_ENABLED=1</code> is set and sending is switched on in the admin.</p>`,
      );
    } catch (err) {
      if (!(err instanceof GmailError)) throw err;
      req.log.warn({ kind: err.kind }, "gmail authorization refused");
      return page(reply, 400, "Authorization not completed", `<p>${esc(err.message)}</p>`);
    }
  });
}
