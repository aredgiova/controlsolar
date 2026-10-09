import { NextResponse } from "next/server";
import { readAuthConfig, readConfig } from "@/lib/config";
import { getCognitoProvider } from "@/modules/auth/oidc";
import { createAuthenticationService } from "@/modules/auth/service";
import { authenticationStore } from "@/modules/auth/store";
import { cookieOptions, FLOW_COOKIE, FLOW_TTL_SECONDS } from "@/modules/auth/security";
import { RateLimitError, takeRateLimit } from "@/modules/auth/rate-limit";
import { respondToApiError } from "@/modules/auth/api";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    if (readConfig().demoMode) return new NextResponse(null, { status: 303, headers: { Location: "/login?error=demo", "Cache-Control": "no-store" } });
    await takeRateLimit("auth_login", "all", 60);
    const configuration = readAuthConfig();
    const auth = createAuthenticationService(configuration, authenticationStore, () => getCognitoProvider(configuration));
    const flow = await auth.start(new URL(request.url).searchParams.get("next"));
    const response = NextResponse.redirect(flow.authorizationUrl);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(FLOW_COOKIE, flow.encryptedFlow, cookieOptions(configuration, FLOW_TTL_SECONDS));
    return response;
  } catch (error) {
    if (error instanceof RateLimitError) return respondToApiError(error);
    const response = new NextResponse(null, { status: 303, headers: { Location: "/login?error=configuration", "Cache-Control": "no-store" } });
    response.cookies.set(FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  }
}
