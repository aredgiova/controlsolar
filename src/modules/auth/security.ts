import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EncryptJWT, jwtDecrypt, type JWTPayload } from "jose";
import type { AuthConfiguration } from "@/lib/config";
import { AuthorizationError } from "./errors";

export const SESSION_COOKIE = "solar_session";
export const FLOW_COOKIE = "solar_auth_flow";
export const FLOW_TTL_SECONDS = 600;
export const SESSION_MAX_SECONDS = 8 * 60 * 60;

export type Identity = { userId: string; email: string; displayName: string | null };
export type VerifiedIdentity = { issuer: string; subject: string; email: string; displayName: string | null; expiresAt: Date };
export type AuthFlow = { state: string; nonce: string; verifier: string; returnTo: string };

export function createOpaqueToken() { return randomBytes(32).toString("base64url"); }
export function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function isOpaqueToken(token: string) { return /^[A-Za-z0-9_-]{43}$/.test(token); }

export function safeReturnTo(value: string | null | undefined) {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20\x7f]/.test(value)) return "/organizations";
  try {
    const url = new URL(value, "https://application.invalid");
    if (url.origin !== "https://application.invalid" || /^\/(auth|login)(?:\/|$)/.test(url.pathname)) return "/organizations";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/organizations"; }
}

export function assertState(actual: string | null, expected: string) {
  if (!actual || !isOpaqueToken(actual) || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new AuthorizationError(401, "El inicio de sesión venció o no es válido. Intenta nuevamente.");
  }
}

function flowKey(secret: string) { return createHash("sha256").update(secret).digest(); }

export async function encryptFlow(flow: AuthFlow, secret: string, now = new Date()) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new EncryptJWT(flow)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer("controlsolar:oauth-flow").setAudience("controlsolar:callback")
    .setIssuedAt(issuedAt).setExpirationTime(issuedAt + FLOW_TTL_SECONDS)
    .encrypt(flowKey(secret));
}

export async function decryptFlow(value: string, secret: string, now = new Date()): Promise<AuthFlow> {
  const { payload } = await jwtDecrypt(value, flowKey(secret), {
    issuer: "controlsolar:oauth-flow", audience: "controlsolar:callback", currentDate: now,
    keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
  });
  const { state, nonce, verifier, returnTo } = payload;
  if (typeof state !== "string" || !isOpaqueToken(state) || typeof nonce !== "string" || !isOpaqueToken(nonce) ||
      typeof verifier !== "string" || !isOpaqueToken(verifier) || typeof returnTo !== "string") {
    throw new AuthorizationError();
  }
  return { state, nonce, verifier, returnTo: safeReturnTo(returnTo) };
}

export function cookieOptions(configuration: Pick<AuthConfiguration, "secureCookies">, maxAge: number) {
  return { httpOnly: true, secure: configuration.secureCookies, sameSite: "lax" as const, path: "/", maxAge };
}

// Called only after JOSE signature, issuer, audience and timestamp verification.
export function verifyIdentityClaims(claims: JWTPayload, configuration: Pick<AuthConfiguration, "issuer" | "clientId">, nonce: string, now = new Date()): VerifiedIdentity {
  if (claims.iss !== configuration.issuer || claims.aud !== configuration.clientId || claims.token_use !== "id" ||
      claims.nonce !== nonce || claims.email_verified !== true || typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.email !== "string" || !claims.email.includes("@") || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) ||
      typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat * 1000 > now.getTime() + 30_000 ||
      claims.exp * 1000 <= now.getTime()) {
    throw new AuthorizationError(401, "No fue posible verificar la identidad o el correo electrónico.");
  }
  return {
    issuer: claims.iss,
    subject: claims.sub,
    email: claims.email.trim().toLowerCase(),
    displayName: typeof claims.name === "string" ? claims.name.slice(0, 200) : null,
    expiresAt: new Date(Math.min(claims.exp * 1000, now.getTime() + SESSION_MAX_SECONDS * 1000)),
  };
}

export function assertRequestOrigin(request: Request, appBaseUrl: string) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(appBaseUrl).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AuthorizationError(403, "La solicitud debe originarse en esta aplicación.");
  }
}

export function readRequestCookie(request: Request, name: string) {
  const entries = (request.headers.get("cookie") ?? "").split(";");
  const match = entries.find((entry) => entry.trim().startsWith(`${name}=`));
  return match ? match.trim().slice(name.length + 1) : undefined;
}
