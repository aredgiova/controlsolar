import "server-only";
import { z } from "zod";
import { ConfigurationError } from "./configuration-error";
export { ConfigurationError } from "./configuration-error";

const environmentSchema = z.object({
  // A missing deployment label never enables a development exception.
  APP_ENV: z.enum(["development", "staging", "production"]).default("production"),
  DATA_ADAPTER: z.enum(["demo", "postgres"]).default("postgres"),
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
  DATABASE_URL: z.url().refine((url) => /^postgres(ql)?:\/\//.test(url)).optional(),
  AUTH_DATABASE_URL: z.url().refine((url) => /^postgres(ql)?:\/\//.test(url)).optional(),
});

export function readConfig(environment: Record<string, string | undefined> = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    // Do not include Zod's input or environment values: they may contain credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]))].join(", ");
    throw new ConfigurationError(`Configuración inválida: revisa ${fields}.`);
  }
  const env = result.data;
  const demoMode = env.DEMO_MODE === "true";
  if (demoMode !== (env.DATA_ADAPTER === "demo")) {
    throw new ConfigurationError("La demostración requiere DEMO_MODE=true y DATA_ADAPTER=demo explícitos.");
  }
  if (env.APP_ENV === "production" && demoMode) {
    throw new ConfigurationError("La demostración está prohibida en APP_ENV=production.");
  }
  return {
    appEnv: env.APP_ENV,
    dataAdapter: env.DATA_ADAPTER,
    demoMode,
    databaseUrl: env.DATABASE_URL,
    authDatabaseUrl: env.AUTH_DATABASE_URL,
  } as const;
}

export type AppConfiguration = ReturnType<typeof readConfig>;

const optionalText = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const authEnvironmentSchema = z.object({
  APP_BASE_URL: optionalText,
  COGNITO_ISSUER: optionalText,
  COGNITO_CLIENT_ID: optionalText,
  COGNITO_CLIENT_SECRET: optionalText,
  COGNITO_DOMAIN: optionalText,
  AUTH_SECRET: optionalText,
});

function applicationUrl(value: string, production: boolean) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConfigurationError("APP_BASE_URL debe ser una URL válida."); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local && !production))) {
    throw new ConfigurationError("APP_BASE_URL requiere HTTPS y solo admite HTTP en localhost de desarrollo.");
  }
  return url.origin;
}

// Cognito's HTTPS issuer is fixed in deployment configuration, never supplied by a request.
export function readAuthConfig(environment: Record<string, string | undefined> = process.env) {
  const base = readConfig(environment);
  const parsed = authEnvironmentSchema.safeParse(environment);
  if (!parsed.success) throw new ConfigurationError("Configuración de identidad inválida.");
  const env = parsed.data;
  const required = ["APP_BASE_URL", "COGNITO_ISSUER", "COGNITO_CLIENT_ID", "AUTH_SECRET"] as const;
  const missing: string[] = required.filter((key) => !env[key]);
  if (!base.authDatabaseUrl) missing.push("AUTH_DATABASE_URL");
  if (missing.length) throw new ConfigurationError(`Identidad pendiente de configurar: ${missing.join(", ")}.`);
  const issuer = env.COGNITO_ISSUER!;
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[A-Za-z0-9_-]+$/.test(issuer)) {
    throw new ConfigurationError("COGNITO_ISSUER debe ser el emisor HTTPS de un User Pool de Amazon Cognito.");
  }
  if (Buffer.byteLength(env.AUTH_SECRET!, "utf8") < 32) {
    throw new ConfigurationError("AUTH_SECRET requiere al menos 32 bytes aleatorios.");
  }
  if (base.databaseUrl && base.databaseUrl === base.authDatabaseUrl) {
    throw new ConfigurationError("La conexión de identidad debe usar un rol separado del acceso a datos.");
  }
  const production = base.appEnv === "production";
  const appBaseUrl = applicationUrl(env.APP_BASE_URL!, production);
  let cognitoDomain: string | undefined;
  if (env.COGNITO_DOMAIN) {
    try {
      const url = new URL(env.COGNITO_DOMAIN);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
      cognitoDomain = url.origin;
    } catch { throw new ConfigurationError("COGNITO_DOMAIN debe ser el dominio HTTPS de inicio de sesión, sin ruta."); }
  }
  return {
    appBaseUrl,
    issuer,
    clientId: env.COGNITO_CLIENT_ID!,
    clientSecret: env.COGNITO_CLIENT_SECRET,
    cognitoDomain,
    secret: env.AUTH_SECRET!,
    secureCookies: production || appBaseUrl.startsWith("https:"),
    callbackUrl: `${appBaseUrl}/auth/callback`,
  } as const;
}

export type AuthConfiguration = ReturnType<typeof readAuthConfig>;

export function getAuthenticationStatus() {
  try { readAuthConfig(); return { configured: true, message: "Identidad configurada." } as const; }
  catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return { configured: false, message: error.message } as const;
  }
}

export function getPublicConfiguration() {
  const configuration = readConfig();
  return {
    appEnv: configuration.appEnv,
    dataAdapter: configuration.dataAdapter,
    demoMode: configuration.demoMode,
    databaseConfigured: Boolean(configuration.databaseUrl),
  };
}
