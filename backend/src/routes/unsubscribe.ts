import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db.js";
import { unsubscribeByToken } from "../outreach/service.js";

/**
 * Public one-click unsubscribe for outreach email (the List-Unsubscribe
 * link). GET only shows a button, because mail scanners follow links; POST
 * unsubscribes, from the button or from a mail client's one-click request
 * (RFC 8058). Both answer the same way whatever the token, so tokens can't
 * be probed, and repeating it is harmless.
 */
export async function unsubscribeRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1_024 }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  await app.register(rateLimit, { max: 30, timeWindow: "1 minute" });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return payload;
  });

  const page = (reply: FastifyReply, title: string, body: string) =>
    reply
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 16px;color:#1d2433;background:#fff}button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #1d2433;background:#1d2433;color:#fff;cursor:pointer}</style></head><body><h1>${title}</h1>${body}</body></html>`,
      );

  const valid = (token: string) => /^[A-Za-z0-9_-]{16,64}$/.test(token);

  app.get<{ Params: { token: string } }>("/u/:token", (req, reply) => {
    if (!valid(req.params.token)) return page(reply.code(404), "Link not valid", "<p>This unsubscribe link isn't valid.</p>");
    return page(
      reply,
      "Unsubscribe from ReclaimBay",
      `<p>Stop all emails from ReclaimBay to this business?</p><form method="post"><button type="submit">Unsubscribe</button></form>`,
    );
  });

  app.post<{ Params: { token: string } }>("/u/:token", async (req, reply) => {
    if (valid(req.params.token)) {
      const { result } = await unsubscribeByToken(db, req.params.token);
      req.log.info({ result }, "outreach unsubscribe");
    }
    return page(reply, "You're unsubscribed", "<p>ReclaimBay won't email this business again.</p>");
  });
}
