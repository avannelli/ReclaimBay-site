import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../../src/config.js";
import { stripeGateway } from "../../src/billing/stripe.js";

/*
 * Which Stripe settings may take payments. Constructing the gateway makes no
 * network calls; the keys below are placeholders, not credentials.
 */

const billing = (mode: "test" | "live", secretKey: string | null = `sk_${mode}_placeholder`) => ({
  mode,
  secretKey,
  webhookSecret: "whsec_placeholder",
  priceId: "price_placeholder",
  productId: "prod_placeholder",
});
const SITE = { siteUrl: "https://reclaimbay.com" };

describe("Stripe gateway configuration", () => {
  test("missing secrets disable purchases instead of failing", () => {
    assert.equal(stripeGateway(billing("live", null), SITE), null);
    assert.equal(stripeGateway({ ...billing("live"), webhookSecret: null }, SITE), null);
  });

  test("a key from the other mode is refused", () => {
    assert.throws(() => stripeGateway(billing("test", "sk_live_placeholder")), /disagree/);
    assert.throws(() => stripeGateway(billing("live", "sk_test_placeholder"), SITE), /disagree/);
  });

  test("production refuses test mode and a non-HTTPS return site", () => {
    assert.throws(() => stripeGateway(billing("test"), SITE), /STRIPE_MODE=live/);
    assert.throws(() => stripeGateway(billing("live"), { siteUrl: "http://localhost:3000" }), /HTTPS/);
    assert.ok(stripeGateway(billing("live"), SITE));
  });

  test("test mode works locally, and STRIPE_MODE defaults to test", () => {
    assert.ok(stripeGateway(billing("test")));
    const c = loadConfig({ DATABASE_URL: "postgresql://localhost/x", STRIPE_SECRET_KEY: "sk_live_placeholder", STRIPE_WEBHOOK_SECRET: "whsec_placeholder" });
    assert.equal(c.billing.mode, "test");
    assert.throws(() => stripeGateway(c.billing), /disagree/);
  });

  test("production is detected the same way as secure admin cookies", () => {
    for (const env of [{ NODE_ENV: "production" }, { RAILWAY_ENVIRONMENT: "production" }])
      assert.equal(loadConfig({ DATABASE_URL: "postgresql://localhost/x", ...env }).secureCookies, true);
    assert.equal(loadConfig({ DATABASE_URL: "postgresql://localhost/x" }).secureCookies, false);
  });
});
