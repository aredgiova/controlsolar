import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const;
const id = z.string().min(1).max(120);
const timestamp = z.iso.datetime({ offset: true });
const versioned = { schema_version: z.literal(SCHEMA_VERSION) };

export const organizationSchema = z.strictObject({
  ...versioned,
  id,
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  timezone: z.literal("America/Bogota"),
});

export const membershipSchema = z.strictObject({
  ...versioned,
  id,
  organization_id: id,
  identity_subject: id,
  role: z.enum(["owner", "administrator", "technician", "customer"]),
  status: z.enum(["active", "invited", "disabled"]),
});

export const customerSchema = z.strictObject({
  ...versioned,
  id,
  organization_id: id,
  name: z.string().min(1),
});

export const projectSchema = z.strictObject({
  ...versioned,
  id,
  organization_id: id,
  customer_id: id,
  name: z.string().min(1),
  location: z.string().min(1),
  capacity_kwp: z.number().positive(),
  timezone: z.literal("America/Bogota"),
});

// Organization/project ownership belongs to this trusted registry, never the payload.
export const deviceSchema = z.strictObject({
  ...versioned,
  id,
  organization_id: id,
  project_id: id,
  name: z.string().min(1),
  kind: z.enum(["gateway", "meter"]),
  status: z.enum(["active", "retired"]),
  configuration_version: z.number().int().positive(),
});

export const measurementPointSchema = z.strictObject({
  ...versioned,
  id,
  device_id: id,
  project_id: id,
  name: z.string().min(1),
  kind: z.enum(["generation", "consumption", "grid"]),
  // For a grid measurement, positive power imports and negative power exports.
  sign_convention: z.enum(["positive_generation", "positive_consumption", "positive_import"]),
});

export const telemetrySampleSchema = z.strictObject({
  ...versioned,
  event_id: z.uuid(),
  device_id: id,
  measurement_point_id: id,
  measured_at: timestamp,
  received_at: timestamp,
  configuration_version: z.number().int().positive(),
  values: z.strictObject({
    active_power: z.number().finite().nullable(),
    import_energy: z.number().finite().nonnegative().nullable(),
    export_energy: z.number().finite().nonnegative().nullable(),
  }),
  units: z.strictObject({
    active_power: z.literal("kW"),
    import_energy: z.literal("kWh"),
    export_energy: z.literal("kWh"),
  }),
  quality: z.enum(["measured", "calculated", "missing", "invalid"]),
}).superRefine((sample, context) => {
  if (Date.parse(sample.received_at) < Date.parse(sample.measured_at)) {
    context.addIssue({ code: "custom", path: ["received_at"], message: "La recepción precede a la medición." });
  }
  if (sample.quality === "missing" && Object.values(sample.values).some((value) => value !== null)) {
    context.addIssue({ code: "custom", path: ["quality"], message: "Una muestra ausente no contiene valores." });
  }
  if (sample.quality === "measured" && Object.values(sample.values).every((value) => value === null)) {
    context.addIssue({ code: "custom", path: ["quality"], message: "Una muestra medida requiere al menos un valor." });
  }
});

export type Organization = z.infer<typeof organizationSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type MeasurementPoint = z.infer<typeof measurementPointSchema>;
export type TelemetrySample = z.infer<typeof telemetrySampleSchema>;
