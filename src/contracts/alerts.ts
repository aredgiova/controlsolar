import { z } from "zod";
import { listQuerySchema, uuidSchema } from "./management";

const seconds = z.number().int().min(0).max(86400);
const freshness = z.number().int().min(10).max(86400);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const communicationPolicySchema = z.strictObject({ staleAfterSeconds: freshness.default(900) });
export const invalidDataPolicySchema = z.strictObject({ maxMeasurementAgeSeconds: freshness.default(300) });
export const generationPolicySchema = z.strictObject({
  startLocalTime: clock, endLocalTime: clock,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  minimumPowerKw: z.number().finite().nonnegative().max(1000000), maxMeasurementAgeSeconds: freshness.default(300),
}).superRefine((value, context) => {
  if (value.startLocalTime === value.endLocalTime) context.addIssue({ code: "custom", path: ["endLocalTime"], message: "La ventana debe tener duración positiva." });
  if (new Set(value.weekdays).size !== value.weekdays.length) context.addIssue({ code: "custom", path: ["weekdays"], message: "No repitas días de la semana." });
});
export const deviceAlarmPolicySchema = z.strictObject({ maxMeasurementAgeSeconds: freshness.default(300), minimumSeverity: z.enum(["warning", "critical"]).default("warning") });
const common = { projectId: uuidSchema, name: z.string().trim().min(2).max(120), enabled: z.boolean().default(true), persistenceSeconds: seconds.default(300), recoverySeconds: seconds.default(120) };
export const alertRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("communication"), configuration: communicationPolicySchema }),
  z.strictObject({ ...common, kind: z.literal("invalid_data"), configuration: invalidDataPolicySchema }),
  z.strictObject({ ...common, kind: z.literal("generation"), configuration: generationPolicySchema }),
  z.strictObject({ ...common, kind: z.literal("device_alarm"), configuration: deviceAlarmPolicySchema }),
]);
// Update keeps project and kind fixed; complete policy replacement avoids partial JSON ambiguity.
export const alertRuleUpdateSchema = z.strictObject({ name: z.string().trim().min(2).max(120).optional(), enabled: z.boolean().optional(), persistenceSeconds: seconds.optional(), recoverySeconds: seconds.optional(), configuration: z.record(z.string(), z.unknown()).optional() }).refine((value) => Object.keys(value).length > 0, "Indica al menos un cambio.");
export const alertListQuerySchema = listQuerySchema.extend({ projectId: uuidSchema.optional(), status: z.enum(["pending", "active", "resolved"]).optional(), kind: z.enum(["communication", "invalid_data", "generation", "device_alarm"]).optional() });
export const incidentListQuerySchema = listQuerySchema.extend({ projectId: uuidSchema.optional(), status: z.enum(["open", "in_progress", "closed"]).optional() });
export const incidentCreateSchema = z.strictObject({ projectId: uuidSchema, title: z.string().trim().min(3).max(160), description: z.string().trim().max(4000).default(""), assigneeUserId: uuidSchema.nullable().optional(), alertId: uuidSchema.optional() });
export const incidentUpdateSchema = z.strictObject({ assigneeUserId: uuidSchema.nullable().optional(), status: z.enum(["open", "in_progress", "closed"]).optional(), resolution: z.string().trim().min(3).max(4000).optional() }).refine((value) => Object.keys(value).length > 0, "Indica al menos un cambio.").superRefine((value, context) => { if (value.status === "closed" && !value.resolution) context.addIssue({ code: "custom", path: ["resolution"], message: "El cierre requiere una resolución." }); });
export const incidentObservationSchema = z.strictObject({ note: z.string().trim().min(1).max(4000) });
export const maintenanceWindowSchema = z.strictObject({ projectId: uuidSchema, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), reason: z.string().trim().min(3).max(1000) }).refine((value) => Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 90 * 86400000, "La ventana debe ser positiva y no superar 90 días.");
export const maintenanceCancelSchema = z.strictObject({ cancelled: z.literal(true) });
export const projectFilterSchema = listQuerySchema.extend({ projectId: uuidSchema.optional() });
