import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { isIP } from "node:net";

export function readBackupKey(value) {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("BACKUP_ENCRYPTION_KEY requires a base64 encoded 32-byte key.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Invalid backup encryption key.");
  return key;
}
export function signManifest(manifest, key) { return createHmac("sha256", key).update("solar-backup-manifest-v1\0").update(JSON.stringify(manifest)).digest("hex"); }
export function verifyManifest(envelope, key) {
  if (!envelope?.manifest || signManifest(envelope.manifest, key) !== envelope.signature) throw new Error("Backup manifest authentication failed.");
  if (envelope.manifest.version !== 1 || !Array.isArray(envelope.manifest.files) || envelope.manifest.files.length > 100001) throw new Error("Unsupported backup manifest.");
  return envelope.manifest;
}
export async function fileHash(file) { const hash = createHash("sha256"); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest("hex"); }
export async function safeRoot(root) {
  const target = path.resolve(root);
  await mkdir(target, { recursive: true, mode: 0o700 });
  if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new Error("Backup roots must use canonical paths without symbolic links.");
  const publicRoot = path.resolve("public");
  if (target === publicRoot || target.startsWith(`${publicRoot}${path.sep}`)) throw new Error("Private backups cannot be stored under public/.");
  return target;
}
export function childPath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === ".." || part === ".")) throw new Error("Unsafe backup path.");
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Backup path escapes its root.");
  return file;
}
export async function regularFile(root, relative) {
  const file = childPath(root, relative);
  if (!(await lstat(file)).isFile() || await realpath(file) !== file) throw new Error("Backup entry must be a regular file without symbolic links.");
  return file;
}
export async function encryptStream(input, output, key, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  await pipeline(input, cipher, createWriteStream(output, { flags: "wx", mode: 0o600 }));
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), sha256: await fileHash(output), bytes: (await lstat(output)).size };
}
export async function decryptFile(input, output, key, metadata, aad) {
  if (await fileHash(input) !== metadata.sha256 || (await lstat(input)).size !== metadata.bytes) throw new Error("Backup ciphertext checksum mismatch.");
  if (!/^[a-f0-9]{24}$/.test(metadata.iv) || !/^[a-f0-9]{32}$/.test(metadata.tag)) throw new Error("Invalid encryption metadata.");
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(metadata.iv, "hex"));
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(Buffer.from(metadata.tag, "hex"));
  await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: "wx", mode: 0o600 }));
}
export function validateOfflineDatabaseConnection(connection, environment = process.env) {
  const fail = () => { throw new Error("Offline PostgreSQL requires an explicit destination and credentials, unambiguous SSL options and verify-full outside loopback."); };
  let url;
  try {
    if (typeof connection !== "string" || /[\u0000-\u0020\u007f]/.test(connection)) return fail();
    url = new URL(connection);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password), database = decodeURIComponent(url.pathname.slice(1));
    if (!/^postgres(ql)?:$/.test(url.protocol) || !user || !password || !host ||
      (!isIP(host) && !/^[A-Za-z0-9._-]+$/.test(host)) || !/^\/[^/]+$/.test(url.pathname) || url.hash ||
      /[\u0000-\u001f\u007f]/.test(user + password + database) ||
      // pg uses decodeURI for its database name, whereas libpq env is literal.
      // Reject reserved encoded delimiters rather than validate one database
      // with pg and then dump/restore a different name with libpq.
      database !== decodeURI(url.pathname.slice(1))) return fail();
  } catch { return fail(); }
  const seen = new Set();
  for (const [name, value] of url.searchParams) {
    if (!["sslmode", "sslrootcert", "sslcert", "sslkey"].includes(name) || seen.has(name) || !value || /[\u0000-\u001f\u007f]/.test(value)) return fail();
    seen.add(name);
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  const mode = url.searchParams.get("sslmode");
  if ((!local && mode !== "verify-full") || (mode !== null && !["verify-full", ...(local ? ["disable"] : [])].includes(mode)) ||
    Boolean(url.searchParams.get("sslcert")) !== Boolean(url.searchParams.get("sslkey")) || environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") return fail();
  // Keep node-postgres and the libpq child independent of ambient PGSSLMODE.
  if (mode === null) url.searchParams.set("sslmode", "disable");
  return url;
}
export function postgresEnvironment(connection, sourceEnvironment = process.env) {
  const url = validateOfflineDatabaseConnection(connection, sourceEnvironment);
  const tlsOptions = { sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY" };
  // libpq's PGHOSTADDR overrides PGHOST's network destination. Drop every PG*
  // variable (case-insensitively for Windows), then rebuild only explicit URL
  // settings so pg_restore cannot leave the loopback destination checked by pg.
  const environment = { ...Object.fromEntries(Object.entries(sourceEnvironment).filter(([name]) => !/^PG/i.test(name))),
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432", PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGAPPNAME: "solar-offline-backup", PGCONNECT_TIMEOUT: "30" };
  for (const [name, value] of url.searchParams) {
    environment[tlsOptions[name]] = value;
  }
  return environment;
}
export function postgresCommand(binary, args, connection) {
  const child = spawn(binary, args, { env: postgresEnvironment(connection), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = "";
  child.stderr.on("data", (bytes) => { diagnostic += bytes.toString().slice(0, 4000 - diagnostic.length); });
  const done = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("PostgreSQL backup executable could not be started.")));
    child.once("close", (code) => code === 0 ? resolve(diagnostic) : reject(new Error("PostgreSQL offline operation failed; inspect the database server log using the operator runbook.")));
  });
  // Attach immediately even when encryption finishes before the process exit.
  done.catch(() => {});
  return { child, done };
}
export async function fingerprints(client) {
  const tables = await client.query("SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname");
  const result = [];
  for (const table of tables.rows) {
    const quoted = `"${table.relname.replaceAll('"', '""')}"`;
    const rows = await client.query(`SELECT count(*)::int AS count, coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),1,15))::bit(60)::bigint),0)::text AS checksum FROM public.${quoted} t`);
    result.push({ name: table.relname, rls: table.relrowsecurity, forced: table.relforcerowsecurity, ...rows.rows[0] });
  }
  return result;
}
export async function walkPrivateFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Private storage contains a symbolic link.");
    if (entry.isDirectory()) result.push(...await walkPrivateFiles(root, relative));
    else if (entry.isFile()) { await regularFile(root, relative); result.push(relative); }
    else throw new Error("Unsupported private storage entry.");
    if (result.length > 100000) throw new Error("Private storage snapshot exceeds the file limit.");
  }
  return result.sort();
}
export async function writeManifest(directory, manifest, key) { await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ manifest, signature: signManifest(manifest, key) }, null, 2), { flag: "wx", mode: 0o600 }); }
export async function readManifest(directory, key) { return verifyManifest(JSON.parse(await readFile(await regularFile(directory, "manifest.json"), "utf8")), key); }
