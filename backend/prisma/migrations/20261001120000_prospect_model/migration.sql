-- CreateEnum
CREATE TYPE "SignalValue" AS ENUM ('yes', 'no');

-- AlterEnum: ProspectStatus (Milestone 2 lifecycle)
-- Existing values are preserved, except the retired `active`:
--   new -> new, contacted -> contacted, active -> engaged, archived -> archived
BEGIN;
CREATE TYPE "ProspectStatus_new" AS ENUM ('new', 'qualified', 'ready_to_contact', 'contacted', 'engaged', 'customer', 'not_a_fit', 'do_not_contact', 'archived');
ALTER TABLE "Prospect" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Prospect" ALTER COLUMN "status" TYPE "ProspectStatus_new" USING (
  CASE "status"::text
    WHEN 'active' THEN 'engaged'
    ELSE "status"::text
  END
)::"ProspectStatus_new";
ALTER TYPE "ProspectStatus" RENAME TO "ProspectStatus_old";
ALTER TYPE "ProspectStatus_new" RENAME TO "ProspectStatus";
DROP TYPE "ProspectStatus_old";
ALTER TABLE "Prospect" ALTER COLUMN "status" SET DEFAULT 'new';
COMMIT;

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "city" VARCHAR(100),
ADD COLUMN     "country" CHAR(2) NOT NULL DEFAULT 'US',
ADD COLUMN     "email" VARCHAR(254),
ADD COLUMN     "emailSourceUrl" VARCHAR(500),
ADD COLUMN     "phone" VARCHAR(30),
ADD COLUMN     "phoneSourceUrl" VARCHAR(500),
ADD COLUMN     "postalCode" VARCHAR(20),
ADD COLUMN     "score" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scoreVersion" VARCHAR(32),
ADD COLUMN     "scoredAt" TIMESTAMP(3),
ADD COLUMN     "state" VARCHAR(50),
ADD COLUMN     "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "ProspectSignal" (
    "id" UUID NOT NULL,
    "prospectId" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "value" "SignalValue" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectEvidence" (
    "id" UUID NOT NULL,
    "prospectId" UUID NOT NULL,
    "signalKey" VARCHAR(64) NOT NULL,
    "sourceUrl" VARCHAR(500) NOT NULL,
    "excerpt" VARCHAR(280) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectNote" (
    "id" UUID NOT NULL,
    "prospectId" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectStatusChange" (
    "id" UUID NOT NULL,
    "prospectId" UUID NOT NULL,
    "fromStatus" "ProspectStatus",
    "toStatus" "ProspectStatus" NOT NULL,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProspectSignal_key_value_idx" ON "ProspectSignal"("key", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ProspectSignal_prospectId_key_key" ON "ProspectSignal"("prospectId", "key");

-- CreateIndex
CREATE INDEX "ProspectEvidence_prospectId_signalKey_idx" ON "ProspectEvidence"("prospectId", "signalKey");

-- CreateIndex
CREATE INDEX "ProspectNote_prospectId_createdAt_idx" ON "ProspectNote"("prospectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProspectStatusChange_prospectId_createdAt_idx" ON "ProspectStatusChange"("prospectId", "createdAt");

-- CreateIndex
CREATE INDEX "Prospect_status_score_idx" ON "Prospect"("status", "score");

-- CreateIndex
CREATE INDEX "Prospect_score_idx" ON "Prospect"("score");

-- CreateIndex
CREATE INDEX "Prospect_state_city_idx" ON "Prospect"("state", "city");

-- AddForeignKey
ALTER TABLE "ProspectSignal" ADD CONSTRAINT "ProspectSignal_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectEvidence" ADD CONSTRAINT "ProspectEvidence_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectNote" ADD CONSTRAINT "ProspectNote_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectStatusChange" ADD CONSTRAINT "ProspectStatusChange_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Backfill: statusChangedAt starts at the last known update, and every
-- existing prospect gets one audit row describing its migrated status.
UPDATE "Prospect" SET "statusChangedAt" = "updatedAt";

INSERT INTO "ProspectStatusChange" ("id", "prospectId", "fromStatus", "toStatus", "reason", "createdAt")
SELECT gen_random_uuid(), "id", NULL, "status",
       CASE WHEN "status" = 'engaged' THEN 'Migrated from Milestone 1 status "active" (mapped to engaged)'
            ELSE 'Migrated from Milestone 1 status' END,
       CURRENT_TIMESTAMP
FROM "Prospect";
