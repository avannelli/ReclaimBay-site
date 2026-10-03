-- Score snapshot (Stage 5C). Additive only: two nullable columns on Outreach,
-- written once when a message is queued. Existing rows stay null: their score
-- at queue time wasn't recorded, and isn't invented.

-- AlterTable
ALTER TABLE "Outreach" ADD COLUMN     "queuedScore" INTEGER,
ADD COLUMN     "queuedScoreVersion" VARCHAR(32);
