-- CreateEnum
CREATE TYPE "TelemetrySource" AS ENUM ('simulator', 'aws_iot');

-- CreateEnum
CREATE TYPE "GatewayIdentityStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "AggregateQuality" AS ENUM ('measured', 'estimated', 'missing');

-- AlterTable
ALTER TABLE "telemetry_samples" ADD COLUMN     "gateway_identity_id" UUID,
ADD COLUMN     "payload_hash" VARCHAR(64),
ADD COLUMN     "payload_json" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "phases" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "source" "TelemetrySource" NOT NULL DEFAULT 'simulator';

-- CreateTable
CREATE TABLE "gateway_identities" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gateway_device_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source" "TelemetrySource" NOT NULL,
    "client_id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "status" "GatewayIdentityStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "gateway_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_meters" (
    "organization_id" UUID NOT NULL,
    "gateway_identity_id" UUID NOT NULL,
    "meter_device_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_meters_pkey" PRIMARY KEY ("organization_id","gateway_identity_id","meter_device_id")
);

-- CreateTable
CREATE TABLE "telemetry_latest" (
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "measurement_point_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "measured_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telemetry_latest_pkey" PRIMARY KEY ("organization_id","measurement_point_id")
);

-- CreateTable
CREATE TABLE "telemetry_daily_aggregates" (
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "measurement_point_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "import_energy_kwh" DECIMAL(20,6),
    "export_energy_kwh" DECIMAL(20,6),
    "integrated_positive_kwh" DECIMAL(20,6),
    "integrated_negative_kwh" DECIMAL(20,6),
    "sample_count" INTEGER NOT NULL,
    "gap_count" INTEGER NOT NULL,
    "reset_count" INTEGER NOT NULL,
    "quality" "AggregateQuality" NOT NULL,
    "detail_json" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telemetry_daily_aggregates_pkey" PRIMARY KEY ("organization_id","measurement_point_id","local_date")
);

-- CreateTable
CREATE TABLE "ingestion_quarantine" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "gateway_identity_id" UUID,
    "event_id" UUID,
    "message_id" TEXT NOT NULL,
    "body_hash" VARCHAR(64) NOT NULL,
    "reason" TEXT NOT NULL,
    "raw_body" TEXT NOT NULL,
    "receipt_context" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_loss_reports" (
    "report_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gateway_identity_id" UUID NOT NULL,
    "lost_from" TIMESTAMPTZ(3) NOT NULL,
    "lost_to" TIMESTAMPTZ(3) NOT NULL,
    "dropped" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_loss_reports_pkey" PRIMARY KEY ("report_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_identities_organization_id_id_key" ON "gateway_identities"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_identities_source_client_id_principal_id_key" ON "gateway_identities"("source", "client_id", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_latest_measurement_point_id_key" ON "telemetry_latest"("measurement_point_id");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_latest_event_id_key" ON "telemetry_latest"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_latest_organization_id_project_id_measurement_poi_key" ON "telemetry_latest"("organization_id", "project_id", "measurement_point_id");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_latest_organization_id_event_id_key" ON "telemetry_latest"("organization_id", "event_id");

-- CreateIndex
CREATE INDEX "telemetry_daily_aggregates_organization_id_project_id_local_idx" ON "telemetry_daily_aggregates"("organization_id", "project_id", "local_date");

-- CreateIndex
CREATE INDEX "ingestion_quarantine_organization_id_created_at_idx" ON "ingestion_quarantine"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_quarantine_message_id_body_hash_reason_key" ON "ingestion_quarantine"("message_id", "body_hash", "reason");

-- CreateIndex
CREATE INDEX "gateway_loss_reports_organization_id_recorded_at_idx" ON "gateway_loss_reports"("organization_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_samples_organization_id_event_id_key" ON "telemetry_samples"("organization_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_samples_organization_id_binding_id_measured_at_key" ON "telemetry_samples"("organization_id", "binding_id", "measured_at");

-- AddForeignKey
ALTER TABLE "telemetry_samples" ADD CONSTRAINT "telemetry_samples_organization_id_gateway_identity_id_fkey" FOREIGN KEY ("organization_id", "gateway_identity_id") REFERENCES "gateway_identities"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_identities" ADD CONSTRAINT "gateway_identities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_identities" ADD CONSTRAINT "gateway_identities_organization_id_gateway_device_id_fkey" FOREIGN KEY ("organization_id", "gateway_device_id") REFERENCES "devices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_meters" ADD CONSTRAINT "gateway_meters_organization_id_gateway_identity_id_fkey" FOREIGN KEY ("organization_id", "gateway_identity_id") REFERENCES "gateway_identities"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_meters" ADD CONSTRAINT "gateway_meters_organization_id_meter_device_id_fkey" FOREIGN KEY ("organization_id", "meter_device_id") REFERENCES "devices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_latest" ADD CONSTRAINT "telemetry_latest_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_latest" ADD CONSTRAINT "telemetry_latest_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_latest" ADD CONSTRAINT "telemetry_latest_organization_id_project_id_measurement_po_fkey" FOREIGN KEY ("organization_id", "project_id", "measurement_point_id") REFERENCES "measurement_points"("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_latest" ADD CONSTRAINT "telemetry_latest_organization_id_event_id_fkey" FOREIGN KEY ("organization_id", "event_id") REFERENCES "telemetry_samples"("organization_id", "event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_daily_aggregates" ADD CONSTRAINT "telemetry_daily_aggregates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_daily_aggregates" ADD CONSTRAINT "telemetry_daily_aggregates_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_daily_aggregates" ADD CONSTRAINT "telemetry_daily_aggregates_organization_id_project_id_meas_fkey" FOREIGN KEY ("organization_id", "project_id", "measurement_point_id") REFERENCES "measurement_points"("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_quarantine" ADD CONSTRAINT "ingestion_quarantine_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_quarantine" ADD CONSTRAINT "ingestion_quarantine_organization_id_gateway_identity_id_fkey" FOREIGN KEY ("organization_id", "gateway_identity_id") REFERENCES "gateway_identities"("organization_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_loss_reports" ADD CONSTRAINT "gateway_loss_reports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_loss_reports" ADD CONSTRAINT "gateway_loss_reports_organization_id_gateway_identity_id_fkey" FOREIGN KEY ("organization_id", "gateway_identity_id") REFERENCES "gateway_identities"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- H4/5 invariants. H2/3 baseline remains unchanged.
ALTER TABLE gateway_identities ADD CONSTRAINT gateway_client_id_valid CHECK (client_id ~ '^[A-Za-z0-9_-]{1,128}$');
ALTER TABLE gateway_identities ADD CONSTRAINT gateway_principal_valid CHECK (length(principal_id) BETWEEN 1 AND 512);
ALTER TABLE gateway_identities ADD CONSTRAINT gateway_revocation_valid CHECK ((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL));
ALTER TABLE telemetry_daily_aggregates ADD CONSTRAINT telemetry_daily_counts_valid CHECK (sample_count>=0 AND gap_count>=0 AND reset_count>=0);
ALTER TABLE telemetry_daily_aggregates ADD CONSTRAINT telemetry_daily_energy_valid CHECK ((import_energy_kwh IS NULL OR import_energy_kwh>=0) AND (export_energy_kwh IS NULL OR export_energy_kwh>=0) AND (integrated_positive_kwh IS NULL OR integrated_positive_kwh>=0) AND (integrated_negative_kwh IS NULL OR integrated_negative_kwh>=0));
ALTER TABLE gateway_loss_reports ADD CONSTRAINT gateway_loss_range_valid CHECK (lost_to>=lost_from AND dropped>0 AND reason='buffer_capacity');
ALTER TABLE ingestion_quarantine ADD CONSTRAINT quarantine_bounds CHECK (octet_length(raw_body)<=65536 AND octet_length(receipt_context::text)<=8192 AND length(reason) BETWEEN 1 AND 128 AND length(message_id) BETWEEN 1 AND 256 AND body_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE gateway_identities ADD CONSTRAINT gateway_client_id_identity CHECK (client_id=id::text);
