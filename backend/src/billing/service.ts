import type Stripe from "stripe";
import type { Db } from "../db.js";
import type { Config } from "../config.js";
import type { ReportPurchase } from "../generated/prisma/client.js";
import { BillingError } from "./identity.js";
import { currentOffer, type PaymentGateway } from "./stripe.js";

export class ReportBilling {
  constructor(
    readonly db: Db,
    readonly gateway: PaymentGateway,
    readonly config: Config,
  ) {}
  async entitlement(buyerId: string, reportId: string) {
    return this.db.reportEntitlement.findUnique({
      where: { buyerId_reportId: { buyerId, reportId } },
    });
  }
  async checkout(buyerId: string, reportId: string, offeredPriceId: string) {
    const existing = await this.entitlement(buyerId, reportId);
    if (existing)
      return {
        paid: !existing.revokedAt,
        revoked: !!existing.revokedAt,
        url: null,
      };
    // Reconcile an existing attempt before deciding whether another may be made.
    const before = await this.db.reportPurchase.findUnique({
      where: { activeKey: `${buyerId}:${reportId}` },
    });
    if (before?.stripeSessionId) await this.reconcile(before);
    const offer = await currentOffer(this.gateway, this.config.billing);
    if (offer.priceId !== offeredPriceId)
      throw new BillingError(409, "price_changed");
    const purchase = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`report:${buyerId}:${reportId}`},0))::text`;
      const paid = await tx.reportEntitlement.findUnique({
        where: { buyerId_reportId: { buyerId, reportId } },
      });
      if (paid)
        throw new BillingError(
          409,
          paid.revokedAt ? "purchase_revoked" : "already_paid",
        );
      const pending = await tx.reportPurchase.findUnique({
        where: { activeKey: `${buyerId}:${reportId}` },
      });
      return (
        pending ??
        tx.reportPurchase.create({
          data: {
            buyerId,
            reportId,
            activeKey: `${buyerId}:${reportId}`,
            priceId: offer.priceId,
            productId: offer.productId,
            unitAmount: offer.amount,
            currency: offer.currency,
            livemode: offer.livemode,
          },
        })
      );
    });
    if (purchase.revokedAt) throw new BillingError(403, "purchase_revoked");
    if (purchase.stripeSessionId) {
      const s = await this.gateway.session(purchase.stripeSessionId);
      return {
        paid: false,
        url: s.url,
        amount: purchase.unitAmount,
        currency: purchase.currency,
      };
    }
    // Stripe may prune idempotency keys after 24h. An unknown old creation must
    // be reviewed, never retried with a potentially forgotten key and recharged.
    if (Date.now() - purchase.createdAt.getTime() > 23 * 60 * 60 * 1000)
      throw new BillingError(409, "checkout_needs_review");
    const base = new URL(this.config.publicSiteUrl);
    const success = new URL("/checkout-return?result=complete", base).href,
      cancel = new URL("/checkout-return?result=cancelled", base).href;
    const s = await this.gateway.create(
      {
        mode: "payment",
        allowed_payment_method_types: ["card"],
        adaptive_pricing: { enabled: false },
        line_items: [{ price: purchase.priceId, quantity: 1 }],
        client_reference_id: purchase.id,
        metadata: { purchase_id: purchase.id },
        success_url: success,
        cancel_url: cancel,
        allow_promotion_codes: false,
        expires_at:
          Math.floor(purchase.createdAt.getTime() / 1000) + 24 * 60 * 60,
      },
      `reclaimbay-report-${purchase.id}`,
    );
    if (
      s.mode !== "payment" ||
      s.livemode !== purchase.livemode ||
      s.client_reference_id !== purchase.id ||
      s.metadata?.purchase_id !== purchase.id ||
      !s.url ||
      !/^https:\/\/checkout\.stripe\.com\//.test(s.url)
    )
      throw new BillingError(502, "invalid_checkout_response");
    await this.db.reportPurchase.updateMany({
      where: { id: purchase.id, stripeSessionId: null },
      data: { stripeSessionId: s.id, state: "open" },
    });
    return {
      paid: false,
      url: s.url,
      amount: purchase.unitAmount,
      currency: purchase.currency,
    };
  }
  async status(buyerId: string, reportId: string) {
    let e = await this.entitlement(buyerId, reportId);
    if (!e) {
      const p = await this.db.reportPurchase.findFirst({
        where: { buyerId, reportId },
        orderBy: { createdAt: "desc" },
      });
      if (p?.stripeSessionId) await this.reconcile(p);
      e = await this.entitlement(buyerId, reportId);
    }
    return { paid: !!e && !e.revokedAt, revoked: !!e?.revokedAt };
  }
  async reconcile(
    purchase: ReportPurchase,
    event?: { id: string; type: string },
  ) {
    if (!purchase.stripeSessionId)
      throw new BillingError(409, "checkout_pending");
    const s = await this.gateway.session(purchase.stripeSessionId);
    const pi =
      typeof s.payment_intent === "object"
        ? (s.payment_intent as Stripe.PaymentIntent | null)
        : null;
    const charge =
      pi && typeof pi.latest_charge === "object"
        ? (pi.latest_charge as Stripe.Charge | null)
        : null;
    const lines = s.line_items?.data ?? [],
      line = lines[0];
    const identity =
      s.id === purchase.stripeSessionId &&
      s.mode === "payment" &&
      s.livemode === purchase.livemode &&
      s.client_reference_id === purchase.id &&
      s.metadata?.purchase_id === purchase.id;
    if (!identity) throw new BillingError(409, "payment_identity_mismatch");
    const revoked =
      !!charge &&
      (charge.refunded || charge.amount_refunded > 0 || charge.disputed);
    const paid =
      s.status === "complete" &&
      s.payment_status === "paid" &&
      s.currency === purchase.currency &&
      s.amount_total === purchase.unitAmount &&
      lines.length === 1 &&
      !s.line_items?.has_more &&
      line?.quantity === 1 &&
      line.price?.id === purchase.priceId &&
      line.price.product === purchase.productId &&
      line.amount_total === purchase.unitAmount &&
      pi?.status === "succeeded" &&
      pi.currency === purchase.currency &&
      pi.amount === purchase.unitAmount &&
      pi.amount_received === purchase.unitAmount &&
      pi.livemode === purchase.livemode &&
      !!charge &&
      charge.paid;
    if (s.payment_status === "paid" && !paid)
      throw new BillingError(409, "payment_evidence_mismatch");
    await this.db.$transaction(async (tx) => {
      if (
        event &&
        (await tx.stripePaymentEvent.findUnique({ where: { id: event.id } }))
      )
        return;
      await tx.$queryRaw`SELECT id FROM "ReportPurchase" WHERE id=${purchase.id}::uuid FOR UPDATE`;
      const p = await tx.reportPurchase.findUniqueOrThrow({
        where: { id: purchase.id },
      });
      if (
        event &&
        (await tx.stripePaymentEvent.findUnique({ where: { id: event.id } }))
      )
        return;
      if (revoked || p.revokedAt) {
        const at = p.revokedAt ?? new Date();
        await tx.reportPurchase.update({
          where: { id: p.id },
          data: { state: "revoked", revokedAt: at, activeKey: null },
        });
        await tx.reportEntitlement.updateMany({
          where: { purchaseId: p.id, revokedAt: null },
          data: { revokedAt: at },
        });
      } else if (paid) {
        await tx.reportPurchase.update({
          where: { id: p.id },
          data: {
            state: "paid",
            paidAt: p.paidAt ?? new Date(),
            activeKey: null,
            paymentIntentId: pi!.id,
          },
        });
        await tx.reportEntitlement.upsert({
          where: {
            buyerId_reportId: { buyerId: p.buyerId, reportId: p.reportId },
          },
          update: {},
          create: {
            buyerId: p.buyerId,
            reportId: p.reportId,
            purchaseId: p.id,
          },
        });
      } else if (s.status === "expired")
        await tx.reportPurchase.update({
          where: { id: p.id },
          data: { state: "expired", activeKey: null },
        });
      if (event) await tx.stripePaymentEvent.create({ data: event });
    });
  }
  async webhook(event: Stripe.Event) {
    if (event.livemode !== (this.config.billing.mode === "live"))
      throw new BillingError(400, "wrong_stripe_mode");
    if (
      await this.db.stripePaymentEvent.findUnique({ where: { id: event.id } })
    )
      return;
    let p: ReportPurchase | null = null;
    const object = event.data.object as {
      id: string;
      payment_intent?: string | { id: string };
    };
    if (
      [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
      ].includes(event.type)
    )
      p = await this.db.reportPurchase.findUnique({
        where: { stripeSessionId: object.id },
      });
    else if (
      ["charge.refunded", "charge.dispute.created"].includes(event.type)
    ) {
      const pi =
        typeof object.payment_intent === "string"
          ? object.payment_intent
          : object.payment_intent?.id;
      if (pi)
        p = await this.db.reportPurchase.findUnique({
          where: { paymentIntentId: pi },
        });
    } else return;
    // A very fast webhook may arrive before the creation response was saved.
    // Match only the server-generated purchase ID from a Checkout event.
    if (!p && event.type.startsWith("checkout.session.")) {
      const o = event.data.object as Stripe.Checkout.Session;
      if (
        o.metadata?.purchase_id &&
        /^[0-9a-f-]{36}$/i.test(o.metadata.purchase_id)
      ) {
        const candidate = await this.db.reportPurchase.findUnique({
          where: { id: o.metadata.purchase_id },
        });
        if (candidate) {
          const verified = await this.gateway.session(o.id);
          if (
            verified.id !== o.id ||
            verified.mode !== "payment" ||
            verified.livemode !== candidate.livemode ||
            verified.client_reference_id !== candidate.id ||
            verified.metadata?.purchase_id !== candidate.id
          )
            throw new BillingError(409, "payment_identity_mismatch");
          await this.db.reportPurchase.updateMany({
            where: { id: candidate.id, stripeSessionId: null },
            data: { stripeSessionId: o.id },
          });
          p = await this.db.reportPurchase.findUnique({
            where: { id: candidate.id },
          });
        }
      }
    }
    if (p) await this.reconcile(p, { id: event.id, type: event.type });
  }
}
