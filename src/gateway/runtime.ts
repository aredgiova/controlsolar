import { randomUUID } from "node:crypto";
import type { GatewayConfiguration } from "./config";
import { ModbusError, readSdm630Mct } from "./modbus";
import { DurableOutbox } from "./outbox";
import type { PacketPublisher } from "./mqtt";
import { telemetryMessageSchema, type TelemetryMessage } from "../modules/telemetry/protocol";

export async function collectMeter(meter: GatewayConfiguration["meters"][number], read = readSdm630Mct, now: () => Date = () => new Date()): Promise<TelemetryMessage> {
  const base = { schema_version: "2.0" as const, event_id: randomUUID(), device_id: meter.deviceId, measurement_point_id: meter.measurementPointId,
    configuration_version: meter.configurationVersion, units: { active_power: "kW" as const, import_energy: "kWh" as const, export_energy: "kWh" as const } };
  try {
    const reading = await read(meter, meter);
    return telemetryMessageSchema.parse({ ...base, measured_at: now().toISOString(), ...reading, quality: "measured" });
  } catch (error) {
    return telemetryMessageSchema.parse({ ...base, measured_at: now().toISOString(), values: { active_power: null, import_energy: null, export_energy: null }, quality: error instanceof ModbusError && error.code !== "VALUE" ? "missing" : "invalid" });
  }
}

export async function flushOnce(buffer: DurableOutbox, gatewayId: string, publisher: PacketPublisher, now = new Date()) {
  const packet = buffer.prepare(gatewayId, now);
  if (!packet) return false;
  await publisher.publish(packet);
  // A PUBACK confirms broker acceptance, not database processing; rule failures are archived in AWS.
  buffer.acknowledge(packet.packet_id);
  return true;
}

export async function runGateway(configuration: GatewayConfiguration, buffer: DurableOutbox, publisher: PacketPublisher, signal: AbortSignal) {
  let flushing = false;
  const flush = async () => {
    if (flushing) return;
    flushing = true;
    try { await flushOnce(buffer, configuration.gatewayId, publisher); }
    catch { /* The exact durable packet remains queued for retry. */ }
    finally { flushing = false; }
  };
  const publishTimer = setInterval(() => void flush(), 1000);
  try {
    while (!signal.aborted) {
      const started = Date.now();
      for (const meter of configuration.meters) { if (signal.aborted) break; buffer.enqueue(await collectMeter(meter)); }
      await flush();
      if (signal.aborted) break;
      const wait = Math.max(50, configuration.pollIntervalMs - (Date.now() - started));
      await new Promise<void>((resolve) => { const timer = setTimeout(done, wait); function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
    }
  } finally {
    clearInterval(publishTimer);
    while (flushing) await new Promise((resolve) => setTimeout(resolve, 25));
    try { await publisher.close(); } finally { buffer.close(); }
  }
}
