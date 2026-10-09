import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { getDatabase } from "../src/lib/db";
import { createCustomer } from "../src/modules/customers/service";
import { createDevice } from "../src/modules/assets/service";
import { createOrganization } from "../src/modules/organizations/service";
import { createMeasurementPoint, createProject, createTopologyVersion, replaceBinding } from "../src/modules/projects/persistent";
import { enrollGateway } from "../src/modules/gateways/service";
import { createTelemetryProcessor, processTelemetryPacket } from "../src/modules/telemetry/processor";
import { getTelemetryProjection, getPortfolioTelemetry } from "../src/modules/telemetry/queries";
import { closeTelemetryStore, withTelemetryStore } from "../src/modules/telemetry/store";
import { localDateAt, localDayWindow } from "../src/modules/telemetry/energy";
import type { TelemetryMessage, TelemetryPacket } from "../src/modules/telemetry/protocol";

const enabled = Boolean(process.env.TEST_RUNTIME_DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL && process.env.TEST_INGEST_DATABASE_URL);
test("telemetry commits samples, monotonic latest and recomputed days atomically across projects, replacements and replays", { skip: !enabled, timeout: 120000 }, async () => {
  process.env.APP_ENV = "development"; process.env.DATA_ADAPTER = "postgres"; process.env.DEMO_MODE = "false";
  process.env.DATABASE_URL = process.env.TEST_RUNTIME_DATABASE_URL; process.env.INGEST_DATABASE_URL = process.env.TEST_INGEST_DATABASE_URL;
  const admin = new pg.Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL, max: 2, options: "-c timezone=UTC" });
  const tag = randomUUID().slice(0, 8), actor = { userId: randomUUID(), email: `telemetry-${tag}@example.test` };
  const temporaryFiles: string[] = [];
  let organizationId = "";
  let now = Math.floor(Date.now() / 60000) * 60000 - 5 * 60000;
  if (localDateAt(now - 10 * 60000, "America/Bogota") !== localDateAt(now + 3 * 60000, "America/Bogota")) now -= 30 * 60000;
  const at = (minutes: number) => new Date(now + minutes * 60000).toISOString();
  try {
    await admin.query("INSERT INTO users(id,cognito_subject,email,email_verified,name,updated_at) VALUES($1,$2,$3,true,'Telemetry fixture',now())", [actor.userId, `test:${actor.userId}`, actor.email]);
    const org = await createOrganization(actor, { name: `Telemetría ${tag}`, slug: `telemetry-${tag}`, timezone: "America/Bogota" }); organizationId = org.id;
    const customer = await createCustomer(actor, org.id, { name: "Cliente de prueba" });
    const projects: Array<{ project: { id: string }; generation: { id: string }; grid: { id: string }; genDevice: { id: string }; gridDevice: { id: string }; genBinding: { id: string }; gridBinding: { id: string } }> = [];
    const devices = [];
    for (let number = 0; number < 2; number++) {
      const project = await createProject(actor, org.id, { name: `Proyecto ${number}`, customerId: customer.id, location: "Yopal", capacityKwp: 6 });
      const generation = await createMeasurementPoint(actor, org.id, project.id, { name: "Generación", kind: "generation", signConvention: "positive_generation" });
      const grid = await createMeasurementPoint(actor, org.id, project.id, { name: "Red", kind: "grid", signConvention: "positive_import" });
      const genDevice = await createDevice(actor, org.id, { name: "Medidor generación", kind: "meter", serialNumber: `${tag}-${number}-GEN` });
      const gridDevice = await createDevice(actor, org.id, { name: "Medidor red", kind: "meter", serialNumber: `${tag}-${number}-GRID` });
      const genBinding = await replaceBinding(actor, org.id, project.id, { deviceId: genDevice.id, measurementPointId: generation.id, validFrom: at(-4320), configuration: { channel: "1", multiplier: 1 } });
      const gridBinding = await replaceBinding(actor, org.id, project.id, { deviceId: gridDevice.id, measurementPointId: grid.id, validFrom: at(-4320), configuration: { channel: "2", multiplier: 1 } });
      await createTopologyVersion(actor, org.id, project.id, { validFrom: at(-4320), configuration: { type: "grid_tied_no_battery", generationPointId: generation.id, gridPointId: grid.id, consumptionPointId: null } });
      projects.push({ project, generation, grid, genDevice, gridDevice, genBinding, gridBinding }); devices.push(genDevice.id, gridDevice.id);
    }
    const replacement = await createDevice(actor, org.id, { name: "Reemplazo generación", kind: "meter", serialNumber: `${tag}-REPLACE` }); devices.push(replacement.id);
    const gatewayDevice = await createDevice(actor, org.id, { name: "Gateway", kind: "gateway", serialNumber: `${tag}-GW` });
    const gateway = await enrollGateway(actor, org.id, { name: "Simulador integración", source: "simulator", gatewayDeviceId: gatewayDevice.id, principalId: `local-${tag}`, meterDeviceIds: devices });
    const context = { source: "simulator" as const, clientId: gateway.id, principalId: gateway.principalId, topic: `solar/v2/gateways/${gateway.id}/telemetry`, receivedAt: new Date() };
    function message(index: number, kind: "generation" | "grid", minute: number, counters = false): TelemetryMessage {
      const fixture = projects[index], point = kind === "generation" ? fixture.generation : fixture.grid, device = kind === "generation" ? fixture.genDevice : fixture.gridDevice;
      return { schema_version: "2.0", event_id: randomUUID(), device_id: device.id, measurement_point_id: point.id, configuration_version: 1, measured_at: at(minute),
        values: { active_power: kind === "generation" ? 2 : 1, import_energy: counters ? 100 + (minute + 10) * (kind === "generation" ? 2 : 1) / 60 : null, export_energy: counters ? 0 : null },
        units: { active_power: "kW", import_energy: "kWh", export_energy: "kWh" }, quality: "measured" };
    }
    const packet = (samples: TelemetryMessage[], reports: TelemetryPacket["loss_reports"] = []): TelemetryPacket => ({ schema_version: "2.0", gateway_id: gateway.id, packet_id: randomUUID(), sent_at: new Date().toISOString(), samples, loss_reports: reports });
    const initial = [message(0, "generation", -10), message(0, "grid", -10), message(0, "generation", 0), message(0, "grid", 0), message(1, "generation", -10, true), message(1, "grid", -10, true), message(1, "generation", 0, true), message(1, "grid", 0, true)];
    const loss = { report_id: randomUUID(), from: at(-30), to: at(-25), dropped: 3, reason: "buffer_capacity" as const };
    const first = await processTelemetryPacket(packet(initial, [loss]), context);
    assert.equal(first.accepted, 8); assert.equal(first.lossReportsRecorded, 1);
    const date = localDateAt(at(0), "America/Bogota");
    const beforeLate = await getTelemetryProjection(actor, org.id, projects[0].project.id, { date });
    assert.equal(beforeLate.energy.generationKwh.value, null); assert.equal(beforeLate.latestMeasuredAt, at(0));
    const measured = await getTelemetryProjection(actor, org.id, projects[1].project.id, { date });
    assert.equal(measured.energy.generationKwh.quality, "measured");
    assert.ok(Math.abs(measured.energy.consumptionKwh.value! - 0.5) < 1e-6);
    const late = packet([message(0, "generation", -5), message(0, "grid", -5)]);
    const races = await Promise.all([processTelemetryPacket(late, context), processTelemetryPacket(late, context)]);
    assert.equal(races.reduce((total, result) => total + result.accepted, 0), 2); assert.equal(races.reduce((total, result) => total + result.duplicate, 0), 2);
    const afterLate = await getTelemetryProjection(actor, org.id, projects[0].project.id, { date });
    assert.equal(afterLate.latestMeasuredAt, at(0)); assert.equal(afterLate.energy.consumptionKwh.quality, "estimated");
    assert.ok(Math.abs(afterLate.energy.consumptionKwh.value! - 0.5) < 1e-6); assert.equal(afterLate.coverage.coveredSeconds, 600);
    assert.equal(afterLate.daySource, "simulator"); assert.equal(afterLate.series.length, 288);
    assert.equal((await getPortfolioTelemetry(actor, org.id))[projects[0].project.id].latestMeasuredAt, at(0));
    const derivedBefore = await admin.query("SELECT updated_at FROM telemetry_daily_aggregates WHERE project_id=$1 ORDER BY measurement_point_id,local_date", [projects[0].project.id]);
    const replay = await processTelemetryPacket(packet(initial, [loss]), context);
    assert.equal(replay.duplicate, 8); assert.equal(replay.lossReportsRecorded, 0);
    assert.deepEqual((await admin.query("SELECT updated_at FROM telemetry_daily_aggregates WHERE project_id=$1 ORDER BY measurement_point_id,local_date", [projects[0].project.id])).rows, derivedBefore.rows);
    const semantic = { ...initial[0], event_id: randomUUID() };
    assert.equal((await processTelemetryPacket(packet([semantic]), context)).duplicate, 1);
    const conflict = { ...initial[0], event_id: randomUUID(), values: { ...initial[0].values, active_power: 999 } };
    assert.equal((await processTelemetryPacket(packet([conflict]), context)).quarantined, 1);
    const atomic = message(0, "generation", 1);
    const failing = createTelemetryProcessor(async (callback) => withTelemetryStore(async (store) => { await callback(store); throw new Error("intentional derived failure"); }));
    await assert.rejects(failing.processTelemetryPacket(packet([atomic]), context), /intentional derived failure/);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM telemetry_samples WHERE event_id=$1", [atomic.event_id])).rows[0].n, 0);
    assert.equal((await getTelemetryProjection(actor, org.id, projects[0].project.id, { date })).latestMeasuredAt, at(0));
    const newBinding = await replaceBinding(actor, org.id, projects[0].project.id, { deviceId: replacement.id, measurementPointId: projects[0].generation.id, validFrom: at(1), configuration: { channel: "1", multiplier: 1 } });
    const newGen = [2, 3].map((minute) => ({ ...message(0, "generation", minute), device_id: replacement.id, configuration_version: newBinding.configurationVersion, values: { active_power: 2, import_energy: minute === 2 ? 0 : 2 / 60, export_energy: 0 } }));
    await processTelemetryPacket(packet([...newGen, message(0, "grid", 2), message(0, "grid", 3)]), context);
    const changed = await getTelemetryProjection(actor, org.id, projects[0].project.id, { date });
    assert.equal(changed.latestMeasuredAt, at(3)); assert.ok(changed.coverage.gapCount >= 1);
    assert.equal((await admin.query("SELECT binding_id FROM telemetry_samples WHERE event_id=$1", [initial[0].event_id])).rows[0].binding_id, projects[0].genBinding.id);
    assert.equal((await processTelemetryPacket(packet([{ ...message(0, "generation", 4), configuration_version: 1 }]), context)).quarantined, 1);
    const persistedEnergy = changed.energy.consumptionKwh.value;
    await closeTelemetryStore(); await getDatabase().$disconnect();
    assert.equal((await getTelemetryProjection(actor, org.id, projects[0].project.id, { date })).energy.consumptionKwh.value, persistedEnergy);

    // A sparse old interval crosses midnight; neighbours outside each loaded day
    // must preserve both affected days rather than erase a valid counter delta.
    const midnight = localDayWindow(localDateAt(now - 86400000, "America/Bogota"), "America/Bogota").from.getTime();
    const beforeMidnight = (midnight - 120000 - now) / 60000, afterMidnight = (midnight + 120000 - now) / 60000;
    assert.equal((await processTelemetryPacket(packet([message(1, "generation", beforeMidnight, true), message(1, "grid", beforeMidnight, true), message(1, "generation", afterMidnight, true), message(1, "grid", afterMidnight, true)]), context)).accepted, 4);
    const previousDate = localDateAt(midnight - 120000, "America/Bogota");
    const previousDay = await getTelemetryProjection(actor, org.id, projects[1].project.id, { date: previousDate });
    assert.equal(previousDay.coverage.coveredSeconds, 120);
    assert.equal(previousDay.energy.consumptionKwh.quality, "estimated");
    assert.ok(Math.abs(previousDay.energy.consumptionKwh.value! - 0.1) < 0.00001);

    // Run the actual CLI twice in fresh processes against the same registered
    // gateway. Exported JSONL and event IDs survive restart; the replay is inert.
    await mkdir(resolve(".work"), { recursive: true });
    const configFile = resolve(`.work/telemetry-cli-${tag}.json`), outputOne = resolve(`.work/telemetry-cli-${tag}-one.jsonl`), outputTwo = resolve(`.work/telemetry-cli-${tag}-two.jsonl`);
    temporaryFiles.push(configFile, outputOne, outputTwo);
    await writeFile(configFile, JSON.stringify({ gatewayId: gateway.id, principalId: gateway.principalId, timezone: "America/Bogota", seed: tag, from: at(-90), to: at(-80), intervalSeconds: 60,
      meters: [{ deviceId: projects[1].genDevice.id, measurementPointId: projects[1].generation.id, configurationVersion: 1, kind: "generation" }, { deviceId: projects[1].gridDevice.id, measurementPointId: projects[1].grid.id, configurationVersion: 1, kind: "grid" }] }));
    for (const [output, replayed] of [[outputOne, false], [outputTwo, true]] as const) {
      const child = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/simulate.ts", "--config", configFile, "--output", output, "--ingest"], { env: process.env, encoding: "utf8", timeout: 30000 });
      assert.equal(child.status, 0, child.stderr);
      const summary = JSON.parse(child.stdout.trim());
      assert.equal(summary[replayed ? "duplicate" : "accepted"], 22); assert.equal(summary.quarantined, 0);
    }
    assert.equal(await readFile(outputOne, "utf8"), await readFile(outputTwo, "utf8"));
  } finally {
    await closeTelemetryStore(); await getDatabase().$disconnect();
    if (organizationId) {
      for (const table of ["telemetry_latest", "telemetry_daily_aggregates", "telemetry_samples", "ingestion_quarantine", "gateway_loss_reports", "gateway_meters", "gateway_identities", "site_access", "topology_versions", "device_bindings", "measurement_points", "devices", "projects", "customers", "audit_events", "memberships"]) await admin.query(`DELETE FROM ${table} WHERE organization_id=$1`, [organizationId]);
      await admin.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    }
    await admin.query("DELETE FROM users WHERE id=$1", [actor.userId]); await admin.end();
    for (const path of temporaryFiles) await unlink(path).catch(() => undefined);
  }
});
