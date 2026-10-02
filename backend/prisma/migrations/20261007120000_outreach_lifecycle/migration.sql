-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('draft', 'queued', 'sent', 'delivered', 'bounced', 'failed', 'replied', 'cancelled');

-- CreateEnum
CREATE TYPE "OutreachKind" AS ENUM ('initial', 'follow_up');

-- CreateEnum
CREATE TYPE "ReplyOutcome" AS ENUM ('interested', 'not_interested', 'unsubscribe', 'other');

-- CreateEnum
CREATE TYPE "OutreachEventType" AS ENUM ('drafted', 'queued', 'sent', 'delivered', 'bounced', 'failed', 'replied', 'cancelled');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProspectStatus" ADD VALUE 'meeting' AFTER 'engaged';
ALTER TYPE "ProspectStatus" ADD VALUE 'proposal' BEFORE 'customer';
ALTER TYPE "ProspectStatus" ADD VALUE 'lost' AFTER 'not_a_fit';

-- CreateTable
CREATE TABLE "Outreach" (
    "id" UUID NOT NULL,
    "prospectId" UUID NOT NULL,
    "kind" "OutreachKind" NOT NULL,
    "followUpOfId" UUID,
    "template" VARCHAR(40) NOT NULL,
    "campaign" VARCHAR(64),
    "subject" VARCHAR(200) NOT NULL,
    "body" VARCHAR(5000) NOT NULL,
    "evidence" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "recipientEmail" VARCHAR(254) NOT NULL,
    "recipientSourceUrl" VARCHAR(500) NOT NULL,
    "senderName" VARCHAR(120),
    "senderEmail" VARCHAR(254),
    "status" "OutreachStatus" NOT NULL DEFAULT 'draft',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openForProspectId" UUID,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" VARCHAR(500),
    "repliedAt" TIMESTAMP(3),
    "replyOutcome" "ReplyOutcome",
    "replySummary" VARCHAR(2000),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" VARCHAR(500),
    "provider" VARCHAR(40),
    "providerMessageId" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachEvent" (
    "id" UUID NOT NULL,
    "outreachId" UUID NOT NULL,
    "type" "OutreachEventType" NOT NULL,
    "detail" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Outreach_openForProspectId_key" ON "Outreach"("openForProspectId");

-- CreateIndex
CREATE UNIQUE INDEX "Outreach_providerMessageId_key" ON "Outreach"("providerMessageId");

-- CreateIndex
CREATE INDEX "Outreach_prospectId_createdAt_idx" ON "Outreach"("prospectId", "createdAt");

-- CreateIndex
CREATE INDEX "Outreach_status_statusChangedAt_idx" ON "Outreach"("status", "statusChangedAt");

-- CreateIndex
CREATE INDEX "OutreachEvent_outreachId_createdAt_idx" ON "OutreachEvent"("outreachId", "createdAt");

-- CreateIndex
CREATE INDEX "OutreachEvent_type_createdAt_idx" ON "OutreachEvent"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "Outreach" ADD CONSTRAINT "Outreach_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outreach" ADD CONSTRAINT "Outreach_followUpOfId_fkey" FOREIGN KEY ("followUpOfId") REFERENCES "Outreach"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_outreachId_fkey" FOREIGN KEY ("outreachId") REFERENCES "Outreach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

