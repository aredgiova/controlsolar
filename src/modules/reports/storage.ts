import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConfigurationError } from "@/lib/config";
export const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const objectKey = /^reports\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9]{64}\.pdf$/i;
export interface ReportArtifact { artifactKey: string; sha256: string; byteLength: number }
export interface ReportStorage { put(artifact: ReportArtifact, bytes: Uint8Array): Promise<void>; get(artifact: ReportArtifact): Promise<Uint8Array> }
function validateArtifact(artifact: ReportArtifact) {
  if (!objectKey.test(artifact.artifactKey) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !artifact.artifactKey.endsWith(`/${artifact.sha256}.pdf`) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 || artifact.byteLength > MAX_REPORT_BYTES) throw new Error("Metadatos del informe inválidos.");
}
export function verifyReportBytes(artifact: ReportArtifact, bytes: Uint8Array) {
  validateArtifact(artifact);
  if (bytes.byteLength !== artifact.byteLength || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Error("La integridad del informe no coincide.");
}
export class LocalReportStorage implements ReportStorage {
  private readonly root: string;
  constructor(root = resolve(".work/private-reports"), environment = process.env.APP_ENV) {
    if (environment !== "development") throw new ConfigurationError("El almacenamiento local de informes solo se permite en development.");
    this.root = resolve(/* turbopackIgnore: true */ root);
    const publicPath = resolve("public"); const fromPublic = relative(publicPath, this.root);
    if (!fromPublic || (!fromPublic.startsWith(`..${sep}`) && fromPublic !== ".." && !isAbsolute(fromPublic))) throw new ConfigurationError("Los informes deben estar fuera de public.");
  }
  private async path(key: string, create: boolean) {
    if (!objectKey.test(key)) throw new Error("Clave de informe inválida.");
    // Inspect every existing ancestor: a symlink in .work or a nested prefix
    // must never redirect private report reads into another directory.
    const target = resolve(/* turbopackIgnore: true */ this.root, ...key.split("/")); const chain: string[] = [];
    for (let current = dirname(target); ; current = dirname(current)) { chain.unshift(current); if (dirname(current) === current) break; }
    for (const directory of chain) {
      try { const info = await lstat(/* turbopackIgnore: true */ directory); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Directorio de informe no seguro.");
        const withinRoot = relative(this.root, directory);
        if (process.platform !== "win32" && (!withinRoot || (!withinRoot.startsWith(`..${sep}`) && withinRoot !== ".." && !isAbsolute(withinRoot))) && (info.mode & 0o077) !== 0) throw new Error("El directorio privado requiere permisos 0700.");
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error; await mkdir(/* turbopackIgnore: true */ directory, { mode: 0o700 }); }
    }
    const actual = await realpath(/* turbopackIgnore: true */ this.root); if (resolve(/* turbopackIgnore: true */ actual).toLowerCase() !== this.root.toLowerCase()) throw new Error("Directorio privado redirigido.");
    const within = relative(this.root, target); if (within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("Ruta de informe fuera del directorio privado.");
    return target;
  }
  async put(artifact: ReportArtifact, bytes: Uint8Array) {
    verifyReportBytes(artifact, bytes); const target = await this.path(artifact.artifactKey, true);
    try { await lstat(/* turbopackIgnore: true */ target); verifyReportBytes(artifact, await this.get(artifact)); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${target}.${randomUUID()}.tmp`; const file = await open(/* turbopackIgnore: true */ temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await rename(/* turbopackIgnore: true */ temporary, /* turbopackIgnore: true */ target); } catch (error) { await unlink(/* turbopackIgnore: true */ temporary).catch(() => {}); throw error; }
  }
  async get(artifact: ReportArtifact) {
    validateArtifact(artifact); const target = await this.path(artifact.artifactKey, false);
    const info = await lstat(/* turbopackIgnore: true */ target); if (info.isSymbolicLink() || !info.isFile() || info.size !== artifact.byteLength) throw new Error("Archivo de informe no seguro.");
    const file = await open(/* turbopackIgnore: true */ target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const current = await file.stat(); if (!current.isFile() || current.size !== artifact.byteLength) throw new Error("Archivo de informe inválido."); const bytes = await file.readFile(); verifyReportBytes(artifact, bytes); return bytes; } finally { await file.close(); }
  }
}
export class S3ReportStorage implements ReportStorage {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, private readonly region: string, private readonly accountId: string) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]+$/.test(region) || !/^\d{12}$/.test(accountId)) throw new ConfigurationError("Configura bucket, región y propietario de informes privados.");
    this.client = new S3Client({ region });
  }
  async put(artifact: ReportArtifact, bytes: Uint8Array) {
    verifyReportBytes(artifact, bytes);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: artifact.artifactKey, Body: bytes, ContentType: "application/pdf", ServerSideEncryption: "AES256", ExpectedBucketOwner: this.accountId, ChecksumSHA256: Buffer.from(artifact.sha256, "hex").toString("base64"), IfNoneMatch: "*" })).catch(async (error) => {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
      verifyReportBytes(artifact, await this.get(artifact));
    });
  }
  async get(artifact: ReportArtifact) {
    validateArtifact(artifact);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: artifact.artifactKey, ExpectedBucketOwner: this.accountId }));
    const body = response.Body as Readable | undefined;
    if (!body || response.ContentLength !== artifact.byteLength || response.ServerSideEncryption !== "AES256") { body?.destroy(); throw new Error("Metadatos privados del objeto no válidos."); }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) { size += chunk.byteLength; if (size > artifact.byteLength) { body.destroy(); throw new Error("Objeto de informe demasiado grande."); } chunks.push(chunk); }
    const bytes = Buffer.concat(chunks); verifyReportBytes(artifact, bytes); return bytes;
  }
}
export function getReportStorage(): ReportStorage {
  if (process.env.REPORT_STORAGE === "local") return new LocalReportStorage();
  if (process.env.REPORT_STORAGE === "s3") return new S3ReportStorage(process.env.REPORT_S3_BUCKET ?? "", process.env.AWS_REGION ?? "", process.env.REPORT_S3_ACCOUNT_ID ?? "");
  throw new ConfigurationError("Selecciona REPORT_STORAGE=local en development o s3 para informes privados.");
}
