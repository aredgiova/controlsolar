import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeSdm630Mct, float32, ModbusError, readInputRegisters, readSdm630Mct } from "../src/gateway/modbus";
import { DurableOutbox } from "../src/gateway/outbox";
import { collectMeter, flushOnce } from "../src/gateway/runtime";
import { readGatewayConfiguration } from "../src/gateway/config";
import type { TelemetryMessage } from "../src/modules/telemetry/protocol";

const gatewayId = "dc379717-7120-4db8-aa1a-2f929cb8ccde";
const deviceId = "34597510-36b1-422e-a006-36f83143fb6e";
const pointId = "538c819f-7a6b-4ef5-84cc-837778cab689";
const now = new Date("2026-10-09T12:00:00Z");
const meter = { model: "SDM630MCT-v1.7" as const, deviceId, measurementPointId: pointId, configurationVersion: 1, host: "127.0.0.1", port: 502, unitId: 1, wordOrder: "high-first" as const, powerSign: 1 as const };
function floats(...values: number[]) { const buffer = Buffer.alloc(values.length * 4); values.forEach((value, index) => buffer.writeFloatBE(value, index * 4)); return buffer; }
function sample(at = now, power = 3): TelemetryMessage { return { schema_version: "2.0", event_id: randomUUID(), device_id: deviceId, measurement_point_id: pointId, configuration_version: 1, measured_at: at.toISOString(), values: { active_power: power, import_energy: 10, export_energy: 2 }, units: { active_power: "kW", import_energy: "kWh", export_energy: "kWh" }, quality: "measured" }; }
async function tcpFixture(reply: (request: Buffer, socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.once("data", (request) => reply(request, socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { target: { host: "127.0.0.1", port: address.port, unitId: 7, timeoutMs: 150 }, close: async () => { sockets.forEach((socket) => socket.destroy()); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
function response(request: Buffer, data: Buffer) {
  const reply = Buffer.alloc(9 + data.length); request.copy(reply, 0, 0, 4); reply.writeUInt16BE(data.length + 3, 4); reply[6] = request[6]; reply[7] = 4; reply[8] = data.length; data.copy(reply, 9); return reply;
}

test("SDM630MCT v1.7 map converts W to kW, preserves kWh and both signed directions", () => {
  const phase = floats(230, 231, 232, 2, 3, 4, 460, -693, 928);
  const result = decodeSdm630Mct(phase, floats(-1500), floats(123.5, 9.25));
  assert.deepEqual(result.values, { active_power: -1.5, import_energy: 123.5, export_energy: 9.25 });
  assert.deepEqual(result.phases[1], { phase: "B", voltage_v: 231, current_a: 3, active_power_kw: -0.693 });
  const reversed = decodeSdm630Mct(phase, floats(-1500), floats(123.5, 9.25), { powerSign: -1 });
  assert.deepEqual(reversed.values, { active_power: 1.5, import_energy: 9.25, export_energy: 123.5 });
  assert.equal(reversed.phases[1].active_power_kw, 0.693);
  const swapped = Buffer.from([0, 0, 0x43, 0x66]); assert.equal(float32(swapped, 0, "low-first"), 230);
  assert.throws(() => float32(floats(NaN), 0), ModbusError);
  assert.throws(() => decodeSdm630Mct(phase, floats(1), floats(-1, 0)), ModbusError);
});

test("Modbus loopback uses only FC04 exact documented offsets and tolerates TCP fragmentation", async () => {
  const requests: [number, number][] = [];
  const fixture = await tcpFixture((request, socket) => {
    assert.equal(request[7], 4); assert.equal(request[6], 7);
    const offset = request.readUInt16BE(8); const count = request.readUInt16BE(10); requests.push([offset, count]);
    const data = offset === 0 ? floats(230, 231, 232, 1, 2, 3, 230, 462, 696) : offset === 52 ? floats(1388) : floats(10, 2);
    const reply = response(request, data); socket.write(reply.subarray(0, 5)); setImmediate(() => socket.write(reply.subarray(5)));
  });
  try { assert.equal((await readSdm630Mct(fixture.target)).values.active_power, 1.388); assert.deepEqual(requests, [[0, 18], [52, 2], [72, 4]]); }
  finally { await fixture.close(); }
});

test("Modbus rejects a mismatched transaction, malformed length, exception and timeout", async () => {
  for (const scenario of ["transaction", "length", "exception", "timeout"]) {
    const fixture = await tcpFixture((request, socket) => {
      if (scenario === "timeout") return;
      const reply = response(request, floats(1));
      if (scenario === "transaction") reply.writeUInt16BE((reply.readUInt16BE(0) + 1) % 65536, 0);
      if (scenario === "length") reply.writeUInt16BE(1, 4);
      if (scenario === "exception") { reply[7] = 0x84; }
      socket.write(reply);
    });
    try { await assert.rejects(readInputRegisters(fixture.target, 52, 2), (error: unknown) => error instanceof ModbusError && error.code === (scenario === "timeout" ? "TIMEOUT" : scenario === "exception" ? "EXCEPTION" : "FRAME")); }
    finally { await fixture.close(); }
  }
  await assert.rejects(readInputRegisters({ host: "localhost", port: 502, unitId: 0 }, 52, 2), ModbusError);
});

test("failed acquisitions carry nulls and their real completion timestamp", async () => {
  const absent = await collectMeter(meter, async () => { throw new ModbusError("TIMEOUT"); }, () => now);
  assert.equal(absent.quality, "missing"); assert.equal(absent.measured_at, now.toISOString());
  assert.deepEqual(absent.values, { active_power: null, import_energy: null, export_energy: null });
  assert.equal((await collectMeter(meter, async () => { throw new ModbusError("VALUE"); }, () => now)).quality, "invalid");
});

test("gateway configuration binds UUID/client/topic, requires a known map and strict AWS TLS endpoint", () => {
  const valid = { gatewayId, clientId: gatewayId, topic: `solar/v2/gateways/${gatewayId}/telemetry`, endpoint: "abc123-ats.iot.us-east-1.amazonaws.com", certificatePath: "/private/cert.pem", privateKeyPath: "/private/key.pem", caPath: "/private/ca.pem", bufferPath: "/private/outbox.sqlite", meters: [meter] };
  assert.equal(readGatewayConfiguration(valid).pollIntervalMs, 10000);
  for (const invalid of [{ endpoint: "mqtt://localhost" }, { endpoint: "localhost" }, { clientId: deviceId }, { topic: `solar/v2/gateways/${deviceId}/telemetry` }, { meters: [{ ...meter, model: "SDM630" }] }, { meters: [{ ...meter, powerSign: undefined }] }, { meters: [meter, meter] }]) assert.throws(() => readGatewayConfiguration({ ...valid, ...invalid }));
});

const sqliteOptions = { skip: Number(process.versions.node.split(".")[0]) !== 24 };
test("SQLite persists the exact packet across restart and does not ACK failed publications", sqliteOptions, async () => {
  const directory = await mkdtemp(join(tmpdir(), "solar-outbox-")); const path = join(directory, "outbox.sqlite");
  let buffer = new DurableOutbox(path, { maxSamples: 20, maxBytes: 20000 });
  try {
    const event = sample(); buffer.enqueue(event); const original = buffer.prepare(gatewayId, now)!;
    await assert.rejects(flushOnce(buffer, gatewayId, { publish: async () => { throw new Error("offline"); }, close: async () => {} }, now));
    assert.equal(buffer.stats().samples, 1); buffer.close(); buffer = new DurableOutbox(path, { maxSamples: 20, maxBytes: 20000 });
    assert.deepEqual(buffer.prepare(gatewayId, new Date(now.getTime() + 100000)), original);
    assert.equal(buffer.acknowledge(randomUUID()), false);
    assert.equal(await flushOnce(buffer, gatewayId, { publish: async (packet) => assert.deepEqual(packet, original), close: async () => {} }, now), true);
    assert.equal(buffer.stats().samples, 0); assert.equal(buffer.prepare(gatewayId, now), null);
  } finally { buffer.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SQLite gives fresh traffic 3:1 capacity while draining oldest backfill", sqliteOptions, async () => {
  const directory = await mkdtemp(join(tmpdir(), "solar-fair-")); const buffer = new DurableOutbox(join(directory, "outbox.sqlite"), { maxSamples: 100, maxBytes: 100000 });
  try {
    for (let index = 0; index < 8; index++) { buffer.enqueue(sample(new Date(now.getTime() - index * 1000))); buffer.enqueue(sample(new Date(now.getTime() - 120000 - index * 1000))); }
    const packet = buffer.prepare(gatewayId, now, 8)!;
    assert.equal(packet.samples.filter((entry) => Date.parse(entry.measured_at) >= now.getTime() - 60000).length, 6);
    const old = packet.samples.filter((entry) => Date.parse(entry.measured_at) < now.getTime() - 60000);
    assert.equal(old.length, 2); assert.ok(Date.parse(old[0].measured_at) < Date.parse(old[1].measured_at));
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 65536);
  } finally { buffer.close(); await rm(directory, { recursive: true, force: true }); }
});

test("capacity drops become stable loss reports; in-flight events and reports remain immutable", sqliteOptions, async () => {
  const directory = await mkdtemp(join(tmpdir(), "solar-loss-")); const buffer = new DurableOutbox(join(directory, "outbox.sqlite"), { maxSamples: 2, maxBytes: 10000 });
  try {
    for (let index = 0; index < 3; index++) buffer.enqueue(sample(new Date(now.getTime() + index * 1000)));
    const original = buffer.prepare(gatewayId, now)!; assert.equal(original.loss_reports[0].dropped, 1); assert.equal(buffer.stats().dropped, 1);
    buffer.enqueue(sample(new Date(now.getTime() + 10000))); assert.equal(buffer.stats().samples, 2); assert.equal(buffer.stats().dropped, 2);
    assert.deepEqual(buffer.prepare(gatewayId, now), original);
    buffer.acknowledge(original.packet_id); const remaining = buffer.prepare(gatewayId, now)!;
    assert.equal(remaining.samples.length, 0); assert.equal(remaining.loss_reports[0].dropped, 1);
    assert.notEqual(remaining.loss_reports[0].report_id, original.loss_reports[0].report_id);
    buffer.acknowledge(remaining.packet_id); assert.equal(buffer.prepare(gatewayId, now), null);
  } finally { buffer.close(); await rm(directory, { recursive: true, force: true }); }
});

test("duplicate events are idempotent and conflicting content rolls back", sqliteOptions, async () => {
  const directory = await mkdtemp(join(tmpdir(), "solar-duplicate-")); const buffer = new DurableOutbox(join(directory, "outbox.sqlite"), { maxSamples: 10, maxBytes: 10000 });
  try { const event = sample(); assert.equal(buffer.enqueue(event), true); assert.equal(buffer.enqueue(event), false); assert.throws(() => buffer.enqueue({ ...event, values: { ...event.values, active_power: 9 } })); assert.equal(buffer.stats().samples, 1); }
  finally { buffer.close(); await rm(directory, { recursive: true, force: true }); }
});
