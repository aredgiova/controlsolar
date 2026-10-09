import { z } from "zod";

const uuid = z.uuid();
export const gatewayConfigurationSchema = z.strictObject({
  gatewayId: uuid,
  clientId: z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/),
  endpoint: z.string().regex(/^[a-z0-9-]+\.iot\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/),
  topic: z.string().regex(/^solar\/v2\/gateways\/[0-9a-f-]{36}\/telemetry$/i),
  certificatePath: z.string().min(1), privateKeyPath: z.string().min(1), caPath: z.string().min(1),
  bufferPath: z.string().min(1),
  pollIntervalMs: z.number().int().min(5000).max(300000).default(10000),
  maxBufferSamples: z.number().int().min(100).max(1000000).default(50000),
  maxBufferBytes: z.number().int().min(65536).max(1073741824).default(67108864),
  meters: z.array(z.strictObject({
    model: z.literal("SDM630MCT-v1.7"),
    deviceId: uuid, measurementPointId: uuid, configurationVersion: z.number().int().positive(),
    host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535).default(502),
    unitId: z.number().int().min(1).max(247),
    wordOrder: z.enum(["high-first", "low-first"]).default("high-first"),
    powerSign: z.union([z.literal(1), z.literal(-1)]),
  })).min(1).max(8),
}).superRefine((configuration, context) => {
  if (configuration.topic !== `solar/v2/gateways/${configuration.gatewayId}/telemetry`) context.addIssue({ code: "custom", path: ["topic"], message: "El tópico debe corresponder al gateway." });
  if (configuration.clientId !== configuration.gatewayId) context.addIssue({ code: "custom", path: ["clientId"], message: "El clientId y Thing Name deben ser el UUID del gateway." });
  if (new Set(configuration.meters.map((meter) => meter.measurementPointId)).size !== configuration.meters.length) context.addIssue({ code: "custom", path: ["meters"], message: "No repitas puntos de medición." });
});
export type GatewayConfiguration = z.infer<typeof gatewayConfigurationSchema>;

export function readGatewayConfiguration(input: unknown) {
  const parsed = gatewayConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new Error("Configuración del gateway inválida. Revisa el esquema y sus campos requeridos.");
  return parsed.data;
}
