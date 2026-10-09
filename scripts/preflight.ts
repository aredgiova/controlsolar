import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import pg from "pg";
import { deploymentServices, inspectDeploymentEnvironment, databaseFieldsFor, databaseRoleFor, type DeploymentService, type Environment, type ReadinessCheck } from "../src/operations/preflight";
import { readAuthConfig } from "../src/lib/config";
import { createCognitoProvider } from "../src/modules/auth/oidc";

async function checkDatabase(field: string, environment: Environment): Promise<ReadinessCheck> {
  const role = databaseRoleFor(field);
  const client = new pg.Client({ connectionString: environment[field], options: "-c timezone=UTC", connectionTimeoutMillis: 5000, query_timeout: 10000 });
  try {
    await client.connect(); await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SELECT set_config('app.user_id','',true),set_config('app.organization_id','',true)");
    const { rows: [row] } = await client.query<{ safe: boolean }>(`SELECT current_user=$1 AND session_user=$1
      AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
      AND current_setting('TimeZone')='UTC'
      AND NOT EXISTS(SELECT FROM pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolbypassrls) AND pg_has_role(current_user,privileged.oid,'MEMBER'))
      AND NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND pg_has_role(current_user,c.relowner,'MEMBER'))
      AND (SELECT count(*)=32 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND c.relname<>'_prisma_migrations') AS safe
      FROM pg_roles r WHERE r.rolname=current_user`, [role]);
    if (!row?.safe) throw new Error("unsafe");
    if (role === "solar_runtime") {
      const { rows: [scope] } = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM public.projects");
      const { rows: [sessions] } = await client.query<{ access: boolean }>("SELECT has_table_privilege(current_user,'public.sessions','SELECT,INSERT,UPDATE,DELETE') AS access");
      if (scope.count !== 0 || sessions.access) throw new Error("unsafe");
    } else {
      const { rows: [tables] } = await client.query<{ access: boolean }>(`SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS access`);
      if (tables.access) throw new Error("unsafe");
      const signatures = role === "solar_auth" ? ["public.auth_resolve_session(text)", "public.auth_take_rate_limit(text,text,integer,integer)"] : ["public.worker_claim_alert_project()", "public.worker_claim_report_job(text,text,timestamp with time zone)"];
      for (const signature of signatures) {
        const { rows: [fn] } = await client.query<{ access: boolean }>("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS access", [signature]);
        if (!fn.access) throw new Error("unsafe");
      }
    }
    return { name: `database:${field}`, passed: true, message: "Conexión, rol efectivo, FORCE RLS y permisos comprobados sin escribir datos." };
  } catch { return { name: `database:${field}`, passed: false, message: "No se acreditó conexión/rol/RLS/permisos. Revisar destino, TLS y migraciones sin imprimir secretos." }; }
  finally { await client.query("ROLLBACK").catch(() => {}); await client.end().catch(() => {}); }
}

async function main() {
  const args = process.argv.slice(2); let service: DeploymentService | undefined, file: string | undefined, database = false, provider = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--service" && !service && deploymentServices.includes(args[index + 1] as DeploymentService)) service = args[++index] as DeploymentService;
    else if (argument === "--env-file" && !file && args[index + 1] && !args[index + 1].startsWith("--")) file = args[++index];
    else if (argument === "--check-database" && !database) database = true;
    else if (argument === "--check-provider" && !provider) provider = true;
    else throw new Error("usage");
  }
  if (!service || (provider && service !== "web") || (database && service === "ingestion")) throw new Error("usage");
  const environment: Environment = file ? parse(await readFile(file)) : { ...process.env };
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") environment.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const result = inspectDeploymentEnvironment(environment, service);
  if (result.ready) {
    if (database) for (const field of databaseFieldsFor(service)) result.checks.push(await checkDatabase(field, environment));
    if (provider) {
      let passed = true; try { await createCognitoProvider(readAuthConfig(environment)); } catch { passed = false; }
      result.checks.push({ name: "provider-metadata", passed, message: "Discovery HTTPS y metadatos esperados. No prueba login, correo, MFA ni callbacks del cliente." });
    }
  }
  result.ready = result.checks.every((check) => check.passed);
  console.log(JSON.stringify({ ...result, source: file ? "explicit-file" : "process-environment", scope: database || provider ? "configuration-and-selected-read-only-checks" : result.scope }, null, 2));
  if (!result.ready) process.exitCode = 1;
}
void main().catch(() => { console.error("Preflight no ejecutado. Uso: npm run preflight -- --service web|monitor|reports|ingestion [--env-file archivo-privado] [--check-database] [--check-provider sólo web]. No se imprimen valores privados."); process.exitCode = 1; });
