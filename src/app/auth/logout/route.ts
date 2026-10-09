import { NextResponse } from "next/server";
import { readAuthConfig } from "@/lib/config";
import { assertSameOrigin, respondToApiError } from "@/modules/auth/api";
import { buildCognitoLogoutUrl, getCognitoProvider } from "@/modules/auth/oidc";
import { cookieOptions, FLOW_COOKIE, hashToken, isOpaqueToken, readRequestCookie, SESSION_COOKIE } from "@/modules/auth/security";
import { authenticationStore } from "@/modules/auth/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const configuration = readAuthConfig();
    const token = readRequestCookie(request, SESSION_COOKIE);
    if (token && isOpaqueToken(token)) await authenticationStore.revokeSession(hashToken(token));
    let target = `${configuration.appBaseUrl}/login`;
    // Local revocation succeeds even when the provider is temporarily unavailable.
    try {
      target = configuration.cognitoDomain ? buildCognitoLogoutUrl(configuration, configuration.cognitoDomain) : (await getCognitoProvider(configuration)).logoutUrl();
    } catch { /* No tokens or provider diagnostics reach the browser. */ }
    const response = NextResponse.redirect(target, 303);
    response.cookies.set(SESSION_COOKIE, "", cookieOptions(configuration, 0));
    response.cookies.set(FLOW_COOKIE, "", cookieOptions(configuration, 0));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return respondToApiError(error); }
}
