-- CreateEnum
CREATE TYPE "AlertRuleKind" AS ENUM ('communication', 'invalid_data', 'generation', 'device_alarm');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('pending', 'active', 'resolved');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('warning', 'critical');

-- CreateEnum
CREATE TYPE "AlertEventKind" AS ENUM ('activated', 'resolved');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('open', 'in_progress', 'closed');

-- CreateEnum
CREATE TYPE "IncidentEventKind" AS ENUM ('created', 'assigned', 'status_changed', 'observation', 'closed');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "ReportJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

-- AlterTable
ALTER TABLE "telemetry_samples" ADD COLUMN     "alarms" JSONB;

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" "AlertRuleKind" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "persistence_seconds" INTEGER NOT NULL,
    "recovery_seconds" INTEGER NOT NULL,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "last_evaluated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL,
    "episode_id" UUID NOT NULL,
    "candidate_since" TIMESTAMPTZ(3),
    "recovery_since" TIMESTAMPTZ(3),
    "activated_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "last_evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "kind" "AlertEventKind" NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "alert_id" UUID,
    "alert_episode_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'open',
    "assignee_user_id" UUID,
    "created_by_id" UUID,
    "resolution" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "actor_id" UUID,
    "kind" "IncidentEventKind" NOT NULL,
    "note" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_windows" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "event_kind" "AlertEventKind" NOT NULL,
    "event_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "lease_token_hash" VARCHAR(64),
    "worker_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "timezone" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "period_from" TIMESTAMPTZ(3) NOT NULL,
    "period_to" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReportJobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token_hash" VARCHAR(64),
    "lease_until" TIMESTAMPTZ(3),
    "worker_id" TEXT,
    "artifact_key" TEXT,
    "sha256" VARCHAR(64),
    "byte_length" INTEGER,
    "snapshot_json" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "report_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "download_leases" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "report_job_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "download_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_rate_limits" (
    "scope" TEXT NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "request_rate_limits_pkey" PRIMARY KEY ("scope","key_hash","window_start")
);

-- CreateIndex
CREATE INDEX "alert_rules_enabled_last_evaluated_at_idx" ON "alert_rules"("enabled", "last_evaluated_at");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_organization_id_project_id_id_key" ON "alert_rules"("organization_id", "project_id", "id");

-- CreateIndex
CREATE INDEX "alerts_organization_id_project_id_status_idx" ON "alerts"("organization_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_organization_id_rule_id_dedup_key_key" ON "alerts"("organization_id", "rule_id", "dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_organization_id_project_id_id_key" ON "alerts"("organization_id", "project_id", "id");

-- CreateIndex
CREATE INDEX "alert_events_organization_id_project_id_created_at_idx" ON "alert_events"("organization_id", "project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "alert_events_alert_id_episode_id_kind_key" ON "alert_events"("alert_id", "episode_id", "kind");

-- CreateIndex
CREATE INDEX "incidents_organization_id_project_id_status_idx" ON "incidents"("organization_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_alert_id_alert_episode_id_key" ON "incidents"("alert_id", "alert_episode_id");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_organization_id_project_id_id_key" ON "incidents"("organization_id", "project_id", "id");

-- CreateIndex
CREATE INDEX "incident_events_organization_id_project_id_created_at_idx" ON "incident_events"("organization_id", "project_id", "created_at");

-- CreateIndex
CREATE INDEX "maintenance_windows_organization_id_project_id_starts_at_en_idx" ON "maintenance_windows"("organization_id", "project_id", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_event_key_key" ON "notification_outbox"("event_key");

-- CreateIndex
CREATE INDEX "notification_outbox_status_next_attempt_at_idx" ON "notification_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_alert_id_episode_id_event_kind_key" ON "notification_outbox"("alert_id", "episode_id", "event_kind");

-- CreateIndex
CREATE INDEX "report_jobs_status_next_attempt_at_idx" ON "report_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_jobs_organization_id_requested_by_idempotency_key_key" ON "report_jobs"("organization_id", "requested_by", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "report_jobs_organization_id_project_id_id_key" ON "report_jobs"("organization_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "download_leases_token_hash_key" ON "download_leases"("token_hash");

-- CreateIndex
CREATE INDEX "download_leases_expires_at_idx" ON "download_leases"("expires_at");

-- CreateIndex
CREATE INDEX "request_rate_limits_expires_at_idx" ON "request_rate_limits"("expires_at");

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_project_id_rule_id_fkey" FOREIGN KEY ("organization_id", "project_id", "rule_id") REFERENCES "alert_rules"("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_organization_id_project_id_alert_id_fkey" FOREIGN KEY ("organization_id", "project_id", "alert_id") REFERENCES "alerts"("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_project_id_alert_id_fkey" FOREIGN KEY ("organization_id", "project_id", "alert_id") REFERENCES "alerts"("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_organization_id_project_id_incident_id_fkey" FOREIGN KEY ("organization_id", "project_id", "incident_id") REFERENCES "incidents"("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_project_id_alert_id_fkey" FOREIGN KEY ("organization_id", "project_id", "alert_id") REFERENCES "alerts"("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_leases" ADD CONSTRAINT "download_leases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_leases" ADD CONSTRAINT "download_leases_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_leases" ADD CONSTRAINT "download_leases_organization_id_project_id_report_job_id_fkey" FOREIGN KEY ("organization_id", "project_id", "report_job_id") REFERENCES "report_jobs"("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_leases" ADD CONSTRAINT "download_leases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain checks intentionally complement Prisma's relational schema.
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_bounds CHECK(length(name) BETWEEN 1 AND 160 AND persistence_seconds BETWEEN 0 AND 604800 AND recovery_seconds BETWEEN 0 AND 604800 AND jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=16384);
ALTER TABLE alerts ADD CONSTRAINT alerts_bounds CHECK(length(dedup_key) BETWEEN 1 AND 256 AND length(title) BETWEEN 1 AND 240 AND length(message)<=4000 AND jsonb_typeof(detail)='object' AND octet_length(detail::text)<=65536);
ALTER TABLE incidents ADD CONSTRAINT incidents_bounds CHECK(length(title) BETWEEN 1 AND 240 AND length(description)<=8000 AND length(resolution)<=8000 AND ((alert_id IS NULL)=(alert_episode_id IS NULL)) AND ((status='closed' AND closed_at IS NOT NULL AND length(trim(resolution))>0) OR (status<>'closed' AND closed_at IS NULL)));
ALTER TABLE incident_events ADD CONSTRAINT incident_events_bounds CHECK(length(note)<=8000 AND jsonb_typeof(detail)='object' AND octet_length(detail::text)<=65536);
ALTER TABLE alert_events ADD CONSTRAINT alert_events_bounds CHECK(jsonb_typeof(detail)='object' AND octet_length(detail::text)<=65536);
ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_bounds CHECK(ends_at>starts_at AND ends_at-starts_at<=interval '366 days' AND length(reason) BETWEEN 1 AND 2000);
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_bounds CHECK(attempts BETWEEN 0 AND 5 AND jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536 AND (lease_token_hash IS NULL OR lease_token_hash ~ '^[a-f0-9]{64}$') AND ((status='delivered')=(delivered_at IS NOT NULL)));
ALTER TABLE report_jobs ADD CONSTRAINT report_jobs_bounds CHECK(end_date>=start_date AND end_date-start_date<=30 AND period_to>period_from AND attempts BETWEEN 0 AND 3 AND (lease_token_hash IS NULL OR lease_token_hash ~ '^[a-f0-9]{64}$') AND (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$') AND (byte_length IS NULL OR byte_length BETWEEN 1 AND 52428800) AND (snapshot_json IS NULL OR (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=8388608)) AND ((status='processing')=(lease_token_hash IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)) AND ((status='completed')=(artifact_key IS NOT NULL AND sha256 IS NOT NULL AND byte_length IS NOT NULL AND snapshot_json IS NOT NULL AND completed_at IS NOT NULL)));
ALTER TABLE download_leases ADD CONSTRAINT download_leases_bounds CHECK(token_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE request_rate_limits ADD CONSTRAINT request_rate_limits_bounds CHECK(key_hash ~ '^[a-f0-9]{64}$' AND count BETWEEN 1 AND 10001 AND expires_at>window_start);
ALTER TABLE telemetry_samples ADD CONSTRAINT telemetry_samples_alarms_bounds CHECK(alarms IS NULL OR (jsonb_typeof(alarms)='array' AND jsonb_array_length(alarms)<=32));

