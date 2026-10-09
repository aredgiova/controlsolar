import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { withTenant } from "../src/lib/tenant";
import { getDatabase } from "../src/lib/db";
import { closeWorkerDatabase } from "../src/lib/worker-db";
import { withAlertWorker } from "../src/modules/alerts/store";
import type { AlertTransition } from "../src/modules/alerts/types";
import { closeTelemetryStore, withTelemetryStore } from "../src/modules/telemetry/store";

const enabled = Boolean(process.env.SOLAR_DATABASE_TEST_ENV || process.env.TEST_ADMIN_DATABASE_URL);
const hash = (text: string = randomUUID()) => createHash("sha256").update(text).digest("hex");

test("H6/H7 PostgreSQL: RLS, atomicidad, outbox, leases privados y rate limit concurrente", { skip: !enabled }, async (t) => {
  const env: { admin: string; runtime: string; auth: string; ingest: string; worker: string; backup: string } = process.env.SOLAR_DATABASE_TEST_ENV
    ? JSON.parse(await readFile(process.env.SOLAR_DATABASE_TEST_ENV, "utf8"))
    : { admin: process.env.TEST_ADMIN_DATABASE_URL!, runtime: process.env.TEST_RUNTIME_DATABASE_URL!, auth: process.env.TEST_AUTH_DATABASE_URL!, ingest: process.env.TEST_INGEST_DATABASE_URL!, worker: process.env.TEST_WORKER_DATABASE_URL!, backup: process.env.TEST_BACKUP_DATABASE_URL! };
  assert.ok(env.worker && env.backup, "La integración H67 requiere roles worker y backup separados.");
  process.env.APP_ENV = "development"; process.env.DATA_ADAPTER = "postgres"; process.env.DEMO_MODE = "false";
  process.env.DATABASE_URL = env.runtime; process.env.WORKER_DATABASE_URL = env.worker; process.env.INGEST_DATABASE_URL = env.ingest;
  const admin = new pg.Client({ connectionString: env.admin }); const runtime = new pg.Client({ connectionString: env.runtime });
  const worker = new pg.Client({ connectionString: env.worker }); const auth = new pg.Pool({ connectionString: env.auth, max: 8 });
  const ingest = new pg.Client({ connectionString: env.ingest }); const backup = new pg.Client({ connectionString: env.backup });
  await Promise.all([admin.connect(), runtime.connect(), worker.connect(), ingest.connect(), backup.connect()]);
  const ids = Object.fromEntries(["org", "foreignOrg", "owner", "customer", "technician", "outsider", "client", "foreignClient", "foreignProject", "point", "rule", "incident", "job", "lease", "device", "binding", "sample", "lateSample"].map((key) => [key, randomUUID()]));
  ids.project = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
  const orgs = [ids.org, ids.foreignOrg]; const users = [ids.owner, ids.customer, ids.technician, ids.outsider];
  const rateHash = hash(); const leaseHash = hash(); const reportLease = hash();
  const deny = async (action: () => Promise<unknown>, code = "42501") => assert.rejects(action(), (e: unknown) => (e as { code: string }).code === code);
  async function scope<T>(user: string, action: () => Promise<T>) {
    await runtime.query("BEGIN");
    try { await runtime.query("SELECT set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true)", [user, ids.org]); const result = await action(); await runtime.query("COMMIT"); return result; }
    catch (e) { await runtime.query("ROLLBACK"); throw e; }
  }
  try {
    for (const id of users) await admin.query("INSERT INTO users(id,cognito_subject,email,email_verified,updated_at) VALUES($1,$2,$3,true,now())", [id, `h67|${id}`, `${id}@example.test`]);
    for (const [org, client, project] of [[ids.org, ids.client, ids.project], [ids.foreignOrg, ids.foreignClient, ids.foreignProject]]) {
      await admin.query("INSERT INTO organizations(id,name,slug,updated_at) VALUES($1::uuid,$1::text,$1::text,now())", [org]);
      await admin.query("INSERT INTO customers(id,organization_id,name,updated_at) VALUES($1,$2,'H67',now())", [client, org]);
      await admin.query("INSERT INTO projects(id,organization_id,customer_id,name,location,capacity_kwp,updated_at) VALUES($1,$2,$3,'Proyecto H67','Yopal',5,now())", [project, org, client]);
    }
    for (const [user, role] of [[ids.owner, "owner"], [ids.customer, "customer"], [ids.technician, "technician"], [ids.outsider, "customer"]]) await admin.query("INSERT INTO memberships(id,organization_id,user_id,role,status,updated_at) VALUES($1,$2,$3,$4,'active',now())", [randomUUID(), ids.org, user, role]);
    for (const [user, role] of [[ids.customer, "customer"], [ids.technician, "technician"]]) await admin.query("INSERT INTO site_access(id,organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ids.org, ids.project, user, role]);
    await admin.query("INSERT INTO alert_rules(id,organization_id,project_id,kind,name,persistence_seconds,recovery_seconds,configuration,updated_at) VALUES($1,$2,$3,'communication','Comunicación',0,0,'{\"staleAfterSeconds\":60}',now())", [ids.rule, ids.org, ids.project]);
    await admin.query("INSERT INTO measurement_points(id,organization_id,project_id,name,kind,sign_convention) VALUES($1,$2,$3,'Generación','generation','positive_generation')", [ids.point, ids.org, ids.project]);
    await admin.query("INSERT INTO devices(id,organization_id,serial,name,kind,updated_at) VALUES($1,$2,$3,'Medidor','meter',now())", [ids.device, ids.org, randomUUID()]);
    await admin.query("INSERT INTO device_bindings(id,organization_id,project_id,device_id,measurement_point_id,valid_from) VALUES($1,$2,$3,$4,$5,now()-interval '3 days')", [ids.binding, ids.org, ids.project, ids.device, ids.point]);

    await t.test("32 tablas FORCE RLS y roles worker/backup efectivos sin escritura directa", async () => {
      const { rows: [row] } = await admin.query("SELECT count(*)::int AS count,bool_and(c.relrowsecurity AND c.relforcerowsecurity) AS safe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'");
      assert.equal(row.count, 32); assert.equal(row.safe, true);
      assert.equal((await worker.query("SELECT current_user")).rows[0].current_user, "solar_worker");
      await deny(() => worker.query("SELECT * FROM report_jobs")); await deny(() => worker.query("SET ROLE solar_security_guard"));
      await deny(() => runtime.query("SELECT public.worker_claim_alert_project()")); await deny(() => ingest.query("SELECT public.worker_claim_alert_project()"));
      assert.ok((await backup.query("SELECT id FROM organizations WHERE id=$1", [ids.org])).rowCount);
      await deny(() => backup.query("UPDATE organizations SET name='x' WHERE id=$1", [ids.org]));
    });
    await t.test("RLS asignado y FK compuesta impiden consultar o enlazar otro proyecto/empresa", async () => {
      await withTenant({ userId: ids.customer }, ids.org, async (tx) => assert.equal(await tx.alertRule.count(), 1));
      await withTenant({ userId: ids.technician }, ids.org, async (tx) => assert.equal(await tx.alertRule.count(), 1));
      await withTenant({ userId: ids.outsider }, ids.org, async (tx) => assert.equal(await tx.alertRule.count(), 0));
      await deny(() => scope(ids.technician, () => runtime.query("INSERT INTO maintenance_windows(id,organization_id,project_id,starts_at,ends_at,reason,created_by_id) VALUES($1,$2,$3,now(),now()+interval '1 hour','No autorizado',$4)", [randomUUID(), ids.org, ids.project, ids.technician])));
      await deny(() => scope(ids.owner, () => runtime.query("INSERT INTO incidents(id,organization_id,project_id,title,description,created_by_id,updated_at) VALUES($1,$2,$3,'Cross-org','x',$4,now())", [randomUUID(), ids.org, ids.foreignProject, ids.owner])), "23503");
      await deny(() => scope(ids.owner, () => runtime.query("INSERT INTO incidents(id,organization_id,project_id,title,description,created_by_id,assignee_user_id,updated_at) VALUES($1,$2,$3,'Asignación inválida','x',$4,$5,now())", [randomUUID(), ids.org, ids.project, ids.owner, ids.outsider])), "23514");
    });
    const episode = randomUUID(); let alertId = "";
    async function evaluate(event: "activated" | "resolved", rollback = false) {
      return withAlertWorker(async (store) => {
        const snapshot = await store.claimProject(); assert.equal(snapshot?.project.id, ids.project); assert.ok(snapshot);
        const at = snapshot.evaluatedAt.toISOString();
        const plan: AlertTransition = { ruleId: ids.rule, dedupKey: `point:${ids.point}`, episodeId: episode, status: event === "activated" ? "active" : "resolved", candidateSince: at, recoverySince: null, activatedAt: event === "activated" ? at : snapshot.states[0].activatedAt as string, resolvedAt: event === "resolved" ? at : null, lastEvaluatedAt: at, title: "Pérdida de comunicación", message: "Sin mediciones recientes", severity: "warning", detail: {}, event };
        const result = await store.saveEvaluation(ids.project, snapshot.evaluatedAt, [plan]);
        if (rollback) throw new Error("rollback esperado");
        return result;
      });
    }
    await t.test("estado/episodio/incidencia/evento/outbox son atómicos y no duplican activación", async () => {
      await assert.rejects(evaluate("activated", true), /rollback esperado/);
      assert.equal((await admin.query("SELECT * FROM alerts WHERE organization_id=$1", [ids.org])).rowCount, 0);
      assert.deepEqual(await evaluate("activated"), { activated: 1, resolved: 0 });
      alertId = (await admin.query("SELECT id FROM alerts WHERE organization_id=$1", [ids.org])).rows[0].id;
      for (const table of ["alert_events", "notification_outbox", "incidents", "incident_events"]) assert.equal((await admin.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [ids.org])).rowCount, 1);
      await admin.query("UPDATE alert_rules SET last_evaluated_at=NULL WHERE id=$1", [ids.rule]);
      assert.deepEqual(await evaluate("activated"), { activated: 0, resolved: 0 });
      assert.equal((await admin.query("SELECT * FROM notification_outbox WHERE organization_id=$1", [ids.org])).rowCount, 1);
      await admin.query("UPDATE alert_rules SET last_evaluated_at=NULL WHERE id=$1", [ids.rule]);
      assert.deepEqual(await evaluate("resolved"), { activated: 0, resolved: 1 });
      assert.equal((await admin.query("SELECT * FROM incidents WHERE organization_id=$1 AND status='open'", [ids.org])).rowCount, 1);
      await deny(() => scope(ids.owner, () => runtime.query("UPDATE alerts SET status='resolved' WHERE id=$1", [alertId])));
    });
    await t.test("outbox local persiste fallo/reintento y entrega in-app con lease correcto", async () => {
      const { rows: [row] } = await worker.query("SELECT public.worker_claim_notification('h67-test',$1) AS result", [leaseHash]); assert.ok(row.result);
      await deny(() => worker.query("SELECT public.worker_complete_notification($1,$2,true,NULL)", [row.result.id, hash()]));
      await worker.query("SELECT public.worker_complete_notification($1,$2,false,'LOCAL_ADAPTER_FAILURE')", [row.result.id, leaseHash]);
      const failed = (await admin.query("SELECT * FROM notification_outbox WHERE id=$1", [row.result.id])).rows[0];
      assert.equal(failed.status, "pending"); assert.equal(failed.attempts, 1); assert.equal(failed.last_error, "LOCAL_ADAPTER_FAILURE");
      await admin.query("UPDATE notification_outbox SET next_attempt_at=now()-interval '1 minute' WHERE id=$1", [row.result.id]);
      await withAlertWorker(async (store) => { const notification = await store.claimNotification(); assert.ok(notification); await store.completeNotification(notification.id, true); });
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM notification_outbox WHERE organization_id=$1 AND status='delivered'", [ids.org])).rows[0].count, 1);
    });
    await t.test("rate limit atómico permite exactamente el límite bajo concurrencia", async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => auth.query("SELECT * FROM public.auth_take_rate_limit('api_write',$1,5,60)", [rateHash])));
      assert.equal(results.filter((r) => r.rows[0].allowed).length, 5); assert.ok(results.every((r) => r.rows[0].retry_after >= 1));
      for (const client of [runtime, ingest, worker, backup]) await deny(() => client.query("SELECT * FROM public.auth_take_rate_limit('api_write',$1,5,60)", [rateHash]));
      await deny(() => auth.query("SELECT * FROM request_rate_limits"));
    });
    await t.test("periodo civil se congela, worker usa lease y el snapshot excluye llegadas posteriores", async () => {
      const localDate = (await admin.query("SELECT (now() AT TIME ZONE 'America/Bogota')::date::text AS date")).rows[0].date;
      await admin.query("INSERT INTO telemetry_samples(event_id,organization_id,binding_id,device_id,measurement_point_id,configuration_version,measured_at,received_at,quality,active_power,alarms) VALUES($1,$2,$3,$4,$5,1,now()-interval '2 minutes',now()-interval '1 minute','measured',3,'[]')", [ids.sample, ids.org, ids.binding, ids.device, ids.point]);
      await scope(ids.customer, () => runtime.query("INSERT INTO report_jobs(id,organization_id,project_id,requested_by,idempotency_key,timezone,start_date,end_date,period_from,period_to,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,'America/Bogota',$6::date,$6::date,$6::date::timestamp AT TIME ZONE 'America/Bogota',($6::date+1)::timestamp AT TIME ZONE 'America/Bogota','2000-01-01',now())", [ids.job, ids.org, ids.project, ids.customer, randomUUID(), localDate]));
      // A delayed transport receipt can predate the request even though SQL
      // persists the observation afterwards. The frozen sequence excludes it.
      await admin.query("INSERT INTO telemetry_samples(event_id,organization_id,binding_id,device_id,measurement_point_id,configuration_version,measured_at,received_at,quality,active_power) VALUES($1,$2,$3,$4,$5,1,now()-interval '1 minute',now()-interval '30 seconds','measured',4)", [ids.lateSample, ids.org, ids.binding, ids.device, ids.point]);
      const claimed = (await worker.query("SELECT public.worker_claim_report_job('h67-test',$1,now()+interval '4 minutes') AS result", [reportLease])).rows[0].result;
      assert.equal(claimed.id, ids.job); assert.equal(claimed.timezone, "America/Bogota");
      await deny(() => worker.query("SELECT public.worker_report_context($1,$2,$3)", [ids.job, hash(), localDate]));
      const context = (await worker.query("SELECT public.worker_report_context($1,$2,$3) AS result", [ids.job, reportLease, localDate])).rows[0].result;
      assert.deepEqual(context.samples.map((s: { eventId: string }) => s.eventId), [ids.sample]);
      await worker.query("SELECT public.worker_renew_report_job($1,$2,now()+interval '4 minutes')", [ids.job, reportLease]);
      const sha = hash("private PDF");
      await worker.query("SELECT public.worker_complete_report_job($1,$2,$3::jsonb)", [ids.job, reportLease, JSON.stringify({ artifactKey: `reports/${ids.org}/${ids.job}/${sha}.pdf`, sha256: sha, byteLength: 100, snapshotJson: { asOf: claimed.createdAt, source: "simulator" } })]);
      await deny(() => worker.query("SELECT public.worker_renew_report_job($1,$2,now()+interval '4 minutes')", [ids.job, reportLease]));
      await scope(ids.customer, () => runtime.query("INSERT INTO download_leases(id,organization_id,project_id,report_job_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '4 minutes')", [ids.lease, ids.org, ids.project, ids.job, ids.customer, leaseHash]));
      await admin.query("DELETE FROM site_access WHERE organization_id=$1 AND user_id=$2", [ids.org, ids.customer]);
      await deny(() => scope(ids.customer, () => runtime.query("SELECT public.app_consume_download_lease($1)", [leaseHash])));
      await admin.query("INSERT INTO site_access(id,organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4,'customer')", [randomUUID(), ids.org, ids.project, ids.customer]);
      const artifact = (await scope(ids.customer, () => runtime.query("SELECT public.app_consume_download_lease($1) AS result", [leaseHash]))).rows[0].result;
      assert.equal(artifact.id, ids.job); assert.equal(artifact.sha256, sha);
      await deny(() => scope(ids.customer, () => runtime.query("SELECT public.app_consume_download_lease($1)", [leaseHash])));
    });
    await t.test("alarmas explícitas conservan el contrato de 80 caracteres y ausencia nullable", async () => {
      const gatewayDevice = randomUUID(), gateway = randomUUID();
      await admin.query("INSERT INTO devices(id,organization_id,serial,name,kind,updated_at) VALUES($1,$2,$3,'Gateway prueba','gateway',now())", [gatewayDevice, ids.org, randomUUID()]);
      await admin.query("INSERT INTO gateway_identities(id,organization_id,gateway_device_id,name,source,client_id,principal_id) VALUES($1::uuid,$2,$3,'Simulador','simulator',$1::text,'h67-simulator')", [gateway, ids.org, gatewayDevice]);
      await admin.query("INSERT INTO gateway_meters(organization_id,gateway_identity_id,meter_device_id) VALUES($1,$2,$3)", [ids.org, gateway, ids.device]);
      await withTelemetryStore(async (store) => {
        const now = new Date(); const eventId = randomUUID(); const alarms = [{ code: "A".repeat(80), severity: "critical", active: true }];
        const result = await store.acceptEvent({ source: "simulator", clientId: gateway, principalId: "h67-simulator", topic: `solar/v2/gateways/${gateway}/telemetry`, receivedAt: now, expectedGatewayId: gateway }, { schemaVersion: "2.0", eventId, deviceId: ids.device, measurementPointId: ids.point, configurationVersion: 1, measuredAt: now.toISOString(), activePower: 1, importEnergy: null, exportEnergy: null, quality: "measured", alarms }, hash());
        assert.equal(result.status, "accepted");
        const context = await store.loadProjectContext(ids.project, new Date(now.getTime() - 86400000), new Date(now.getTime() + 60000));
        assert.deepEqual(context.samples.find((s) => s.eventId === eventId)?.alarms, alarms);
        assert.equal(context.samples.find((s) => s.eventId === ids.lateSample)?.alarms, null);
      });
    });
  } finally {
    await runtime.query("ROLLBACK"); await closeWorkerDatabase(); await closeTelemetryStore(); await getDatabase().$disconnect();
    await admin.query("DELETE FROM request_rate_limits WHERE key_hash=$1", [rateHash]);
    for (const table of ["download_leases", "report_jobs", "notification_outbox", "incident_events", "incidents", "alert_events", "alerts", "alert_rules", "maintenance_windows", "telemetry_latest", "telemetry_samples", "gateway_meters", "gateway_identities", "site_access", "device_bindings", "measurement_points", "devices", "audit_events", "projects", "customers", "memberships"]) await admin.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`, [orgs]);
    await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [orgs]); await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
    await Promise.all([admin.end(), runtime.end(), worker.end(), auth.end(), ingest.end(), backup.end()]);
  }
});
