-- M1: bounded autonomous campaign authorization and the record of each prospect created under one.
-- Additive only. Existing campaigns become mode 'selected' and keep every value; no campaign is
-- authorized, no prospect is created, and no sending control changes.

-- CreateEnum
CREATE TYPE "CampaignMode" AS ENUM ('selected', 'autonomous');

-- AlterTable
ALTER TABLE "OutreachCampaign" ADD COLUMN     "authorizedAt" TIMESTAMP(3),
ADD COLUMN     "authorizedReason" VARCHAR(500),
ADD COLUMN     "authorizedVia" VARCHAR(32),
ADD COLUMN     "commercialMinimum" VARCHAR(16),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "messageCap" INTEGER,
ADD COLUMN     "mode" "CampaignMode" NOT NULL DEFAULT 'selected',
ADD COLUMN     "policyVersions" JSONB,
ADD COLUMN     "prospectCap" INTEGER,
ADD COLUMN     "stopReason" VARCHAR(500),
ADD COLUMN     "stoppedAt" TIMESTAMP(3);

-- An autonomous campaign always carries its bounds and its authorization.
ALTER TABLE "OutreachCampaign" ADD CONSTRAINT "OutreachCampaign_autonomous_bounds_check" CHECK (
  "mode" = 'selected' OR (
    "prospectCap" BETWEEN 1 AND 100 AND "messageCap" BETWEEN 1 AND 250 AND
    "expiresAt" IS NOT NULL AND "expiresAt" > "startedAt" AND
    "commercialMinimum" IN ('high', 'medium') AND
    "authorizedAt" IS NOT NULL AND "authorizedReason" IS NOT NULL AND "authorizedVia" IS NOT NULL AND "policyVersions" IS NOT NULL
  )
);
-- A stop always records why.
ALTER TABLE "OutreachCampaign" ADD CONSTRAINT "OutreachCampaign_stop_reason_check" CHECK (("stoppedAt" IS NULL) = ("stopReason" IS NULL));

-- CreateTable
CREATE TABLE "OutreachCampaignProspect" (
    "campaignId" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "prospectId" UUID NOT NULL,
    "researchId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "policyVersions" JSONB NOT NULL,
    "commercialDisposition" VARCHAR(16) NOT NULL,
    "commercialConfidence" VARCHAR(16) NOT NULL,

    CONSTRAINT "OutreachCampaignProspect_pkey" PRIMARY KEY ("campaignId","candidateId")
);

-- Only a commercial fit at medium or high confidence can ever be created automatically.
ALTER TABLE "OutreachCampaignProspect" ADD CONSTRAINT "OutreachCampaignProspect_commercial_check" CHECK ("commercialDisposition" = 'fit' AND "commercialConfidence" IN ('high', 'medium'));

-- CreateIndex
CREATE UNIQUE INDEX "OutreachCampaignProspect_candidateId_key" ON "OutreachCampaignProspect"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachCampaignProspect_prospectId_key" ON "OutreachCampaignProspect"("prospectId");

-- AddForeignKey
ALTER TABLE "OutreachCampaignProspect" ADD CONSTRAINT "OutreachCampaignProspect_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachCampaignProspect" ADD CONSTRAINT "OutreachCampaignProspect_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "DiscoveryCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachCampaignProspect" ADD CONSTRAINT "OutreachCampaignProspect_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
