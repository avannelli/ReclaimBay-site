-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('bounced', 'complained', 'unsubscribed', 'invalid');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutreachEventType" ADD VALUE 'complained';
ALTER TYPE "OutreachEventType" ADD VALUE 'unsubscribed';

-- AlterEnum: a rename keeps any recorded reply outcome.
ALTER TYPE "ReplyOutcome" RENAME VALUE 'unsubscribe' TO 'do_not_contact';

-- AlterTable
ALTER TABLE "Outreach" ADD COLUMN     "lastSendError" VARCHAR(500),
ADD COLUMN     "sendAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sendStartedAt" TIMESTAMP(3),
ADD COLUMN     "unsubscribeToken" VARCHAR(64);

-- AlterTable
ALTER TABLE "OutreachEvent" ADD COLUMN     "providerEventId" VARCHAR(200);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "detail" VARCHAR(500),
    "outreachId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachControlChange" (
    "id" UUID NOT NULL,
    "sendingEnabled" BOOLEAN NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachControlChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");

-- CreateIndex
CREATE INDEX "OutreachControlChange_createdAt_idx" ON "OutreachControlChange"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Outreach_unsubscribeToken_key" ON "Outreach"("unsubscribeToken");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachEvent_providerEventId_key" ON "OutreachEvent"("providerEventId");

