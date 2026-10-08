-- Additive only: existing history is retained. Queued runs capture ownership
-- when claimed; old running runs have no snapshot and are recovered safely.
ALTER TABLE "DiscoveryCandidate" ADD COLUMN "researchRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CandidateResearch" ADD COLUMN "candidateRevision" INTEGER,
ADD COLUMN "subjectWebsite" VARCHAR(200);
