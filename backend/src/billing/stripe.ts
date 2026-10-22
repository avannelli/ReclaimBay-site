import Stripe from "stripe";
import type { Config } from "../config.js";
import { BillingError } from "./identity.js";

export interface PaymentGateway {
  price(id: string): Promise<Stripe.Price>;
  create(
    input: Stripe.Checkout.SessionCreateParams,
    key: string,
  ): Promise<Stripe.Checkout.Session>;
  session(id: string): Promise<Stripe.Checkout.Session>;
  event(raw: Buffer, signature: string, secret: string): Stripe.Event;
}
export function stripeGateway(
  c: Config["billing"],
  production?: { siteUrl: string },
): PaymentGateway | null {
  if (!c.secretKey || !c.webhookSecret) return null;
  if (!new RegExp(`^(sk|rk)_${c.mode}_`).test(c.secretKey))
    throw new Error("Stripe key and STRIPE_MODE disagree.");
  // Deployed, test cards would unlock real reports, and paying customers must
  // never be returned to a development URL.
  if (
    production &&
    (c.mode !== "live" || new URL(production.siteUrl).protocol !== "https:")
  )
    throw new Error(
      "Production purchases require STRIPE_MODE=live and an HTTPS PUBLIC_SITE_URL.",
    );
  const s = new Stripe(c.secretKey, { timeout: 10_000, maxNetworkRetries: 1 });
  return {
    price: (id) => s.prices.retrieve(id),
    create: (input, key) =>
      s.checkout.sessions.create(input, { idempotencyKey: key }),
    session: (id) =>
      s.checkout.sessions.retrieve(id, {
        expand: ["line_items.data.price", "payment_intent.latest_charge"],
      }),
    event: (raw, sig, secret) =>
      s.webhooks.constructEvent(raw, sig, secret, 300),
  };
}
export async function currentOffer(g: PaymentGateway, c: Config["billing"]) {
  if (!c.priceId || !c.productId)
    throw new BillingError(503, "payments_not_configured");
  const p = await g.price(c.priceId!);
  if (
    p.id !== c.priceId ||
    !p.active ||
    p.type !== "one_time" ||
    p.currency !== "usd" ||
    !Number.isSafeInteger(p.unit_amount) ||
    p.unit_amount! <= 0 ||
    p.livemode !== (c.mode === "live") ||
    p.product !== c.productId
  )
    throw new BillingError(503, "invalid_report_price");
  return {
    priceId: p.id,
    productId: c.productId!,
    amount: p.unit_amount!,
    currency: "usd",
    livemode: p.livemode,
  };
}
