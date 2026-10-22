import Stripe from "stripe";
import type { PaymentGateway } from "../../src/billing/stripe.js";

/** Local fixtures only. Never used by the production gateway or config. */
export const WEBHOOK_FIXTURE_SECRET = "whsec_local_signed_fixture_only";
const sdk = new Stripe("sk_test_local_fixture_not_a_real_key");
export class FixturePayments implements PaymentGateway {
  prices = new Map<string, Stripe.Price>([
    [
      "price_launch",
      {
        id: "price_launch",
        object: "price",
        active: true,
        type: "one_time",
        currency: "usd",
        unit_amount: 4900,
        product: "prod_report",
        livemode: false,
      } as Stripe.Price,
    ],
  ]);
  sessions = new Map<string, Stripe.Checkout.Session>();
  attempts: { input: Stripe.Checkout.SessionCreateParams; key: string }[] = [];
  keys = new Map<string, string>();
  failAfterCreation = false;
  async price(id: string) {
    const p = this.prices.get(id);
    if (!p) throw Error("Fixture price missing");
    return structuredClone(p);
  }
  async create(input: Stripe.Checkout.SessionCreateParams, key: string) {
    this.attempts.push({ input: structuredClone(input), key });
    let id = this.keys.get(key);
    if (!id) {
      id = "cs_test_fixture_" + (this.sessions.size + 1);
      this.keys.set(key, id);
      const price = await this.price(input.line_items![0]!.price!);
      this.sessions.set(id, {
        id,
        object: "checkout.session",
        mode: "payment",
        livemode: false,
        status: "open",
        payment_status: "unpaid",
        client_reference_id: input.client_reference_id,
        metadata: input.metadata,
        url: "https://checkout.stripe.com/c/pay/" + id,
        currency: "usd",
        amount_total: price.unit_amount,
        payment_intent: null,
        line_items: {
          object: "list",
          data: [
            {
              id: "li_fixture",
              object: "item",
              quantity: 1,
              price,
              amount_total: price.unit_amount,
            },
          ],
          has_more: false,
          url: "",
        },
      } as Stripe.Checkout.Session);
    }
    if (this.failAfterCreation) {
      this.failAfterCreation = false;
      throw Error("Simulated response timeout");
    }
    return this.session(id);
  }
  async session(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw Error("Fixture session missing");
    return structuredClone(s);
  }
  pay(id: string) {
    const s = this.sessions.get(id)!;
    Object.assign(s, {
      status: "complete",
      payment_status: "paid",
      url: null,
      payment_intent: {
        id: "pi_" + id,
        object: "payment_intent",
        status: "succeeded",
        currency: "usd",
        amount: s.amount_total,
        amount_received: s.amount_total,
        livemode: false,
        latest_charge: {
          id: "ch_" + id,
          object: "charge",
          paid: true,
          refunded: false,
          amount_refunded: 0,
          disputed: false,
        },
      },
    });
    return s;
  }
  event(raw: Buffer, signature: string, secret: string) {
    return sdk.webhooks.constructEvent(raw, signature, secret, 300);
  }
  signed(
    type: string,
    object: unknown,
    id = "evt_" + crypto.randomUUID(),
    timestamp?: number,
  ) {
    const payload = JSON.stringify({
      id,
      object: "event",
      type,
      livemode: false,
      data: { object },
    });
    return {
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sdk.webhooks.generateTestHeaderString({
          payload,
          secret: WEBHOOK_FIXTURE_SECRET,
          timestamp,
        }),
      },
    };
  }
}
