-- AlterTable
ALTER TABLE "report_jobs" ADD COLUMN     "snapshot_sequence" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "telemetry_samples" ADD COLUMN     "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
ADD COLUMN     "ingestion_sequence" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_samples_ingestion_sequence_key" ON "telemetry_samples"("ingestion_sequence");

