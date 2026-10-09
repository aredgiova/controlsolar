import assert from "node:assert/strict";
import test from "node:test";
import { checkVercelDemoEnvironment } from "../scripts/check-vercel-demo.mjs";

const demo = { APP_ENV: "staging", DATA_ADAPTER: "demo", DEMO_MODE: "true" };

test("Vercel demo allows a production Next runtime only with explicit fixture configuration", () => {
  assert.doesNotThrow(() => checkVercelDemoEnvironment({ ...demo, NODE_ENV: "production", VERCEL_ENV: "production" }));
  for (const environment of [{}, { ...demo, APP_ENV: "production" }, { ...demo, DATA_ADAPTER: "postgres" }, { ...demo, DEMO_MODE: "false" }]) {
    assert.throws(() => checkVercelDemoEnvironment(environment));
  }
});

test("Vercel demo rejects real-service credentials without revealing values", () => {
  for (const key of ["DATABASE_URL", "AUTH_DATABASE_URL", "DATABASE_MIGRATION_URL", "WORKER_DATABASE_URL", "INGEST_DATABASE_URL", "COGNITO_CLIENT_SECRET", "COGNITO_ISSUER", "AUTH_SECRET", "AWS_SECRET_ACCESS_KEY", "REPORT_S3_BUCKET", "BACKUP_ENCRYPTION_KEY_FILE"]) {
    assert.throws(() => checkVercelDemoEnvironment({ ...demo, [key]: "private-test-value" }), (error) => {
      assert.ok(error.message.includes(key));
      assert.equal(error.message.includes("private-test-value"), false);
      return true;
    });
  }
  assert.doesNotThrow(() => checkVercelDemoEnvironment({ ...demo, DATABASE_URL: "", VERCEL_URL: "controlsolar-demo.vercel.app" }));
});
