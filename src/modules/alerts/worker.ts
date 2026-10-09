import "server-only";
import { z } from "zod";
import { evaluateProject } from "./evaluator";
import { withAlertWorker } from "./store";
import type { NotificationRow } from "./types";

const cycleSchema = z.strictObject({ maxProjects: z.number().int().min(0).max(1000).default(100), maxNotifications: z.number().int().min(0).max(1000).default(100) });
export interface MonitoringCycleResult { projects: number; activated: number; resolved: number; notificationsDelivered: number; notificationsFailed: number }
type StoreRunner = typeof withAlertWorker;
type LocalPublisher = (notification: NotificationRow) => Promise<void>;

/** Publication is a durable in-app status change. External transports are not enabled. */
export function createMonitoringWorker(runStore: StoreRunner = withAlertWorker, publish: LocalPublisher = async () => undefined) {
  return async function runMonitoringCycle(input: unknown = {}): Promise<MonitoringCycleResult> {
    const options = cycleSchema.parse(input);
    const result: MonitoringCycleResult = { projects: 0, activated: 0, resolved: 0, notificationsDelivered: 0, notificationsFailed: 0 };
    for (let count = 0; count < options.maxProjects; count++) {
      const saved = await runStore(async (store) => {
        const snapshot = await store.claimProject(); if (!snapshot) return null;
        return store.saveEvaluation(snapshot.project.id, snapshot.evaluatedAt, evaluateProject(snapshot));
      });
      if (!saved) break;
      result.projects++; result.activated += saved.activated; result.resolved += saved.resolved;
    }
    for (let count = 0; count < options.maxNotifications; count++) {
      const delivered = await runStore(async (store) => {
        const notification = await store.claimNotification(); if (!notification) return null;
        try { await publish(notification); } catch {
          await store.completeNotification(notification.id, false, "IN_APP_PUBLICATION_FAILED"); return false;
        }
        await store.completeNotification(notification.id, true); return true;
      });
      if (delivered === null) break;
      if (delivered) result.notificationsDelivered++; else result.notificationsFailed++;
    }
    return result;
  };
}
export const runMonitoringCycle = createMonitoringWorker();
