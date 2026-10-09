import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { processTelemetryPacket } from "../src/modules/telemetry/processor";
import { closeTelemetryStore } from "../src/modules/telemetry/store";
import type { TelemetryMessage, TelemetryPacket } from "../src/modules/telemetry/protocol";

// Uses the isolated local identities seeded by test:http; never an application auth bypass.
async function main() {
const fixturePath = resolve(".work/http-fixture.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const base = process.env.TEST_BASE_URL ?? fixture.base;
assert.equal(base, fixture.base);
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
assert.ok(process.env.INGEST_DATABASE_URL && ["127.0.0.1", "localhost"].includes(new URL(process.env.INGEST_DATABASE_URL).hostname));
assert.match(new URL(process.env.INGEST_DATABASE_URL!).pathname, /_test$/);
// This offline test has already required loopback and an isolated *_test DB.
// Its plaintext fixture is never a staging/production transport exception.
process.env.APP_ENV = "development";
const root = `/api/v1/organizations/${fixture.organization.id}`;
async function api(actor: string, path: string, method = "GET", input?: unknown, status = 200) {
  const response = await fetch(`${base}${path}`, { method, headers: { Cookie: `solar_session=${fixture.identities[actor].token}`, Origin: base, ...(input ? { "Content-Type": "application/json" } : {}) }, body: input ? JSON.stringify(input) : undefined });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${result.error?.code ?? "response"}`);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return result;
}
if (process.env.TEST_VERIFY_PERSISTENCE === "true") {
  const saved = await api("customer", `${root}/projects/${fixture.project.id}/telemetry?date=${fixture.telemetry.date}`);
  assert.equal(saved.latestMeasuredAt, fixture.telemetry.latestMeasuredAt);
  assert.equal(saved.energy.generationKwh.value, fixture.telemetry.generationKwh);
  assert.equal(saved.daySource, "simulator");
  console.log("PASS telemetry persistence: latest, source and energy survived application restart.");
} else {
  const managed = await api("owner", `${root}/projects/${fixture.project.id}`);
  const bindings = managed.bindings.filter((entry: { validTo: string | null }) => !entry.validTo);
  const device = await api("owner", `${root}/devices`, "POST", { name: "Gateway de prueba local", serialNumber: `GW-HTTP-${randomUUID()}`, kind: "gateway" }, 201);
  const enrollment = { name: "Simulador HTTP local", gatewayDeviceId: device.id, source: "simulator", principalId: `local-${randomUUID()}`, meterDeviceIds: bindings.map((entry: { deviceId: string }) => entry.deviceId) };
  await api("customer", `${root}/gateways`, "POST", enrollment, 403);
  await api("owner", `${root}/gateways`, "POST", { ...enrollment, organizationId: fixture.otherOrganization.id }, 400);
  const gateway = await api("owner", `${root}/gateways`, "POST", enrollment, 201);
  assert.equal(gateway.id, gateway.clientId);
  await api("other", `${root}/gateways`, "GET", undefined, 403);
  await api("customer", `${root}/gateways`, "GET", undefined, 403);
  const now = Math.floor(Date.now() / 60000) * 60000;
  const at = (minute: number) => new Date(now - (4 - minute) * 60000).toISOString();
  const samples: TelemetryMessage[] = [];
  for (const minute of [0, 2, 4, 1, 3]) for (const binding of bindings) {
    const point = managed.measurementPoints.find((entry: { id: string }) => entry.id === binding.measurementPointId);
    const generation = point.kind === "generation";
    samples.push({ schema_version: "2.0", event_id: randomUUID(), device_id: binding.deviceId, measurement_point_id: binding.measurementPointId, configuration_version: binding.configurationVersion, measured_at: at(minute),
      values: { active_power: generation ? 4 : 2, import_energy: Number(((generation ? 100 : 50) + minute * (generation ? 4 : 2) / 60).toFixed(6)), export_energy: 0 },
      units: { active_power: "kW", import_energy: "kWh", export_energy: "kWh" }, quality: "measured" });
  }
  const packet: TelemetryPacket = { schema_version: "2.0", gateway_id: gateway.id, packet_id: randomUUID(), sent_at: new Date().toISOString(), samples, loss_reports: [] };
  const context = { source: "simulator" as const, principalId: gateway.principalId, clientId: gateway.id, expectedGatewayId: gateway.id, topic: `solar/v2/gateways/${gateway.id}/telemetry`, receivedAt: new Date() };
  try {
    const accepted = await processTelemetryPacket(packet, context);
    assert.equal(accepted.accepted, 10);
    assert.equal((await processTelemetryPacket(packet, { ...context, receivedAt: new Date() })).duplicate, 10);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: managed.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    const saved = await api("customer", `${root}/projects/${fixture.project.id}/telemetry?date=${date}`);
    assert.equal(saved.latestMeasuredAt, at(4));
    assert.equal(saved.source, "simulator");
    assert.equal(saved.power.generationKw.value, 4);
    assert.equal(saved.power.consumptionKw.value, 6);
    assert.equal(saved.energy.generationKwh.quality, "measured");
    assert.ok(Math.abs(saved.energy.generationKwh.value - 4 / 15) < 0.00001);
    assert.ok(Math.abs(saved.energy.consumptionKwh.value - 0.4) < 0.00001);
    await api("customer", `${root}/projects/${fixture.secondProject.id}/telemetry`, "GET", undefined, 404);
    await api("other", `${root}/projects/${fixture.project.id}/telemetry`, "GET", undefined, 403);
    await api("owner", `${root}/projects/${fixture.project.id}/telemetry?date=2026-02-30`, "GET", undefined, 400);
    const conflict = { ...samples[0], values: { ...samples[0].values, active_power: 999 } };
    assert.equal((await processTelemetryPacket({ ...packet, packet_id: randomUUID(), samples: [conflict] }, context)).quarantined, 1);
    await api("owner", `${root}/gateways/${gateway.id}`, "PATCH", { status: "revoked" });
    const blocked = await processTelemetryPacket({ ...packet, packet_id: randomUUID(), samples: [{ ...samples[0], event_id: randomUUID() }] }, context);
    assert.equal(blocked.quarantined, 1);
    fixture.telemetry = { date, latestMeasuredAt: saved.latestMeasuredAt, generationKwh: saved.energy.generationKwh.value, gatewayId: gateway.id };
    await writeFile(fixturePath, JSON.stringify(fixture, null, 2));
    console.log("PASS telemetry HTTP: enrollment, scope, common ingestion, duplicate/out-of-order, energy, date validation, conflict and revocation.");
  } finally { await closeTelemetryStore(); }
}
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
