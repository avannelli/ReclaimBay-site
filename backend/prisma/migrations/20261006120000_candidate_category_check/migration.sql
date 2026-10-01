-- CreateEnum
CREATE TYPE "CategoryVerdict" AS ENUM ('in_target', 'wrong_category', 'unclear');

-- CreateEnum
CREATE TYPE "CategorySource" AS ENUM ('provider', 'name', 'website', 'manual');

-- AlterTable
ALTER TABLE "DiscoveryCandidate" ADD COLUMN     "categoryCheckedAt" TIMESTAMP(3),
ADD COLUMN     "categoryReason" VARCHAR(300),
ADD COLUMN     "categoryRules" VARCHAR(40),
ADD COLUMN     "categorySource" "CategorySource",
ADD COLUMN     "categorySourceUrl" VARCHAR(500),
ADD COLUMN     "categoryVerdict" "CategoryVerdict";

-- CreateIndex
CREATE INDEX "DiscoveryCandidate_categoryVerdict_idx" ON "DiscoveryCandidate"("categoryVerdict");

