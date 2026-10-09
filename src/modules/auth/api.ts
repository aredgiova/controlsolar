import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ConfigurationError, readAuthConfig, readConfig } from "@/lib/config";
import { HttpError } from "./errors";
import { assertRequestOrigin, type Identity } from "./security";
import { requireApiIdentity } from "./session";
import { RateLimitError, takeRateLimit } from "./rate-limit";

export function assertSameOrigin(request: Request) {
  assertRequestOrigin(request, readAuthConfig().appBaseUrl);
}

export function respondToApiError(error: unknown) {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "Cache-Control": "no-store", ...(error instanceof RateLimitError ? { "Retry-After": String(error.retryAfter) } : {}) } });
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json({ error: { code: "INVALID_INPUT", message: "Revisa los campos enviados." } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof ConfigurationError) {
    return NextResponse.json({ error: { code: "CONFIGURATION_REQUIRED", message: "El servicio requiere completar su configuración." } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof Error && "code" in error && ["P2002", "P2003", "P2004", "P2010"].includes(String(error.code))) {
    return NextResponse.json({ error: { code: "DATA_CONFLICT", message: "La operación entra en conflicto con los datos o permisos actuales." } }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  // Database/network/provider errors never expose SQL, environment values, or tokens.
  return NextResponse.json({ error: { code: "SERVICE_ERROR", message: "No fue posible completar la solicitud. Intenta nuevamente." } }, { status: 500, headers: { "Cache-Control": "no-store" } });
}

export function apiHandler<TContext>(handler: (request: Request, identity: Identity, context: TContext) => Promise<Response>) {
  return async (request: Request, context: TContext) => {
    try {
      if (!readConfig().demoMode) await takeRateLimit("api_global", "all", 1200);
      const identity = await requireApiIdentity(request);
      const write = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
      if (write) assertSameOrigin(request);
      await takeRateLimit(write ? "api_write" : "api_read", identity.userId, write ? 120 : 600);
      const response = await handler(request, identity, context);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) { return respondToApiError(error); }
  };
}
