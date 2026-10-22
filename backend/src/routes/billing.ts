import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { readFile, access } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import {
  authenticateBuyer,
  BillingError,
  buyerKey,
  UUID,
} from "../billing/identity.js";
import {
  currentOffer,
  stripeGateway,
  type PaymentGateway,
} from "../billing/stripe.js";
import { ReportBilling } from "../billing/service.js";

const uuid = { type: "string", pattern: UUID.source },
  short = { type: "string", maxLength: 200, minLength: 1 };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const protectedBody = (checkout = false) =>
  object({
    buyerId: uuid,
    challenge: uuid,
    signature: { type: "string", pattern: "^[A-Za-z0-9_-]{86}$" },
    payload: object({
      reportId: uuid,
      ...(checkout ? { priceId: short } : {}),
    }),
  });
type Proof = {
  buyerId: string;
  challenge: string;
  signature: string;
  payload: { reportId: string; priceId?: string };
};

export async function billingRoutes(
  app: FastifyInstance,
  opts: { config: Config; db: Db; gateway?: PaymentGateway; bundle?: string },
) {
  const { config, db } = opts,
    g =
      opts.gateway ??
      stripeGateway(
        config.billing,
        config.secureCookies ? { siteUrl: config.publicSiteUrl } : undefined,
      ),
    billing = g ? new ReportBilling(db, g, config) : null;
  const origins = new Set([
    ...config.allowedOrigins,
    new URL(config.publicSiteUrl).origin,
  ]);
  const file = new URL("../../private/report.js", import.meta.url);
  const bundleReady = async () => {
    if (opts.bundle === undefined)
      try {
        await access(file);
      } catch {
        throw new BillingError(503, "fulfillment_unavailable");
      }
  };
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !!origin && origins.has(origin)),
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    maxAge: 600,
  });
  await app.register(rateLimit, { max: 90, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    if (
      req.method === "POST" &&
      req.url.split("?")[0] !== "/api/billing/webhook" &&
      (!req.headers.origin || !origins.has(req.headers.origin))
    )
      return reply.code(403).send({ error: "origin_not_allowed" });
  });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof BillingError)
      return reply.code(e.status).send({ error: e.code });
    if (e && typeof e === "object" && "validation" in e)
      return reply.code(400).send({ error: "invalid_purchase_request" });
    // No Stripe error bodies, customer email, raw webhook, keys or proofs in logs/responses.
    return reply.code(503).send({ error: "payment_service_unavailable" });
  });
  const ready = () => {
    if (!g || !billing) throw new BillingError(503, "payments_not_configured");
    return billing;
  };
  app.get("/offer", async () => {
    // Unsetting the Price stops new checkouts only; status, fulfillment and
    // webhooks keep serving existing purchases.
    if (!g || !config.billing.priceId || !config.billing.productId)
      return { available: false };
    await bundleReady();
    const o = await currentOffer(g, config.billing);
    return {
      available: true,
      priceId: o.priceId,
      amount: o.amount,
      currency: o.currency,
      oneTime: true,
      previewOpportunities: 1,
    };
  });
  app.post<{ Body: { buyerId: string; publicKey: unknown } }>(
    "/buyer",
    {
      schema: {
        body: object({ buyerId: uuid, publicKey: { type: "object" } }),
      },
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      ready();
      const key = buyerKey(req.body.publicKey);
      await db.reportBuyer.createMany({
        data: [{ id: req.body.buyerId, publicKey: key }],
        skipDuplicates: true,
      });
      const owner = await db.reportBuyer.findUniqueOrThrow({
        where: { id: req.body.buyerId },
      });
      if (JSON.stringify(buyerKey(owner.publicKey)) !== JSON.stringify(key))
        throw new BillingError(409, "buyer_key_conflict");
      return reply.code(200).send({ buyerId: owner.id });
    },
  );
  app.post<{ Body: { buyerId: string } }>(
    "/challenge",
    { schema: { body: object({ buyerId: uuid }) } },
    async (req) => {
      ready();
      if (
        !(await db.reportBuyer.findUnique({
          where: { id: req.body.buyerId },
          select: { id: true },
        }))
      )
        throw new BillingError(401, "unknown_buyer");
      await db.buyerChallenge.deleteMany({
        where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } },
      });
      return db.buyerChallenge.create({
        data: {
          buyerId: req.body.buyerId,
          expiresAt: new Date(Date.now() + 120000),
        },
        select: { id: true },
      });
    },
  );
  for (const route of ["checkout", "status", "fulfillment"] as const)
    app.post<{ Body: Proof }>(
      `/${route}`,
      { schema: { body: protectedBody(route === "checkout") } },
      async (req, reply) => {
        const service = ready(),
          buyer = await authenticateBuyer(
            db,
            `/api/billing/${route}`,
            req.body as Parameters<typeof authenticateBuyer>[2],
          );
        if (route === "checkout") {
          await bundleReady();
          return service.checkout(
            buyer,
            req.body.payload.reportId,
            req.body.payload.priceId!,
          );
        }
        if (route === "status")
          return service.status(buyer, req.body.payload.reportId);
        const e = await service.entitlement(buyer, req.body.payload.reportId);
        if (!e || e.revokedAt)
          throw new BillingError(403, "paid_report_required");
        return reply
          .type("text/javascript; charset=utf-8")
          .send(opts.bundle ?? (await readFile(file, "utf8")));
      },
    );
  await app.register(async (hook) => {
    hook.removeContentTypeParser("application/json");
    hook.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    hook.post<{ Body: Buffer }>(
      "/webhook",
      { bodyLimit: 262144 },
      async (req, reply) => {
        ready();
        const signature = req.headers["stripe-signature"];
        if (typeof signature !== "string" || !config.billing.webhookSecret)
          throw new BillingError(400, "invalid_webhook");
        let event;
        try {
          event = g!.event(req.body, signature, config.billing.webhookSecret);
        } catch {
          throw new BillingError(400, "invalid_webhook");
        }
        await billing!.webhook(event);
        return reply.code(200).send({ received: true });
      },
    );
  });
}
