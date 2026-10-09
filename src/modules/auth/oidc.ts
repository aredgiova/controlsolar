import "server-only";
import * as oidc from "openid-client";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { AuthConfiguration } from "@/lib/config";
import { ConfigurationError } from "@/lib/config";
import { type AuthFlow, type VerifiedIdentity, verifyIdentityClaims } from "./security";

export interface IdentityProvider {
  authorizationUrl(flow: AuthFlow): Promise<string>;
  exchange(callbackUrl: URL, flow: AuthFlow): Promise<VerifiedIdentity>;
  logoutUrl(): string;
}

export function buildCognitoLogoutUrl(configuration: Pick<AuthConfiguration, "clientId" | "appBaseUrl">, domain: string) {
  const url = new URL("/logout", domain);
  url.searchParams.set("client_id", configuration.clientId);
  url.searchParams.set("logout_uri", `${configuration.appBaseUrl}/login`);
  return url.href;
}

// fetchImplementation is an explicit dependency for isolated protocol tests, never an environment bypass.
export async function createCognitoProvider(configuration: AuthConfiguration, fetchImplementation = globalThis.fetch): Promise<IdentityProvider> {
  const protocolFetch: oidc.CustomFetch = (input, options) => fetchImplementation(input, options as RequestInit);
  const client = await oidc.discovery(
    new URL(configuration.issuer), configuration.clientId,
    { client_secret: configuration.clientSecret, id_token_signed_response_alg: "RS256" },
    configuration.clientSecret ? oidc.ClientSecretBasic(configuration.clientSecret) : oidc.None(),
    { [oidc.customFetch]: protocolFetch, timeout: 10 },
  );
  const metadata = client.serverMetadata();
  const expectedJwks = `${configuration.issuer}/.well-known/jwks.json`;
  if (metadata.issuer !== configuration.issuer || metadata.jwks_uri !== expectedJwks || !metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new ConfigurationError("Los metadatos del proveedor de identidad no son válidos.");
  }
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) throw new ConfigurationError("Cognito requiere endpoints HTTPS.");
  }
  client[oidc.customFetch] = protocolFetch;
  oidc.enableNonRepudiationChecks(client);
  const jwks = createRemoteJWKSet(new URL(expectedJwks), { [customFetch]: fetchImplementation, timeoutDuration: 10_000 });
  const domain = configuration.cognitoDomain ?? new URL(metadata.authorization_endpoint).origin;
  return {
    async authorizationUrl(flow) {
      const challenge = await oidc.calculatePKCECodeChallenge(flow.verifier);
      return oidc.buildAuthorizationUrl(client, {
        response_type: "code", redirect_uri: configuration.callbackUrl,
        scope: "openid email profile", code_challenge: challenge, code_challenge_method: "S256",
        state: flow.state, nonce: flow.nonce,
      }).href;
    },
    async exchange(callbackUrl, flow) {
      const tokens = await oidc.authorizationCodeGrant(client, callbackUrl, {
        pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
      });
      if (!tokens.id_token) throw new Error("Missing identity token.");
      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        issuer: configuration.issuer, audience: configuration.clientId, algorithms: ["RS256"],
        requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce", "token_use", "email", "email_verified"],
      });
      return verifyIdentityClaims(payload, configuration, flow.nonce);
    },
    logoutUrl() {
      return buildCognitoLogoutUrl(configuration, domain);
    },
  };
}

let cachedProvider: { configuration: string; provider: Promise<IdentityProvider> } | undefined;
export function getCognitoProvider(configuration: AuthConfiguration) {
  const key = JSON.stringify(configuration);
  if (!cachedProvider || cachedProvider.configuration !== key) {
    const provider = createCognitoProvider(configuration);
    cachedProvider = { configuration: key, provider };
    provider.catch(() => { if (cachedProvider?.provider === provider) cachedProvider = undefined; });
  }
  return cachedProvider.provider;
}
