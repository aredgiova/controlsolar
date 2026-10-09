import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createTelemetryProcessor, affectedLocalDates } from "../src/modules/telemetry/processor";
import { buildPowerSeries, summarizeLatestTelemetry } from "../src/modules/telemetry/queries";
import { generateSimulation, simulationTransport } from "../src/modules/telemetry/simulator";
import { buildDailyPointAggregates, localDayWindow, packDailyAggregate, unpackAggregateDetail } from "../src/modules/telemetry/energy";
import type { ProjectProcessingContext, TelemetryStoreTransaction } from "../src/modules/telemetry/store";

const ids = { gateway: randomUUID(), generation: randomUUID(), grid: randomUUID(), meter: randomUUID(), gridMeter: randomUUID(), project: randomUUID() };
const config = { gatewayId: ids.gateway, principalId: "local-pipeline-test", timezone: "America/Bogota", seed: "same-run-after-restart", from: "2026-10-08T11:00:00Z", to: "2026-10-08T12:00:00Z", intervalSeconds: 300,
  meters: [{ deviceId: ids.meter, measurementPointId: ids.generation, configurationVersion: 1, kind: "generation" }, { deviceId: ids.gridMeter, measurementPointId: ids.grid, configurationVersion: 1, kind: "grid" }] };

test("simulator packets replay identically and expose missing, resets, duplicates and late ordering without tenant claims", () => {
  const first = generateSimulation(config), second = generateSimulation(config);
  assert.deepEqual(first, second);
  assert.equal(first.observationCount, 26);
  assert.ok(first.packets.every((packet) => packet.samples.length <= 100));
  const transport = simulationTransport(first.config, new Date("2026-10-08T12:01:00Z"));
  assert.equal(transport.source, "simulator");
  assert.equal(transport.clientId, first.config.gatewayId);
  assert.ok(!("source" in first.packets[0]) && !("organization_id" in first.packets[0].samples[0]));
  const duplicates = generateSimulation({ ...config, scenario: "duplicates" }).packets.flatMap((packet) => packet.samples);
  assert.ok(duplicates.length > new Set(duplicates.map((sample) => sample.event_id)).size);
  const late = generateSimulation({ ...config, scenario: "late" }).packets.flatMap((packet) => packet.samples);
  assert.ok(late[0].measured_at > late.at(-1)!.measured_at);
  const missing = generateSimulation({ ...config, scenario: "missing" }).packets.flatMap((packet) => packet.samples).filter((sample) => sample.quality === "missing");
  assert.equal(missing.length, 2); assert.ok(missing.every((sample) => Object.values(sample.values).every((value) => value === null)));
  const resets = generateSimulation({ ...config, scenario: "reset" }).packets.flatMap((packet) => packet.samples).filter((sample) => sample.device_id === ids.meter);
  assert.ok(resets.some((sample, index) => index > 0 && sample.values.import_energy! < resets[index - 1].values.import_energy!));
  assert.throws(() => generateSimulation({ ...config, meters: [...config.meters, config.meters[0]] }));
});

test("a packet recomputes a project once, duplicate replay does no derived writes, and invalid wire never reaches storage", async () => {
  const generated = generateSimulation(config), samples: ProjectProcessingContext["samples"] = [];
  const events = new Set<string>(); let reads = 0, writes = 0, accepts = 0;
  const context: ProjectProcessingContext = { projectId: ids.project, timezone: "America/Bogota", points: [{ id: ids.generation, kind: "generation", signConvention: "positive_generation" }, { id: ids.grid, kind: "grid", signConvention: "positive_import" }],
    bindings: config.meters.map((meter) => ({ id: meter.deviceId, ...meter, validFrom: new Date(config.from), validTo: null, configuration: { multiplier: 1 } })),
    topologyVersions: [], samples };
  const store: TelemetryStoreTransaction = {
    async acceptEvent(source, payload) {
      accepts++; const duplicate = events.has(payload.eventId); events.add(payload.eventId);
      if (!duplicate) samples.push({ ...payload, bindingId: payload.deviceId, measuredAt: new Date(payload.measuredAt), receivedAt: new Date(source.receivedAt), source: source.source, phases: payload.phases ?? [] });
      return { status: duplicate ? "duplicate" : "accepted", eventId: payload.eventId, storedEventId: payload.eventId, projectId: ids.project, organizationId: randomUUID(), measurementPointId: payload.measurementPointId, bindingId: payload.deviceId, timezone: "America/Bogota" };
    },
    async loadProjectContext() { reads++; return context; },
    async saveDailyAggregates(_id, rows) { writes++; assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.quality === "measured")); },
    async recordLossReports() { return 0; },
  };
  const processor = createTelemetryProcessor(async (callback) => callback(store));
  const result = await processor.processTelemetryPacket(generated.packets[0], simulationTransport(generated.config));
  assert.equal(result.accepted, 26); assert.equal(reads, 1); assert.equal(writes, 1);
  const replay = await processor.processTelemetryPacket(generated.packets[0], simulationTransport(generated.config));
  assert.equal(replay.duplicate, 26); assert.equal(reads, 1); assert.equal(writes, 1);
  const before = accepts;
  await assert.rejects(processor.processTelemetryPacket({ ...generated.packets[0], organization_id: randomUUID() }, simulationTransport(generated.config)));
  assert.equal(accepts, before);
  const event = { ...samples[4], schemaVersion: "2.0" as const, measuredAt: samples[4].measuredAt.toISOString(), quality: "measured" as const, alarms: samples[4].alarms ?? undefined };
  assert.deepEqual(affectedLocalDates(context, [event]), ["2026-10-08"]);
});

test("freshness uses measurement and reception clocks, sequential meter timestamps leave instantaneous balance missing, and DST chart buckets stay bounded", () => {
  const generated = generateSimulation(config);
  const all = generated.packets.flatMap((packet) => packet.samples);
  const context: ProjectProcessingContext = { projectId: ids.project, timezone: config.timezone, points: [{ id: ids.generation, kind: "generation", signConvention: "positive_generation" }, { id: ids.grid, kind: "grid", signConvention: "positive_import" }],
    bindings: config.meters.map((meter) => ({ id: meter.deviceId, ...meter, validFrom: new Date(config.from), validTo: null, configuration: { multiplier: 1 } })),
    topologyVersions: [{ id: randomUUID(), version: 1, validFrom: new Date(config.from), validTo: null, configuration: { type: "grid_tied_no_battery", generationPointId: ids.generation, gridPointId: ids.grid, consumptionPointId: null } }],
    samples: all.map((sample) => ({ eventId: sample.event_id, deviceId: sample.device_id, measurementPointId: sample.measurement_point_id, configurationVersion: sample.configuration_version, bindingId: sample.device_id, measuredAt: new Date(sample.measured_at), receivedAt: new Date("2026-10-08T12:01:00Z"), activePower: sample.values.active_power, importEnergy: sample.values.import_energy, exportEnergy: sample.values.export_energy, quality: sample.quality, source: "simulator", phases: [] })) };
  assert.equal(summarizeLatestTelemetry(context, new Date("2026-10-08T12:01:00Z")).connection, "online");
  assert.equal(summarizeLatestTelemetry(context, new Date("2026-10-08T12:06:00Z")).connection, "stale");
  assert.equal(summarizeLatestTelemetry(context, new Date("2026-10-09T12:01:00Z")).connection, "offline");
  const closed = { ...context, bindings: context.bindings.map((binding) => ({ ...binding, validTo: new Date("2026-10-08T12:00:30Z") })) };
  assert.equal(summarizeLatestTelemetry(closed, new Date("2026-10-08T12:01:00Z")).connection, "offline");
  assert.notEqual(summarizeLatestTelemetry(closed, new Date("2026-10-08T12:01:00Z")).power.generationKw.value, null);
  const later = context.samples.at(-1)!; later.measuredAt = new Date(later.measuredAt.getTime() + 1000);
  assert.equal(summarizeLatestTelemetry(context, new Date("2026-10-08T12:01:00Z")).power.consumptionKw.quality, "missing");
  const series = buildPowerSeries({ ...context, timezone: "America/New_York", samples: [] }, "2026-11-01");
  assert.equal(series.length, 288); assert.ok(series.every((bucket) => bucket.generationKw === null));
  assert.equal((Date.parse(series.at(-1)!.measuredAt) - Date.parse(series[0].measuredAt)) / 3600000 > 24, true);
});

test("full daily interval snapshots fit the per-point write budget at default and fastest supported polling", (t) => {
  const window = localDayWindow("2026-10-08", "America/Bogota");
  for (const seconds of [10, 5]) {
    const context: ProjectProcessingContext = { projectId: ids.project, timezone: "America/Bogota", points: [{ id: ids.generation, kind: "generation", signConvention: "positive_generation" }, { id: ids.grid, kind: "grid", signConvention: "positive_import" }],
      bindings: config.meters.map((meter) => ({ id: meter.deviceId, ...meter, validFrom: window.from, validTo: null, configuration: { multiplier: 1 } })), topologyVersions: [], samples: [] };
    for (let index = 0; index <= window.seconds / seconds; index++) for (const [meter, power] of [[config.meters[0], 2], [config.meters[1], 1]] as const) {
      context.samples.push({ eventId: `${meter.deviceId}-${index}`, bindingId: meter.deviceId, deviceId: meter.deviceId, measurementPointId: meter.measurementPointId, configurationVersion: 1,
        measuredAt: new Date(window.from.getTime() + index * seconds * 1000), receivedAt: window.to, activePower: power, importEnergy: 100 + index * seconds * power / 3600, exportEnergy: 0, quality: "measured", source: "simulator", phases: [] });
    }
    const rows = buildDailyPointAggregates(context, "2026-10-08");
    const bytes = rows.map((row) => Buffer.byteLength(JSON.stringify(packDailyAggregate(row))));
    assert.ok(bytes.every((size) => size < 3500000));
    assert.deepEqual(unpackAggregateDetail(packDailyAggregate(rows[0]).detailJson).intervals, rows[0].detailJson.intervals);
    t.diagnostic(`${seconds}s polling: ${context.samples.length} samples/day incl endpoints; compact daily row bytes=${bytes.join(",")}`);
  }
  assert.throws(() => unpackAggregateDetail({ intervalEncoding: "tuple-v1", intervals: [["2026-10-08T00:00:00Z", "bad", 1, 0, "measured", ids.meter, "meter_counter", "simulator", null, null]] }));
});
