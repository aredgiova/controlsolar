import { z } from "zod";

export const uuidSchema = z.uuid();
export const membershipRoleSchema = z.enum(["owner", "administrator", "technician", "customer"]);
export const siteRoleSchema = z.enum(["technician", "customer"]);
const name = z.string().trim().min(2).max(160);
export const timezoneSchema = z.string().min(1).max(80).refine((value) => {
  try { new Intl.DateTimeFormat("es", { timeZone: value }); return true; } catch { return false; }
}, "Zona horaria IANA inválida.");
export const listQuerySchema = z.strictObject({
  search: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
export const organizationCreateSchema = z.strictObject({ name, slug: z.string().trim().min(3).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), timezone: timezoneSchema.default("America/Bogota") });
export const customerCreateSchema = z.strictObject({ name });
export const customerUpdateSchema = customerCreateSchema.partial().refine((value) => Object.keys(value).length > 0, "Incluye un cambio.");
const projectFieldsSchema = z.strictObject({
  customerId: uuidSchema, name, location: z.string().trim().min(2).max(240),
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
  capacityKwp: z.number().finite().positive().max(1000000),
  timezone: timezoneSchema.default("America/Bogota"),
  topologyType: z.literal("grid_tied_no_battery").default("grid_tied_no_battery"),
});
export const projectCreateSchema = projectFieldsSchema.refine((value) => (value.latitude == null) === (value.longitude == null), "Latitud y longitud deben definirse juntas.");
export const projectUpdateSchema = projectFieldsSchema.omit({ timezone: true, topologyType: true }).partial().extend({ timezone: timezoneSchema.optional(), topologyType: z.literal("grid_tied_no_battery").optional() }).refine((value) => Object.keys(value).length > 0, "Incluye un cambio.");
export const deviceCreateSchema = z.strictObject({ name, serialNumber: z.string().trim().min(3).max(120), kind: z.enum(["gateway", "meter"]) });
export const deviceUpdateSchema = z.strictObject({ name: name.optional() }).refine((value) => Object.keys(value).length > 0, "Incluye un cambio.");
const pointBase = z.strictObject({ name, kind: z.enum(["generation", "consumption", "grid"]), signConvention: z.enum(["positive_generation", "positive_consumption", "positive_import"]) });
export const pointCreateSchema = pointBase.refine((value) => value.signConvention === ({ generation: "positive_generation", consumption: "positive_consumption", grid: "positive_import" } as const)[value.kind], "La convención de signo no corresponde al punto.");
export const participantSchema = z.strictObject({ userId: uuidSchema, role: siteRoleSchema });
const timestamp = z.iso.datetime({ offset: true });
export const bindingSchema = z.strictObject({ deviceId: uuidSchema, measurementPointId: uuidSchema, validFrom: timestamp, configuration: z.strictObject({ channel: z.string().trim().min(1).max(80), multiplier: z.number().finite().positive().max(100000).default(1) }) });
export const topologySchema = z.strictObject({ validFrom: timestamp, configuration: z.strictObject({ type: z.literal("grid_tied_no_battery"), generationPointId: uuidSchema, gridPointId: uuidSchema, consumptionPointId: uuidSchema.nullable().default(null) }) }).refine((value) => new Set([value.configuration.generationPointId, value.configuration.gridPointId, value.configuration.consumptionPointId].filter(Boolean)).size === (value.configuration.consumptionPointId ? 3 : 2), "Usa un punto distinto para cada función.");
export const commissioningSchema = z.strictObject({ commissionedAt: timestamp, notes: z.string().trim().min(5).max(2000) });
export const membershipUpdateSchema = z.strictObject({ role: membershipRoleSchema.optional(), status: z.enum(["active", "disabled"]).optional() }).refine((value) => Object.keys(value).length > 0, "Incluye un cambio.");
export const invitationCreateSchema = z.strictObject({ email: z.email().trim().toLowerCase().max(254), role: membershipRoleSchema, projectIds: z.array(uuidSchema).max(100).default([]) }).refine((value) => value.role === "owner" || value.role === "administrator" ? value.projectIds.length === 0 : true, "Los administradores tienen acceso a toda la organización.");
export const invitationAcceptSchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) });

export type CustomerCreate = z.infer<typeof customerCreateSchema>;
export type ProjectCreate = z.infer<typeof projectCreateSchema>;
export type DeviceCreate = z.infer<typeof deviceCreateSchema>;
export type PointCreate = z.infer<typeof pointCreateSchema>;
export type BindingInput = z.infer<typeof bindingSchema>;
export type TopologyInput = z.infer<typeof topologySchema>;
export type InvitationCreate = z.infer<typeof invitationCreateSchema>;

/** Spreadsheet programs treat leading =,+,-,@ as formulae, even inside CSV quotes. */
export function csvCell(value: unknown): string {
  const source = value == null ? "" : String(value);
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(source) ? `'${source}` : source;
  return `"${safe.replaceAll('"', '""')}"`;
}
