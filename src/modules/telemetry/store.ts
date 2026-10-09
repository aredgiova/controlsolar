import "server-only";
import pg from "pg";
import { ConfigurationError } from "@/lib/config";
import { validateDatabaseConnection } from "@/lib/database-configuration";

export type IngestionSource = "simulator" | "aws_iot";
export interface SourceContext {
  source: IngestionSource;
  clientId: string;
  principalId: string;
  topic: string;
  receivedAt: string | Date;
  expectedGatewayId?: string;
}
export interface NormalizedTelemetryInput {
  schemaVersion: "2.0";
  eventId: string;
  deviceId: string;
  measurementPointId: string;
  configurationVersion: number;
  measuredAt: string;
  activePower: number | null;
  importEnergy: number | null;
  exportEnergy: number | null;
  quality: "measured" | "missing" | "invalid";
  phases?: unknown[];
  alarms?: unknown[];
}
export interface DailyAggregateInput {
  localDate: string;
  measurementPointId: string;
  importEnergyKwh: number | null;
  exportEnergyKwh: number | null;
  integratedPositiveKwh: number | null;
  integratedNegativeKwh: number | null;
  sampleCount: number;
  gapCount: number;
  resetCount: number;
  quality: "measured" | "estimated" | "missing";
  detailJson: unknown;
}
export interface StoredSample {
  eventId: string; bindingId: string; deviceId: string; measurementPointId: string;
  configurationVersion: number; measuredAt: Date; receivedAt: Date;
  activePower: number | null; importEnergy: number | null; exportEnergy: number | null;
  quality: "measured" | "calculated" | "missing" | "invalid";
  source: IngestionSource; phases: unknown[]; alarms?: unknown[] | null;
}
export interface ProjectProcessingContext {
  projectId: string; timezone: string;
  points: Array<{ id: string; kind: "generation" | "consumption" | "grid"; signConvention: string }>;
  bindings: Array<{ id: string; measurementPointId: string; deviceId: string; configurationVersion: number; validFrom: Date; validTo: Date | null; configuration: unknown }>;
  topologyVersions: Array<{ id: string; version: number; validFrom: Date; validTo: Date | null; configuration: unknown }>;
  samples: StoredSample[];
}
export type StoredTelemetryResult = {
  status: "accepted" | "duplicate";
  eventId: string; storedEventId: string; organizationId: string; projectId: string;
  measurementPointId: string; bindingId: string; timezone: string;
} | {
  status: "quarantined"; reason: string; eventId: string | null; quarantineId: string;
};
export interface LossReportInput { reportId: string; from: string; to: string; dropped: number; reason: "buffer_capacity" }
export interface TelemetryStoreTransaction {
  acceptEvent(context: SourceContext, payload: NormalizedTelemetryInput, payloadHash: string): Promise<StoredTelemetryResult>;
  loadProjectContext(projectId: string, from?: Date, to?: Date): Promise<ProjectProcessingContext>;
  saveDailyAggregates(projectId: string, rows: DailyAggregateInput[]): Promise<void>;
  recordLossReports(context: SourceContext, reports: LossReportInput[]): Promise<number>;
}

const poolState = globalThis as unknown as { solarIngestionPool?: { url: string; pool: pg.Pool } };
async function getIngestionPool() {
  const url = process.env.INGEST_DATABASE_URL;
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
    throw new ConfigurationError("La ingesta requiere INGEST_DATABASE_URL con un rol separado.");
  }
  if (url === process.env.DATABASE_URL || url === process.env.AUTH_DATABASE_URL || url === process.env.DATABASE_MIGRATION_URL) {
    throw new ConfigurationError("La ingesta no puede reutilizar credenciales de ejecución, identidad ni migración.");
  }
  validateDatabaseConnection(url, "solar_ingest", process.env.APP_ENV, "INGEST_DATABASE_URL");
  if (poolState.solarIngestionPool?.url === url) return poolState.solarIngestionPool.pool;
  const previous = poolState.solarIngestionPool?.pool;
  const pool = new pg.Pool({ connectionString: url, max: 4, options: "-c timezone=UTC", connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  pool.on("error", () => { /* The next checked transaction reports failure without logging credentials. */ });
  poolState.solarIngestionPool = { url, pool };
  if (previous) await previous.end();
  return pool;
}
function validateSimulatorContext(context: SourceContext) {
  if (context.source === "simulator" && !["development", "staging"].includes(process.env.APP_ENV ?? "production")) {
    throw new ConfigurationError("La ingesta del simulador solo se permite en development o staging.");
  }
}
function serializeContext(context: SourceContext) {
  return JSON.stringify({ ...context, receivedAt: new Date(context.receivedAt).toISOString() });
}
async function assertIngestionRole(client: pg.PoolClient) {
  const { rows: [role] } = await client.query<{ safe: boolean }>(`
    SELECT current_user='solar_ingest' AND session_user='solar_ingest'
      AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
      AND current_setting('TimeZone')='UTC'
      AND NOT EXISTS(SELECT FROM pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolbypassrls)
        AND pg_has_role(current_user,privileged.oid,'MEMBER'))
      AND NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
          (pg_has_role(current_user,c.relowner,'MEMBER') OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
      AND (SELECT count(*)=32 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN
          ('users','sessions','auth_flows','organizations','memberships','customers','projects','devices','measurement_points',
           'device_bindings','topology_versions','site_access','invitations','invitation_projects','audit_events','telemetry_samples',
           'gateway_identities','gateway_meters','telemetry_latest','telemetry_daily_aggregates','ingestion_quarantine','gateway_loss_reports',
           'alert_rules','alerts','alert_events','incidents','incident_events','maintenance_windows',
           'notification_outbox','report_jobs','download_leases','request_rate_limits')) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (!role?.safe) throw new ConfigurationError("El rol de ingesta o la instalación de RLS no son seguros.");
}
function projectContext(raw: ProjectProcessingContext): ProjectProcessingContext {
  return {
    ...raw,
    bindings: raw.bindings.map((row) => ({ ...row, validFrom: new Date(row.validFrom), validTo: row.validTo ? new Date(row.validTo) : null })),
    topologyVersions: raw.topologyVersions.map((row) => ({ ...row, validFrom: new Date(row.validFrom), validTo: row.validTo ? new Date(row.validTo) : null })),
    samples: raw.samples.map((row) => ({ ...row, measuredAt: new Date(row.measuredAt), receivedAt: new Date(row.receivedAt) })),
  };
}

/** Registry resolution, sample, latest state and derived days commit together. */
export async function withTelemetryStore<T>(callback: (store: TelemetryStoreTransaction) => Promise<T>): Promise<T> {
  const pool = await getIngestionPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='30s'");
    await assertIngestionRole(client);
    await client.query("SELECT set_config('app.ingest_project_id','',true),set_config('app.ingest_gateway_id','',true),set_config('app.ingest_project_ids','[]',true)");
    const store: TelemetryStoreTransaction = {
      async acceptEvent(context, payload, payloadHash) {
        validateSimulatorContext(context);
        const normalized = { ...payload, measuredAt: new Date(payload.measuredAt).toISOString(), phases: payload.phases ?? [] };
        const { rows: [row] } = await client.query<{ result: StoredTelemetryResult }>("SELECT public.ingest_accept_event($1::jsonb,$2::jsonb,$3) AS result", [serializeContext(context), JSON.stringify(normalized), payloadHash]);
        return row.result;
      },
      async loadProjectContext(projectId, from = new Date(Date.now() - 31 * 86_400_000), to = new Date(Date.now() + 5 * 60_000)) {
        const { rows: [row] } = await client.query<{ result: ProjectProcessingContext }>("SELECT public.ingest_load_project_context($1::uuid,$2::timestamptz,$3::timestamptz) AS result", [projectId, from.toISOString(), to.toISOString()]);
        return projectContext(row.result);
      },
      async saveDailyAggregates(projectId, rows) {
        await client.query("SELECT public.ingest_save_daily_aggregates($1::uuid,$2::jsonb)", [projectId, JSON.stringify(rows)]);
      },
      async recordLossReports(context, reports) {
        validateSimulatorContext(context);
        const { rows: [row] } = await client.query<{ saved: number }>("SELECT public.ingest_record_loss_reports($1::jsonb,$2::jsonb) AS saved", [serializeContext(context), JSON.stringify(reports)]);
        return row.saved;
      },
    };
    const result = await callback(store);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function quarantineRaw(input: { messageId: string; bodyHash: string; reason: string; rawBody: string; receiptContext: unknown }): Promise<string> {
  const pool = await getIngestionPool();
  const client = await pool.connect();
  try {
    await assertIngestionRole(client);
    const raw = Buffer.from(input.rawBody, "utf8");
    const truncated = raw.byteLength > 65_530;
    const context = truncated && typeof input.receiptContext === "object" && input.receiptContext !== null
      ? { ...input.receiptContext, rawBodyTruncated: true } : input.receiptContext;
    const { rows: [row] } = await client.query<{ id: string }>("SELECT public.ingest_quarantine($1,$2,$3,$4,$5::jsonb) AS id", [input.messageId, input.bodyHash, input.reason, truncated ? raw.subarray(0, 65_530).toString("utf8") : input.rawBody, JSON.stringify(context)]);
    return row.id;
  } finally { client.release(); }
}
export async function closeTelemetryStore(): Promise<void> {
  const pool = poolState.solarIngestionPool?.pool;
  delete poolState.solarIngestionPool;
  if (pool) await pool.end();
}
