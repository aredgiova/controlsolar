import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { decryptFile, fingerprints, postgresCommand, readBackupKey, readManifest, regularFile, safeRoot, childPath, validateOfflineDatabaseConnection } from "./backup-lib.mjs";

async function main() {
  const targetUrl = validateOfflineDatabaseConnection(process.env.RESTORE_DATABASE_URL || "");
  const target = decodeURIComponent(targetUrl.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{1,50}_restore_test$/.test(target) || !["127.0.0.1", "localhost", "[::1]"].includes(targetUrl.hostname)) throw new Error("Restore rehearsal only permits a loopback database ending in _restore_test.");
  if (!process.env.RESTORE_BACKUP_DIRECTORY) throw new Error("RESTORE_BACKUP_DIRECTORY is required.");
  const backup = await safeRoot(process.env.RESTORE_BACKUP_DIRECTORY);
  const key = readBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  const manifest = await readManifest(backup, key);
  if (target === manifest.sourceDatabase) throw new Error("Restore target cannot be the backup source.");
  const output = await safeRoot(process.env.RESTORE_REPORT_ROOT || `.work/restored-reports/${randomUUID()}`);
  if ((await readdir(output)).length) throw new Error("Restored private storage must be empty.");
  const temp = await safeRoot(`.work/restore-temp/${randomUUID()}`);
  const plain = path.join(temp, "database.dump");
  const started = performance.now();
  const client = new pg.Client({ connectionString: targetUrl.toString(), options: "-c timezone=UTC", connectionTimeoutMillis: 5000 });
  try {
    // Authenticate and validate all ciphertext before executing the trusted archive.
    const database = manifest.files.filter((file) => file.kind === "database");
    if (database.length !== 1 || database[0].name !== "database.enc") throw new Error("Invalid archive inventory.");
    await decryptFile(await regularFile(backup, database[0].name), plain, key, database[0], `${manifest.id}/database`);
    for (const file of manifest.files.filter((file) => file.kind === "report")) {
      const targetFile = childPath(output, file.relative);
      await mkdir(path.dirname(targetFile), { recursive: true, mode: 0o700 });
      await decryptFile(await regularFile(backup, file.name), targetFile, key, file, `${manifest.id}/${file.relative}`);
    }
    await client.connect();
    const occupied = await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','S')");
    if (occupied.rows[0].count !== 0) throw new Error("Restore target must be empty; this command never overwrites a database.");
    const command = postgresCommand(process.env.PG_RESTORE_BIN || "pg_restore", ["--no-password", "--exit-on-error", "--single-transaction", "--dbname", target, plain], targetUrl.toString());
    command.child.stdout.resume();
    if ((await command.done).trim()) throw new Error("pg_restore emitted diagnostics; review the server log.");
    const restored = await fingerprints(client);
    if (JSON.stringify(restored) !== JSON.stringify(manifest.tables)) throw new Error("Restored table contents or FORCE RLS flags differ from the signed snapshot.");
    const evidence = { backupId: manifest.id, targetDatabase: target, verifiedTables: restored.length, forcedRlsTables: restored.filter((table) => table.rls && table.forced).length, restoredReportFiles: manifest.files.filter((file) => file.kind === "report").length, durationMs: Math.round(performance.now() - started), restoredAt: new Date().toISOString() };
    await writeFile(path.join(output, "restore-evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(evidence));
  } finally {
    await client.end();
    // Delete only this invocation's known decrypted file, never a recursive path.
    await unlink(plain).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
main().catch(() => { console.error("Restore rehearsal failed. Source database was not modified. Review the operator runbook and retain encrypted evidence."); process.exitCode = 1; });
