import "server-only";
import { cookies } from "next/headers";
import { readConfig } from "@/lib/config";
import { AuthorizationError } from "./errors";
import { hashToken, isOpaqueToken, readRequestCookie, safeReturnTo, SESSION_COOKIE, type Identity } from "./security";
import { authenticationStore } from "./store";

async function resolveIdentity(token: string | undefined): Promise<Identity | null> {
  if (!token || !isOpaqueToken(token) || readConfig().demoMode) return null;
  const session = await authenticationStore.resolveSession(hashToken(token));
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return { userId: session.userId, email: session.email, displayName: session.displayName };
}

export async function getCurrentIdentity(): Promise<Identity | null> {
  return resolveIdentity((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function getIdentityFromRequest(request: Request): Promise<Identity | null> {
  return resolveIdentity(readRequestCookie(request, SESSION_COOKIE));
}

export async function requireIdentity(returnTo?: string): Promise<Identity> {
  const identity = await getCurrentIdentity();
  if (!identity) {
    const { redirect } = await import("next/navigation");
    return redirect(`/login?next=${encodeURIComponent(safeReturnTo(returnTo))}`);
  }
  return identity;
}

export async function requireApiIdentity(request: Request): Promise<Identity> {
  const identity = await getIdentityFromRequest(request);
  if (!identity) throw new AuthorizationError();
  return identity;
}
