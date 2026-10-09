import assert from "node:assert/strict";
import test from "node:test";
import { validateDatabaseConnection } from "../src/lib/database-configuration";
import { ConfigurationError } from "../src/lib/configuration-error";
import { inspectDeploymentEnvironment } from "../src/operations/preflight";
import { getDatabase, getAuthenticationDatabase } from "../src/lib/db";
import { getWorkerPool } from "../src/lib/worker-db";
import { withTelemetryStore } from "../src/modules/telemetry/store";

const connection = "postgresql://solar_runtime:unit-secret@db.internal:5432/solar_staging?sslmode=verify-full";
test("database guard accepts explicit roles and verified TLS, plaintext only on development loopback", () => {
  assert.equal(validateDatabaseConnection(connection, "solar_runtime", "staging", "DATABASE_URL", {}).hostname, "db.internal");
  assert.equal(validateDatabaseConnection(connection.replace("solar_runtime", "solar_auth") + "&sslrootcert=%2Fetc%2Fsolar%2Fca.pem", "solar_auth", "production", "AUTH_DATABASE_URL", {}).searchParams.get("sslrootcert"), "/etc/solar/ca.pem");
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const local = `postgresql://solar_runtime:unit-secret@${host}/solar_test`;
    assert.doesNotThrow(() => validateDatabaseConnection(local, "solar_runtime", "development", "DATABASE_URL", {}));
    for (const environment of ["staging", "production", undefined]) assert.throws(() => validateDatabaseConnection(local, "solar_runtime", environment, "DATABASE_URL", {}), ConfigurationError);
  }
});

test("connection guard blocks URL overrides, duplicate TLS parameters and secret-bearing error messages", () => {
  const invalid = [connection + "&sslmode=disable", connection + "&sslmode=verify-full", connection + "&host=other.internal",
    connection + "&user=solar_migrator", connection + "&options=-c%20role%3Dsolar_migrator", connection + "&uselibpqcompat=true",
    connection + "&ssl=no-verify", connection + "&SSLMode=disable", connection + "&sslrootcert=", connection + "&sslcert=certificate.pem",
    connection.replace("verify-full", "require"), connection.replace("verify-full", "verify-ca"), connection.replace("solar_runtime:", "solar_migrator:"),
    connection.replace(":unit-secret@", "@"), connection.replace("db.internal", "%2Ftmp"), connection + "#fragment", connection + "\n"];
  for (const value of invalid) assert.throws(() => validateDatabaseConnection(value, "solar_runtime", "staging", "DATABASE_URL", {}), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError); assert.equal(error.message.includes("unit-secret"), false); assert.equal(error.message.includes("db.internal"), false); return true;
  });
  assert.throws(() => validateDatabaseConnection(connection, "solar_runtime", "production", "DATABASE_URL", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }), ConfigurationError);
});

test("web, auth, monitor and ingestion apply the transport guard before opening a pool", async () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { APP_ENV: "staging", DATA_ADAPTER: "postgres", DEMO_MODE: "false", DATABASE_URL: "postgresql://solar_runtime:unit-secret@localhost/solar_test", AUTH_DATABASE_URL: "postgresql://solar_auth:unit-secret@localhost/solar_test", WORKER_DATABASE_URL: "postgresql://solar_worker:unit-secret@localhost/solar_test", INGEST_DATABASE_URL: "postgresql://solar_ingest:unit-secret@localhost/solar_test" });
    assert.throws(() => getDatabase(), ConfigurationError);
    assert.throws(() => getAuthenticationDatabase(), ConfigurationError);
    await assert.rejects(getWorkerPool(), ConfigurationError);
    await assert.rejects(withTelemetryStore(async () => { assert.fail("must not reach SQL"); }), ConfigurationError);
  } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
});

const web = {
  APP_ENV: "staging", DATA_ADAPTER: "postgres", DEMO_MODE: "false", DATABASE_URL: connection, AUTH_DATABASE_URL: connection.replace("solar_runtime:", "solar_auth:"),
  APP_BASE_URL: "https://staging.solar.test", COGNITO_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool", COGNITO_CLIENT_ID: "unitclient123",
  COGNITO_DOMAIN: "https://solar-test.auth.us-east-1.amazoncognito.com", AUTH_SECRET: "unit-secret-configuration-only-32-bytes-minimum", REPORT_STORAGE: "s3", REPORT_S3_BUCKET: "solar-staging-reports", AWS_REGION: "us-east-1", REPORT_S3_ACCOUNT_ID: "123456789012",
};
test("readiness distinguishes configuration from external proof and catches incomplete/cross-process secrets", () => {
  const valid = inspectDeploymentEnvironment(web, "web");
  assert.equal(valid.ready, true); assert.equal(valid.scope, "configuration-only"); assert.ok(valid.pending.includes("Login real y asignaciones de usuarios"));
  for (const environment of [{ ...web, WORKER_DATABASE_URL: connection }, { ...web, DATABASE_MIGRATION_URL: connection }, { ...web, AUTH_SECRET: "" }, { ...web, REPORT_STORAGE: "local" }, { ...web, APP_BASE_URL: "https://solar-staging.example.invalid" }, { ...web, AUTH_DATABASE_URL: web.AUTH_DATABASE_URL.replace("solar_staging", "solar_production") }, { ...web, APP_BASE_URL: "http://127.0.0.1:3100" }]) {
    const result = inspectDeploymentEnvironment(environment, "web"); assert.equal(result.ready, false); assert.equal(JSON.stringify(result).includes("unit-secret"), false);
  }
  assert.equal(inspectDeploymentEnvironment({ APP_ENV: "development", DATA_ADAPTER: "demo", DEMO_MODE: "true" }, "web").ready, false);
  const development = { ...web, APP_ENV: "development", APP_BASE_URL: "http://localhost:3100", REPORT_STORAGE: "local" };
  assert.equal(inspectDeploymentEnvironment(development, "web").ready, true);
});

test("readiness profiles check workers and Lambda without requesting other service secrets", () => {
  const monitor = { APP_ENV: "staging", DATA_ADAPTER: "postgres", DEMO_MODE: "false", WORKER_DATABASE_URL: connection.replace("solar_runtime:", "solar_worker:") };
  assert.equal(inspectDeploymentEnvironment(monitor, "monitor").ready, true);
  assert.equal(inspectDeploymentEnvironment(monitor, "reports").ready, false);
  assert.equal(inspectDeploymentEnvironment({ ...monitor, AUTH_SECRET: web.AUTH_SECRET }, "monitor").ready, false);
  const ingestion = { APP_ENV: "staging", AWS_REGION: "us-east-1", INGEST_DATABASE_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:solar-staging/ingest-123", INGEST_QUEUE_ARN: "arn:aws:sqs:us-east-1:123456789012:solar-staging-telemetry" };
  assert.equal(inspectDeploymentEnvironment(ingestion, "ingestion").ready, true);
  assert.equal(inspectDeploymentEnvironment({ ...ingestion, INGEST_QUEUE_ARN: ingestion.INGEST_QUEUE_ARN.replace("123456789012", "999999999999") }, "ingestion").ready, false);
  assert.equal(inspectDeploymentEnvironment({ ...ingestion, INGEST_DATABASE_URL: connection }, "ingestion").ready, false);
});
