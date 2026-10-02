-- CreateEnum
CREATE TYPE "DuplicateDecision" AS ENUM ('not_duplicate', 'unresolved');

-- AlterTable: a person's answer to a possible-duplicate flag (the flag itself is kept),
-- and whether the current Needs review hold is the one the duplicate check placed.
ALTER TABLE "DiscoveryCandidate" ADD COLUMN     "duplicateDecision" "DuplicateDecision",
ADD COLUMN     "duplicateDecidedAt" TIMESTAMP(3),
ADD COLUMN     "duplicateHold" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a flagged candidate still in the Needs review it was stored with
-- (its status never changed after it was created). Anything else stays false,
-- so an ambiguous hold is never lifted automatically.
UPDATE "DiscoveryCandidate"
SET "duplicateHold" = true
WHERE "status" = 'needs_review'
  AND ("possibleDuplicateCandidateId" IS NOT NULL OR "possibleDuplicateProspectId" IS NOT NULL)
  AND ABS(EXTRACT(EPOCH FROM ("statusChangedAt" - "createdAt"))) < 1;
