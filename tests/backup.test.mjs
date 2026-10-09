import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { mkdtemp, readFile, writeFile, unlink, rmdir, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { childPath, decryptFile, encryptStream, postgresEnvironment, readBackupKey, signManifest, validateOfflineDatabaseConnection, verifyManifest } from "../scripts/backup-lib.mjs";

test("backup authenticates ciphertext, archive identity and signed inventory before restoration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "solar-backup-test-"));
  const encrypted = path.join(directory, "data.enc"), plain = path.join(directory, "data.dump"), key = randomBytes(32);
  try {
    assert.deepEqual(readBackupKey(key.toString("base64")), key);
    assert.throws(() => readBackupKey("short"));
    const metadata = await encryptStream(Readable.from(Buffer.from("PGDMP private fixture")), encrypted, key, "job/database");
    const manifest = { version: 1, files: [{ name: "data.enc", ...metadata }] };
    assert.deepEqual(verifyManifest({ manifest, signature: signManifest(manifest, key) }, key), manifest);
    assert.throws(() => verifyManifest({ manifest: { ...manifest, version: 2 }, signature: signManifest(manifest, key) }, key), /authentication/);
    await assert.rejects(decryptFile(encrypted, plain, key, metadata, "other/database"));
    await unlink(plain);
    await decryptFile(encrypted, plain, key, metadata, "job/database");
    assert.equal(await readFile(plain, "utf8"), "PGDMP private fixture");
    await unlink(plain);
    const bytes = await readFile(encrypted); bytes[0] ^= 1; await writeFile(encrypted, bytes);
    await assert.rejects(decryptFile(encrypted, plain, key, metadata, "job/database"), /checksum/);
    assert.throws(() => childPath(directory, "../escape"), /Unsafe/);
    assert.throws(() => childPath(directory, path.resolve("public")), /Unsafe/);
  } finally {
    for (const file of [encrypted, plain]) await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
});

test("offline clients preserve explicit TLS options and reject ambiguous connection overrides", () => {
  const environment = postgresEnvironment("postgresql://solar_backup:fixture@localhost:55432/solar_test?sslmode=verify-full&sslrootcert=private-ca.pem");
  assert.equal(environment.PGSSLMODE, "verify-full"); assert.equal(environment.PGSSLROOTCERT, "private-ca.pem");
  assert.equal(environment.PGDATABASE, "solar_test"); assert.equal(environment.PGOPTIONS, undefined);
  assert.throws(() => postgresEnvironment("postgresql://localhost/solar_test?host=other"));
  assert.throws(() => postgresEnvironment("postgresql://localhost/solar_test?sslmode=disable&sslmode=require"));
  const remote = "postgresql://solar_backup:fixture-private@db.internal/solar_staging?sslmode=verify-full";
  assert.equal(validateOfflineDatabaseConnection(remote, {}).searchParams.get("sslmode"), "verify-full");
  const invalid = [remote.replace("?sslmode=verify-full", ""), remote.replace("verify-full", "disable"), remote.replace("verify-full", "require"),
    remote + "&sslmode=disable", remote + "&host=127.0.0.1", remote + "&options=-c%20role=solar_migrator", remote + "&uselibpqcompat=true",
    remote + "&sslcert=client.pem", remote + "&sslrootcert=", remote + "&sslkey=%0A", remote + "#fragment", remote + "\n",
    remote.replace("solar_backup:fixture-private@", "fixture-private@"), remote.replace(":fixture-private@", "@"),
    remote.replace("db.internal", "%2Ftmp"), remote.replace("/solar_staging", "/"), remote.replace("/solar_staging", "/solar%2Fstaging"),
    remote.replace("fixture-private", "fixture%00private"), remote.replace("postgresql:", "http:")];
  for (const value of invalid) assert.throws(() => validateOfflineDatabaseConnection(value, {}), (error) => {
    assert.equal(error.message.includes("fixture-private"), false); assert.equal(error.message.includes("db.internal"), false); return true;
  });
  assert.throws(() => validateOfflineDatabaseConnection(remote, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(validateOfflineDatabaseConnection(`postgresql://solar_test_admin:fixture@${host}/solar_restore_test`, {}).searchParams.get("sslmode"), "disable");
});

test("libpq cannot inherit a destination, credentials or TLS mode different from the checked URL", () => {
  const inherited = { PATH: "fixture-path", PGHOSTADDR: "192.0.2.50", PGSSLMODE: "disable", PGSSLROOTCERT: "other-ca.pem", PGSERVICE: "production", PGSERVICEFILE: "private-service.conf", PGOPTIONS: "-c role=solar_migrator", PGUSER: "admin", PGPASSWORD: "other-private", PGDATABASE: "production", PGTARGETSESSIONATTRS: "read-write", pgHostAddr: "192.0.2.51" };
  const remote = postgresEnvironment("postgresql://solar_backup:fixture@db.internal:5432/solar_staging?sslmode=verify-full&sslrootcert=selected-ca.pem", inherited);
  assert.equal(remote.PATH, "fixture-path"); assert.equal(remote.PGHOST, "db.internal"); assert.equal(remote.PGUSER, "solar_backup");
  assert.equal(remote.PGDATABASE, "solar_staging"); assert.equal(remote.PGSSLMODE, "verify-full"); assert.equal(remote.PGSSLROOTCERT, "selected-ca.pem");
  for (const name of ["PGHOSTADDR", "pgHostAddr", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGTARGETSESSIONATTRS"]) assert.equal(remote[name], undefined);
  const local = postgresEnvironment("postgresql://solar_test_admin:fixture@127.0.0.1:55432/solar_restore_test", inherited);
  assert.equal(local.PGHOSTADDR, undefined); assert.equal(local.PGSSLMODE, "disable"); assert.equal(local.PGSSLROOTCERT, undefined);
  assert.equal(local.PGPASSWORD, "fixture");
});

test("backup and restore CLIs reject unsafe destinations before creating private output or opening a client", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "solar-backup-guard-"));
  try {
    const destination = path.join(directory, "must-not-exist");
    const base = { ...process.env, APP_ENV: "development", BACKUP_ROOT: destination, RESTORE_BACKUP_DIRECTORY: destination,
      BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      BACKUP_DATABASE_URL: "postgresql://solar_backup:fixture-private@192.0.2.50/solar_staging?sslmode=disable",
      RESTORE_DATABASE_URL: "postgresql://solar_test_admin:fixture-private@127.0.0.1/solar_restore_test?host=192.0.2.50" };
    for (const script of ["scripts/backup.mjs", "scripts/restore-rehearsal.mjs"]) {
      const result = spawnSync(process.execPath, [script], { cwd: process.cwd(), env: base, encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 1);
      assert.equal((result.stdout + result.stderr).includes("fixture-private"), false);
      assert.equal((result.stdout + result.stderr).includes("192.0.2.50"), false);
      await assert.rejects(lstat(destination), { code: "ENOENT" });
    }
  } finally { await rmdir(directory); }
});
