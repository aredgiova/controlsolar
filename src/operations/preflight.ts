import { readAuthConfig } from "../lib/config";
import { validateDatabaseConnection, type DatabaseRole } from "../lib/database-configuration";

export const deploymentServices = ["web", "monitor", "reports", "ingestion"] as const;
export type DeploymentService = typeof deploymentServices[number];
export interface ReadinessCheck { name: string; passed: boolean; message: string }
export type Environment = Record<string, string | undefined>;
const databaseRoles: Record<string, DatabaseRole> = { DATABASE_URL: "solar_runtime", AUTH_DATABASE_URL: "solar_auth", WORKER_DATABASE_URL: "solar_worker" };
const secretFields = ["DATABASE_URL", "AUTH_DATABASE_URL", "WORKER_DATABASE_URL", "INGEST_DATABASE_URL", "DATABASE_MIGRATION_URL", "BACKUP_DATABASE_URL", "BACKUP_ENCRYPTION_KEY", "AUTH_SECRET", "COGNITO_CLIENT_SECRET"];
const serviceSecrets: Record<DeploymentService, string[]> = {
  web: ["DATABASE_URL", "AUTH_DATABASE_URL", "AUTH_SECRET", "COGNITO_CLIENT_SECRET"],
  monitor: ["WORKER_DATABASE_URL"], reports: ["WORKER_DATABASE_URL"], ingestion: [],
};
const placeholder = /(?:example\.(?:invalid|com)|REEMPLAZAR|REPLACE_ME|CHANGEME|<[^>]+>)/i;
export function databaseFieldsFor(service: DeploymentService) { return service === "web" ? ["DATABASE_URL", "AUTH_DATABASE_URL"] : service === "ingestion" ? [] : ["WORKER_DATABASE_URL"]; }
export function databaseRoleFor(field: string) { return databaseRoles[field]; }

// Returns only names and static diagnostics. Never return the environment or
// messages from URL/SDK/SQL errors, which can contain credentials.
export function inspectDeploymentEnvironment(environment: Environment, service: DeploymentService) {
  const checks: ReadinessCheck[] = [];
  const add = (name: string, passed: boolean, message: string) => checks.push({ name, passed, message });
  const required = (field: string) => {
    const value = environment[field];
    add(field, Boolean(value && value.trim() && !placeholder.test(value)), `Completar ${field} con el valor de este entorno; no usar el ejemplo.`);
    return value;
  };
  const appEnv = environment.APP_ENV;
  add("APP_ENV", ["development", "staging", "production"].includes(appEnv ?? ""), "Definir APP_ENV explícitamente.");
  add("TLS", environment.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "Conservar la verificación TLS de Node.");
  if (service === "web") add("adapter", environment.DATA_ADAPTER === "postgres" && environment.DEMO_MODE === "false", "Usar DATA_ADAPTER=postgres y DEMO_MODE=false para la preparación real.");
  for (const field of secretFields) if (environment[field] && !serviceSecrets[service].includes(field)) add(`separation:${field}`, false, `${field} pertenece a otro proceso; retirarla de este entorno.`);
  for (const field of databaseFieldsFor(service)) {
    const value = required(field);
    if (value) { let valid = true; try { validateDatabaseConnection(value, databaseRoleFor(field), appEnv, field, environment); } catch { valid = false; }
      add(`transport:${field}`, valid, `${field} necesita su rol limitado, destino explícito y verify-full fuera de development loopback.`);
    }
  }
  if (service === "web") {
    for (const field of ["APP_BASE_URL", "COGNITO_ISSUER", "COGNITO_CLIENT_ID", "COGNITO_DOMAIN", "AUTH_SECRET"]) required(field);
    let configured = true; try { readAuthConfig(environment); } catch { configured = false; }
    add("oidc", configured, "Revisar emisor, dominio, cliente, origen exacto, secreto privado y conexiones separadas.");
    if (environment.APP_BASE_URL?.startsWith("http:")) {
      let valid = false; try { valid = appEnv !== "production" && new URL(environment.APP_BASE_URL).hostname === "localhost"; } catch { /* static diagnostic only */ }
      add("cognito-localhost", valid, "Cognito admite HTTP local sólo con localhost; registrar exactamente ese callback.");
    }
    if (environment.DATABASE_URL && environment.AUTH_DATABASE_URL) {
      let same = false;
      try { const runtime = new URL(environment.DATABASE_URL), auth = new URL(environment.AUTH_DATABASE_URL); same = runtime.hostname === auth.hostname && (runtime.port || "5432") === (auth.port || "5432") && runtime.pathname === auth.pathname; } catch { /* transport checks already fail */ }
      add("database-target", same, "Web e identidad deben apuntar a la misma base del entorno, con roles diferentes.");
    }
  }
  if (service === "web" || service === "reports") {
    required("REPORT_STORAGE");
    if (environment.REPORT_STORAGE === "local") {
      add("report-storage", appEnv === "development", "REPORT_STORAGE=local sólo sirve en development; staging/production necesitan s3.");
    } else {
      add("report-storage", environment.REPORT_STORAGE === "s3", "Seleccionar REPORT_STORAGE=s3 para archivos privados remotos.");
      const bucket = required("REPORT_S3_BUCKET"), region = required("AWS_REGION"), account = required("REPORT_S3_ACCOUNT_ID");
      add("report-target", Boolean(bucket && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && region && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region) && account && /^\d{12}$/.test(account) && account !== "000000000000"), "Comprobar bucket privado, región y cuenta propietaria del mismo entorno.");
    }
  }
  if (service === "ingestion") {
    const secret = required("INGEST_DATABASE_SECRET_ARN"), queue = required("INGEST_QUEUE_ARN"), region = required("AWS_REGION");
    const secretMatch = secret?.match(/^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z0-9-]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/);
    const queueMatch = queue?.match(/^arn:(aws|aws-us-gov|aws-cn):sqs:([a-z0-9-]+):(\d{12}):[A-Za-z0-9_-]{1,80}$/);
    add("ingestion-target", Boolean(secretMatch && queueMatch && secretMatch[1] === queueMatch[1] && secretMatch[2] === region && queueMatch[2] === region && secretMatch[3] === queueMatch[3] && secretMatch[3] !== "000000000000"), "Secreto y cola deben tener cuenta, partición y región coherentes; completar desde outputs reales.");
  }
  if (service === "monitor" || service === "ingestion") {
    for (const field of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) if (environment[field]) add(`separation:${field}`, false, "Este proceso usa su rol de ejecución; no incluir claves AWS estáticas.");
  }
  return { service, scope: "configuration-only", ready: checks.every((check) => check.passed), checks,
    pending: ["Cuenta/recursos y permisos AWS efectivos", "Login real y asignaciones de usuarios", "TLS/conectividad del destino", "Kit, firmware, signos y comparación física", "Piloto con clientes autorizados"] };
}
