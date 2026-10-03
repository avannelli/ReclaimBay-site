-- Invitations (Stage 4A). Additive only: a new table, and a nullable column on
-- AnalyticsSession. Only a SHA-256 hash of each public token is stored.


-- AlterTable
ALTER TABLE "AnalyticsSession" ADD COLUMN     "invitationId" UUID;

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "prospectId" UUID NOT NULL,
    "outreachId" UUID NOT NULL,
    "campaign" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(200),
    "firstOpenedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_outreachId_key" ON "Invitation"("outreachId");

-- CreateIndex
CREATE INDEX "Invitation_prospectId_idx" ON "Invitation"("prospectId");

-- CreateIndex
CREATE INDEX "Invitation_campaign_idx" ON "Invitation"("campaign");

-- CreateIndex
CREATE INDEX "AnalyticsSession_invitationId_idx" ON "AnalyticsSession"("invitationId");

-- AddForeignKey
ALTER TABLE "AnalyticsSession" ADD CONSTRAINT "AnalyticsSession_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "Invitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_outreachId_fkey" FOREIGN KEY ("outreachId") REFERENCES "Outreach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

