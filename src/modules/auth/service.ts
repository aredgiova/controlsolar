import "server-only";
import type { AuthConfiguration } from "@/lib/config";
import { AuthorizationError } from "./errors";
import type { IdentityProvider } from "./oidc";
import type { AuthStore } from "./store";
import { assertState, createOpaqueToken, decryptFlow, encryptFlow, FLOW_TTL_SECONDS, hashToken, safeReturnTo } from "./security";

export function createAuthenticationService(configuration: AuthConfiguration, store: AuthStore, provider: IdentityProvider | (() => Promise<IdentityProvider>)) {
  const getProvider = async () => typeof provider === "function" ? provider() : provider;
  return {
    async start(returnTo?: string | null) {
      const flow = { state: createOpaqueToken(), nonce: createOpaqueToken(), verifier: createOpaqueToken(), returnTo: safeReturnTo(returnTo) };
      const authorizationUrl = await (await getProvider()).authorizationUrl(flow);
      const encryptedFlow = await encryptFlow(flow, configuration.secret);
      await store.registerFlow(hashToken(flow.state), new Date(Date.now() + FLOW_TTL_SECONDS * 1000));
      return { authorizationUrl, encryptedFlow };
    },
    async finish(callbackUrl: URL, encryptedFlow: string) {
      const flow = await decryptFlow(encryptedFlow, configuration.secret);
      // Atomic consumption precedes the exchange: even simultaneous callbacks cannot reuse a flow.
      if (!await store.consumeFlow(hashToken(flow.state))) throw new AuthorizationError(401, "El inicio de sesión ya se utilizó o venció.");
      if (callbackUrl.searchParams.getAll("state").length !== 1) throw new AuthorizationError();
      assertState(callbackUrl.searchParams.get("state"), flow.state);
      if (callbackUrl.searchParams.has("error") || callbackUrl.searchParams.getAll("code").length !== 1 || !callbackUrl.searchParams.get("code")) {
        throw new AuthorizationError(401, "El proveedor no completó el inicio de sesión.");
      }
      const verified = await (await getProvider()).exchange(callbackUrl, flow);
      const token = createOpaqueToken();
      const identity = await store.createSession(verified, hashToken(token));
      return { token, identity, expiresAt: verified.expiresAt, returnTo: flow.returnTo };
    },
  };
}
