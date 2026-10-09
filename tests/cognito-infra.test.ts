import assert from "node:assert/strict";
import test from "node:test";
import template from "../infra/cognito.json";
import stagingExample from "../infra/cognito/staging.parameters.example.json";
import productionExample from "../infra/cognito/production.parameters.example.json";
import { readAuthConfig } from "../src/lib/config";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createCognitoProvider } from "../src/modules/auth/oidc";
import { createOpaqueToken, type AuthFlow } from "../src/modules/auth/security";

const omitted = Symbol("AWS::NoValue");
type Parameters = Record<string, string | number>;
type ParameterDefinition = { Type: string; Default?: string | number; AllowedValues?: string[]; AllowedPattern?: string; MinValue?: number; MaxValue?: number; MaxLength?: number };
const definitions: Record<string, ParameterDefinition> = template.Parameters;
const pseudo: Parameters = { "AWS::AccountId": "123456789012", "AWS::Region": "us-east-1", "AWS::URLSuffix": "amazonaws.com" };

// Deliberately limited to the intrinsics used by this template. This exercises
// policy branches offline; it does not pretend to validate AWS service schemas.
function resolve(value: unknown, parameters: Parameters): unknown {
  if (Array.isArray(value)) return value.map((item) => resolve(item, parameters)).filter((item) => item !== omitted);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (typeof object.Ref === "string") {
    if (object.Ref === "AWS::NoValue") return omitted;
    if (Object.hasOwn(parameters, object.Ref)) return parameters[object.Ref];
    if (Object.hasOwn(pseudo, object.Ref)) return pseudo[object.Ref];
    if (object.Ref === "UserPool") return "us-east-1_ReadinessFixture";
    if (object.Ref === "WebClient") return "readinessfixtureclient";
    if (object.Ref === "UserPoolDomain") return `${parameters.DeploymentPrefix}-${parameters.Environment}`;
    throw new Error(`Unresolved Ref: ${object.Ref}`);
  }
  if (Array.isArray(object["Fn::Equals"])) { const [left, right] = object["Fn::Equals"].map((item) => resolve(item, parameters)); return left === right; }
  if (Array.isArray(object["Fn::Not"])) return !resolve(object["Fn::Not"][0], parameters);
  if (Array.isArray(object["Fn::And"])) return object["Fn::And"].every((item) => resolve(item, parameters));
  if (Array.isArray(object["Fn::Or"])) return object["Fn::Or"].some((item) => resolve(item, parameters));
  if (Array.isArray(object["Fn::If"])) {
    const [condition, yes, no] = object["Fn::If"];
    assert.equal(typeof condition, "string");
    const expression = (template.Conditions as Record<string, unknown>)[String(condition)];
    assert.ok(expression, `Unknown condition: ${String(condition)}`);
    return resolve(resolve(expression, parameters) ? yes : no, parameters);
  }
  if (typeof object["Fn::Sub"] === "string") return object["Fn::Sub"].replace(/\$\{([^}]+)\}/g, (_match, name: string) => String(resolve({ Ref: name }, parameters)));
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolve(item, parameters)]).filter(([, item]) => item !== omitted));
}

function inputs(overrides: Parameters = {}): Parameters {
  const parameters: Parameters = Object.fromEntries(Object.entries(definitions).filter(([, definition]) => definition.Default !== undefined).map(([name, definition]) => [name, definition.Default!]));
  Object.assign(parameters, { Environment: "staging", DeploymentPrefix: "solar-fixture", AppBaseUrl: "https://solar-staging.example.invalid" }, overrides);
  for (const [name, definition] of Object.entries(definitions)) {
    const value = parameters[name];
    assert.notEqual(value, undefined, `Missing parameter: ${name}`);
    if (definition.AllowedValues) assert.ok(definition.AllowedValues.includes(String(value)), `Allowed values: ${name}`);
    if (definition.AllowedPattern) assert.match(String(value), new RegExp(`^(?:${definition.AllowedPattern})$`), `Allowed pattern: ${name}`);
    if (definition.MinValue !== undefined) assert.ok(Number(value) >= definition.MinValue, `Minimum: ${name}`);
    if (definition.MaxValue !== undefined) assert.ok(Number(value) <= definition.MaxValue, `Maximum: ${name}`);
    if (definition.MaxLength !== undefined) assert.ok(String(value).length <= definition.MaxLength, `Length: ${name}`);
  }
  for (const [name, rule] of Object.entries(template.Rules)) {
    if ("RuleCondition" in rule && !resolve(rule.RuleCondition, parameters)) continue;
    for (const assertion of rule.Assertions) assert.equal(resolve(assertion.Assert, parameters), true, `Rule: ${name}`);
  }
  return parameters;
}

function webClient(parameters: Parameters) {
  return resolve(template.Resources.WebClient.Properties, parameters) as { CallbackURLs: string[]; LogoutURLs: string[]; GenerateSecret: boolean };
}

function walk(value: unknown, visit: (object: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item) => walk(item, visit)); return; }
  visit(value as Record<string, unknown>);
  Object.values(value).forEach((item) => walk(item, visit));
}

test("Cognito dependencies and references are complete and acyclic", () => {
  const resources = new Set(Object.keys(template.Resources));
  const check = (name: string) => assert.ok(resources.has(name) || Object.hasOwn(definitions, name) || name.startsWith("AWS::"), `Unknown reference: ${name}`);
  walk(template, (object) => {
    if (typeof object.Ref === "string") check(object.Ref);
    if (Array.isArray(object["Fn::GetAtt"])) check(String(object["Fn::GetAtt"][0]));
    if (typeof object["Fn::Sub"] === "string") for (const match of object["Fn::Sub"].matchAll(/\$\{([^}]+)\}/g)) check(match[1].split(".")[0]);
  });
  const graph = new Map<string, Set<string>>();
  for (const [name, definition] of Object.entries(template.Resources)) {
    const dependencies = new Set<string>();
    walk(definition, (object) => {
      if (typeof object.Ref === "string" && resources.has(object.Ref)) dependencies.add(object.Ref);
      if (Array.isArray(object["Fn::GetAtt"])) dependencies.add(String(object["Fn::GetAtt"][0]));
      if (typeof object.DependsOn === "string") dependencies.add(object.DependsOn);
      if (typeof object["Fn::Sub"] === "string") for (const match of object["Fn::Sub"].matchAll(/\$\{([^}]+)\}/g)) if (resources.has(match[1].split(".")[0])) dependencies.add(match[1].split(".")[0]);
    });
    graph.set(name, dependencies);
  }
  const seen = new Set<string>(); const active = new Set<string>();
  function visit(name: string) { if (seen.has(name)) return; assert.ok(!active.has(name), `Cycle: ${name}`); active.add(name); graph.get(name)?.forEach(visit); active.delete(name); seen.add(name); }
  resources.forEach(visit);
});

test("production cannot accept HTTP, localhost exceptions or unconfigured production email", () => {
  const production = inputs({ Environment: "production", AppBaseUrl: "https://solar.example.invalid", SesIdentityArn: "arn:aws:ses:us-east-1:123456789012:identity/example.invalid", EmailFromAddress: "login@example.invalid" });
  assert.deepEqual(webClient(production).CallbackURLs, ["https://solar.example.invalid/auth/callback"]);
  assert.deepEqual(webClient(production).LogoutURLs, ["https://solar.example.invalid/login"]);
  assert.throws(() => inputs({ ...production, EnableLocalhostCallbacks: "true" }), /LocalCallbackOnlyInStaging/);
  assert.throws(() => inputs({ Environment: "production" }), /ProductionRequiresSes/);
  assert.throws(() => inputs({ EmailFromAddress: "login@example.invalid" }), /EmailParametersTogether/);
  for (const origin of ["http://solar.example.invalid", "http://localhost:3100", "https://solar.example.invalid/", "https://solar.example.invalid/path", "https://user:secret@solar.example.invalid", "https://solar.example.invalid?redirect=other"]) assert.throws(() => inputs({ AppBaseUrl: origin }));
  const staging = inputs({ EnableLocalhostCallbacks: "true", LocalTestPort: 3101 });
  assert.deepEqual(webClient(staging).CallbackURLs, ["https://solar-staging.example.invalid/auth/callback", "http://localhost:3101/auth/callback"]);
  assert.deepEqual(webClient(staging).LogoutURLs, ["https://solar-staging.example.invalid/login", "http://localhost:3101/login"]);
  assert.throws(() => inputs({ LocalTestPort: 65536 }));
});

test("identity policies preserve verified email, code-only OAuth, TOTP and separate client-secret modes", () => {
  const pool = template.Resources.UserPool.Properties; const client = template.Resources.WebClient.Properties;
  assert.deepEqual(pool.AutoVerifiedAttributes, ["email"]);
  assert.equal(pool.Schema[0].Required, true);
  assert.deepEqual(pool.UserAttributeUpdateSettings.AttributesRequireVerificationBeforeUpdate, ["email"]);
  assert.equal(pool.UsernameConfiguration.CaseSensitive, false);
  assert.deepEqual(client.AllowedOAuthFlows, ["code"]);
  assert.deepEqual(client.AllowedOAuthScopes, ["openid", "email", "profile"]);
  assert.ok(client.ReadAttributes.includes("email_verified")); assert.ok(!client.WriteAttributes.includes("email_verified"));
  assert.equal(client.PreventUserExistenceErrors, "ENABLED"); assert.equal(client.EnableTokenRevocation, true);
  assert.equal(webClient(inputs()).GenerateSecret, true);
  assert.equal(webClient(inputs({ GenerateClientSecret: "false" })).GenerateSecret, false);
  assert.deepEqual(resolve(pool.EnabledMfas, inputs()), ["SOFTWARE_TOKEN_MFA"]);
  assert.deepEqual(resolve(pool.EnabledMfas, inputs({ MfaMode: "OPTIONAL" })), ["SOFTWARE_TOKEN_MFA"]);
  assert.equal(resolve(pool.EnabledMfas, inputs({ MfaMode: "OFF" })), omitted);
  assert.ok(pool.Policies.PasswordPolicy.MinimumLength >= 12);
});

test("managed login includes the per-client style and protects identity resources without emitting secrets", () => {
  assert.equal(template.Resources.UserPool.Properties.UserPoolTier, "ESSENTIALS");
  assert.equal(template.Resources.UserPoolDomain.Properties.ManagedLoginVersion, 2);
  assert.equal(template.Resources.ManagedLoginBranding.Properties.UseCognitoProvidedValues, true);
  assert.deepEqual(template.Resources.ManagedLoginBranding.Properties.ClientId, { Ref: "WebClient" });
  assert.equal(template.Resources.ManagedLoginBranding.DependsOn, "UserPoolDomain");
  assert.equal(template.Resources.UserPool.Properties.DeletionProtection, "ACTIVE");
  for (const resource of Object.values(template.Resources)) {
    assert.equal(resource.DeletionPolicy, "Retain"); assert.equal(resource.UpdateReplacePolicy, "Retain");
    assert.ok(resource.Type.startsWith("AWS::Cognito::"));
  }
  assert.ok(!Object.keys(template.Outputs).includes("ClientSecret"));
  walk(template.Outputs, (object) => {
    if (Array.isArray(object["Fn::GetAtt"])) assert.ok(!object["Fn::GetAtt"].some((item) => String(item).includes("Secret")));
  });
});

test("Cognito outputs match existing application callback, logout and secure-cookie configuration", () => {
  const parameters = inputs();
  const output = (name: string) => String(resolve((template.Outputs as Record<string, { Value: unknown }>)[name].Value, parameters));
  const environment = { APP_ENV: "staging", DATA_ADAPTER: "postgres", DEMO_MODE: "false", APP_BASE_URL: output("AppBaseUrl"), COGNITO_ISSUER: output("CognitoIssuer"), COGNITO_CLIENT_ID: output("CognitoClientId"), COGNITO_DOMAIN: output("CognitoDomain"), COGNITO_CLIENT_SECRET: "fixture-server-only-client-secret", AUTH_SECRET: "fixture-32-random-bytes-required-not-a-live-secret", DATABASE_URL: "postgresql://solar_runtime:fixture@localhost/solar_staging", AUTH_DATABASE_URL: "postgresql://solar_auth:fixture@localhost/solar_staging" };
  const configuration = readAuthConfig(environment);
  assert.equal(configuration.callbackUrl, output("CallbackUrl"));
  assert.equal(`${configuration.appBaseUrl}/login`, output("LogoutUrl"));
  assert.equal(configuration.secureCookies, true);
  assert.equal(configuration.cognitoDomain, "https://solar-fixture-staging.auth.us-east-1.amazoncognito.com");
  assert.equal(readAuthConfig({ ...environment, APP_ENV: "development", APP_BASE_URL: "http://localhost:3100" }).callbackUrl, "http://localhost:3100/auth/callback");
  assert.throws(() => readAuthConfig({ ...environment, APP_ENV: "production", APP_BASE_URL: "http://localhost:3100" }));
});

test("public parameter examples specify separate environments and contain no client or application secrets", () => {
  for (const [example, expected] of [[stagingExample, "staging"], [productionExample, "production"]] as const) {
    const parameters = Object.fromEntries(example.map((entry) => [entry.ParameterKey, entry.ParameterValue]));
    assert.equal(parameters.Environment, expected);
    assert.equal(parameters.EnableLocalhostCallbacks, "false");
    assert.equal(new Set(example.map((entry) => entry.ParameterKey)).size, example.length);
    assert.ok(example.every((entry) => Object.hasOwn(definitions, entry.ParameterKey)));
    assert.ok(!example.some((entry) => /AUTH_SECRET|COGNITO_CLIENT_SECRET|PASSWORD|DATABASE_URL/.test(entry.ParameterKey)));
    assert.ok(String(parameters.AppBaseUrl).endsWith(".example.invalid"));
    inputs(parameters);
  }
});

test("the default confidential client uses Basic only at token exchange and retains PKCE", async () => {
  const configuration = readAuthConfig({ APP_ENV: "staging", DATA_ADAPTER: "postgres", DEMO_MODE: "false", APP_BASE_URL: "https://solar-staging.example.invalid", COGNITO_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ReadinessFixture", COGNITO_CLIENT_ID: "readinessfixtureclient", COGNITO_DOMAIN: "https://solar-fixture-staging.auth.us-east-1.amazoncognito.com", COGNITO_CLIENT_SECRET: "fixture-server-only-secret", AUTH_SECRET: "fixture-32-random-bytes-required-not-a-live-secret", AUTH_DATABASE_URL: "postgresql://solar_auth:fixture@localhost/solar_staging" });
  const flow: AuthFlow = { state: createOpaqueToken(), nonce: createOpaqueToken(), verifier: createOpaqueToken(), returnTo: "/organizations" };
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "readiness-key", alg: "RS256", use: "sig" };
  const domain = configuration.cognitoDomain!;
  let tokenRequests = 0;
  const mockFetch: typeof globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    const headers = new Headers(options?.headers);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.href === `${domain}/oauth2/token`) {
      tokenRequests++;
      const authorization = headers.get("authorization")!;
      assert.match(authorization, /^Basic /);
      const credentials = Buffer.from(authorization.slice(6), "base64").toString("utf8").split(":").map((part) => decodeURIComponent(part));
      assert.deepEqual(credentials, [configuration.clientId, configuration.clientSecret]);
      const body = new URLSearchParams(String(options?.body));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code_verifier"), flow.verifier);
      assert.equal(body.has("client_secret"), false);
      const jwt = await new SignJWT({ email: "owner@example.invalid", email_verified: true, token_use: "id", nonce: flow.nonce }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(configuration.issuer).setAudience(configuration.clientId).setSubject("fixture-owner").setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return json({ id_token: jwt, access_token: "fixture-access", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(headers.has("authorization"), false);
    if (url.href === `${configuration.issuer}/.well-known/openid-configuration`) return json({ issuer: configuration.issuer, authorization_endpoint: `${domain}/oauth2/authorize`, token_endpoint: `${domain}/oauth2/token`, jwks_uri: `${configuration.issuer}/.well-known/jwks.json`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_basic"], code_challenge_methods_supported: ["S256"] });
    if (url.href === `${configuration.issuer}/.well-known/jwks.json`) return json({ keys: [jwk] });
    throw new Error("Unexpected fixture request.");
  };
  const provider = await createCognitoProvider(configuration, mockFetch);
  const authorizationUrl = new URL(await provider.authorizationUrl(flow));
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.href.includes(configuration.clientSecret!), false);
  const callback = new URL(configuration.callbackUrl);
  callback.search = new URLSearchParams({ state: flow.state, code: "fixture-authorization-code" }).toString();
  assert.equal((await provider.exchange(callback, flow)).email, "owner@example.invalid");
  assert.equal(tokenRequests, 1);
});
