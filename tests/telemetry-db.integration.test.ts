import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { closeTelemetryStore, quarantineRaw, withTelemetryStore, type NormalizedTelemetryInput, type SourceContext } from "../src/modules/telemetry/store";
import { withTenant } from "../src/lib/tenant";
import { getDatabase } from "../src/lib/db";

const enabled = Boolean(process.env.SOLAR_DATABASE_TEST_ENV || process.env.TEST_ADMIN_DATABASE_URL);
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

test("ingesta PostgreSQL: registro, procedencia, idempotencia, aislamiento y persistencia atómica", { skip: !enabled }, async (t) => {
  const env: { admin: string; runtime: string; ingest: string } = process.env.SOLAR_DATABASE_TEST_ENV
    ? JSON.parse(await readFile(process.env.SOLAR_DATABASE_TEST_ENV, "utf8"))
    : { admin: process.env.TEST_ADMIN_DATABASE_URL!, runtime: process.env.TEST_RUNTIME_DATABASE_URL!, ingest: process.env.TEST_INGEST_DATABASE_URL! };
  assert.ok(env.ingest, "La integración requiere credenciales locales solar_ingest separadas.");
  process.env.APP_ENV = "development"; process.env.DATA_ADAPTER = "postgres"; process.env.DEMO_MODE = "false";
  process.env.DATABASE_URL = env.runtime; process.env.INGEST_DATABASE_URL = env.ingest;
  const admin = new pg.Client({ connectionString: env.admin });
  const ingest = new pg.Client({ connectionString: env.ingest });
  const runtime = new pg.Client({ connectionString: env.runtime });
  await Promise.all([admin.connect(), ingest.connect(), runtime.connect()]);
  const ids = Object.fromEntries(["orgA", "orgB", "ownerA", "ownerB", "customerA", "clientA", "clientB", "projectA", "projectB", "pointA", "pointB", "gatewayDevice", "gateway", "oldMeter", "newMeter", "foreignMeter", "oldBinding", "newBinding", "foreignBinding"].map((name) => [name, randomUUID()]));
  const instant = Date.now(); const at = (minutesAgo: number) => new Date(instant - minutesAgo * 60_000).toISOString();
  const envelope: SourceContext = { source: "simulator", clientId: ids.gateway, principalId: `local-${ids.gateway}`, expectedGatewayId: ids.gateway, topic: `solar/v2/gateways/${ids.gateway}/telemetry`, receivedAt: at(0) };
  const payload = (overrides: Partial<NormalizedTelemetryInput> = {}): NormalizedTelemetryInput => ({ schemaVersion: "2.0", eventId: randomUUID(), deviceId: ids.newMeter, measurementPointId: ids.pointA, configurationVersion: 2, measuredAt: at(10), activePower: 3, importEnergy: 5, exportEnergy: 0, quality: "measured", ...overrides });
  const accept = (event: NormalizedTelemetryInput, context = envelope) => withTelemetryStore((tx) => tx.acceptEvent(context, event, digest(event)));
  try {
    for (const name of ["ownerA", "ownerB", "customerA"]) await admin.query("INSERT INTO users(id,cognito_subject,email,email_verified,updated_at) VALUES($1,$2,$3,true,now())", [ids[name], `telemetry|${ids[name]}`, `${ids[name]}@example.test`]);
    for (const [org, owner, customer, project, point] of [["orgA", "ownerA", "clientA", "projectA", "pointA"], ["orgB", "ownerB", "clientB", "projectB", "pointB"]]) {
      await admin.query("INSERT INTO organizations(id,name,slug,updated_at) VALUES($1::uuid,$1::text,$1::text,now())", [ids[org]]);
      await admin.query("INSERT INTO memberships(id,organization_id,user_id,role,status,updated_at) VALUES($1,$2,$3,'owner','active',now())", [randomUUID(), ids[org], ids[owner]]);
      await admin.query("INSERT INTO customers(id,organization_id,name,updated_at) VALUES($1,$2,'Prueba',now())", [ids[customer], ids[org]]);
      await admin.query("INSERT INTO projects(id,organization_id,customer_id,name,location,capacity_kwp,updated_at) VALUES($1,$2,$3,'Telemetría','Yopal',5,now())", [ids[project], ids[org], ids[customer]]);
      await admin.query("INSERT INTO measurement_points(id,organization_id,project_id,name,kind,sign_convention) VALUES($1,$2,$3,'Generación','generation','positive_generation')", [ids[point], ids[org], ids[project]]);
    }
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,role,status,updated_at) VALUES($1,$2,$3,'customer','active',now())", [randomUUID(), ids.orgA, ids.customerA]);
    await admin.query("INSERT INTO site_access(id,organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4,'customer')", [randomUUID(), ids.orgA, ids.projectA, ids.customerA]);
    for (const [device, org, kind] of [["gatewayDevice", "orgA", "gateway"], ["oldMeter", "orgA", "meter"], ["newMeter", "orgA", "meter"], ["foreignMeter", "orgB", "meter"]]) await admin.query("INSERT INTO devices(id,organization_id,serial,name,kind,updated_at) VALUES($1::uuid,$2::uuid,$1::text,$1::text,$3,now())", [ids[device], ids[org], kind]);
    for (const [binding, meter, version, from, to] of [["oldBinding", "oldMeter", 1, at(120), at(30)], ["newBinding", "newMeter", 2, at(30), null]] as const) await admin.query("INSERT INTO device_bindings(id,organization_id,project_id,device_id,measurement_point_id,configuration_version,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [ids[binding], ids.orgA, ids.projectA, ids[meter], ids.pointA, version, from, to]);
    await admin.query("UPDATE devices SET status='retired' WHERE id=$1", [ids.oldMeter]);
    await admin.query("INSERT INTO gateway_identities(id,organization_id,gateway_device_id,name,source,client_id,principal_id) VALUES($1,$2,$3,'Simulador local','simulator',$5,$4)", [ids.gateway, ids.orgA, ids.gatewayDevice, envelope.principalId, ids.gateway]);
    for (const meter of [ids.oldMeter, ids.newMeter]) await admin.query("INSERT INTO gateway_meters(organization_id,gateway_identity_id,meter_device_id) VALUES($1,$2,$3)", [ids.orgA, ids.gateway, meter]);

    await t.test("rol separado no tiene tablas ni puede ejecutar helpers privilegiados", async () => {
      await assert.rejects(ingest.query("SELECT * FROM telemetry_samples"), (error: unknown) => (error as { code: string }).code === "42501");
      await assert.rejects(ingest.query("SET ROLE solar_security_guard"), (error: unknown) => (error as { code: string }).code === "42501");
      await assert.rejects(runtime.query("SELECT public.ingest_accept_event('{}','{}',$1)", [digest({})]), (error: unknown) => (error as { code: string }).code === "42501");
      await assert.rejects(withTelemetryStore((tx) => tx.loadProjectContext(ids.projectA)), (error: unknown) => (error as { code: string }).code === "42501");
    });
    const newest = payload();
    await t.test("muestra y agregado se confirman juntos, con origen y registro resueltos", async () => {
      const result = await withTelemetryStore(async (tx) => {
        const accepted = await tx.acceptEvent(envelope, newest, digest(newest));
        assert.equal(accepted.status, "accepted");
        const context = await tx.loadProjectContext(ids.projectA, new Date(at(180)), new Date(at(-1)));
        assert.equal(context.timezone, "America/Bogota"); assert.equal(context.samples.length, 1);
        assert.equal(context.samples[0].measuredAt.toISOString(), newest.measuredAt);
        assert.equal(context.samples[0].source, "simulator"); assert.equal(context.samples[0].bindingId, ids.newBinding);
        const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(newest.measuredAt));
        await tx.saveDailyAggregates(ids.projectA, [{ localDate, measurementPointId: ids.pointA, importEnergyKwh: null, exportEnergyKwh: null, integratedPositiveKwh: null, integratedNegativeKwh: null, sampleCount: 1, gapCount: 0, resetCount: 0, quality: "missing", detailJson: { coverageSeconds: 0, source: "simulator" } }]);
        return accepted;
      });
      assert.equal(result.status, "accepted");
      const { rows: [row] } = await admin.query("SELECT organization_id,gateway_identity_id,source,payload_hash FROM telemetry_samples WHERE event_id=$1", [newest.eventId]);
      assert.equal(row.organization_id, ids.orgA); assert.equal(row.gateway_identity_id, ids.gateway); assert.equal(row.source, "simulator"); assert.match(row.payload_hash, /^[a-f0-9]{64}$/);
      assert.equal((await admin.query("SELECT * FROM telemetry_daily_aggregates WHERE organization_id=$1", [ids.orgA])).rowCount, 1);
    });
    await t.test("duplicados no suman dos veces; conflicto de UUID o instante queda en cuarentena", async () => {
      assert.equal((await accept(newest)).status, "duplicate");
      assert.equal((await accept({ ...newest, eventId: randomUUID() })).status, "duplicate");
      const changedUuid = await accept({ ...newest, activePower: 4 });
      assert.equal(changedUuid.status, "quarantined"); if (changedUuid.status === "quarantined") assert.equal(changedUuid.reason, "event_id_conflict");
      const changedTimestamp = await accept({ ...newest, eventId: randomUUID(), activePower: 4 });
      assert.equal(changedTimestamp.status, "quarantined"); if (changedTimestamp.status === "quarantined") assert.equal(changedTimestamp.reason, "timestamp_conflict");
      assert.equal((await admin.query("SELECT * FROM telemetry_samples WHERE organization_id=$1", [ids.orgA])).rowCount, 1);
    });
    await t.test("lectura atrasada del equipo retirado conserva versión e histórico y no retrasa latest", async () => {
      const delayed = payload({ deviceId: ids.oldMeter, configurationVersion: 1, measuredAt: at(45), importEnergy: 100 });
      assert.equal((await accept(delayed)).status, "accepted");
      assert.equal((await admin.query("SELECT event_id FROM telemetry_latest WHERE measurement_point_id=$1", [ids.pointA])).rows[0].event_id, newest.eventId);
      assert.equal((await admin.query("SELECT binding_id FROM telemetry_samples WHERE event_id=$1", [delayed.eventId])).rows[0].binding_id, ids.oldBinding);
      await withTelemetryStore(async (tx) => {
        await tx.acceptEvent(envelope, newest, digest(newest));
        const between = await tx.loadProjectContext(ids.projectA, new Date(at(25)), new Date(at(20)));
        assert.deepEqual(between.samples.map((sample) => sample.eventId), [delayed.eventId, newest.eventId]);
        assert.equal(between.bindings.length, 2, "los vecinos traen sus versiones históricas fuera de la ventana");
      });
      assert.equal((await accept(payload({ deviceId: ids.oldMeter, configurationVersion: 1, measuredAt: at(5) }))).status, "quarantined");
    });
    await t.test("gateway, principal, topic, medidor y ámbito nunca proceden del payload", async () => {
      for (const context of [{ ...envelope, principalId: "wrong-principal" }, { ...envelope, topic: `solar/v2/gateways/${randomUUID()}/telemetry` }, { ...envelope, expectedGatewayId: randomUUID() }]) assert.equal((await accept(payload({ measuredAt: at(11) }), context)).status, "quarantined");
      assert.equal((await accept(payload({ deviceId: ids.foreignMeter, measurementPointId: ids.pointB }))).status, "quarantined");
      assert.equal((await accept({ ...payload(), organizationId: ids.orgB } as NormalizedTelemetryInput)).status, "quarantined");
      assert.equal((await accept(payload({ measuredAt: at(-10) }))).status, "quarantined");
      assert.equal((await accept(payload({ measuredAt: at(31 * 24 * 60) }))).status, "quarantined");
    });
    await t.test("rollback de procesamiento elimina muestra/latest junto con los derivados", async () => {
      const event = payload({ measuredAt: at(1) });
      await assert.rejects(withTelemetryStore(async (tx) => { assert.equal((await tx.acceptEvent(envelope, event, digest(event))).status, "accepted"); throw new Error("fallo calculador de prueba"); }));
      assert.equal((await admin.query("SELECT * FROM telemetry_samples WHERE event_id=$1", [event.eventId])).rowCount, 0);
      assert.equal((await admin.query("SELECT event_id FROM telemetry_latest WHERE measurement_point_id=$1", [ids.pointA])).rows[0].event_id, newest.eventId);
      await closeTelemetryStore();
      assert.equal((await accept(newest)).status, "duplicate");
    });
    await t.test("RLS de latest/agregados/cuarentena limita empresas y proyectos asignados", async () => {
      await withTenant({ userId: ids.customerA }, ids.orgA, async (tx) => { assert.equal(await tx.telemetryLatest.count(), 1); assert.equal(await tx.telemetryDailyAggregate.count(), 1); assert.equal(await tx.ingestionQuarantine.count(), 0); });
      await withTenant({ userId: ids.ownerB }, ids.orgB, async (tx) => { assert.equal(await tx.telemetrySample.count(), 0); assert.equal(await tx.telemetryLatest.count(), 0); assert.equal(await tx.telemetryDailyAggregate.count(), 0); assert.equal(await tx.gatewayIdentity.count(), 0); });
    });
    await t.test("pérdidas explícitas y cuarentena cruda son durables e idempotentes", async () => {
      const report = { reportId: randomUUID(), from: at(100), to: at(90), dropped: 8, reason: "buffer_capacity" as const };
      assert.equal(await withTelemetryStore((tx) => tx.recordLossReports(envelope, [report])), 1);
      assert.equal(await withTelemetryStore((tx) => tx.recordLossReports(envelope, [report])), 0);
      assert.equal(await withTelemetryStore((tx) => tx.recordLossReports(envelope, [{ ...report, dropped: 9 }])), 0);
      assert.equal(await withTelemetryStore((tx) => tx.recordLossReports(envelope, [{ ...report, reportId: randomUUID(), to: report.from, dropped: 1 }])), 1);
      assert.equal(await withTelemetryStore((tx) => tx.recordLossReports({ ...envelope, principalId: "forged" }, [report])), 0);
      const invalid = { messageId: `test-${randomUUID()}`, bodyHash: digest("invalid"), reason: "invalid_json", rawBody: "{invalid", receiptContext: { source: "test" } };
      const first = await quarantineRaw(invalid); assert.equal(await quarantineRaw(invalid), first);
      await admin.query("DELETE FROM ingestion_quarantine WHERE id=$1", [first]);
    });
    await t.test("revocación bloquea próximos envíos y producción rechaza la conexión de prueba sin TLS", async () => {
      process.env.APP_ENV = "production";
      try { await assert.rejects(accept(payload({ measuredAt: at(2) })), /TLS verify-full/); }
      finally { process.env.APP_ENV = "development"; }
      await admin.query("UPDATE gateway_identities SET status='revoked',revoked_at=now() WHERE id=$1", [ids.gateway]);
      assert.equal((await accept(payload({ measuredAt: at(2) }))).status, "quarantined");
      await assert.rejects(admin.query("UPDATE gateway_identities SET status='active',revoked_at=NULL WHERE id=$1", [ids.gateway]));
    });
  } finally {
    await closeTelemetryStore(); await getDatabase().$disconnect();
    await admin.query("DELETE FROM ingestion_quarantine WHERE receipt_context->>'clientId'=$1", [ids.gateway]);
    for (const table of ["telemetry_latest", "telemetry_daily_aggregates", "telemetry_samples", "gateway_loss_reports", "ingestion_quarantine", "gateway_meters", "gateway_identities", "site_access", "device_bindings", "measurement_points", "devices", "projects", "customers", "memberships"]) await admin.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`, [[ids.orgA, ids.orgB]]);
    await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [[ids.orgA, ids.orgB]]);
    await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ids.ownerA, ids.ownerB, ids.customerA]]);
    await Promise.all([admin.end(), ingest.end(), runtime.end()]);
  }
});


