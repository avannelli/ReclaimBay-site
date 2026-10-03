import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { openInvitation } from "../invitations/service.js";
import { SESSION_ID_PATTERN } from "../validation.js";

/**
 * POST /api/invitations/open: the site's /invite page reports that a visitor
 * opened an invitation link. Public and anonymous.
 *
 * Registered inside the analytics scope (routes/events.ts), so it shares that
 * scope's exact-origin CORS; it has its own, stricter rate limit. Tokens are
 * 256-bit, so guessing is hopeless anyway; the limit stops floods of junk.
 * A visitor opening their own link a few times is nowhere near it.
 *
 * The answer is only `{ active: false }`, or `{ active: true, businessName }`
 * with the business's own public name: never an id, email, campaign, or
 * status, and identical for an unknown, malformed, or inactive token, so it
 * can't tell anyone whether an invitation ever existed. Nothing is logged
 * about the token.
 */
export const INVITATION_OPEN_LIMIT = { max: 30, timeWindow: "1 minute" } as const;

const bodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token"],
  properties: {
    // Shape only; the service decides. Loose on purpose, so a bad token gets the same answer as a good one that isn't active.
    token: { type: "string", maxLength: 100 },
    sessionId: { type: "string", pattern: SESSION_ID_PATTERN },
  },
} as const;

export function registerInvitationOpen(app: FastifyInstance, db: Db) {
  app.post<{ Body: { token: string; sessionId?: string } }>(
    "/api/invitations/open",
    { bodyLimit: 1_024, schema: { body: bodySchema }, config: { rateLimit: INVITATION_OPEN_LIMIT } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const result = await openInvitation(db, { token: request.body.token, sessionId: request.body.sessionId });
        return result.active ? { active: true, businessName: result.businessName } : { active: false };
      } catch (err) {
        // A public endpoint: details stay in the server log (never the token), the caller learns only that it failed.
        request.log.error({ err: { name: (err as Error).name, code: (err as { code?: string }).code } }, "invitation open failed");
        return reply.code(500).send({ error: "unavailable" });
      }
    },
  );
}
