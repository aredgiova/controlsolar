import "server-only";
import { withWorkerTransaction } from "@/lib/worker-db";
import type { EnergyContext } from "../telemetry/energy";
import type { ReportArtifact } from "./storage";
import type { ReportSnapshot } from "./snapshot";
export interface ClaimedReportJob { id: string; organizationId: string; projectId: string; projectName: string; timezone: string; startDate: string; endDate: string; createdAt: string; attempts: number }
export interface ReportWorkerStore {
  claim(workerId: string, leaseHash: string, leaseUntil: Date): Promise<ClaimedReportJob | null>;
  renew(jobId: string, leaseHash: string, leaseUntil: Date): Promise<void>;
  context(jobId: string, leaseHash: string, date: string): Promise<EnergyContext>;
  complete(jobId: string, leaseHash: string, artifact: ReportArtifact & { snapshotJson: ReportSnapshot }): Promise<void>;
  fail(jobId: string, leaseHash: string, errorCode: string, retryAt: Date): Promise<void>;
}
export const reportWorkerStore: ReportWorkerStore = {
  async claim(workerId, leaseHash, leaseUntil) { return withWorkerTransaction(async (client) => { const { rows: [row] } = await client.query<{ result: ClaimedReportJob | null }>("SELECT public.worker_claim_report_job($1,$2,$3::timestamptz) AS result", [workerId, leaseHash, leaseUntil.toISOString()]); return row.result; }); },
  async renew(jobId, leaseHash, leaseUntil) { await withWorkerTransaction(async (client) => { await client.query("SELECT public.worker_renew_report_job($1::uuid,$2,$3::timestamptz)", [jobId, leaseHash, leaseUntil.toISOString()]); }); },
  async context(jobId, leaseHash, date) { return withWorkerTransaction(async (client) => { const { rows: [row] } = await client.query<{ result: EnergyContext }>("SELECT public.worker_report_context($1::uuid,$2,$3::date) AS result", [jobId, leaseHash, date]); return row.result; }); },
  async complete(jobId, leaseHash, artifact) { await withWorkerTransaction(async (client) => { await client.query("SELECT public.worker_complete_report_job($1::uuid,$2,$3::jsonb)", [jobId, leaseHash, JSON.stringify(artifact)]); }); },
  async fail(jobId, leaseHash, errorCode, retryAt) { await withWorkerTransaction(async (client) => { await client.query("SELECT public.worker_fail_report_job($1::uuid,$2,$3,$4::timestamptz)", [jobId, leaseHash, errorCode, retryAt.toISOString()]); }); },
};
