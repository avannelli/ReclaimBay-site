// Local browser integration harness only. Not imported from src/ or production.
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { freshDb } from "../integration/helpers.js";
import { FixturePayments, WEBHOOK_FIXTURE_SECRET } from "./billing.js";

if (!process.env.TEST_DATABASE_URL || !process.env.BILLING_FIXTURE_CONTROL)
  throw Error("Disposable local fixture environment required");
const db = await freshDb(),
  g = new FixturePayments();
const config = loadConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  PUBLIC_SITE_URL: "http://127.0.0.1:47890",
  ALLOWED_ORIGIN: "http://127.0.0.1:47890",
  STRIPE_MODE: "test",
});
config.billing = {
  mode: "test",
  secretKey: null,
  webhookSecret: WEBHOOK_FIXTURE_SECRET,
  priceId: "price_launch",
  productId: "prod_report",
};
const app = await buildApp(config, db, false, {
  paymentGateway: g,
});
app.post<{ Body: { action: string } }>("/local-fixture", async (req, reply) => {
  if (req.headers["x-fixture-control"] !== process.env.BILLING_FIXTURE_CONTROL)
    return reply.code(403).send();
  if (req.body.action === "pay") {
    for (const id of g.sessions.keys()) {
      const s = g.pay(id),
        signed = g.signed("checkout.session.completed", s);
      const response = await app.inject({
        method: "POST",
        url: "/api/billing/webhook",
        ...signed,
      });
      if (response.statusCode !== 200)
        throw Error("Signed fixture webhook rejected");
    }
  }
  return {
    purchases: await db.reportPurchase.count(),
    entitlements: await db.reportEntitlement.count(),
    sessions: g.sessions.size,
    outreach: await db.outreach.count(),
    campaigns: await db.outreachCampaign.count(),
    events: await db.stripePaymentEvent.count(),
    attempts: g.attempts,
  };
});
await app.listen({ port: 47892, host: "127.0.0.1" });
console.log("BILLING_FIXTURE_READY");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  void app
    .close()
    .then(() => db.$disconnect())
    .then(() => process.exit(0));
});
