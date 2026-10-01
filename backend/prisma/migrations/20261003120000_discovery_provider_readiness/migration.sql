-- CreateEnum
CREATE TYPE "CategoryTier" AS ENUM ('core', 'adjacent');

-- CreateEnum
CREATE TYPE "ProviderOperatingStatus" AS ENUM ('open', 'temporarily_closed', 'permanently_closed');

-- CreateEnum
CREATE TYPE "ProviderImportStatus" AS ENUM ('running', 'completed', 'failed');

-- AlterEnum
ALTER TYPE "DiscoveryRunStatus" ADD VALUE 'queued';

-- AlterTable
ALTER TABLE "DiscoveryCandidate" ADD COLUMN     "categoryTier" "CategoryTier",
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "providerBrand" VARCHAR(120),
ADD COLUMN     "providerCategory" VARCHAR(100),
ADD COLUMN     "providerConfidence" DOUBLE PRECISION,
ADD COLUMN     "providerPhone" VARCHAR(30),
ADD COLUMN     "providerRelease" VARCHAR(64),
ADD COLUMN     "providerRetrievedAt" TIMESTAMP(3),
ADD COLUMN     "providerStatus" "ProviderOperatingStatus",
ADD COLUMN     "relatedCandidateId" UUID,
ADD COLUMN     "relatedProspectId" UUID,
ADD COLUMN     "relationReason" VARCHAR(120),
ADD COLUMN     "streetAddress" VARCHAR(200);

-- AlterTable
ALTER TABLE "DiscoveryRun" ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "importId" UUID,
ADD COLUMN     "providerRelease" VARCHAR(64),
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "tiers" "CategoryTier"[];

-- CreateTable
CREATE TABLE "ProviderImport" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "release" VARCHAR(64) NOT NULL,
    "scope" VARCHAR(40) NOT NULL,
    "status" "ProviderImportStatus" NOT NULL DEFAULT 'running',
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(300),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderPlace" (
    "id" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "externalId" VARCHAR(200) NOT NULL,
    "businessName" VARCHAR(120) NOT NULL,
    "website" VARCHAR(200),
    "phone" VARCHAR(30),
    "streetAddress" VARCHAR(200),
    "city" VARCHAR(100),
    "county" VARCHAR(100),
    "state" VARCHAR(50),
    "postalCode" VARCHAR(20),
    "country" CHAR(2),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "category" VARCHAR(100),
    "categoryTier" "CategoryTier",
    "brand" VARCHAR(120),
    "confidence" DOUBLE PRECISION,
    "operatingStatus" "ProviderOperatingStatus",
    "sourceUrl" VARCHAR(500),
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderPlace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderImport_provider_scope_status_startedAt_idx" ON "ProviderImport"("provider", "scope", "status", "startedAt");

-- CreateIndex
CREATE INDEX "ProviderPlace_importId_state_county_city_idx" ON "ProviderPlace"("importId", "state", "county", "city");

-- CreateIndex
CREATE INDEX "ProviderPlace_importId_categoryTier_idx" ON "ProviderPlace"("importId", "categoryTier");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderPlace_importId_externalId_key" ON "ProviderPlace"("importId", "externalId");

-- CreateIndex
CREATE INDEX "DiscoveryCandidate_categoryTier_idx" ON "DiscoveryCandidate"("categoryTier");

-- CreateIndex
CREATE INDEX "DiscoveryRun_status_createdAt_idx" ON "DiscoveryRun"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ProviderImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderPlace" ADD CONSTRAINT "ProviderPlace_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ProviderImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
