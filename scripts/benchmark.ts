import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { getDatabase } from "../src/lib/db";
import { createCustomer } from "../src/modules/customers/service";
import { createDevice } from "../src/modules/assets/service";
import { createOrganization } from "../src/modules/organizations/service";
import { commissionProject, createMeasurementPoint, createProject, createTopologyVersion, listProjects, replaceBinding } from "../src/modules/projects/persistent";
import { enrollGateway } from "../src/modules/gateways/service";
import { localDateAt, nextLocalDate } from "../src/modules/telemetry/energy";
import { processTelemetryPacket } from "../src/modules/telemetry/processor";
import { getTelemetryProjection } from "../src/modules/telemetry/queries";
import { closeTelemetryStore } from "../src/modules/telemetry/store";
import { simulationUuid } from "../src/modules/telemetry/simulator";
import type { TelemetryMessage, TelemetryPacket, TelemetryTransportContext } from "../src/modules/telemetry/protocol";

interface Phase { packets: number; observations: number; accepted: number; duplicate: number; quarantined: number; durationMs: number; latencyMs: { p50: number; p95: number; p99: number; maximum: number }; throughputEventsPerSecond: number }
const rounded = (value: number) => Number(value.toFixed(3));
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => rounded(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0);
  return { count: sorted.length, minimum: rounded(sorted[0] ?? 0), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), maximum: percentile(1) };
}
function phaseResult(latencies: number[], started: number, counts: { observations: number; accepted: number; duplicate: number; quarantined: number }): Phase {
  const sorted = [...latencies].sort((a, b) => a - b), durationMs = performance.now() - started;
  const percentile = (fraction: number) => rounded(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0);
  return { packets: latencies.length, ...counts, durationMs: rounded(durationMs), latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), maximum: percentile(1) }, throughputEventsPerSecond: rounded(counts.observations * 1000 / durationMs) };
}
interface ProjectFixture { actor: { userId: string; email: string }; organizationId: string; projectId: string; generationId: string; gridId: string; generationMeterId: string; gridMeterId: string; gatewayId: string; context: TelemetryTransportContext }

async function main() {
  const args = process.argv.slice(2), allowed = new Set(["--env-file", "--output"]);
  for (let index = 0; index < args.length; index++) { if (!allowed.has(args[index]) || !args[++index] || args[index].startsWith("--")) throw new Error("Uso: benchmark --env-file archivo-test.json [--output evidencia.json]"); }
  const option = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const envFile = option("--env-file") ?? process.env.TEST_ENV_FILE;
  assert.ok(envFile, "Se requiere un archivo de conexiones de prueba aisladas.");
  const connections = JSON.parse(await readFile(resolve(envFile), "utf8")) as { admin: string; runtime: string; ingest: string };
  for (const value of [connections.admin, connections.runtime, connections.ingest]) { const url = new URL(value); assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "El benchmark solo usa PostgreSQL local."); assert.match(url.pathname, /_test$/, "El benchmark requiere una base de pruebas."); }
  process.env.APP_ENV = "development"; process.env.DATA_ADAPTER = "postgres"; process.env.DEMO_MODE = "false";
  process.env.DATABASE_URL = connections.runtime; process.env.INGEST_DATABASE_URL = connections.ingest;
  const admin = new pg.Pool({ connectionString: connections.admin, max: 2, options: "-c timezone=UTC" });
  const tag = randomUUID().slice(0, 8), organizationIds: string[] = [], actors: Array<{ userId: string; email: string }> = [], fixtures: ProjectFixture[] = [];
  const projectSetup: Array<{ projectNumber: number; projectRecordMs: number; configuredAndCommissionedMs: number; totalServiceProvisioningMs: number }> = [];
  const measurementToReceipt: number[] = [], measurementToAcknowledgement: number[] = [], receiptToAcknowledgement: number[] = [];
  const base = Math.floor(Date.now() / 60000) * 60000 - 65 * 60000;
  const timestamp = (minute: number) => new Date(base + minute * 60000).toISOString();
  try {
    for (let installer = 0; installer < 2; installer++) {
      const actor = { userId: randomUUID(), email: `benchmark-${tag}-${installer}@example.test` }; actors.push(actor);
      await admin.query("INSERT INTO users(id,cognito_subject,email,email_verified,name,updated_at) VALUES($1,$2,$3,true,'Simulated benchmark fixture',now())", [actor.userId, `test:${actor.userId}`, actor.email]);
      const org = await createOrganization(actor, { name: `Instaladora ficticia ${installer}`, slug: `benchmark-${tag}-${installer}`, timezone: "America/Bogota" }); organizationIds.push(org.id);
      const client = await createCustomer(actor, org.id, { name: "Cliente ficticio del ensayo" });
      const organizationFixtures: Omit<ProjectFixture, "gatewayId" | "context">[] = [], meterIds: string[] = [];
      for (let projectIndex = 0; projectIndex < (installer === 0 ? 3 : 2); projectIndex++) {
        const projectStarted = performance.now();
        const project = await createProject(actor, org.id, { name: `Instalación simulada ${installer}-${projectIndex}`, customerId: client.id, location: "Laboratorio local", capacityKwp: 6 });
        const projectCreated = performance.now();
        const generation = await createMeasurementPoint(actor, org.id, project.id, { name: "Generación", kind: "generation", signConvention: "positive_generation" }), grid = await createMeasurementPoint(actor, org.id, project.id, { name: "Red", kind: "grid", signConvention: "positive_import" });
        const genMeter = await createDevice(actor, org.id, { name: "Medidor simulado de generación", kind: "meter", serialNumber: `${tag}-${installer}-${projectIndex}-GEN` }), gridMeter = await createDevice(actor, org.id, { name: "Medidor simulado de red", kind: "meter", serialNumber: `${tag}-${installer}-${projectIndex}-GRID` }); meterIds.push(genMeter.id, gridMeter.id);
        await replaceBinding(actor, org.id, project.id, { deviceId: genMeter.id, measurementPointId: generation.id, validFrom: timestamp(-60), configuration: { channel: "1", multiplier: 1 } });
        await replaceBinding(actor, org.id, project.id, { deviceId: gridMeter.id, measurementPointId: grid.id, validFrom: timestamp(-60), configuration: { channel: "2", multiplier: 1 } });
        await createTopologyVersion(actor, org.id, project.id, { validFrom: timestamp(-60), configuration: { type: "grid_tied_no_battery", generationPointId: generation.id, gridPointId: grid.id, consumptionPointId: null } });
        await commissionProject(actor, org.id, project.id, { commissionedAt: timestamp(-50), notes: "Ensayo ficticio local; sin lectura de hardware." });
        projectSetup.push({ projectNumber: projectSetup.length + 1, projectRecordMs: rounded(projectCreated - projectStarted), configuredAndCommissionedMs: rounded(performance.now() - projectCreated), totalServiceProvisioningMs: rounded(performance.now() - projectStarted) });
        organizationFixtures.push({ actor, organizationId: org.id, projectId: project.id, generationId: generation.id, gridId: grid.id, generationMeterId: genMeter.id, gridMeterId: gridMeter.id });
      }
      const gatewayDevice = await createDevice(actor, org.id, { name: "Gateway simulado", kind: "gateway", serialNumber: `${tag}-${installer}-GW` });
      const gateway = await enrollGateway(actor, org.id, { name: "Replay de laboratorio", source: "simulator", gatewayDeviceId: gatewayDevice.id, principalId: `benchmark-${tag}-${installer}`, meterDeviceIds: meterIds });
      const context = { source: "simulator" as const, clientId: gateway.id, principalId: gateway.principalId, topic: `solar/v2/gateways/${gateway.id}/telemetry`, receivedAt: new Date() };
      fixtures.push(...organizationFixtures.map((fixture) => ({ ...fixture, gatewayId: gateway.id, context })));
    }
    function message(fixture: ProjectFixture, minute: number, generation: boolean): TelemetryMessage {
      return { schema_version: "2.0", event_id: simulationUuid(`${tag}|${fixture.projectId}|${minute}|${generation}`), device_id: generation ? fixture.generationMeterId : fixture.gridMeterId, measurement_point_id: generation ? fixture.generationId : fixture.gridId, configuration_version: 1, measured_at: timestamp(minute),
        values: { active_power: generation ? 2 : 1, import_energy: Number(((generation ? 100 : 50) + minute * (generation ? 2 : 1) / 60).toFixed(6)), export_energy: 0 }, units: { active_power: "kW", import_energy: "kWh", export_energy: "kWh" }, quality: "measured" };
    }
    const packet = (fixture: ProjectFixture, samples: TelemetryMessage[]): TelemetryPacket => ({ schema_version: "2.0", gateway_id: fixture.gatewayId, packet_id: randomUUID(), sent_at: new Date().toISOString(), samples, loss_reports: [] });
    async function phase(jobs: Array<{ fixture: ProjectFixture; packet: TelemetryPacket }>, concurrency: number) {
      const started = performance.now(), latencies: number[] = [], counts = { observations: 0, accepted: 0, duplicate: 0, quarantined: 0 };
      let cursor = 0, completed = 0; const backlog: number[] = [jobs.reduce((sum, job) => sum + job.packet.samples.length, 0)];
      await Promise.all(Array.from({ length: concurrency }, async () => {
        for (;;) {
          const job = jobs[cursor++]; if (!job) return;
          const receivedAt = new Date(), before = performance.now(), result = await processTelemetryPacket(job.packet, { ...job.fixture.context, receivedAt });
          const acknowledgedAt = Date.now();
          if (result.accepted) receiptToAcknowledgement.push(acknowledgedAt - receivedAt.getTime());
          result.results.forEach((event, index) => { if (event.status === "accepted") { const measuredAt = Date.parse(job.packet.samples[index].measured_at); measurementToReceipt.push(receivedAt.getTime() - measuredAt); measurementToAcknowledgement.push(acknowledgedAt - measuredAt); } });
          latencies.push(performance.now() - before); counts.observations += job.packet.samples.length; counts.accepted += result.accepted; counts.duplicate += result.duplicate; counts.quarantined += result.quarantined;
          completed += job.packet.samples.length; backlog.push(backlog[0] - completed);
        }
      }));
      return { ...phaseResult(latencies, started, counts), backlog: { initialObservations: backlog[0], maximumObservations: Math.max(...backlog), finalObservations: backlog.at(-1)!, checkpoints: backlog } };
    }
    const normalJobs = [];
    for (let minute = 0; minute < 10; minute++) for (const fixture of fixtures) normalJobs.push({ fixture, packet: packet(fixture, [message(fixture, minute, true), message(fixture, minute, false)]) });
    const normal = await phase(normalJobs, 1); assert.equal(normal.accepted, 100); assert.equal(normal.quarantined, 0);
    const burstJobs = [];
    for (const organizationId of organizationIds) {
      const orgFixtures = fixtures.filter((fixture) => fixture.organizationId === organizationId), samples = [];
      for (let minute = 10; minute < 60; minute++) for (const fixture of orgFixtures) samples.push(message(fixture, minute, true), message(fixture, minute, false));
      for (let index = 0; index < samples.length; index += 100) burstJobs.push({ fixture: orgFixtures[0], packet: packet(orgFixtures[0], samples.slice(index, index + 100)) });
    }
    const reconnection = await phase(burstJobs, 2); assert.equal(reconnection.accepted, 500); assert.equal(reconnection.quarantined, 0); assert.equal(reconnection.backlog.finalObservations, 0);
    const duplicateReplay = await phase(fixtures.map((fixture) => ({ fixture, packet: packet(fixture, [message(fixture, 20, true), message(fixture, 20, false)]) })), 2); assert.equal(duplicateReplay.duplicate, 10); assert.equal(duplicateReplay.accepted, 0); assert.equal(duplicateReplay.quarantined, 0);
    const continuity = [];
    for (const fixture of fixtures) {
      let generationKwh = 0, consumptionKwh = 0, coveredSeconds = 0;
      const endDate = localDateAt(timestamp(59), "America/Bogota");
      for (let date = localDateAt(timestamp(0), "America/Bogota"); date <= endDate; date = nextLocalDate(date)) {
        const projection = await getTelemetryProjection(fixture.actor, fixture.organizationId, fixture.projectId, { date });
        assert.equal(projection.source, "simulator"); assert.equal(projection.latestMeasuredAt, timestamp(59));
        generationKwh += projection.energy.generationKwh.value ?? 0; consumptionKwh += projection.energy.consumptionKwh.value ?? 0; coveredSeconds += projection.coverage.coveredSeconds;
      }
      assert.ok(Math.abs(generationKwh - 2 * 59 / 60) < 0.00001); assert.ok(Math.abs(consumptionKwh - 3 * 59 / 60) < 0.00001); assert.equal(coveredSeconds, 59 * 60);
      continuity.push({ generationKwh: rounded(generationKwh), consumptionKwh: rounded(consumptionKwh), coveredSeconds, latestDidNotRegress: true });
    }
    assert.equal((await listProjects(actors[0], organizationIds[0])).total, 3); assert.equal((await listProjects(actors[1], organizationIds[1])).total, 2);
    await assert.rejects(getTelemetryProjection(actors[0], organizationIds[1], fixtures.at(-1)!.projectId));
    await assert.rejects(getTelemetryProjection(actors[0], organizationIds[0], fixtures.at(-1)!.projectId));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM telemetry_samples WHERE organization_id=ANY($1::uuid[])", [organizationIds])).rows[0].n, 600);
    const serverIngestionLag = (await admin.query<{ lag: string }>("SELECT (extract(epoch FROM (ingested_at-measured_at))*1000)::text AS lag FROM telemetry_samples WHERE organization_id=ANY($1::uuid[])", [organizationIds])).rows.map((row) => Number(row.lag));
    assert.equal(serverIngestionLag.length, 600); assert.equal(measurementToReceipt.length, 600); assert.ok(serverIngestionLag.every((lag) => Number.isFinite(lag) && lag >= 0));
    const evidence = { generatedAt: new Date().toISOString(), scope: "local_postgresql_simulated", externalServicesUsed: false, environment: { node: process.version, postgres: (await admin.query("SHOW server_version")).rows[0].server_version, platform: process.platform, architecture: process.arch },
      fixture: { fictitiousInstallers: 2, projects: 5, meters: 10, gateways: 2, uniqueObservations: 600, duplicateObservations: 10 }, measurement: { latencyUnit: "milliseconds_per_packet", throughputUnit: "observations_per_second", setupExcluded: true, coldFirstPacketIncluded: true, maximumConcurrentPackets: 2, simulatedReconnectBuffer: true, sourceTimeSpanSeconds: 3540, acceleratedHistoricalReplay: true },
      projectProvisioning: { unit: "milliseconds", mode: "local_server_service_calls", usabilityTiming: false, excludesOrganizationUserAndGatewaySetup: true, projects: projectSetup, totalServiceProvisioningMs: distribution(projectSetup.map((project) => project.totalServiceProvisioningMs)) },
      ingestionDelay: { unit: "milliseconds", interpretation: "historical_simulated_replay_not_network_latency", fieldClockSynchronizationVerified: false, measurementToTrustedReceipt: distribution(measurementToReceipt), measurementToServerIngestion: distribution(serverIngestionLag), measurementToCommitAcknowledgement: distribution(measurementToAcknowledgement), receiptToCommitAcknowledgementPerAcceptedPacket: distribution(receiptToAcknowledgement) },
      phases: { normal, reconnection, duplicateReplay }, continuity: { projectsVerified: continuity.length, allPassed: true, results: continuity }, tenantIsolationVerified: true,
      limits: ["Ensayo de 610 observaciones; percentiles con pocos paquetes, no capacidad productiva.", "Backlog modelado en memoria para reconexión, no métrica real de AWS SQS.", "El atraso medición-recepción/commit procede de timestamps históricos simulados y replay acelerado; no mide NTP ni red de campo.", "El alta por proyecto mide llamadas locales de servicios, no tiempo de uso de interfaz ni puesta en marcha física.", "No incluye red de campo, hardware, despliegue AWS, carga sostenida ni estimación de costes."] };
    const output = resolve(option("--output") ?? "docs/qa/h67-benchmark.json"); await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ benchmark: "local_simulated", observations: 610, accepted: 600, duplicate: 10, quarantined: 0, continuityProjectsPassed: 5, isolation: "verified", output }));
  } finally {
    await closeTelemetryStore(); await getDatabase().$disconnect();
    for (const table of ["telemetry_latest", "telemetry_daily_aggregates", "telemetry_samples", "ingestion_quarantine", "gateway_loss_reports", "gateway_meters", "gateway_identities", "topology_versions", "device_bindings", "measurement_points", "devices", "projects", "customers", "audit_events", "memberships"]) await admin.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`, [organizationIds]);
    await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [organizationIds]); await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [actors.map((actor) => actor.userId)]); await admin.end();
  }
}
main().catch((error: unknown) => { console.error(error instanceof assert.AssertionError ? `Falló la verificación local: ${error.message}` : "El benchmark local no pudo completarse. Revisa la configuración de pruebas."); process.exitCode = 1; });
