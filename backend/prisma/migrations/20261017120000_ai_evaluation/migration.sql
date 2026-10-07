CREATE TABLE "AiEvalCohort" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "samplingVersion" VARCHAR(40) NOT NULL,
    "seed" VARCHAR(80) NOT NULL,
    "strata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiEvalCohort_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiEvalCase" (
    "id" UUID NOT NULL,
    "cohortId" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "stratum" VARCHAR(40) NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiEvalCase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiEvalCase_position" CHECK ("position" >= 1)
);

CREATE TABLE "AiLabel" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "note" VARCHAR(500),
    "labeledBy" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiLabel_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiLabel_label" CHECK ("label" IN ('collision_primary', 'specialty_body', 'dealership_body_dept', 'not_collision', 'insufficient_evidence')),
    CONSTRAINT "AiLabel_revision_source" CHECK (
        ("revision" = 1 AND "source" = 'blind') OR
        ("revision" > 1 AND "source" = 'adjudicated' AND "note" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "AiEvalCohort_name_key" ON "AiEvalCohort"("name");
CREATE UNIQUE INDEX "AiEvalCase_cohortId_candidateId_key" ON "AiEvalCase"("cohortId", "candidateId");
CREATE UNIQUE INDEX "AiEvalCase_cohortId_position_key" ON "AiEvalCase"("cohortId", "position");
CREATE INDEX "AiEvalCase_candidateId_idx" ON "AiEvalCase"("candidateId");
CREATE UNIQUE INDEX "AiLabel_caseId_revision_key" ON "AiLabel"("caseId", "revision");
CREATE INDEX "AiLabel_candidateId_idx" ON "AiLabel"("candidateId");
ALTER TABLE "AiEvalCase" ADD CONSTRAINT "AiEvalCase_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "AiEvalCohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiLabel" ADD CONSTRAINT "AiLabel_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AiEvalCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
