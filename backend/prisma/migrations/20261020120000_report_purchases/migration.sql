-- Additive purchase ledger only. No report data, outreach or acquisition changes.
CREATE TABLE "ReportBuyer" (
 "id" UUID PRIMARY KEY, "publicKey" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BuyerChallenge" (
 "id" UUID PRIMARY KEY, "buyerId" UUID NOT NULL REFERENCES "ReportBuyer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3)
);
CREATE INDEX "BuyerChallenge_expiresAt_idx" ON "BuyerChallenge"("expiresAt");
CREATE TABLE "ReportPurchase" (
 "id" UUID PRIMARY KEY, "buyerId" UUID NOT NULL REFERENCES "ReportBuyer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "reportId" UUID NOT NULL, "activeKey" VARCHAR(80) UNIQUE, "state" VARCHAR(24) NOT NULL DEFAULT 'creating',
 "priceId" VARCHAR(200) NOT NULL, "productId" VARCHAR(200) NOT NULL, "unitAmount" INTEGER NOT NULL CHECK ("unitAmount">0),
 "currency" VARCHAR(3) NOT NULL CHECK ("currency"='usd'), "livemode" BOOLEAN NOT NULL,
 "stripeSessionId" VARCHAR(200) UNIQUE, "paymentIntentId" VARCHAR(200) UNIQUE,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "paidAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
 CONSTRAINT "ReportPurchase_state_check" CHECK ("state" IN ('creating','open','paid','expired','revoked'))
);
CREATE INDEX "ReportPurchase_buyerId_reportId_createdAt_idx" ON "ReportPurchase"("buyerId","reportId","createdAt");
CREATE TABLE "ReportEntitlement" (
 "id" UUID PRIMARY KEY, "buyerId" UUID NOT NULL REFERENCES "ReportBuyer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "reportId" UUID NOT NULL, "purchaseId" UUID NOT NULL UNIQUE REFERENCES "ReportPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMP(3),
 UNIQUE ("buyerId","reportId")
);
CREATE TABLE "StripePaymentEvent" (
 "id" VARCHAR(200) PRIMARY KEY, "type" VARCHAR(100) NOT NULL, "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
