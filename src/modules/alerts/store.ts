import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { withWorkerTransaction } from "@/lib/worker-db";
import type { AlertTransition, NotificationRow, WorkerSnapshot } from "./types";

export interface AlertWorkerTransaction {
  claimProject(): Promise<WorkerSnapshot | null>;
  saveEvaluation(projectId: string, evaluatedAt: Date, results: AlertTransition[]): Promise<{ activated: number; resolved: number }>;
  claimNotification(): Promise<NotificationRow | null>;
  completeNotification(id: string, success: boolean, errorCode?: string): Promise<void>;
}

/** Project locks and outbox state share one checked worker transaction. */
export function withAlertWorker<T>(callback: (store: AlertWorkerTransaction) => Promise<T>): Promise<T> {
  return withWorkerTransaction(async (client) => {
    const workerId = `local-${randomUUID()}`;
    const leaseHash = createHash("sha256").update(randomUUID()).digest("hex");
    const store: AlertWorkerTransaction = {
      async claimProject() {
        const { rows: [row] } = await client.query<{ result: WorkerSnapshot | null }>("SELECT public.worker_claim_alert_project() AS result");
        return row.result ? { ...row.result, evaluatedAt: new Date(row.result.evaluatedAt) } : null;
      },
      async saveEvaluation(projectId, evaluatedAt, results) {
        const { rows: [row] } = await client.query<{ result: { activated: number; resolved: number } }>("SELECT public.worker_save_alert_evaluation($1::uuid,$2::timestamptz,$3::jsonb) AS result", [projectId, evaluatedAt.toISOString(), JSON.stringify(results)]);
        return row.result;
      },
      async claimNotification() {
        const { rows: [row] } = await client.query<{ result: NotificationRow | null }>("SELECT public.worker_claim_notification($1,$2) AS result", [workerId, leaseHash]);
        return row.result;
      },
      async completeNotification(id, success, errorCode) {
        await client.query("SELECT public.worker_complete_notification($1::uuid,$2,$3::boolean,$4::text)", [id, leaseHash, success, errorCode ?? null]);
      },
    };
    return callback(store);
  });
}
