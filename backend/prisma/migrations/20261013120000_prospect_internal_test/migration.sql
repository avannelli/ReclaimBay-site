-- Internal outreach test (5F). Additive only: one flag on Prospect, false for
-- every existing row. Set only when a prospect is created as an internal test,
-- and never changed afterwards.

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN "internalTest" BOOLEAN NOT NULL DEFAULT false;
