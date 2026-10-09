import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { nextLocalDate, type EnergyContext } from "../telemetry/energy";
import { finalizeSnapshot, reportDay, type ReportDay } from "./snapshot";
import { renderReportPdf } from "./pdf";
import { getReportStorage, type ReportStorage } from "./storage";
import { reportWorkerStore, type ReportWorkerStore } from "./store";
export function createReportWorker(store: ReportWorkerStore, storage: ReportStorage, clock: () => Date = () => new Date()) {
  return async (workerId: string): Promise<"empty" | "completed" | "retry"> => {
    const leaseHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    const leaseUntil = () => new Date(clock().getTime() + 5 * 60000);
    const job = await store.claim(workerId, leaseHash, leaseUntil()); if (!job) return "empty";
    try {
      const startDate = job.startDate.slice(0, 10), endDate = job.endDate.slice(0, 10);
      if ((Date.parse(endDate) - Date.parse(startDate)) / 86400000 >= 31 || endDate < startDate) throw new Error("Periodo de worker inválido.");
      const days: ReportDay[] = []; const bindings = new Map<string, EnergyContext["bindings"][number]>(); const topologies = new Map<string, EnergyContext["topologyVersions"][number]>();
      const integrationGapSeconds = Number(process.env.TELEMETRY_MAX_INTEGRATION_GAP_SECONDS ?? 300);
      for (let date = startDate; date <= endDate; date = nextLocalDate(date)) {
        await store.renew(job.id, leaseHash, leaseUntil());
        const context = await store.context(job.id, leaseHash, date);
        if (context.projectId !== job.projectId || context.samples.length > 200000 || Buffer.byteLength(JSON.stringify(context)) > 64 * 1024 * 1024) throw new Error("Dataset de informe fuera de límites.");
        days.push(reportDay({ ...context, timezone: job.timezone }, date, integrationGapSeconds));
        context.bindings.forEach((binding) => bindings.set(binding.id, binding)); context.topologyVersions.forEach((topology) => topologies.set(topology.id, topology));
      }
      const snapshotJson = finalizeSnapshot({ reportId: job.id, organizationId: job.organizationId, projectId: job.projectId, projectName: job.projectName ?? job.projectId, timezone: job.timezone, startDate, endDate, generatedAt: clock().toISOString(), requestedAt: new Date(job.createdAt).toISOString(), days,
        basis: { methodVersion: "energy-v2", integrationGapSeconds, topologies: [...topologies.values()], bindings: [...bindings.values()] } });
      const bytes = await renderReportPdf(snapshotJson); const sha256 = createHash("sha256").update(bytes).digest("hex");
      const artifact = { artifactKey: `reports/${job.organizationId}/${job.id}/${sha256}.pdf`, sha256, byteLength: bytes.byteLength };
      await store.renew(job.id, leaseHash, leaseUntil()); await storage.put(artifact, bytes); await store.complete(job.id, leaseHash, { ...artifact, snapshotJson }); return "completed";
    } catch {
      // SQL enforces the active lease and maximum attempts; a stale worker cannot
      // overwrite another worker's result, even during failure handling.
      await store.fail(job.id, leaseHash, "REPORT_GENERATION_FAILED", new Date(clock().getTime() + Math.min(300, 5 * 2 ** Math.max(0, job.attempts - 1)) * 1000)); return "retry";
    }
  };
}
export function runReportWorkerOnce(workerId = `report-${randomUUID()}`) { return createReportWorker(reportWorkerStore, getReportStorage())(workerId); }
