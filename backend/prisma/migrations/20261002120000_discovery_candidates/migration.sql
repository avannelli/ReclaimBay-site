-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('discovered', 'researching', 'researched', 'needs_review', 'approved', 'rejected', 'duplicate');

-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "region" VARCHAR(100) NOT NULL,
    "city" VARCHAR(100),
    "businessType" VARCHAR(100) NOT NULL,
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'running',
    "found" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "flagged" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryCandidate" (
    "id" UUID NOT NULL,
    "runId" UUID,
    "businessName" VARCHAR(120) NOT NULL,
    "website" VARCHAR(200),
    "city" VARCHAR(100),
    "state" VARCHAR(50),
    "postalCode" VARCHAR(20),
    "country" CHAR(2) NOT NULL DEFAULT 'US',
    "phone" VARCHAR(30),
    "phoneSourceUrl" VARCHAR(500),
    "email" VARCHAR(254),
    "emailSourceUrl" VARCHAR(500),
    "domainKey" VARCHAR(200),
    "nameKey" VARCHAR(160) NOT NULL,
    "locationKey" VARCHAR(160),
    "phoneKey" VARCHAR(15),
    "provider" VARCHAR(40) NOT NULL,
    "externalId" VARCHAR(200),
    "sourceUrl" VARCHAR(500),
    "query" VARCHAR(300),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "CandidateStatus" NOT NULL DEFAULT 'discovered',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "researchedAt" TIMESTAMP(3),
    "decisionReason" VARCHAR(500),
    "decidedAt" TIMESTAMP(3),
    "possibleDuplicateCandidateId" UUID,
    "possibleDuplicateProspectId" UUID,
    "duplicateReason" VARCHAR(120),
    "prospectId" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateSignal" (
    "id" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "value" "SignalValue" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateEvidence" (
    "id" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "signalKey" VARCHAR(64) NOT NULL,
    "sourceUrl" VARCHAR(500) NOT NULL,
    "excerpt" VARCHAR(280) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateNote" (
    "id" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscoveryRun_createdAt_idx" ON "DiscoveryRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryCandidate_prospectId_key" ON "DiscoveryCandidate"("prospectId");

-- CreateIndex
CREATE INDEX "DiscoveryCandidate_status_discoveredAt_idx" ON "DiscoveryCandidate"("status", "discoveredAt");

-- CreateIndex
CREATE INDEX "DiscoveryCandidate_domainKey_idx" ON "DiscoveryCandidate"("domainKey");

-- CreateIndex
CREATE INDEX "DiscoveryCandidate_nameKey_locationKey_idx" ON "DiscoveryCandidate"("nameKey", "locationKey");

-- CreateIndex
CREATE INDEX "DiscoveryCandidate_phoneKey_idx" ON "DiscoveryCandidate"("phoneKey");

-- CreateIndex
CREATE INDEX "DiscoveryCandidate_runId_idx" ON "DiscoveryCandidate"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryCandidate_provider_externalId_key" ON "DiscoveryCandidate"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateSignal_candidateId_key_key" ON "CandidateSignal"("candidateId", "key");

-- CreateIndex
CREATE INDEX "CandidateEvidence_candidateId_signalKey_idx" ON "CandidateEvidence"("candidateId", "signalKey");

-- CreateIndex
CREATE INDEX "CandidateNote_candidateId_createdAt_idx" ON "CandidateNote"("candidateId", "createdAt");

-- AddForeignKey
ALTER TABLE "DiscoveryCandidate" ADD CONSTRAINT "DiscoveryCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryCandidate" ADD CONSTRAINT "DiscoveryCandidate_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateSignal" ADD CONSTRAINT "CandidateSignal_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "DiscoveryCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateEvidence" ADD CONSTRAINT "CandidateEvidence_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "DiscoveryCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateNote" ADD CONSTRAINT "CandidateNote_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "DiscoveryCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
