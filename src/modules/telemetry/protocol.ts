import { z } from "zod";

export const TELEMETRY_SCHEMA_VERSION = "2.0" as const;
const timestamp = z.iso.datetime({ offset: true });
const counter = z.number().finite().nonnegative().max(1e12).nullable();
const power = z.number().finite().min(-1e6).max(1e6).nullable();
export const phaseSchema = z.strictObject({
  phase: z.enum(["A", "B", "C"]), voltage_v: z.number().finite().min(0).max(1500).nullable(),
  current_a: z.number().finite().min(0).max(1e6).nullable(), active_power_kw: power,
});
export const reportedAlarmSchema = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/), severity: z.enum(["warning", "critical"]), active: z.boolean() });
/** The wire message carries electrical observations, never authority or reception time. */
export const telemetryMessageSchema = z.strictObject({
  schema_version: z.literal(TELEMETRY_SCHEMA_VERSION), event_id: z.uuid(), device_id: z.uuid(),
  measurement_point_id: z.uuid(), configuration_version: z.number().int().positive().max(2147483647),
  measured_at: timestamp,
  values: z.strictObject({ active_power: power, import_energy: counter, export_energy: counter }),
  units: z.strictObject({ active_power: z.literal("kW"), import_energy: z.literal("kWh"), export_energy: z.literal("kWh") }),
  quality: z.enum(["measured", "missing", "invalid"]),
  phases: z.array(phaseSchema).min(1).max(3).optional(),
  // Omitted means unsupported/unreported; [] explicitly reports no active alarms.
  alarms: z.array(reportedAlarmSchema).max(32).optional(),
}).superRefine((message, context) => {
  if (message.quality === "missing" && (Object.values(message.values).some((value) => value !== null) || message.phases?.some((phase) => phase.voltage_v !== null || phase.current_a !== null || phase.active_power_kw !== null))) {
    context.addIssue({ code: "custom", path: ["quality"], message: "Una observación ausente no contiene valores eléctricos." });
  }
  if (message.quality === "measured" && Object.values(message.values).every((value) => value === null)) context.addIssue({ code: "custom", path: ["quality"], message: "Una observación medida requiere al menos un valor." });
  if (message.phases && new Set(message.phases.map((phase) => phase.phase)).size !== message.phases.length) context.addIssue({ code: "custom", path: ["phases"], message: "Cada fase aparece una sola vez." });
  if (message.alarms && new Set(message.alarms.map((alarm) => alarm.code)).size !== message.alarms.length) context.addIssue({ code: "custom", path: ["alarms"], message: "Cada código de alarma aparece una sola vez." });
});
export const gatewayLossReportSchema = z.strictObject({ report_id: z.uuid(), from: timestamp, to: timestamp, dropped: z.number().int().positive().max(1e9), reason: z.literal("buffer_capacity") }).refine((report) => Date.parse(report.to) >= Date.parse(report.from), "El intervalo de pérdida es inválido.");
export const telemetryPacketSchema = z.strictObject({
  schema_version: z.literal(TELEMETRY_SCHEMA_VERSION), gateway_id: z.uuid(), packet_id: z.uuid(), sent_at: timestamp,
  samples: z.array(telemetryMessageSchema).max(100), loss_reports: z.array(gatewayLossReportSchema).max(100).default([]),
}).refine((packet) => packet.samples.length + packet.loss_reports.length > 0, "El paquete debe contener observaciones o pérdidas.");

export type TelemetryMessage = z.infer<typeof telemetryMessageSchema>;
export type TelemetryPacket = z.infer<typeof telemetryPacketSchema>;
export type GatewayLossReport = z.infer<typeof gatewayLossReportSchema>;
export type TelemetryQuality = "measured" | "calculated" | "estimated" | "missing" | "invalid";
export type TelemetrySource = "simulator" | "aws_iot";
export interface TelemetryTransportContext { source: TelemetrySource; principalId: string; clientId: string; topic: string; receivedAt: Date | string; expectedGatewayId?: string }

/** Stable key ordering also makes a redelivery distinguishable from an event-ID collision. */
export function canonicalTelemetry(message: TelemetryMessage): string {
  const canonical = { schema_version: message.schema_version, event_id: message.event_id, device_id: message.device_id,
    measurement_point_id: message.measurement_point_id, configuration_version: message.configuration_version,
    measured_at: new Date(message.measured_at).toISOString(), values: { active_power: message.values.active_power,
      import_energy: message.values.import_energy, export_energy: message.values.export_energy }, units: message.units,
    quality: message.quality, ...(message.phases ? { phases: [...message.phases].sort((a, b) => a.phase.localeCompare(b.phase)).map((phase) => ({ phase: phase.phase, voltage_v: phase.voltage_v, current_a: phase.current_a, active_power_kw: phase.active_power_kw })) } : {}),
    ...(message.alarms ? { alarms: [...message.alarms].sort((a, b) => a.code.localeCompare(b.code)).map((alarm) => ({ code: alarm.code, severity: alarm.severity, active: alarm.active })) } : {}) };
  return JSON.stringify(canonical);
}
