import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { getDatabase } from "../src/lib/db";
import { createCustomer } from "../src/modules/customers/service";
import { createDevice } from "../src/modules/assets/service";
import { createOrganization } from "../src/modules/organizations/service";
import { createMeasurementPoint, createProject, createTopologyVersion, replaceBinding } from "../src/modules/projects/persistent";
import { enrollGateway, revokeGateway } from "../src/modules/gateways/service";
import { processTelemetryPacket, type TelemetryPacketResult } from "../src/modules/telemetry/processor";
import { getTelemetryProjection } from "../src/modules/telemetry/queries";
import { closeTelemetryStore, quarantineRaw } from "../src/modules/telemetry/store";
import { collectMeter } from "../src/gateway/runtime";
import { DurableOutbox } from "../src/gateway/outbox";
import { createSqsHandler } from "../src/ingestion/sqs";
import { localDateAt } from "../src/modules/telemetry/energy";
import type { TelemetryPacket } from "../src/modules/telemetry/protocol";

const enabled = Number(process.versions.node.split(".")[0]) === 24 && Boolean(process.env.TEST_RUNTIME_DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL && process.env.TEST_INGEST_DATABASE_URL);
test("local FC04 → SQLite restart → trusted envelope → real PostgreSQL commits, deduplicates and quarantines", { skip: !enabled, timeout: 120000 }, async () => {
  process.env.APP_ENV = "development"; process.env.DATA_ADAPTER = "postgres"; process.env.DEMO_MODE = "false";
  process.env.DATABASE_URL = process.env.TEST_RUNTIME_DATABASE_URL; process.env.INGEST_DATABASE_URL = process.env.TEST_INGEST_DATABASE_URL;
  const admin = new pg.Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL, max: 2, options: "-c timezone=UTC" });
  const actor = { userId: randomUUID(), email: `gateway-${randomUUID()}@example.test` }; const tag = randomUUID().slice(0, 8);
  const directory = await mkdtemp(join(tmpdir(), "solar-pipeline-")); const path = join(directory, "outbox.sqlite");
  const sockets = new Set<Socket>(); let acquisition = 0;
  function floats(...values: number[]) { const data = Buffer.alloc(values.length * 4); values.forEach((value, index) => data.writeFloatBE(value, index * 4)); return data; }
  const server = createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.once("data", (request) => {
      assert.equal(request[7], 4); const address = request.readUInt16BE(8);
      const data = address === 0 ? floats(230, 230, 230, 3, 3, 3, 666, 667, 667) : address === 52 ? floats(2000) : floats(100 + acquisition++ / 30, 0);
      const reply = Buffer.alloc(9 + data.length); request.copy(reply, 0, 0, 4); reply.writeUInt16BE(data.length + 3, 4); reply[6] = request[6]; reply[7] = 4; reply[8] = data.length; data.copy(reply, 9); socket.write(reply);
    });
  });
  let organizationId = ""; let buffer: DurableOutbox | undefined; const malformedId = randomUUID();
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
    await admin.query("INSERT INTO users(id,cognito_subject,email,email_verified,name,updated_at) VALUES($1,$2,$3,true,'Gateway fixture',now())", [actor.userId, `test:${actor.userId}`, actor.email]);
    const org = await createOrganization(actor, { name: `Gateway ${tag}`, slug: `gateway-${tag}`, timezone: "America/Bogota" }); organizationId = org.id;
    const customer = await createCustomer(actor, org.id, { name: "Cliente piloto local" });
    const project = await createProject(actor, org.id, { name: "Pipeline local", customerId: customer.id, location: "Yopal", capacityKwp: 6 });
    const point = await createMeasurementPoint(actor, org.id, project.id, { name: "Generación", kind: "generation", signConvention: "positive_generation" });
    const gridPoint = await createMeasurementPoint(actor, org.id, project.id, { name: "Red pendiente", kind: "grid", signConvention: "positive_import" });
    await createTopologyVersion(actor, org.id, project.id, { validFrom: new Date(Date.now() - 3600000).toISOString(), configuration: { type: "grid_tied_no_battery", generationPointId: point.id, gridPointId: gridPoint.id, consumptionPointId: null } });
    const device = await createDevice(actor, org.id, { name: "Medidor FC04 fixture", kind: "meter", serialNumber: `${tag}-METER` });
    const binding = await replaceBinding(actor, org.id, project.id, { deviceId: device.id, measurementPointId: point.id, validFrom: new Date(Date.now() - 3600000).toISOString(), configuration: { channel: "1", multiplier: 1 } });
    const gatewayDevice = await createDevice(actor, org.id, { name: "Gateway fixture", kind: "gateway", serialNumber: `${tag}-GW` });
    // Explicit database/test fixture, not an application route or TLS authentication claim.
    const principal = createHash("sha256").update(randomUUID()).digest("hex");
    const gateway = await enrollGateway(actor, org.id, { name: "AWS envelope local fixture", source: "aws_iot", gatewayDeviceId: gatewayDevice.id, principalId: principal, meterDeviceIds: [device.id] });
    const meter = { model: "SDM630MCT-v1.7" as const, deviceId: device.id, measurementPointId: point.id, configurationVersion: binding.configurationVersion, host: "127.0.0.1", port: address.port, unitId: 1, wordOrder: "high-first" as const, powerSign: 1 as const };
    const observedAt = Date.now() - 30000;
    buffer = new DurableOutbox(path, { maxSamples: 2, maxBytes: 10000 });
    for (let index = 0; index < 3; index++) buffer.enqueue(await collectMeter(meter, undefined, () => new Date(observedAt - (2 - index) * 60000)));
    const packet = buffer.prepare(gateway.id)!; assert.equal(packet.samples.length, 2); assert.equal(packet.loss_reports[0].dropped, 1); assert.equal(packet.loss_reports[0].from, packet.loss_reports[0].to);
    buffer.close(); buffer = new DurableOutbox(path, { maxSamples: 2, maxBytes: 10000 }); assert.deepEqual(buffer.prepare(gateway.id), packet);
    const queueArn = "arn:aws:sqs:us-east-1:123456789012:local-pilot";
    const envelope = (payload: TelemetryPacket) => JSON.stringify({ source: "aws_iot", principal, client_id: gateway.id, topic: `solar/v2/gateways/${gateway.id}/telemetry`, received_at_ms: Date.now(), payload_base64: Buffer.from(JSON.stringify(payload)).toString("base64") });
    const sqsRecord = (body: string, messageId = randomUUID()) => ({ messageId, body, eventSource: "aws:sqs", eventSourceARN: queueArn });
    const results: TelemetryPacketResult[] = [];
    const handler = createSqsHandler({ queueArn, processPacket: async (payload, context) => { const result = await processTelemetryPacket(payload, context); results.push(result); return result; }, quarantine: quarantineRaw });
    assert.deepEqual(await handler({ Records: [sqsRecord(envelope(packet)), sqsRecord(envelope(packet)), sqsRecord("invalid-json", malformedId)] }), { batchItemFailures: [] });
    assert.equal(results[0].accepted, 2); assert.equal(results[0].lossReportsRecorded, 1); assert.equal(results[1].duplicate, 2); assert.equal(results[1].lossReportsRecorded, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM telemetry_samples WHERE organization_id=$1", [org.id])).rows[0].n, 2);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM gateway_loss_reports WHERE organization_id=$1", [org.id])).rows[0].n, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM ingestion_quarantine WHERE message_id=$1", [malformedId])).rows[0].n, 1);
    buffer.acknowledge(packet.packet_id); assert.equal(buffer.prepare(gateway.id), null);
    const projection = await getTelemetryProjection(actor, org.id, project.id, { date: localDateAt(new Date(observedAt), org.timezone) });
    assert.equal(projection.source, "aws_iot"); assert.equal(projection.latestMeasuredAt, new Date(observedAt).toISOString()); assert.equal(projection.power.generationKw.value, 2);
    assert.equal(projection.power.consumptionKw.value, null);
    // Project balance shares a common interval; the absent grid does not imply zero.
    assert.equal(projection.energy.consumptionKwh.value, null);
    const daily = (await admin.query("SELECT quality,import_energy_kwh FROM telemetry_daily_aggregates WHERE measurement_point_id=$1", [point.id])).rows[0];
    assert.equal(daily.quality, "measured"); assert.ok(Number(daily.import_energy_kwh) > 0);
    await revokeGateway(actor, org.id, gateway.id, { status: "revoked" });
    const blocked = { ...packet, packet_id: randomUUID(), loss_reports: [], samples: [{ ...packet.samples[0], event_id: randomUUID(), measured_at: new Date(observedAt + 1000).toISOString() }] };
    assert.deepEqual(await handler({ Records: [sqsRecord(envelope(blocked))] }), { batchItemFailures: [] }); assert.equal(results[2].quarantined, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM telemetry_samples WHERE organization_id=$1", [org.id])).rows[0].n, 2);
  } finally {
    buffer?.close(); sockets.forEach((socket) => socket.destroy()); await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTelemetryStore(); await getDatabase().$disconnect();
    await admin.query("DELETE FROM ingestion_quarantine WHERE message_id=$1", [malformedId]);
    if (organizationId) {
      for (const table of ["telemetry_latest", "telemetry_daily_aggregates", "telemetry_samples", "ingestion_quarantine", "gateway_loss_reports", "gateway_meters", "gateway_identities", "site_access", "topology_versions", "device_bindings", "measurement_points", "devices", "projects", "customers", "audit_events", "memberships"]) await admin.query(`DELETE FROM ${table} WHERE organization_id=$1`, [organizationId]);
      await admin.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    }
    await admin.query("DELETE FROM users WHERE id=$1", [actor.userId]); await admin.end(); await rm(directory, { recursive: true, force: true });
  }
});
