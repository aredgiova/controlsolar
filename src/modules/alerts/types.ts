import type { EnergyBinding, EnergySample, EnergyTopology } from "@/modules/telemetry/energy";

export type AlertKind = "communication" | "invalid_data" | "generation" | "device_alarm";
export type AlertSeverity = "warning" | "critical";
export type AlertStatus = "pending" | "active" | "resolved";
export interface ReportedAlarm { code: string; severity: AlertSeverity; active: boolean }
export interface AlertRuleRecord {
  id: string; organizationId: string; projectId: string; name: string; kind: AlertKind;
  enabled: boolean; persistenceSeconds: number; recoverySeconds: number; configuration: unknown;
  createdAt: Date | string; updatedAt?: Date | string; lastEvaluatedAt?: Date | string | null;
}
export interface AlertState {
  id: string; ruleId: string; dedupKey: string; status: AlertStatus; episodeId: string;
  candidateSince: Date | string | null; recoverySince: Date | string | null;
  activatedAt: Date | string | null; resolvedAt: Date | string | null; lastEvaluatedAt: Date | string | null;
  title: string; message: string; severity: AlertSeverity; detail: unknown;
}
export interface MaintenanceRecord { id: string; from: Date | string; to: Date | string; cancelledAt: Date | string | null; reason: string }
export interface WorkerSnapshot {
  evaluatedAt: Date;
  project: { id: string; organizationId: string; name: string; timezone: string; commissionedAt: Date | string | null };
  rules: AlertRuleRecord[];
  points: Array<{ id: string; kind: "generation" | "grid" | "consumption"; signConvention?: string }>;
  bindings: EnergyBinding[];
  topologyVersions: EnergyTopology[];
  latestSamples: Array<EnergySample & { receivedAt: Date | string; alarms?: ReportedAlarm[] | null }>;
  states: AlertState[];
  maintenanceWindows: MaintenanceRecord[];
}
export interface AlertObservation {
  dedupKey: string; condition: "abnormal" | "normal" | "unknown"; title: string; message: string;
  severity: AlertSeverity; detail: Record<string, unknown>; forceResolve?: boolean;
}
export interface AlertTransition {
  ruleId: string; dedupKey: string; episodeId: string; status: AlertStatus;
  candidateSince: string | null; recoverySince: string | null; activatedAt: string | null;
  resolvedAt: string | null; lastEvaluatedAt: string; title: string; message: string;
  severity: AlertSeverity; detail: Record<string, unknown>; event: "activated" | "resolved" | null;
}
export interface NotificationRow {
  id: string; organizationId: string; projectId: string; eventKey: string;
  payload: { title: string; message: string; severity: AlertSeverity; alertId: string; episodeId: string };
  attempts: number; createdAt: Date | string;
}
