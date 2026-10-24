-- CreateTable
CREATE TABLE "ReplenishmentControl" (
    "id" VARCHAR(40) NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "pausedAt" TIMESTAMP(3),
    "pauseReason" VARCHAR(500),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplenishmentControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentControlChange" (
    "id" UUID NOT NULL,
    "controlId" VARCHAR(40) NOT NULL,
    "action" VARCHAR(24) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "paused" BOOLEAN NOT NULL,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplenishmentControlChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentBatch" (
    "id" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "area" VARCHAR(60) NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "release" VARCHAR(20) NOT NULL,
    "trigger" JSONB NOT NULL,
    "limits" JSONB NOT NULL,
    "sourceRead" INTEGER NOT NULL DEFAULT 0,
    "sourceSelected" INTEGER NOT NULL DEFAULT 0,
    "screened" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "skippedBudget" INTEGER NOT NULL DEFAULT 0,
    "ingested" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "fetches" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "reservedFetches" INTEGER NOT NULL DEFAULT 0,
    "reservedBytes" INTEGER NOT NULL DEFAULT 0,
    "runId" UUID,
    "reason" VARCHAR(500),
    "report" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReplenishmentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningEntry" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "externalId" VARCHAR(200) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "business" JSONB NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB,
    "publishedEmail" VARCHAR(254),
    "fetches" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "candidateId" UUID,
    "screenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReplenishmentControlChange_createdAt_idx" ON "ReplenishmentControlChange"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentBatch_runId_key" ON "ReplenishmentBatch"("runId");

-- CreateIndex
CREATE INDEX "ReplenishmentBatch_createdAt_idx" ON "ReplenishmentBatch"("createdAt");

-- CreateIndex
CREATE INDEX "ReplenishmentBatch_status_idx" ON "ReplenishmentBatch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningEntry_candidateId_key" ON "ScreeningEntry"("candidateId");

-- CreateIndex
CREATE INDEX "ScreeningEntry_batchId_status_idx" ON "ScreeningEntry"("batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningEntry_provider_externalId_key" ON "ScreeningEntry"("provider", "externalId");

-- AddForeignKey
ALTER TABLE "ReplenishmentControlChange" ADD CONSTRAINT "ReplenishmentControlChange_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "ReplenishmentControl"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentBatch" ADD CONSTRAINT "ReplenishmentBatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningEntry" ADD CONSTRAINT "ScreeningEntry_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ReplenishmentBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningEntry" ADD CONSTRAINT "ScreeningEntry_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "DiscoveryCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

