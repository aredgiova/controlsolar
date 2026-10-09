import { NextResponse } from "next/server";
import { readAuthConfig } from "@/lib/config";
import { getCognitoProvider } from "@/modules/auth/oidc";
import { createAuthenticationService } from "@/modules/auth/service";
import { authenticationStore } from "@/modules/auth/store";
import { cookieOptions, FLOW_COOKIE, readRequestCookie, SESSION_COOKIE } from "@/modules/auth/security";
import { RateLimitError, takeRateLimit } from "@/modules/auth/rate-limit";
import { respondToApiError } from "@/modules/auth/api";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let response: NextResponse;
  let secure = process.env.APP_ENV === "production" || new URL(request.url).protocol === "https:";
  try {
    await takeRateLimit("auth_callback", "all", 120);
    const configuration = readAuthConfig();
    secure = configuration.secureCookies;
    const encryptedFlow = readRequestCookie(request, FLOW_COOKIE);
    if (!encryptedFlow) throw new Error("Missing authentication flow.");
    const callbackUrl = new URL(configuration.callbackUrl);
    callbackUrl.search = new URL(request.url).search;
    const auth = createAuthenticationService(configuration, authenticationStore, () => getCognitoProvider(configuration));
    const session = await auth.finish(callbackUrl, encryptedFlow);
    response = NextResponse.redirect(new URL(session.returnTo, configuration.appBaseUrl));
    const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    response.cookies.set(SESSION_COOKIE, session.token, { ...cookieOptions(configuration, maxAge), expires: session.expiresAt });
  } catch (error) {
    response = error instanceof RateLimitError ? respondToApiError(error) : new NextResponse(null, { status: 303, headers: { Location: "/login?error=authentication" } });
  }
  // Every callback, including failed or replayed attempts, removes the browser flow cookie.
  response.cookies.set(FLOW_COOKIE, "", { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
