import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { encryptStream, fingerprints, postgresCommand, readBackupKey, regularFile, safeRoot, validateOfflineDatabaseConnection, walkPrivateFiles, writeManifest } from "./backup-lib.mjs";
let stage = "configuration";

async function main() {
  if (!process.env.BACKUP_DATABASE_URL) throw new Error("BACKUP_DATABASE_URL is required; the web runtime must never receive this credential.");
  const backupUrl = validateOfflineDatabaseConnection(process.env.BACKUP_DATABASE_URL);
  if (decodeURIComponent(backupUrl.username) !== "solar_backup") throw new Error("Backup requires the dedicated offline solar_backup role.");
  const key = readBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  if (process.env.APP_ENV !== "development" && !process.env.BACKUP_ROOT) throw new Error("Configure a private BACKUP_ROOT for staging/production.");
  const root = await safeRoot(process.env.BACKUP_ROOT || ".work/backups");
  const id = randomUUID(); const directory = path.join(root, id);
  await mkdir(directory, { mode: 0o700 });
  const client = new pg.Client({ connectionString: backupUrl.toString(), options: "-c timezone=UTC", connectionTimeoutMillis: 5000 });
  const started = performance.now();
  try {
    stage = "connection"; await client.connect();
    stage = "role validation";
    const role = await client.query(`SELECT current_user='solar_backup' AND session_user='solar_backup' AND NOT r.rolsuper AND r.rolbypassrls
      AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
      AND NOT EXISTS (SELECT FROM pg_roles privileged WHERE privileged.rolname<>current_user
        AND (privileged.rolsuper OR privileged.rolbypassrls OR privileged.rolname='solar_migrator') AND pg_has_role(current_user,privileged.oid,'MEMBER'))
      AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND (c.relowner=r.oid OR has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) AS safe
      FROM pg_roles r WHERE r.rolname=current_user`);
    if (!role.rows[0]?.safe) throw new Error("Backup requires the dedicated offline read-only solar_backup role.");
    stage = "snapshot"; await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    stage = "fingerprints"; const tables = await fingerprints(client);
    stage = "pg_dump and encryption";
    const command = postgresCommand(process.env.PG_DUMP_BIN || "pg_dump", ["--format=custom", "--no-password", `--snapshot=${snapshot}`], backupUrl.toString());
    const encrypted = await encryptStream(command.child.stdout, path.join(directory, "database.enc"), key, `${id}/database`);
    const warnings = await command.done;
    if (warnings.trim()) throw new Error("pg_dump emitted diagnostics; backup withheld until the operator reviews the server log.");
    stage = "snapshot commit"; await client.query("COMMIT");
    const files = [{ name: "database.enc", kind: "database", ...encrypted }];
    if (process.env.BACKUP_REPORT_ROOT) {
      stage = "private file backup";
      const storage = await safeRoot(process.env.BACKUP_REPORT_ROOT);
      for (const relative of await walkPrivateFiles(storage)) {
        const name = `report-${files.length}.enc`;
        files.push({ name, kind: "report", relative, ...await encryptStream(createReadStream(await regularFile(storage, relative)), path.join(directory, name), key, `${id}/${relative}`) });
      }
    }
    const manifest = { version: 1, id, createdAt: new Date().toISOString(), sourceDatabase: decodeURIComponent(backupUrl.pathname.slice(1)), tables, files, reportsIncluded: Boolean(process.env.BACKUP_REPORT_ROOT), durationMs: Math.round(performance.now() - started) };
    stage = "signed manifest"; await writeManifest(directory, manifest, key);
    console.log(JSON.stringify({ backupId: id, directory, tables: tables.length, files: files.length, durationMs: manifest.durationMs }));
  } finally { await client.end(); }
}
main().catch(() => { console.error(`Backup failed at ${stage}. No complete signed manifest was published; review configuration and the operator runbook.`); process.exitCode = 1; });
