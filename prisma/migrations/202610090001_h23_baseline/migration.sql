-- Hitos 2/3: baseline complete for a NEW PostgreSQL database.

CREATE TYPE "MembershipRole" AS ENUM ('owner', 'administrator', 'technician', 'customer');

CREATE TYPE "MembershipStatus" AS ENUM ('active', 'invited', 'disabled');

CREATE TYPE "DeviceKind" AS ENUM ('gateway', 'meter');

CREATE TYPE "DeviceStatus" AS ENUM ('active', 'retired');

CREATE TYPE "MeasurementPointKind" AS ENUM ('generation', 'consumption', 'grid');

CREATE TYPE "ProjectTopology" AS ENUM ('grid_tied_no_battery');

CREATE TYPE "TelemetryQuality" AS ENUM ('measured', 'calculated', 'missing', 'invalid');

CREATE TABLE "users" (
  "id" UUID NOT NULL,
  "cognito_subject" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "email_verified" BOOLEAN NOT NULL DEFAULT false,
  "name" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_flows" (
  "state_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "auth_flows_pkey" PRIMARY KEY ("state_hash")
);

CREATE TABLE "sessions" (
  "id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organizations" (
  "id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '2.0',
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memberships" (
  "id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '2.0',
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "MembershipRole" NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'invited',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "site_access" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "MembershipRole" NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_access_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invitations" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "MembershipRole" NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "accepted_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invitation_projects" (
  "organization_id" UUID NOT NULL,
  "invitation_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  CONSTRAINT "invitation_projects_pkey" PRIMARY KEY ("organization_id", "invitation_id", "project_id")
);

CREATE TABLE "audit_events" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customers" (
  "id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '2.0',
  "organization_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projects" (
  "id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '2.0',
  "organization_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "latitude" DECIMAL(9, 6),
  "longitude" DECIMAL(10, 6),
  "capacity_kwp" DECIMAL(12, 3) NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
  "topology" "ProjectTopology" NOT NULL DEFAULT 'grid_tied_no_battery',
  "commissioned_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "devices" (
  "id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '2.0',
  "organization_id" UUID NOT NULL,
  "serial" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "DeviceKind" NOT NULL,
  "status" "DeviceStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "measurement_points" (
  "id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '2.0',
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "MeasurementPointKind" NOT NULL,
  "sign_convention" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "measurement_points_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "device_bindings" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "measurement_point_id" UUID NOT NULL,
  "configuration_version" INTEGER NOT NULL DEFAULT 1,
  "valid_from" TIMESTAMPTZ(3) NOT NULL,
  "valid_to" TIMESTAMPTZ(3),
  "configuration" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_bindings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "topology_versions" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "valid_from" TIMESTAMPTZ(3) NOT NULL,
  "valid_to" TIMESTAMPTZ(3),
  "configuration" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "topology_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "telemetry_samples" (
  "event_id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '1.0',
  "organization_id" UUID NOT NULL,
  "binding_id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "measurement_point_id" UUID NOT NULL,
  "measured_at" TIMESTAMPTZ(3) NOT NULL,
  "received_at" TIMESTAMPTZ(3) NOT NULL,
  "configuration_version" INTEGER NOT NULL,
  "active_power" DECIMAL(16, 6),
  "import_energy" DECIMAL(20, 6),
  "export_energy" DECIMAL(20, 6),
  "power_unit" TEXT NOT NULL DEFAULT 'kW',
  "energy_unit" TEXT NOT NULL DEFAULT 'kWh',
  "quality" "TelemetryQuality" NOT NULL,
  CONSTRAINT "telemetry_samples_pkey" PRIMARY KEY ("event_id")
);

CREATE UNIQUE INDEX "users_cognito_subject_key" ON "users" ("cognito_subject");

CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");

CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" ("token_hash");

CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions" ("user_id", "expires_at");

CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" ("slug");

CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships" ("organization_id", "user_id");

CREATE UNIQUE INDEX "memberships_organization_id_id_key" ON "memberships" ("organization_id", "id");

CREATE UNIQUE INDEX "site_access_organization_id_project_id_user_id_key" ON "site_access" ("organization_id", "project_id", "user_id");

CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations" ("token_hash");

CREATE UNIQUE INDEX "invitations_organization_id_id_key" ON "invitations" ("organization_id", "id");

CREATE INDEX "invitations_organization_id_email_idx" ON "invitations" ("organization_id", "email");

CREATE INDEX "audit_events_organization_id_created_at_idx" ON "audit_events" ("organization_id", "created_at");

CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers" ("organization_id", "id");

CREATE UNIQUE INDEX "projects_organization_id_id_key" ON "projects" ("organization_id", "id");

CREATE UNIQUE INDEX "devices_organization_id_id_key" ON "devices" ("organization_id", "id");

CREATE UNIQUE INDEX "devices_organization_id_serial_key" ON "devices" ("organization_id", "serial");

CREATE UNIQUE INDEX "measurement_points_organization_id_id_key" ON "measurement_points" ("organization_id", "id");

CREATE UNIQUE INDEX "measurement_points_organization_id_project_id_id_key" ON "measurement_points" ("organization_id", "project_id", "id");

CREATE UNIQUE INDEX "device_bindings_organization_id_measurement_point_id_config_key" ON "device_bindings" ("organization_id", "measurement_point_id", "configuration_version");

CREATE UNIQUE INDEX "device_bindings_sample_identity_key" ON "device_bindings" ("organization_id", "id", "measurement_point_id", "device_id", "configuration_version");

CREATE INDEX "device_bindings_organization_id_project_id_valid_from_idx" ON "device_bindings" ("organization_id", "project_id", "valid_from");

CREATE UNIQUE INDEX "topology_versions_organization_id_project_id_version_key" ON "topology_versions" ("organization_id", "project_id", "version");

CREATE INDEX "telemetry_samples_organization_id_measurement_point_id_meas_idx" ON "telemetry_samples" ("organization_id", "measurement_point_id", "measured_at");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_access" ADD CONSTRAINT "site_access_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_access" ADD CONSTRAINT "site_access_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_access" ADD CONSTRAINT "site_access_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invitation_projects" ADD CONSTRAINT "invitation_projects_organization_id_invitation_id_fkey" FOREIGN KEY ("organization_id", "invitation_id") REFERENCES "invitations" ("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invitation_projects" ADD CONSTRAINT "invitation_projects_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "devices" ADD CONSTRAINT "devices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "measurement_points" ADD CONSTRAINT "measurement_points_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "measurement_points" ADD CONSTRAINT "measurement_points_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "device_bindings" ADD CONSTRAINT "device_bindings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "device_bindings" ADD CONSTRAINT "device_bindings_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "device_bindings" ADD CONSTRAINT "device_bindings_organization_id_device_id_fkey" FOREIGN KEY ("organization_id", "device_id") REFERENCES "devices" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "device_bindings" ADD CONSTRAINT "device_bindings_organization_id_project_id_measurement_poi_fkey" FOREIGN KEY ("organization_id", "project_id", "measurement_point_id") REFERENCES "measurement_points" ("organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "topology_versions" ADD CONSTRAINT "topology_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "topology_versions" ADD CONSTRAINT "topology_versions_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telemetry_samples" ADD CONSTRAINT "telemetry_samples_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telemetry_samples" ADD CONSTRAINT "telemetry_samples_binding_fkey" FOREIGN KEY ("organization_id", "binding_id", "measurement_point_id", "device_id", "configuration_version") REFERENCES "device_bindings" ("organization_id", "id", "measurement_point_id", "device_id", "configuration_version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database invariants supplement server validation and apply to every writer.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE customers ADD CONSTRAINT customers_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 180);
ALTER TABLE projects ADD CONSTRAINT projects_capacity_positive CHECK (capacity_kwp > 0);
ALTER TABLE projects ADD CONSTRAINT projects_coordinates_valid CHECK (
  (latitude IS NULL AND longitude IS NULL) OR
  (latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180));
ALTER TABLE devices ADD CONSTRAINT devices_serial_nonempty CHECK (length(btrim(serial)) BETWEEN 1 AND 160);
ALTER TABLE site_access ADD CONSTRAINT site_access_participant_role CHECK (role IN ('technician', 'customer'));
ALTER TABLE invitations ADD CONSTRAINT invitations_expiry_valid CHECK (expires_at > created_at);
ALTER TABLE device_bindings ADD CONSTRAINT bindings_interval_valid CHECK (valid_to IS NULL OR valid_to > valid_from);
ALTER TABLE device_bindings ADD CONSTRAINT bindings_version_positive CHECK (configuration_version > 0);
ALTER TABLE device_bindings ADD CONSTRAINT bindings_configuration_object CHECK (jsonb_typeof(configuration) = 'object');
ALTER TABLE topology_versions ADD CONSTRAINT topology_interval_valid CHECK (valid_to IS NULL OR valid_to > valid_from);
ALTER TABLE topology_versions ADD CONSTRAINT topology_version_positive CHECK (version > 0);
ALTER TABLE topology_versions ADD CONSTRAINT topology_configuration_object CHECK (jsonb_typeof(configuration) = 'object');
ALTER TABLE device_bindings ADD CONSTRAINT bindings_point_no_overlap EXCLUDE USING gist (
  organization_id WITH =, measurement_point_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&);
ALTER TABLE device_bindings ADD CONSTRAINT bindings_device_no_overlap EXCLUDE USING gist (
  organization_id WITH =, device_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&);
ALTER TABLE topology_versions ADD CONSTRAINT topology_project_no_overlap EXCLUDE USING gist (
  organization_id WITH =, project_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&);
