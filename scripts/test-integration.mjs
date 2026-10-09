import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const environment = { ...process.env };
environment.SOLAR_DATABASE_TEST_ENV ??= environment.TEST_ENV_FILE;
if (environment.TEST_ENV_FILE) {
  const urls = JSON.parse(await readFile(environment.TEST_ENV_FILE, "utf8"));
  environment.TEST_ADMIN_DATABASE_URL ??= urls.admin;
  environment.TEST_RUNTIME_DATABASE_URL ??= urls.runtime;
  environment.TEST_AUTH_DATABASE_URL ??= urls.auth;
  environment.TEST_INGEST_DATABASE_URL ??= urls.ingest;
  environment.TEST_WORKER_DATABASE_URL ??= urls.worker;
  environment.TEST_BACKUP_DATABASE_URL ??= urls.backup;
}
for (const key of ["TEST_ADMIN_DATABASE_URL", "TEST_RUNTIME_DATABASE_URL", "TEST_AUTH_DATABASE_URL"]) assert.ok(environment[key], `${key} is required; use an isolated test database.`);
const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--test", "--test-concurrency=1", "tests/*.integration.test.ts"], { env: environment, stdio: "inherit" });
process.exit(result.status ?? 1);
