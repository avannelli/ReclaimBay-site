import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { eventBodySchema, exportTypeError, type EventBody } from "../validation.js";

/**
 * POST /api/events: anonymous, behavioral-only analytics.
 *
 * Registered in its own scope so CORS and rate limiting apply here and not
 * to the admin pages.
 */
export async function eventRoutes(app: FastifyInstance, opts: { config: Config; db: Db }) {
  const { config, db } = opts;
  const allowed = new Set(config.allowedOrigins);

  await app.register(cors, {
    origin: (origin, cb) => cb(null, origin !== undefined && allowed.has(origin)),
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  app.post<{ Body: EventBody }>(
    "/api/events",
    {
      bodyLimit: 2_048,
      schema: { body: eventBodySchema },
    },
    async (request, reply) => {
      const body = request.body;
      const crossFieldError = exportTypeError(body);
      if (crossFieldError) return reply.code(400).send({ error: crossFieldError });

      await recordEvent(db, body);
      // Same response whether or not the ref matched, so codes can't be probed.
      return reply.code(204).send();
    },
  );
}

async function recordEvent(db: Db, body: EventBody) {
  const now = new Date();
  const prospect = body.ref
    ? await db.prospect.findUnique({ where: { referralCode: body.ref }, select: { id: true } })
    : null;

  const session = await upsertSession(db, body.sessionId, prospect?.id ?? null, now);

  await db.productEvent.create({
    data: {
      sessionId: session.id,
      // Events follow the session's attribution, even once the ref is gone.
      prospectId: session.prospectId,
      eventType: body.event,
      campaign: body.campaign ?? null,
      exportType: body.exportType ?? null,
      isSample: body.isSample ?? false,
      createdAt: now,
    },
  });
}

/** First-touch attribution: a session keeps the first prospect it was linked to. */
async function upsertSession(db: Db, anonymousSessionId: string, prospectId: string | null, now: Date) {
  const select = { id: true, prospectId: true } as const;
  for (let attempt = 0; ; attempt++) {
    try {
      const session = await db.analyticsSession.upsert({
        where: { anonymousSessionId },
        create: { anonymousSessionId, prospectId, firstSeenAt: now, lastSeenAt: now },
        update: { lastSeenAt: now },
        select,
      });
      if (prospectId && !session.prospectId) {
        return db.analyticsSession.update({
          where: { id: session.id },
          data: { prospectId },
          select,
        });
      }
      return session;
    } catch (err) {
      // Two first events racing on the unique key: the retry takes the update path.
      if ((err as { code?: string }).code !== "P2002" || attempt > 0) throw err;
    }
  }
}
