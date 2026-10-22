import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { buildApp } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { proofMessage } from "../../src/billing/identity.js";
import {
  FixturePayments,
  WEBHOOK_FIXTURE_SECRET,
} from "../fixtures/billing.js";
import { TEST_DATABASE_URL, freshDb, skipReason } from "./helpers.js";

const origin = "http://localhost:3000";
const device = () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { id: randomUUID(), ...keys };
};
describe("private one-time scanner purchases", { skip: skipReason }, () => {
  let db: Db, app: FastifyInstance, g: FixturePayments, c: Config;
  let buyer: ReturnType<typeof device>, reportId: string;
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url,
      payload: payload as Record<string, unknown>,
      headers: { origin },
    });
  beforeEach(async () => {
    db = await freshDb();
    g = new FixturePayments();
    c = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      ALLOWED_ORIGIN: origin,
      PUBLIC_SITE_URL: origin,
      STRIPE_MODE: "test",
    });
    c.billing = {
      mode: "test",
      secretKey: null,
      webhookSecret: WEBHOOK_FIXTURE_SECRET,
      priceId: "price_launch",
      productId: "prod_report",
    };
    app = await buildApp(c, db, false, {
      paymentGateway: g,
      paidReportBundle: "window.ReclaimBayPaid={mount(){}};",
    });
    buyer = device();
    reportId = randomUUID();
    await register(buyer);
  });
  afterEach(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  async function register(b: ReturnType<typeof device>) {
    const r = await post("/api/billing/buyer", {
      buyerId: b.id,
      publicKey: b.publicKey.export({ format: "jwk" }),
    });
    assert.equal(r.statusCode, 200, r.body);
  }
  async function proof(
    route: string,
    payload: Record<string, string>,
    b = buyer,
  ) {
    const r = await post("/api/billing/challenge", { buyerId: b.id });
    assert.equal(r.statusCode, 200, r.body);
    const challenge = r.json().id as string;
    const signature = sign(
      "sha256",
      Buffer.from(proofMessage("/api/billing/" + route, challenge, payload)),
      { key: b.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url");
    return { buyerId: b.id, challenge, payload, signature };
  }
  async function request(
    route: string,
    payload: Record<string, string> = { reportId },
    b = buyer,
  ) {
    return post("/api/billing/" + route, await proof(route, payload, b));
  }
  const checkout = () =>
    request("checkout", { reportId, priceId: c.billing.priceId! });
  const purchase = () =>
    db.reportPurchase.findFirstOrThrow({
      where: { buyerId: buyer.id, reportId },
      orderBy: { createdAt: "desc" },
    });
  async function paid() {
    assert.equal((await checkout()).statusCode, 200);
    const p = await purchase();
    g.pay(p.stripeSessionId!);
    return p;
  }
  const webhook = (
    type: string,
    object: unknown,
    id?: string,
    timestamp?: number,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/billing/webhook",
      ...g.signed(type, object, id, timestamp),
    });

  test("offer is server priced, one-time USD; invalid/recurring/mismatched prices fail closed", async () => {
    const offer = await app.inject("/api/billing/offer");
    assert.equal(offer.statusCode, 200);
    assert.equal(offer.json().amount, 4900);
    for (const patch of [
      { type: "recurring" },
      { currency: "eur" },
      { product: "prod_other" },
      { livemode: true },
      { active: false },
      { unit_amount: 0 },
    ]) {
      const p = g.prices.get("price_launch")!;
      const original = structuredClone(p);
      Object.assign(p, patch);
      assert.equal((await checkout()).statusCode, 503);
      g.prices.set("price_launch", original);
    }
    assert.equal(g.attempts.length, 0);
  });
  test("missing credentials disables purchases without affecting health", async () => {
    const disabled = await buildApp(
      loadConfig({ DATABASE_URL: TEST_DATABASE_URL, PUBLIC_SITE_URL: origin }),
      db,
      false,
    );
    try {
      assert.deepEqual((await disabled.inject("/api/billing/offer")).json(), {
        available: false,
      });
      assert.equal((await disabled.inject("/health")).statusCode, 200);
    } finally {
      await disabled.close();
    }
  });
  test("strict schema rejects report data, amounts and forged success; disallowed origins denied", async () => {
    const body = await proof("checkout", { reportId, priceId: "price_launch" });
    for (const extra of [
      { paid: true },
      { analysis: { total: 999 } },
      { fileName: "private.csv" },
      { amount: 1 },
    ])
      assert.equal(
        (await post("/api/billing/checkout", { ...body, ...extra })).statusCode,
        400,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/billing/status",
          payload: body,
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject("/api/billing/fulfillment?paid=true")).statusCode,
      404,
    );
    assert.equal((await request("fulfillment")).statusCode, 403);
    assert.equal(await db.reportEntitlement.count(), 0);
  });
  test("device identity is immutable and private keys are rejected", async () => {
    assert.equal(
      (
        await post("/api/billing/buyer", {
          buyerId: buyer.id,
          publicKey: device().publicKey.export({ format: "jwk" }),
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await post("/api/billing/buyer", {
          buyerId: randomUUID(),
          publicKey: buyer.privateKey.export({ format: "jwk" }),
        })
      ).statusCode,
      400,
    );
  });
  test("proof is route/report/owner bound, expires and is consumed once concurrently", async () => {
    let body = await proof("status", { reportId });
    assert.equal(
      (await post("/api/billing/fulfillment", body)).statusCode,
      401,
    );
    assert.equal(
      (
        await post("/api/billing/status", {
          ...body,
          payload: { reportId: randomUUID() },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await post("/api/billing/status", { ...body, buyerId: randomUUID() }))
        .statusCode,
      401,
    );
    const responses = await Promise.all([
      post("/api/billing/status", body),
      post("/api/billing/status", body),
    ]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 401]);
    body = await proof("status", { reportId });
    await db.buyerChallenge.update({
      where: { id: body.challenge },
      data: { expiresAt: new Date(0) },
    });
    assert.equal((await post("/api/billing/status", body)).statusCode, 401);
  });
  test("concurrent checkouts and an ambiguous creation timeout reuse one immutable purchase and Stripe key", async () => {
    g.failAfterCreation = true;
    assert.equal((await checkout()).statusCode, 503);
    const responses = await Promise.all([checkout(), checkout()]);
    assert.ok(
      responses.every((r) => r.statusCode === 200),
      responses.map((r) => r.body).join(),
    );
    assert.equal(await db.reportPurchase.count(), 1);
    assert.equal(g.sessions.size, 1);
    assert.equal(new Set(g.attempts.map((a) => a.key)).size, 1);
    const input = g.attempts[0]!.input;
    assert.equal(input.mode, "payment");
    assert.deepEqual(input.allowed_payment_method_types, ["card"]);
    assert.deepEqual(input.adaptive_pricing, {enabled:false});
    assert.deepEqual(input.line_items, [
      { price: "price_launch", quantity: 1 },
    ]);
    assert.deepEqual(Object.keys(input.metadata!), ["purchase_id"]);
    assert.doesNotMatch(
      JSON.stringify(input),
      /analysis|filename|customer_email|reportId|4900/,
    );
    assert.doesNotMatch(input.success_url!, /session_id|cs_test|buyer|report/i);
  });
  test("cancelled, failed and incomplete payment never grants access; refresh resumes the same checkout", async () => {
    const first = await checkout(),
      again = await checkout();
    assert.equal(first.json().url, again.json().url);
    assert.deepEqual((await request("status")).json(), {
      paid: false,
      revoked: false,
    });
    assert.equal((await request("fulfillment")).statusCode, 403);
    assert.equal(await db.reportEntitlement.count(), 0);
  });
  test("verified server reconciliation fulfills without relying on a browser success URL", async () => {
    await paid();
    assert.deepEqual((await request("status")).json(), {
      paid: true,
      revoked: false,
    });
    const f = await request("fulfillment");
    assert.equal(f.statusCode, 200);
    assert.match(f.body, /ReclaimBayPaid/);
    assert.equal(f.headers["cache-control"], "no-store");
    assert.equal((await checkout()).json().paid, true);
    assert.equal(g.sessions.size, 1);
  });
  test("signed raw-body webhooks are idempotent even concurrently and out of order", async () => {
    const p = await paid(),
      s = await g.session(p.stripeSessionId!);
    const responses = await Promise.all([
      webhook("checkout.session.completed", s, "evt_same"),
      webhook("checkout.session.completed", s, "evt_same"),
    ]);
    assert.ok(
      responses.every((r) => r.statusCode === 200),
      responses.map((r) => r.body).join(),
    );
    assert.equal(
      (await webhook("checkout.session.expired", s, "evt_late")).statusCode,
      200,
    );
    assert.equal(await db.reportEntitlement.count(), 1);
    assert.equal(await db.stripePaymentEvent.count(), 2);
    assert.equal((await purchase()).state, "paid");
  });
  test("invalid signatures, modified raw payloads, stale signatures and wrong-mode events fail", async () => {
    const p = await paid(),
      s = await g.session(p.stripeSessionId!);
    const signed = g.signed("checkout.session.completed", s);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/billing/webhook",
          ...signed,
          payload: signed.payload + " ",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await webhook(
          "checkout.session.completed",
          s,
          undefined,
          Math.floor(Date.now() / 1000) - 600,
        )
      ).statusCode,
      400,
    );
    const raw = JSON.stringify({
      id: "evt_live",
      type: "checkout.session.completed",
      livemode: true,
      data: { object: s },
    });
    // Sign the wrong-mode object using the fixture helper's raw verifier.
    const Stripe = (await import("stripe")).default,
      sdk = new Stripe("sk_test_fixture_only");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/billing/webhook",
          payload: raw,
          headers: {
            "content-type": "application/json",
            "stripe-signature": sdk.webhooks.generateTestHeaderString({
              payload: raw,
              secret: WEBHOOK_FIXTURE_SECRET,
            }),
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(await db.reportEntitlement.count(), 0);
  });
  test("another customer, copied report ID or copied Stripe session ID cannot reuse fulfillment", async () => {
    await paid();
    await request("status");
    const other = device();
    await register(other);
    assert.equal(
      (await request("fulfillment", { reportId }, other)).statusCode,
      403,
    );
    assert.equal(
      (await request("fulfillment", { reportId: randomUUID() })).statusCode,
      403,
    );
    assert.equal(
      (
        await post("/api/billing/status", {
          ...(await proof("status", { reportId })),
          stripeSessionId: (await purchase()).stripeSessionId,
        })
      ).statusCode,
      400,
    );
  });
  test("mismatched amounts, line items, product, identity or incomplete payment intent never fulfill", async () => {
    const p = await paid(),
      original = await g.session(p.stripeSessionId!);
    const variants = [
      (s: Stripe.Checkout.Session) => (s.amount_total = 1),
      (s: Stripe.Checkout.Session) => (s.metadata!.purchase_id = randomUUID()),
      (s: Stripe.Checkout.Session) => (s.line_items!.data[0]!.quantity = 2),
      (s: Stripe.Checkout.Session) =>
        (s.line_items!.data[0]!.price!.product = "prod_other"),
      (s: Stripe.Checkout.Session) =>
        ((s.payment_intent as Stripe.PaymentIntent).status = "processing"),
    ];
    for (const change of variants) {
      const s = structuredClone(original);
      change(s);
      g.sessions.set(s.id, s);
      assert.equal((await request("status")).statusCode, 409);
      assert.equal(await db.reportEntitlement.count(), 0);
    }
  });
  test("refund/dispute revocation is sticky under late payment completion replay", async () => {
    const p = await paid();
    await request("status");
    const s = g.sessions.get(p.stripeSessionId!)!,
      pi = s.payment_intent as Stripe.PaymentIntent;
    (pi.latest_charge as Stripe.Charge).amount_refunded = 4900;
    assert.equal(
      (
        await webhook("charge.refunded", {
          id: "ch_refund",
          payment_intent: pi.id,
        })
      ).statusCode,
      200,
    );
    (pi.latest_charge as Stripe.Charge).amount_refunded = 0;
    assert.equal(
      (await webhook("checkout.session.completed", s)).statusCode,
      200,
    );
    assert.deepEqual((await request("status")).json(), {
      paid: false,
      revoked: true,
    });
    assert.equal((await request("fulfillment")).statusCode, 403);
    assert.equal((await checkout()).json().revoked, true);
    assert.equal(g.sessions.size, 1);
  });
  test("price rotation honors historical checkout snapshots and existing entitlements", async () => {
    await checkout();
    const p = await purchase();
    g.prices.set("price_next", {
      ...g.prices.get("price_launch")!,
      id: "price_next",
      unit_amount: 5900,
    });
    c.billing.priceId = "price_next";
    assert.equal(
      (
        await request("checkout", {
          reportId: randomUUID(),
          priceId: "price_launch",
        })
      ).statusCode,
      409,
    );
    g.pay(p.stripeSessionId!);
    assert.equal((await request("status")).json().paid, true);
    assert.equal((await purchase()).unitAmount, 4900);
    assert.equal((await request("fulfillment")).statusCode, 200);
    c.billing.priceId = null;
    assert.deepEqual((await app.inject("/api/billing/offer")).json(), {
      available: false,
    });
    assert.equal((await request("status")).json().paid, true);
    assert.equal((await request("fulfillment")).statusCode, 200);
    const next = await request("checkout", {
      reportId: randomUUID(),
      priceId: "price_next",
    });
    assert.equal(next.statusCode, 503);
  });
  test("only a confirmed expired session allows a new attempt; unknown old creation requires review", async () => {
    await checkout();
    const p = await purchase();
    g.sessions.get(p.stripeSessionId!)!.status = "expired";
    assert.equal((await checkout()).statusCode, 200);
    assert.equal(g.sessions.size, 2);
    const otherReport = randomUUID();
    await db.reportPurchase.create({
      data: {
        buyerId: buyer.id,
        reportId: otherReport,
        activeKey: `${buyer.id}:${otherReport}`,
        priceId: "price_launch",
        productId: "prod_report",
        unitAmount: 4900,
        currency: "usd",
        livemode: false,
        createdAt: new Date(Date.now() - 24 * 3600000),
      },
    });
    assert.equal(
      (
        await request("checkout", {
          reportId: otherReport,
          priceId: "price_launch",
        })
      ).json().error,
      "checkout_needs_review",
    );
    assert.equal(g.sessions.size, 2);
  });
  test("billing CORS preflight is scoped without disrupting anonymous analytics", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/billing/checkout",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], origin);
    const analytics = await app.inject({
      method: "OPTIONS",
      url: "/api/events",
      headers: { origin, "access-control-request-method": "POST" },
    });
    assert.equal(analytics.statusCode, 204);
    const denied = await app.inject({
      method: "OPTIONS",
      url: "/api/billing/checkout",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "POST",
      },
    });
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  });
  test("a signed webhook arriving before creation response is reconciled once without overwriting paid state", async () => {
    const create = g.create.bind(g);
    g.create = async (input, key) => {
      const s = await create(input, key);
      g.pay(s.id);
      assert.equal(
        (await webhook("checkout.session.completed", await g.session(s.id)))
          .statusCode,
        200,
      );
      return s;
    };
    assert.equal((await checkout()).statusCode, 200);
    assert.equal((await purchase()).state, "paid");
    assert.equal(await db.reportEntitlement.count(), 1);
    assert.equal((await request("status")).json().paid, true);
  });
  test("fast webhook metadata cannot attach a mismatched Stripe session to a purchase", async () => {
    g.failAfterCreation = true;
    await checkout();
    const p = await purchase();
    assert.equal(p.stripeSessionId, null);
    const s = [...g.sessions.values()][0]!;
    s.client_reference_id = randomUUID();
    assert.equal(
      (await webhook("checkout.session.completed", s)).statusCode,
      409,
    );
    assert.equal((await purchase()).stripeSessionId, null);
    assert.equal(await db.reportEntitlement.count(), 0);
  });
  test("disputes revoke access and refunded payment observed before first fulfillment cannot grant it", async () => {
    const p = await paid();
    await request("status");
    const s = g.sessions.get(p.stripeSessionId!)!,
      pi = s.payment_intent as Stripe.PaymentIntent;
    (pi.latest_charge as Stripe.Charge).disputed = true;
    assert.equal(
      (
        await webhook("charge.dispute.created", {
          id: "dp_fixture",
          payment_intent: pi.id,
        })
      ).statusCode,
      200,
    );
    assert.equal((await request("fulfillment")).statusCode, 403);
    reportId = randomUUID();
    const second = await paid(),
      secondPi = g.sessions.get(second.stripeSessionId!)!
        .payment_intent as Stripe.PaymentIntent;
    (secondPi.latest_charge as Stripe.Charge).refunded = true;
    assert.equal((await request("status")).json().paid, false);
    assert.equal((await request("fulfillment")).statusCode, 403);
    assert.equal(await db.reportEntitlement.count(), 1);
  });
  test("provider failures never fulfill, and logs exclude raw webhook PII and device proofs", async () => {
    await app.close();
    const lines: string[] = [];
    app = await buildApp(c, db, true, {
      paymentGateway: g,
      paidReportBundle: "fixture",
      logStream: {
        write: (line) => {
          lines.push(line);
        },
      },
    });
    await checkout();
    g.session = async () => {
      throw Error(
        "Stripe fixture failure with PRIVATE_STRIPE_CUSTOMER@example.test",
      );
    };
    const body = await proof("status", { reportId });
    const r = await post("/api/billing/status", body);
    assert.equal(r.statusCode, 503);
    const object = {
      id: "cs_unknown",
      metadata: {},
      customer_details: { email: "PRIVATE_WEBHOOK_CUSTOMER@example.test" },
    };
    await webhook("checkout.session.completed", object);
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(
      lines.join(""),
      /PRIVATE_STRIPE_CUSTOMER|PRIVATE_WEBHOOK_CUSTOMER|publicKey|stripe-signature/,
    );
    assert(!lines.join("").includes(body.signature));
    assert.equal(await db.reportEntitlement.count(), 0);
  });
});
