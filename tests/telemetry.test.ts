import assert from "node:assert/strict";
import test from "node:test";
import { telemetryMessageSchema, telemetryPacketSchema, canonicalTelemetry } from "../src/modules/telemetry/protocol";
import { buildDailyPointAggregates, composeProjectEnergy, localDateAt, localDayWindow, signedPowerEnergy, type EnergyContext, type EnergySample } from "../src/modules/telemetry/energy";

const device = "14f894f8-75a1-43a0-8867-5baf90b47c58";
const point = "52a24c3f-cf4a-44a3-9914-6ed1ace9c898";
const wire = { schema_version: "2.0" as const, event_id: "a1e6fb51-47bf-4369-96ee-c6ee3cdb05d3", device_id: device, measurement_point_id: point, configuration_version: 1, measured_at: "2026-10-09T12:00:00Z", values: { active_power: 3, import_energy: 100, export_energy: null }, units: { active_power: "kW" as const, import_energy: "kWh" as const, export_energy: "kWh" as const }, quality: "measured" as const };
function context(): EnergyContext {
  return { projectId: "project", timezone: "America/Bogota", points: [{ id: "generation", kind: "generation" }, { id: "grid", kind: "grid" }],
    bindings: ["generation", "grid"].map((id) => ({ id: `${id}-binding`, measurementPointId: id, deviceId: `${id}-device`, configurationVersion: 1, validFrom: "2026-01-01T00:00:00Z", validTo: null, configuration: { multiplier: 1 } })),
    topologyVersions: [{ id: "topology", version: 1, validFrom: "2026-01-01T00:00:00Z", validTo: null, configuration: { type: "grid_tied_no_battery", generationPointId: "generation", gridPointId: "grid", consumptionPointId: null } }], samples: [] };
}
function sample(pointId: string, at: string, forward: number | null, reverse: number | null = 0, activePower: number | null = 1): EnergySample {
  return { eventId: `${pointId}-${at}`, bindingId: `${pointId}-binding`, deviceId: `${pointId}-device`, measurementPointId: pointId, configurationVersion: 1, measuredAt: at, receivedAt: at, activePower, importEnergy: forward, exportEnergy: reverse, quality: "measured", source: "simulator" };
}
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `expected ${expected}, got ${actual}`);
test("wire v2 rejects injected authority, trusted timestamps, units, phases and invented quality", () => {
  assert.ok(telemetryMessageSchema.safeParse(wire).success);
  for (const injected of [{ organization_id: device }, { project_id: device }, { received_at: wire.measured_at }, { source: "aws_iot" }, { quality: "calculated" }, { quality: "estimated" }, { units: { ...wire.units, active_power: "W" } }, { values: { ...wire.values, import_energy: -1 } }]) assert.equal(telemetryMessageSchema.safeParse({ ...wire, ...injected }).success, false);
  assert.equal(telemetryMessageSchema.safeParse({ ...wire, quality: "missing" }).success, false);
  assert.equal(telemetryMessageSchema.safeParse({ ...wire, phases: [{ phase: "A", voltage_v: 230, current_a: 1, active_power_kw: 0.2 }, { phase: "A", voltage_v: 230, current_a: 1, active_power_kw: 0.2 }] }).success, false);
  assert.equal(telemetryPacketSchema.safeParse({ schema_version: "2.0", gateway_id: device, packet_id: point, sent_at: wire.measured_at, samples: [], loss_reports: [] }).success, false);
  assert.equal(canonicalTelemetry(telemetryMessageSchema.parse(wire)), canonicalTelemetry(telemetryMessageSchema.parse({ ...wire, measured_at: "2026-10-09T07:00:00-05:00" })));
});
test("counter deltas are measured and project energy balances only aligned intervals", () => {
  const input = context();
  input.samples = [sample("generation", "2026-10-09T12:00:00Z", 2), sample("generation", "2026-10-09T13:00:00Z", 5), sample("grid", "2026-10-09T12:00:00Z", 10, 2), sample("grid", "2026-10-09T13:00:00Z", 12, 3)];
  const rows = buildDailyPointAggregates(input, "2026-10-09");
  const result = composeProjectEnergy(input, "2026-10-09", rows);
  near(result.energy.generationKwh.value, 3); near(result.energy.gridImportKwh.value, 2); near(result.energy.gridExportKwh.value, 1); near(result.energy.consumptionKwh.value, 4);
  assert.equal(result.energy.generationKwh.quality, "measured"); assert.equal(result.energy.consumptionKwh.quality, "calculated"); assert.equal(result.coveredSeconds, 3600);
  input.samples = input.samples.filter((entry) => entry.measurementPointId !== "grid");
  assert.equal(composeProjectEnergy(input, "2026-10-09", buildDailyPointAggregates(input, "2026-10-09")).energy.consumptionKwh.value, null);
});
test("signed power integration separates direction and is always an estimate within its gap limit", () => {
  assert.deepEqual(signedPowerEnergy(2, -2, 3600), { positiveKwh: 0.5, negativeKwh: 0.5 });
  const input = context(); input.points = [input.points[1]];
  input.samples = [sample("grid", "2026-10-09T12:00:00Z", null, null, 2), sample("grid", "2026-10-09T13:00:00Z", null, null, -2)];
  assert.equal(buildDailyPointAggregates(input, "2026-10-09")[0].quality, "missing");
  const row = buildDailyPointAggregates(input, "2026-10-09", { maxIntegrationGapSeconds: 3600 })[0];
  near(row.integratedPositiveKwh, 0.5); near(row.integratedNegativeKwh, 0.5); assert.equal(row.quality, "estimated");
});
test("resets never yield negative energy and explicit missing or replaced bindings create gaps", () => {
  const input = context(); input.points = [input.points[0]];
  input.samples = [sample("generation", "2026-10-09T12:00:00Z", 100, 0, 6), sample("generation", "2026-10-09T12:01:00Z", 0, 0, 6)];
  const reset = buildDailyPointAggregates(input, "2026-10-09")[0];
  assert.equal(reset.resetCount, 1); near(reset.integratedPositiveKwh, 0.1); assert.equal(reset.importEnergyKwh, null); assert.equal(reset.quality, "estimated");
  input.samples[1] = { ...input.samples[1], quality: "missing", activePower: null, importEnergy: null, exportEnergy: null };
  assert.equal(buildDailyPointAggregates(input, "2026-10-09")[0].quality, "missing");
  input.bindings[0].validTo = "2026-10-09T12:07:30Z";
  input.bindings.push({ ...input.bindings[0], id: "replacement", deviceId: "new-device", configurationVersion: 2, validFrom: "2026-10-09T12:07:30Z", validTo: null });
  input.samples = [sample("generation", "2026-10-09T12:00:00Z", 8), sample("generation", "2026-10-09T12:05:00Z", 9), { ...sample("generation", "2026-10-09T12:10:00Z", 0), bindingId: "replacement", deviceId: "new-device", configurationVersion: 2 }, { ...sample("generation", "2026-10-09T12:15:00Z", 1), bindingId: "replacement", deviceId: "new-device", configurationVersion: 2 }];
  const replacement = buildDailyPointAggregates(input, "2026-10-09")[0]; near(replacement.importEnergyKwh, 2); assert.equal(replacement.gapCount, 1); assert.equal(replacement.resetCount, 0);
});
test("daily windows respect UTC, DST and crossing midnight without calling prorated counters measured", () => {
  assert.equal(localDayWindow("2026-03-08", "America/New_York").seconds, 23 * 3600);
  assert.equal(localDayWindow("2026-11-01", "America/New_York").seconds, 25 * 3600);
  assert.equal(localDayWindow("2026-10-09", "America/Bogota").from.toISOString(), "2026-10-09T05:00:00.000Z");
  assert.equal(localDateAt("2026-10-09T04:59:59Z", "America/Bogota"), "2026-10-08");
  assert.throws(() => localDayWindow("2026-02-30", "America/Bogota"));
  const input = context(); input.points = [input.points[0]]; input.samples = [sample("generation", "2026-10-09T04:55:00Z", 10), sample("generation", "2026-10-09T05:05:00Z", 12)];
  for (const date of ["2026-10-08", "2026-10-09"]) { const row = buildDailyPointAggregates(input, date)[0]; near(row.importEnergyKwh, 1); assert.equal(row.quality, "estimated"); assert.equal(row.detailJson.coverageSeconds, 300); }
});
test("late samples recompute affected intervals, exact duplicates do not add energy, and topology changes are temporal", () => {
  const input = context(); input.points = [input.points[0]];
  input.samples = [sample("generation", "2026-10-09T12:00:00Z", null, null, 0), sample("generation", "2026-10-09T12:10:00Z", null, null, 0)];
  assert.equal(buildDailyPointAggregates(input, "2026-10-09")[0].quality, "missing");
  const late = sample("generation", "2026-10-09T12:05:00Z", null, null, 4); input.samples.push(late, late);
  const result = buildDailyPointAggregates(input, "2026-10-09")[0]; near(result.integratedPositiveKwh, 1 / 3); assert.equal(result.sampleCount, 3); assert.equal(result.gapCount, 0);
  const changed = context(); changed.points.push({ id: "generation2", kind: "generation" });
  changed.bindings.push({ ...changed.bindings[0], id: "generation2-binding", deviceId: "generation2-device", measurementPointId: "generation2" });
  changed.topologyVersions[0].validTo = "2026-10-09T12:10:00Z";
  changed.topologyVersions.push({ id: "topology2", version: 2, validFrom: "2026-10-09T12:10:00Z", validTo: null, configuration: { type: "grid_tied_no_battery", generationPointId: "generation2", gridPointId: "grid", consumptionPointId: null } });
  changed.samples = [sample("generation", "2026-10-09T12:00:00Z", 0), sample("generation", "2026-10-09T12:20:00Z", 20), sample("generation2", "2026-10-09T12:00:00Z", 0), sample("generation2", "2026-10-09T12:20:00Z", 40), sample("grid", "2026-10-09T12:00:00Z", 0, 0), sample("grid", "2026-10-09T12:20:00Z", 20, 0)];
  const composed = composeProjectEnergy(changed, "2026-10-09", buildDailyPointAggregates(changed, "2026-10-09")); near(composed.energy.generationKwh.value, 30); near(composed.energy.gridImportKwh.value, 20); near(composed.energy.consumptionKwh.value, 50); assert.equal(composed.energy.consumptionKwh.quality, "estimated");
});
