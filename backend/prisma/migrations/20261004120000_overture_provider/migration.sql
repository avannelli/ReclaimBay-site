-- Overture provider: import area and counters, and per-record upstream sources.
ALTER TABLE "ProviderImport" ADD COLUMN "area" VARCHAR(100),
ADD COLUMN "stats" JSONB;

ALTER TABLE "ProviderPlace" ADD COLUMN "sources" VARCHAR(200);

ALTER TABLE "DiscoveryCandidate" ADD COLUMN "providerSources" VARCHAR(200);
