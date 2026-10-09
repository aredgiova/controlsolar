import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { ConfigurationError, readAuthConfig } from "../src/lib/config";
import { respondToApiError } from "../src/modules/auth/api";
import { AuthorizationError } from "../src/modules/auth/errors";
import { createCognitoProvider } from "../src/modules/auth/oidc";
import { createAuthenticationService } from "../src/modules/auth/service";
import { requireApiIdentity } from "../src/modules/auth/session";
import { assertRequestOrigin, cookieOptions, createOpaqueToken, decryptFlow, encryptFlow, hashToken, isOpaqueToken, safeReturnTo, verifyIdentityClaims, type AuthFlow, type Identity } from "../src/modules/auth/security";
import type { AuthStore } from "../src/modules/auth/store";

const environment = {
  APP_ENV: "development", DATA_ADAPTER: "postgres", DEMO_MODE: "false",
  APP_BASE_URL: "http://127.0.0.1:3100",
  COGNITO_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_LocalFixture",
  COGNITO_CLIENT_ID: "local-test-client",
  AUTH_SECRET: "test-secret-with-at-least-32-random-bytes-only-fixture",
  DATABASE_URL: "postgresql://solar_app:fixture@127.0.0.1/solar_test",
  AUTH_DATABASE_URL: "postgresql://solar_auth:fixture@127.0.0.1/solar_test",
};
const configuration = readAuthConfig(environment);

test("identity configuration restricts issuer, callback origin, separate credentials and cookie policy", () => {
  assert.equal(configuration.callbackUrl, "http://127.0.0.1:3100/auth/callback");
  assert.equal(configuration.secureCookies, false);
  assert.throws(() => readAuthConfig({ ...environment, COGNITO_ISSUER: "http://localhost:8000" }), ConfigurationError);
  assert.throws(() => readAuthConfig({ ...environment, COGNITO_ISSUER: "https://attacker.invalid/pool" }), ConfigurationError);
  assert.throws(() => readAuthConfig({ ...environment, APP_ENV: "production" }), ConfigurationError);
  assert.throws(() => readAuthConfig({ ...environment, APP_BASE_URL: "https://solar.example.com/path" }), ConfigurationError);
  assert.throws(() => readAuthConfig({ ...environment, APP_BASE_URL: "https://user:secret@solar.example.com" }), ConfigurationError);
  assert.throws(() => readAuthConfig({ ...environment, AUTH_DATABASE_URL: environment.DATABASE_URL }), ConfigurationError);
  assert.throws(() => readAuthConfig({ ...environment, AUTH_SECRET: "short" }), ConfigurationError);
  assert.equal(readAuthConfig({ ...environment, APP_BASE_URL: "https://solar.example.com" }).secureCookies, true);
  assert.deepEqual(cookieOptions({ secureCookies: true }, 3600), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3600 });
});

test("flow cookie is encrypted, authenticated and expires after ten minutes", async () => {
  const flow: AuthFlow = { state: createOpaqueToken(), nonce: createOpaqueToken(), verifier: createOpaqueToken(), returnTo: "/projects?organization=example" };
  const now = new Date("2026-10-09T12:00:00Z");
  const encrypted = await encryptFlow(flow, configuration.secret, now);
  assert.equal(encrypted.includes(flow.verifier), false);
  assert.equal(encrypted.split(".").length, 5);
  assert.deepEqual(await decryptFlow(encrypted, configuration.secret, now), flow);
  await assert.rejects(decryptFlow(encrypted, "different-encryption-secret-with-32bytes", now));
  const parts = encrypted.split(".");
  parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
  await assert.rejects(decryptFlow(parts.join("."), configuration.secret, now));
  await assert.rejects(decryptFlow(encrypted, configuration.secret, new Date(now.getTime() + 600_000)));
  assert.equal(isOpaqueToken(flow.state), true);
  assert.equal(hashToken(flow.state).length, 64);
  assert.notEqual(hashToken(flow.state), flow.state);
});

test("return paths cannot redirect to another origin, auth loop or script", () => {
  for (const invalid of ["https://attacker.invalid", "//attacker.invalid", "/\\attacker.invalid", "javascript:alert(1)", "/login", "/auth/callback", "/projects\nheader"]) {
    assert.equal(safeReturnTo(invalid), "/organizations");
  }
  assert.equal(safeReturnTo("/projects?organization=abc"), "/projects?organization=abc");
  assert.equal(safeReturnTo("/invitations/test-token"), "/invitations/test-token");
});

test("mutations require an exact same Origin and reject missing or cross-site Origin", () => {
  const makeRequest = (headers: HeadersInit) => new Request(`${configuration.appBaseUrl}/api/v1/organizations`, { method: "POST", headers });
  assert.doesNotThrow(() => assertRequestOrigin(makeRequest({ origin: configuration.appBaseUrl }), configuration.appBaseUrl));
  assert.throws(() => assertRequestOrigin(makeRequest({}), configuration.appBaseUrl), AuthorizationError);
  assert.throws(() => assertRequestOrigin(makeRequest({ origin: "https://attacker.invalid" }), configuration.appBaseUrl), AuthorizationError);
  assert.throws(() => assertRequestOrigin(makeRequest({ origin: configuration.appBaseUrl, "sec-fetch-site": "cross-site" }), configuration.appBaseUrl), AuthorizationError);
});

function validClaims(nonce: string): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return { iss: configuration.issuer, aud: configuration.clientId, sub: "test-user-subject", email: "Owner@Example.invalid", email_verified: true, token_use: "id", nonce, iat: now, exp: now + 3600, name: "Usuario de prueba" };
}

test("identity claims require verified email, exact audience, issuer, nonce and identity token type", () => {
  const nonce = createOpaqueToken();
  const claims = validClaims(nonce);
  assert.equal(verifyIdentityClaims(claims, configuration, nonce).email, "owner@example.invalid");
  const invalid: JWTPayload[] = [
    { ...claims, nonce: "foreign" }, { ...claims, iss: "https://foreign.invalid" }, { ...claims, aud: "other-client" },
    { ...claims, token_use: "access" }, { ...claims, email_verified: false }, { ...claims, email_verified: "true" },
    { ...claims, sub: "" }, { ...claims, exp: Math.floor(Date.now() / 1000) - 1 },
    { ...claims, iat: Math.floor(Date.now() / 1000) + 3600 },
  ];
  for (const payload of invalid) assert.throws(() => verifyIdentityClaims(payload, configuration, nonce), AuthorizationError);
  const longLived = verifyIdentityClaims({ ...claims, exp: Math.floor(Date.now() / 1000) + 86400 }, configuration, nonce);
  assert.ok(longLived.expiresAt.getTime() <= Date.now() + 8 * 3600_000);
  const shortLived = verifyIdentityClaims(claims, configuration, nonce);
  assert.equal(shortLived.expiresAt.getTime(), (claims.exp as number) * 1000);
});

function memoryStore(): AuthStore & { sessions: Map<string, Identity>; states: Set<string> } {
  const states = new Set<string>();
  const sessions = new Map<string, Identity>();
  return {
    states, sessions,
    async registerFlow(stateHash) { states.add(stateHash); },
    async consumeFlow(stateHash) { return states.delete(stateHash); },
    async createSession(identity, tokenHash) {
      const user = { userId: "fixture-user-id", email: identity.email, displayName: identity.displayName };
      sessions.set(tokenHash, user);
      return user;
    },
    async resolveSession(tokenHash) {
      const identity = sessions.get(tokenHash);
      return identity ? { ...identity, expiresAt: new Date(Date.now() + 3600_000) } : null;
    },
    async revokeSession(tokenHash) { sessions.delete(tokenHash); },
  };
}

test("a failed provider callback consumes the flow before network access and cannot be replayed", async () => {
  const store = memoryStore();
  const flow: AuthFlow = { state: createOpaqueToken(), nonce: createOpaqueToken(), verifier: createOpaqueToken(), returnTo: "/organizations" };
  const encrypted = await encryptFlow(flow, configuration.secret);
  await store.registerFlow(hashToken(flow.state), new Date(Date.now() + 600_000));
  let providerCalls = 0;
  const service = createAuthenticationService(configuration, store, async () => {
    providerCalls++;
    throw new Error("Simulated provider outage.");
  });
  const callback = new URL(configuration.callbackUrl);
  callback.search = new URLSearchParams({ state: flow.state, code: "fixture-code" }).toString();
  await assert.rejects(service.finish(callback, encrypted));
  assert.equal(store.states.size, 0);
  await assert.rejects(service.finish(callback, encrypted), AuthorizationError);
  assert.equal(providerCalls, 1);
});

test("local HTTPS OIDC fixture exercises discovery, PKCE, signed JWT, nonce and callback replay protection", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "local-fixture-key", alg: "RS256", use: "sig" };
  const domain = "https://solar-fixture.auth.us-east-1.amazoncognito.com";
  let flow!: AuthFlow;
  let tokenCalls = 0;
  let claimOverrides: JWTPayload = {};
  let signingKey = privateKey;
  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href === `${configuration.issuer}/.well-known/openid-configuration`) {
      return Response.json({ issuer: configuration.issuer, authorization_endpoint: `${domain}/oauth2/authorize`, token_endpoint: `${domain}/oauth2/token`, jwks_uri: `${configuration.issuer}/.well-known/jwks.json`, response_types_supported: ["code"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
    }
    if (url.href === `${configuration.issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (url.href === `${domain}/oauth2/token`) {
      tokenCalls++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code_verifier"), flow.verifier);
      assert.equal(body.get("redirect_uri"), configuration.callbackUrl);
      const token = await new SignJWT({ ...validClaims(flow.nonce), ...claimOverrides }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).sign(signingKey);
      return Response.json({ access_token: "server-only-fixture-access-token", id_token: token, token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error("Unexpected network call in local fixture.");
  };
  const provider = await createCognitoProvider(configuration, mockFetch);
  const store = memoryStore();
  const service = createAuthenticationService(configuration, store, provider);
  const start = await service.start("/projects?organization=fixture");
  flow = await decryptFlow(start.encryptedFlow, configuration.secret);
  const authorization = new URL(start.authorizationUrl);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("nonce"), flow.nonce);
  assert.equal(authorization.searchParams.get("state"), flow.state);
  assert.equal(authorization.searchParams.has("code_verifier"), false);
  const callback = new URL(configuration.callbackUrl);
  callback.search = new URLSearchParams({ state: flow.state, code: "fixture-code" }).toString();
  const session = await service.finish(callback, start.encryptedFlow);
  assert.equal(session.identity.email, "owner@example.invalid");
  assert.ok(isOpaqueToken(session.token));
  assert.equal(store.sessions.has(session.token), false);
  assert.equal(store.sessions.has(hashToken(session.token)), true);
  assert.equal(tokenCalls, 1);
  await assert.rejects(service.finish(callback, start.encryptedFlow), AuthorizationError);
  assert.equal(tokenCalls, 1);
  await store.revokeSession(hashToken(session.token));
  assert.equal(await store.resolveSession(hashToken(session.token)), null);

  const wrongState = await service.start();
  flow = await decryptFlow(wrongState.encryptedFlow, configuration.secret);
  const wrongCallback = new URL(configuration.callbackUrl);
  wrongCallback.search = new URLSearchParams({ state: createOpaqueToken(), code: "fixture-code" }).toString();
  await assert.rejects(service.finish(wrongCallback, wrongState.encryptedFlow), AuthorizationError);
  assert.equal(tokenCalls, 1);

  for (const overrides of [{ nonce: "wrong-nonce" }, { email_verified: false }, { token_use: "access" }, { aud: "foreign-client" }, { iss: "https://foreign.invalid" }, { exp: 1 }]) {
    claimOverrides = overrides;
    const attempt = await service.start();
    flow = await decryptFlow(attempt.encryptedFlow, configuration.secret);
    callback.search = new URLSearchParams({ state: flow.state, code: "fixture-code" }).toString();
    await assert.rejects(service.finish(callback, attempt.encryptedFlow));
  }
  claimOverrides = {};
  signingKey = (await generateKeyPair("RS256")).privateKey;
  const forged = await service.start();
  flow = await decryptFlow(forged.encryptedFlow, configuration.secret);
  callback.search = new URLSearchParams({ state: flow.state, code: "fixture-code" }).toString();
  await assert.rejects(service.finish(callback, forged.encryptedFlow));
  assert.equal(new URL(provider.logoutUrl()).searchParams.get("logout_uri"), `${configuration.appBaseUrl}/login`);
});

test("API denies missing sessions as JSON 401 and never exposes underlying errors", async () => {
  await assert.rejects(requireApiIdentity(new Request("http://localhost/api/v1/organizations")), AuthorizationError);
  const unauthenticated = respondToApiError(new AuthorizationError());
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.has("location"), false);
  assert.equal(unauthenticated.headers.get("cache-control"), "no-store");
  const secretError = respondToApiError(new Error("postgres://user:private-token@database SELECT * sessions"));
  assert.equal(secretError.status, 500);
  assert.equal((await secretError.text()).includes("private-token"), false);
  const configurationError = respondToApiError(new ConfigurationError("secret configuration data"));
  assert.equal(configurationError.status, 503);
  assert.equal((await configurationError.text()).includes("secret configuration data"), false);
});
