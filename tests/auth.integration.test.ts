import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getAuthenticationDatabase } from "../src/lib/db";
import { POST as logout } from "../src/app/auth/logout/route";
import { getIdentityFromRequest } from "../src/modules/auth/session";
import { authenticationStore } from "../src/modules/auth/store";
import { createOpaqueToken, hashToken } from "../src/modules/auth/security";

const enabled = Boolean(process.env.TEST_AUTH_DATABASE_URL && process.env.TEST_RUNTIME_DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL);

test("restricted PostgreSQL auth store enforces flow TTL/replay, session expiry/hash and HTTPS logout CSRF", { skip: !enabled, timeout: 30000 }, async () => {
  const previousEnvironment = { ...process.env };
  Object.assign(process.env, {
    // The isolated PostgreSQL fixture is plaintext loopback. HTTPS still tests
    // Secure cookies; production transport rejection is tested separately.
    APP_ENV: "development", DATA_ADAPTER: "postgres", DEMO_MODE: "false",
    DATABASE_URL: process.env.TEST_RUNTIME_DATABASE_URL,
    AUTH_DATABASE_URL: process.env.TEST_AUTH_DATABASE_URL,
    APP_BASE_URL: "https://solar-fixture.example.invalid",
    COGNITO_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_LocalFixture",
    COGNITO_CLIENT_ID: "local-fixture-client",
    COGNITO_DOMAIN: "https://solar-fixture.auth.us-east-1.amazoncognito.com",
    AUTH_SECRET: "local-fixture-only-secret-with-more-than-32-bytes",
  });
  const admin = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL, max: 1 });
  const runtime = new Pool({ connectionString: process.env.TEST_RUNTIME_DATABASE_URL, max: 1 });
  const subject = `auth-store-${randomUUID()}`;
  const token = createOpaqueToken();
  const flowHash = hashToken(createOpaqueToken());
  const identity = {
    issuer: process.env.COGNITO_ISSUER!, subject, email: `${subject}@example.invalid`,
    displayName: "Fixture local de identidad", expiresAt: new Date(Date.now() + 3_600_000),
  };
  let userId: string | undefined;
  try {
    const authentication = getAuthenticationDatabase();
    await assert.rejects(authentication.query("SELECT * FROM public.sessions"), { code: "42501" });
    await assert.rejects(runtime.query("SELECT public.auth_consume_flow($1)", [flowHash]), { code: "42501" });
    await assert.rejects(authenticationStore.registerFlow(flowHash, new Date(Date.now() - 1000)), { code: "22023" });
    await assert.rejects(authenticationStore.registerFlow(flowHash, new Date(Date.now() + 11 * 60_000)), { code: "22023" });
    await authenticationStore.registerFlow(flowHash, new Date(Date.now() + 600_000));
    const results = await Promise.all([authenticationStore.consumeFlow(flowHash), authenticationStore.consumeFlow(flowHash)]);
    assert.deepEqual(results.sort(), [false, true]);
    await authenticationStore.registerFlow(flowHash, new Date(Date.now() + 600_000));
    await admin.query("UPDATE auth_flows SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [flowHash]);
    assert.equal(await authenticationStore.consumeFlow(flowHash), false);

    await assert.rejects(authentication.query("SELECT * FROM public.auth_create_session($1,$2,$3,$4,$5,$6,$7)", [
      identity.issuer, subject, identity.email, false, identity.displayName, hashToken(token), identity.expiresAt,
    ]), { code: "22023" });
    await assert.rejects(authenticationStore.createSession({ ...identity, expiresAt: new Date(Date.now() + 9 * 3600_000) }, hashToken(token)), { code: "22023" });
    const user = await authenticationStore.createSession(identity, hashToken(token));
    userId = user.userId;
    const request = new Request(`${process.env.APP_BASE_URL}/api/v1/organizations`, { headers: { cookie: `solar_session=${token}` } });
    assert.equal((await getIdentityFromRequest(request))?.userId, userId);
    const forged = new Request(request.url, { headers: { cookie: `solar_session=${createOpaqueToken()}` } });
    assert.equal(await getIdentityFromRequest(forged), null);
    const persisted = await admin.query("SELECT token_hash FROM sessions WHERE user_id=$1", [userId]);
    assert.equal(persisted.rows[0].token_hash, hashToken(token));
    assert.notEqual(persisted.rows[0].token_hash, token);
    await admin.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hashToken(token)]);
    assert.equal(await authenticationStore.resolveSession(hashToken(token)), null);
    assert.equal(await getIdentityFromRequest(request), null);

    const logoutToken = createOpaqueToken();
    await authenticationStore.createSession(identity, hashToken(logoutToken));
    const logoutRequest = (origin?: string) => new Request(`${process.env.APP_BASE_URL}/auth/logout`, {
      method: "POST", headers: { cookie: `solar_session=${logoutToken}`, ...(origin ? { origin } : {}) },
    });
    const rejected = await logout(logoutRequest("https://foreign.example.invalid"));
    assert.equal(rejected.status, 403);
    assert.ok(await authenticationStore.resolveSession(hashToken(logoutToken)));
    const missingOrigin = await logout(logoutRequest());
    assert.equal(missingOrigin.status, 403);
    const response = await logout(logoutRequest(process.env.APP_BASE_URL));
    assert.equal(response.status, 303);
    assert.equal(await authenticationStore.resolveSession(hashToken(logoutToken)), null);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin, process.env.COGNITO_DOMAIN);
    assert.equal(location.searchParams.get("logout_uri"), `${process.env.APP_BASE_URL}/login`);
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const cookie of cookies) {
      assert.match(cookie, /Max-Age=0/i);
      assert.match(cookie, /Secure/i);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=lax/i);
    }
  } finally {
    await admin.query("DELETE FROM auth_flows WHERE state_hash=$1", [flowHash]);
    if (userId) {
      await admin.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
      await admin.query("DELETE FROM users WHERE id=$1", [userId]);
    }
    await getAuthenticationDatabase().end();
    await runtime.end();
    await admin.end();
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
  }
});
