import "server-only";
import { createHmac } from "node:crypto";
import { withAuthenticationDatabase } from "@/lib/db";
import { readAuthConfig } from "@/lib/config";
import { HttpError } from "./errors";

export class RateLimitError extends HttpError {
  constructor(public readonly retryAfter: number) {
    super(429, "RATE_LIMITED", "Se alcanzó el límite de solicitudes. Espera antes de intentarlo nuevamente.");
  }
}

// Shared PostgreSQL counters work across application replicas. Neither arbitrary
// proxy headers nor raw identities are stored as counter keys.
export async function takeRateLimit(scope: "api_global" | "api_read" | "api_write" | "auth_login" | "auth_callback", key: string, limit: number, seconds = 60) {
  const hash = createHmac("sha256", readAuthConfig().secret).update(`${scope}\0${key}`).digest("hex");
  const result = await withAuthenticationDatabase((client) => client.query<{ allowed: boolean; retry_after: number }>(
    "SELECT * FROM public.auth_take_rate_limit($1,$2,$3,$4)", [scope, hash, limit, seconds],
  ));
  if (!result.rows[0]?.allowed) throw new RateLimitError(Math.max(1, result.rows[0]?.retry_after ?? seconds));
}
