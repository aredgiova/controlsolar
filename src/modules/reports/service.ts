import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { reportDownloadTokenSchema, reportRequestSchema } from "@/contracts/reports";
import { uuidSchema } from "@/contracts/management";
import { withTenant } from "@/lib/tenant";
import { audit, DomainError, requireProject, type Actor } from "@/modules/organizations/access";
import { localDateAt, localDayWindow } from "../telemetry/energy";
import { getReportStorage, type ReportArtifact, type ReportStorage } from "./storage";
const reportSelection = { id: true, projectId: true, timezone: true, startDate: true, endDate: true, status: true, attempts: true, errorCode: true, createdAt: true, completedAt: true } as const;
export const downloadTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const downloadLeaseExpiry = (now = new Date()) => new Date(now.getTime() + 5 * 60000);
function deniedDownload(error: unknown) {
  if (!error || typeof error !== "object" || !("meta" in error) || !error.meta || typeof error.meta !== "object") return false;
  const meta = error.meta as { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  // Prisma's pg adapter carries SQLSTATE on the driver cause; the engine adapter
  // exposes meta.code instead. Only the expected authorization state is mapped.
  return meta.code === "42501" || meta.driverAdapterError?.cause?.originalCode === "42501";
}
export async function requestReport(actor: Actor, organizationId: string, projectId: string, input: unknown) {
  const data = reportRequestSchema.parse(input); uuidSchema.parse(projectId);
  return withTenant(actor, organizationId, async (tx) => {
    const project = await requireProject(tx, organizationId, projectId);
    const existing = await tx.reportJob.findFirst({ where: { organizationId, requestedBy: actor.userId, idempotencyKey: data.idempotencyKey }, select: reportSelection });
    if (existing) {
      if (existing.projectId !== projectId || existing.startDate.toISOString().slice(0, 10) !== data.startDate || existing.endDate.toISOString().slice(0, 10) !== data.endDate) throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "La clave de solicitud ya corresponde a otro informe.");
      return existing;
    }
    if (data.endDate > localDateAt(new Date(), project.timezone)) throw new DomainError(400, "FUTURE_REPORT_PERIOD", "El periodo no puede terminar en una fecha futura del proyecto.");
    const from = localDayWindow(data.startDate, project.timezone).from; const to = localDayWindow(data.endDate, project.timezone).to;
    const inserted = await tx.reportJob.createMany({ data: [{ id: randomUUID(), organizationId, projectId, requestedBy: actor.userId, idempotencyKey: data.idempotencyKey, timezone: project.timezone, startDate: new Date(`${data.startDate}T00:00:00Z`), endDate: new Date(`${data.endDate}T00:00:00Z`), from, to }], skipDuplicates: true });
    const job = await tx.reportJob.findFirst({ where: { organizationId, requestedBy: actor.userId, idempotencyKey: data.idempotencyKey }, select: reportSelection });
    if (!job || job.projectId !== projectId || job.startDate.toISOString().slice(0, 10) !== data.startDate || job.endDate.toISOString().slice(0, 10) !== data.endDate) throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "La clave de solicitud ya corresponde a otro informe.");
    if (inserted.count) await audit(tx, actor, organizationId, "report.requested", "report", job.id, { projectId, startDate: data.startDate, endDate: data.endDate, timezone: project.timezone }); return job;
  });
}
export async function listReports(actor: Actor, organizationId: string, projectId: string) {
  uuidSchema.parse(projectId);
  return withTenant(actor, organizationId, async (tx) => { await requireProject(tx, organizationId, projectId); return { items: await tx.reportJob.findMany({ where: { organizationId, projectId }, select: reportSelection, orderBy: { createdAt: "desc" }, take: 50 }) }; });
}
export async function createDownloadLease(actor: Actor, organizationId: string, reportId: string) {
  uuidSchema.parse(reportId);
  return withTenant(actor, organizationId, async (tx) => {
    const report = await tx.reportJob.findFirst({ where: { id: reportId, organizationId }, select: { id: true, projectId: true, status: true } });
    if (!report) throw new DomainError(404, "NOT_FOUND", "No se encontró el informe autorizado.");
    await requireProject(tx, organizationId, report.projectId);
    if (report.status !== "completed") throw new DomainError(409, "REPORT_NOT_READY", "El informe todavía no está disponible.");
    const token = randomBytes(32).toString("hex"), expiresAt = downloadLeaseExpiry();
    await tx.downloadLease.createMany({ data: [{ organizationId, projectId: report.projectId, reportJobId: reportId, userId: actor.userId, tokenHash: downloadTokenHash(token), expiresAt }] });
    await audit(tx, actor, organizationId, "report.download_authorized", "report", reportId); return { token, expiresAt: expiresAt.toISOString() };
  });
}
export async function downloadReport(actor: Actor, organizationId: string, reportId: string, token: string, storage: ReportStorage = getReportStorage()) {
  uuidSchema.parse(reportId); reportDownloadTokenSchema.parse(token);
  const artifact = await withTenant(actor, organizationId, async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ result: (ReportArtifact & { id: string; organizationId: string; startDate: string; endDate: string }) | null }[]>("SELECT public.app_consume_download_lease($1) AS result", downloadTokenHash(token)).catch((error: unknown) => {
      if (deniedDownload(error)) throw new DomainError(404, "INVALID_DOWNLOAD_LEASE", "La autorización de descarga no existe, expiró o ya fue utilizada.");
      throw error;
    });
    const report = rows[0]?.result;
    if (!report || report.id !== reportId || report.organizationId !== organizationId) throw new DomainError(404, "INVALID_DOWNLOAD_LEASE", "La autorización de descarga no existe, expiró o ya fue utilizada.");
    await audit(tx, actor, organizationId, "report.downloaded", "report", reportId); return report;
  });
  let bytes: Uint8Array;
  try { bytes = await storage.get(artifact); } catch { throw new DomainError(503, "REPORT_STORAGE_UNAVAILABLE", "El archivo no está disponible o no superó la verificación de integridad. Solicita otra autorización de descarga y reintenta."); }
  return { bytes, contentType: "application/pdf" as const, filename: `informe-solar-${artifact.startDate.slice(0, 10)}-${artifact.endDate.slice(0, 10)}.pdf` };
}
