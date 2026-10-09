import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { reportRequestSchema } from "../src/contracts/reports";
import { reportDay, finalizeSnapshot } from "../src/modules/reports/snapshot";
import { renderReportPdf } from "../src/modules/reports/pdf";
import { LocalReportStorage, verifyReportBytes, type ReportArtifact } from "../src/modules/reports/storage";
import { createReportWorker } from "../src/modules/reports/worker";
import { downloadLeaseExpiry, downloadTokenHash } from "../src/modules/reports/service";
import type { ReportWorkerStore, ClaimedReportJob } from "../src/modules/reports/store";
import type { EnergyContext, EnergySample } from "../src/modules/telemetry/energy";
const now = new Date("2026-10-09T14:00:00Z"); const reportId = randomUUID(), organizationId = randomUUID(), projectId = randomUUID();
function context(): EnergyContext {
  const sample = (point: string, hour: number, imported: number, exported: number): EnergySample => ({ eventId: randomUUID(), bindingId: `${point}-binding`, deviceId: `${point}-device`, measurementPointId: point, configurationVersion: 1, measuredAt: `2026-10-09T${hour}:00:00Z`, receivedAt: `2026-10-09T${hour}:00:05Z`, activePower: 3, importEnergy: imported, exportEnergy: exported, quality: "measured", source: "simulator" });
  return { projectId, timezone: "America/Bogota", points: [{ id: "gen", kind: "generation" }, { id: "grid", kind: "grid" }], bindings: ["gen", "grid"].map((point) => ({ id: `${point}-binding`, deviceId: `${point}-device`, measurementPointId: point, configurationVersion: 1, validFrom: "2026-01-01T00:00:00Z", validTo: null, configuration: { channel: "1", multiplier: 1 } })), topologyVersions: [{ id: "topology-1", version: 1, validFrom: "2026-01-01T00:00:00Z", validTo: null, configuration: { type: "grid_tied_no_battery", generationPointId: "gen", gridPointId: "grid", consumptionPointId: null } }], samples: [sample("gen", 12, 10, 0), sample("gen", 13, 13, 0), sample("grid", 12, 20, 2), sample("grid", 13, 22, 3)] };
}
function snapshot(days = [reportDay(context(), "2026-10-09")]) { return finalizeSnapshot({ reportId, organizationId, projectId, projectName: "Instalación solar - Yopal", timezone: "America/Bogota", startDate: days[0].date, endDate: days.at(-1)!.date, generatedAt: now.toISOString(), requestedAt: now.toISOString(), days, basis: { methodVersion: "energy-v2", integrationGapSeconds: 300, topologies: context().topologyVersions, bindings: context().bindings } }); }
function artifact(bytes: Uint8Array): ReportArtifact { const sha256 = createHash("sha256").update(bytes).digest("hex"); return { artifactKey: `reports/${organizationId}/${reportId}/${sha256}.pdf`, sha256, byteLength: bytes.byteLength }; }

test("report period validates real civil dates, bounded inclusive length and no injected authority", () => {
  const input = { startDate: "2026-10-01", endDate: "2026-10-31", idempotencyKey: randomUUID() }; assert.ok(reportRequestSchema.safeParse(input).success);
  for (const invalid of [{ endDate: "2026-11-01" }, { startDate: "2026-02-30" }, { endDate: "2026-09-30" }, { organizationId }, { timezone: "UTC" }]) assert.equal(reportRequestSchema.safeParse({ ...input, ...invalid }).success, false);
});
test("snapshot preserves electrical quality separately from simulated provenance and temporal versions", () => {
  const result = snapshot(); assert.equal(result.source, "simulator"); assert.equal(result.energy.generationKwh.value, 3); assert.equal(result.energy.gridImportKwh.value, 2); assert.equal(result.energy.gridExportKwh.value, 1); assert.equal(result.energy.consumptionKwh.value, 4);
  assert.equal(result.energy.generationKwh.quality, "measured"); assert.equal(result.energy.consumptionKwh.quality, "calculated"); assert.equal(result.coverage.coveredSeconds, 3600); assert.equal(result.basis.topologies[0].version, 1); assert.equal(result.basis.bindings[0].configurationVersion, 1);
});
test("partial missing days do not become zero totals, and DST changes the period denominator", () => {
  const empty = context(); empty.samples = []; const missing = reportDay(empty, "2026-10-10"); const result = snapshot([reportDay(context(), "2026-10-09"), missing]);
  assert.equal(result.energy.generationKwh.value, null); assert.equal(result.energy.generationKwh.quality, "missing"); assert.equal(result.coverage.coveredSeconds, 3600); assert.equal(result.coverage.daySeconds, 172800);
  empty.timezone = "America/New_York"; assert.equal(reportDay(empty, "2026-03-08").coverage.daySeconds, 23 * 3600);
});
test("download tokens are hashed and expire exactly five minutes from the supplied clock", () => {
  const token = "a".repeat(64); assert.notEqual(downloadTokenHash(token), token); assert.equal(downloadTokenHash(token), createHash("sha256").update(token).digest("hex")); assert.equal(downloadLeaseExpiry(now).getTime() - now.getTime(), 300000);
});
test("PDF is a real multi-page document even at the maximum period", async () => {
  const day = reportDay(context(), "2026-10-09"); const days = Array.from({ length: 31 }, (_, index) => ({ ...day, date: `2026-10-${String(index + 1).padStart(2, "0")}` }));
  const bytes = await renderReportPdf(snapshot(days)); assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-"); const doc = await PDFDocument.load(bytes); assert.ok(doc.getPageCount() >= 2); assert.equal(doc.getTitle(), "Informe solar 2026-10-01 a 2026-10-31");
});
test("private local storage is idempotent and rejects traversal, public paths, production and corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "solar-report-")); const storage = new LocalReportStorage(directory, "development");
  try { const bytes = await renderReportPdf(snapshot()), meta = artifact(bytes); await storage.put(meta, bytes); await storage.put(meta, bytes); assert.deepEqual(await storage.get(meta), Buffer.from(bytes));
    await assert.rejects(storage.get({ ...meta, artifactKey: "../public/report.pdf" })); assert.throws(() => new LocalReportStorage(resolve("public/reports"), "development")); assert.throws(() => new LocalReportStorage(directory, "production"));
    assert.throws(() => verifyReportBytes({ ...meta, sha256: "f".repeat(64) }, bytes)); await writeFile(join(directory, ...meta.artifactKey.split("/")), Buffer.alloc(meta.byteLength, 65)); await assert.rejects(storage.get(meta), /integridad/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("private storage rejects a symlink/junction root", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "solar-link-")), target = join(directory, "target"), link = join(directory, "link"); await mkdir(target);
  try { try { await symlink(target, link, process.platform === "win32" ? "junction" : "dir"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("OS does not permit creating symlink fixtures"); return; } throw error; }
    const bytes = await renderReportPdf(snapshot()); await assert.rejects(new LocalReportStorage(link, "development").put(artifact(bytes), bytes), /seguro/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("worker claims once, renews between days and commits only after private storage", async () => {
  const job: ClaimedReportJob = { id: reportId, organizationId, projectId, projectName: "Piloto local", timezone: "America/Bogota", startDate: "2026-10-09", endDate: "2026-10-09", createdAt: now.toISOString(), attempts: 1 };
  let pending = true, stored = false, completed = false, renewals = 0;
  const store: ReportWorkerStore = { claim: async () => pending ? (pending = false, job) : null, renew: async () => { renewals++; }, context: async () => context(), complete: async (_id, _hash, value) => { assert.ok(stored); assert.equal(value.snapshotJson.source, "simulator"); assert.equal(value.snapshotJson.timezone, job.timezone); completed = true; }, fail: async () => assert.fail("unexpected failure") };
  const run = createReportWorker(store, { put: async (meta, bytes) => { verifyReportBytes(meta, bytes); stored = true; }, get: async () => new Uint8Array() }, () => now);
  assert.equal(await run("test-worker"), "completed"); assert.ok(completed); assert.equal(renewals, 2); assert.equal(await run("test-worker"), "empty");
});
test("worker transient generation failure schedules a bounded retry and does not complete", async () => {
  let retry: Date | undefined; const job: ClaimedReportJob = { id: reportId, organizationId, projectId, projectName: "Piloto", timezone: "UTC", startDate: "2026-10-09", endDate: "2026-10-09", createdAt: now.toISOString(), attempts: 1 };
  const store: ReportWorkerStore = { claim: async () => job, renew: async () => {}, context: async () => { throw new Error("database unavailable"); }, complete: async () => assert.fail("must not complete"), fail: async (_id, _hash, code, at) => { assert.equal(code, "REPORT_GENERATION_FAILED"); retry = at; } };
  assert.equal(await createReportWorker(store, { put: async () => assert.fail("must not publish"), get: async () => new Uint8Array() }, () => now)("test-worker"), "retry"); assert.equal(retry!.getTime() - now.getTime(), 5000);
});
