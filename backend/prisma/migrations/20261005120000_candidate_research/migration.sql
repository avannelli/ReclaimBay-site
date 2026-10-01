-- CreateEnum
CREATE TYPE "RecordOrigin" AS ENUM ('manual', 'research');

-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "FactState" AS ENUM ('verified', 'unverified', 'uncertain', 'not_found');

-- AlterTable
ALTER TABLE "CandidateEvidence" ADD COLUMN     "origin" "RecordOrigin" NOT NULL DEFAULT 'manual',
ADD COLUMN     "researchId" UUID;

-- AlterTable
ALTER TABLE "CandidateSignal" ADD COLUMN     "origin" "RecordOrigin" NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "DiscoveryCandidate" ADD COLUMN     "websiteVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CandidateResearch" (
    "id" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "status" "ResearchStatus" NOT NULL DEFAULT 'queued',
    "version" VARCHAR(20) NOT NULL,
    "trigger" VARCHAR(20) NOT NULL,
    "outcome" VARCHAR(40),
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "error" VARCHAR(300),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CandidateResearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchSource" (
    "id" UUID NOT NULL,
    "researchId" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "finalUrl" VARCHAR(500),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "httpStatus" INTEGER,
    "ok" BOOLEAN NOT NULL,
    "contentType" VARCHAR(100),
    "bytes" INTEGER,
    "note" VARCHAR(200),

    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchFact" (
    "id" UUID NOT NULL,
    "researchId" UUID NOT NULL,
    "field" VARCHAR(40) NOT NULL,
    "value" VARCHAR(500),
    "state" "FactState" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "sourceId" UUID,
    "excerpt" VARCHAR(280),
    "note" VARCHAR(300),

    CONSTRAINT "ResearchFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateResearch_candidateId_queuedAt_idx" ON "CandidateResearch"("candidateId", "queuedAt");

-- CreateIndex
CREATE INDEX "CandidateResearch_status_queuedAt_idx" ON "CandidateResearch"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "ResearchSource_researchId_idx" ON "ResearchSource"("researchId");

-- CreateIndex
CREATE INDEX "ResearchFact_researchId_idx" ON "ResearchFact"("researchId");

-- AddForeignKey
ALTER TABLE "CandidateEvidence" ADD CONSTRAINT "CandidateEvidence_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "CandidateResearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateResearch" ADD CONSTRAINT "CandidateResearch_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "DiscoveryCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "CandidateResearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchFact" ADD CONSTRAINT "ResearchFact_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "CandidateResearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchFact" ADD CONSTRAINT "ResearchFact_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

