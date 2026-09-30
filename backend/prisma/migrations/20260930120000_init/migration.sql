-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProspectStatus" AS ENUM ('new', 'contacted', 'active', 'archived');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('landing_view', 'upload_started', 'scan_completed', 'tour_completed', 'report_exported');

-- CreateEnum
CREATE TYPE "ExportType" AS ENUM ('pdf', 'csv', 'copied_summary');

-- CreateTable
CREATE TABLE "Prospect" (
    "id" UUID NOT NULL,
    "referralCode" TEXT NOT NULL,
    "businessName" TEXT,
    "website" TEXT,
    "status" "ProspectStatus" NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSession" (
    "id" UUID NOT NULL,
    "anonymousSessionId" UUID NOT NULL,
    "prospectId" UUID,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "prospectId" UUID,
    "eventType" "EventType" NOT NULL,
    "campaign" VARCHAR(64),
    "exportType" "ExportType",
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Prospect_referralCode_key" ON "Prospect"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSession_anonymousSessionId_key" ON "AnalyticsSession"("anonymousSessionId");

-- CreateIndex
CREATE INDEX "AnalyticsSession_prospectId_idx" ON "AnalyticsSession"("prospectId");

-- CreateIndex
CREATE INDEX "AnalyticsSession_lastSeenAt_idx" ON "AnalyticsSession"("lastSeenAt");

-- CreateIndex
CREATE INDEX "ProductEvent_sessionId_createdAt_idx" ON "ProductEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_prospectId_eventType_idx" ON "ProductEvent"("prospectId", "eventType");

-- CreateIndex
CREATE INDEX "ProductEvent_eventType_isSample_createdAt_idx" ON "ProductEvent"("eventType", "isSample", "createdAt");

-- AddForeignKey
ALTER TABLE "AnalyticsSession" ADD CONSTRAINT "AnalyticsSession_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnalyticsSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

