ALTER TABLE "OutreachControlChange" ADD COLUMN "dailyLimit" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN "activeCampaignId" UUID;
ALTER TABLE "OutreachControlChange" ADD CONSTRAINT "OutreachControlChange_dailyLimit_check" CHECK ("dailyLimit" BETWEEN 1 AND 500);

CREATE TABLE "OutreachCampaign" (
  "id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "attributionCampaign" VARCHAR(64) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutreachCampaign_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "OutreachCampaignMessage" (
  "campaignId" UUID NOT NULL,
  "outreachId" UUID NOT NULL,
  "messageHash" CHAR(64) NOT NULL,
  CONSTRAINT "OutreachCampaignMessage_pkey" PRIMARY KEY ("campaignId", "outreachId")
);
CREATE INDEX "OutreachCampaignMessage_outreachId_idx" ON "OutreachCampaignMessage"("outreachId");
ALTER TABLE "OutreachControlChange" ADD CONSTRAINT "OutreachControlChange_activeCampaignId_fkey" FOREIGN KEY ("activeCampaignId") REFERENCES "OutreachCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutreachCampaignMessage" ADD CONSTRAINT "OutreachCampaignMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutreachCampaignMessage" ADD CONSTRAINT "OutreachCampaignMessage_outreachId_fkey" FOREIGN KEY ("outreachId") REFERENCES "Outreach"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- No campaign is approved, no message queued, and no sending switch enabled.
