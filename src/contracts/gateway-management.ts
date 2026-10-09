import { z } from "zod";
import { uuidSchema } from "./management";

export const gatewayEnrollmentSchema = z.strictObject({
  name: z.string().trim().min(2).max(100),
  gatewayDeviceId: uuidSchema,
  source: z.enum(["simulator", "aws_iot"]),
  principalId: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9:_/-]+$/),
  meterDeviceIds: z.array(uuidSchema).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, "No repitas medidores."),
});
export const gatewayRevocationSchema = z.strictObject({ status: z.literal("revoked") });
