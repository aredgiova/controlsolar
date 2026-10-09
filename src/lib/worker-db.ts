import "server-only";
import pg from "pg";
import { ConfigurationError } from "./config";
import { validateDatabaseConnection } from "./database-configuration";
const state = globalThis as unknown as { solarWorkerPool?: { url: string; pool: pg.Pool } };
export async function getWorkerPool() {
  const value = process.env.WORKER_DATABASE_URL;
  if (!value || [process.env.DATABASE_URL, process.env.AUTH_DATABASE_URL, process.env.INGEST_DATABASE_URL, process.env.DATABASE_MIGRATION_URL].includes(value)) throw new ConfigurationError("WORKER_DATABASE_URL requiere credenciales separadas.");
  validateDatabaseConnection(value, "solar_worker", process.env.APP_ENV, "WORKER_DATABASE_URL");
  if (state.solarWorkerPool?.url === value) return state.solarWorkerPool.pool;
  const previous = state.solarWorkerPool?.pool;
  const pool = new pg.Pool({ connectionString: value, max: 2, options: "-c timezone=UTC", connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }); pool.on("error", () => {});
  state.solarWorkerPool = { url: value, pool }; if (previous) await previous.end(); return pool;
}
async function assertWorkerRole(client: pg.PoolClient) {
  const { rows: [role] } = await client.query<{ safe: boolean }>(`SELECT current_user='solar_worker' AND session_user='solar_worker'
    AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
    AND current_setting('TimeZone')='UTC'
    AND NOT EXISTS(SELECT FROM pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolbypassrls) AND pg_has_role(current_user,privileged.oid,'MEMBER'))
    AND NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p')
      AND (pg_has_role(current_user,c.relowner,'MEMBER') OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
    AND (SELECT count(*)=32 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN('users','sessions','auth_flows','organizations','memberships','customers','projects','devices',
      'measurement_points','device_bindings','topology_versions','site_access','invitations','invitation_projects','audit_events','telemetry_samples',
      'gateway_identities','gateway_meters','telemetry_latest','telemetry_daily_aggregates','ingestion_quarantine','gateway_loss_reports',
      'alert_rules','alerts','alert_events','incidents','incident_events','maintenance_windows','notification_outbox','report_jobs','download_leases','request_rate_limits')) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (!role?.safe) throw new ConfigurationError("El rol del worker o su instalación RLS no es seguro.");
}
export async function withWorkerTransaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = await getWorkerPool(); const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query("SET LOCAL statement_timeout='30s'"); await assertWorkerRole(client);
    await client.query("SELECT set_config('app.worker_job_id','',true),set_config('app.worker_project_id','',true),set_config('app.worker_org_id','',true)");
    const result = await callback(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export const withWorkerDatabase = withWorkerTransaction;
export async function closeWorkerDatabase() { const pool = state.solarWorkerPool?.pool; delete state.solarWorkerPool; if (pool) await pool.end(); }
