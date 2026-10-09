import { createHash } from "node:crypto";
import { z } from "zod";
import { signedPowerEnergy } from "./energy";
import { telemetryPacketSchema, type TelemetryMessage, type TelemetryPacket, type TelemetryTransportContext } from "./protocol";

const timestamp = z.iso.datetime({ offset: true });
const meterSchema = z.strictObject({ deviceId: z.uuid(), measurementPointId: z.uuid(), configurationVersion: z.number().int().positive(), kind: z.enum(["generation", "grid", "consumption"]), validFrom: timestamp.optional(), validTo: timestamp.optional() });
export const simulationConfigSchema = z.strictObject({
  gatewayId: z.uuid(), principalId: z.string().min(1).max(256),
  timezone: z.string().default("America/Bogota").refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Zona horaria IANA inválida."),
  seed: z.string().min(1).max(100).default("solar-pilot"),
  from: timestamp, to: timestamp, intervalSeconds: z.number().int().min(30).max(3600).default(300),
  capacityKwp: z.number().positive().max(1e6).default(6), baseLoadKw: z.number().nonnegative().max(1e6).default(2),
  scenario: z.enum(["baseline", "duplicates", "late", "gap", "missing", "reset", "device_alarm"]).default("baseline"),
  meters: z.array(meterSchema).min(1).max(20),
}).superRefine((value, context) => {
  const from = Date.parse(value.from), to = Date.parse(value.to);
  if (to <= from || to - from > 31 * 86400000) context.addIssue({ code: "custom", path: ["to"], message: "El rango debe ser positivo y no superar 31 días." });
  if ((Math.floor((to - from) / (value.intervalSeconds * 1000)) + 1) * value.meters.length > 20000) context.addIssue({ code: "custom", path: ["to"], message: "El simulador admite hasta 20 000 observaciones por ejecución." });
  for (const meter of value.meters) if (meter.validFrom && meter.validTo && Date.parse(meter.validTo) <= Date.parse(meter.validFrom)) context.addIssue({ code: "custom", path: ["meters"], message: "La vigencia del medidor es inválida." });
  for (let a = 0; a < value.meters.length; a++) for (let b = a + 1; b < value.meters.length; b++) {
    const first = value.meters[a], second = value.meters[b];
    if ((first.deviceId === second.deviceId || first.measurementPointId === second.measurementPointId) && Math.max(Date.parse(first.validFrom ?? value.from), Date.parse(second.validFrom ?? value.from)) < Math.min(Date.parse(first.validTo ?? value.to) + (first.validTo ? 0 : 1), Date.parse(second.validTo ?? value.to) + (second.validTo ? 0 : 1))) context.addIssue({ code: "custom", path: ["meters"], message: "Las vigencias de un equipo o punto no pueden solaparse." });
  }
});
export type SimulationConfig = z.infer<typeof simulationConfigSchema>;

/** Stable IDs make a replay the same observation, even after a process restart. */
export function simulationUuid(value: string): string {
  const bytes = createHash("sha256").update(`solar-simulator/v2/${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const rounded = (value: number) => Math.round(value * 1e6) / 1e6;

/** Uses the gateway's actual wire contract; the provenance is supplied separately at ingestion. */
export function generateSimulation(input: unknown): { config: SimulationConfig; packets: TelemetryPacket[]; observationCount: number } {
  const config = simulationConfigSchema.parse(input);
  const from = Date.parse(config.from), to = Date.parse(config.to), step = config.intervalSeconds * 1000;
  const count = Math.floor((to - from) / step) + 1, middle = Math.floor(count / 2);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const powers = (at: number) => {
    const parts = formatter.formatToParts(new Date(at));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)!.value;
    const hour = Number(part("hour")) + Number(part("minute")) / 60 + Number(part("second")) / 3600;
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    const weather = 0.75 + createHash("sha256").update(`${config.seed}|${day}`).digest().readUInt16BE(0) / 65535 * 0.2;
    const generation = hour <= 6 || hour >= 18 ? 0 : config.capacityKwp * weather * Math.sin((hour - 6) / 12 * Math.PI);
    const consumption = config.baseLoadKw * (0.8 + 0.2 * Math.cos((hour - 20) / 24 * 2 * Math.PI) ** 2);
    return { generation, consumption, grid: consumption - generation };
  };
  const states = config.meters.map(() => ({ at: from, power: 0, positive: 100, negative: 50, initialized: false, reset: false }));
  const samples: TelemetryMessage[] = [];
  for (let tick = 0; tick < count; tick++) {
    const at = from + tick * step, measuredAt = new Date(at).toISOString(), curve = powers(at);
    for (let index = 0; index < config.meters.length; index++) {
      const meter = config.meters[index], state = states[index];
      if (at < Date.parse(meter.validFrom ?? config.from) || at >= Date.parse(meter.validTo ?? new Date(to + 1).toISOString())) continue;
      const activePower = curve[meter.kind];
      if (state.initialized) {
        const delta = signedPowerEnergy(state.power, activePower, (at - state.at) / 1000);
        state.positive += delta.positiveKwh; state.negative += delta.negativeKwh;
      }
      if (config.scenario === "reset" && tick >= middle && !state.reset) { state.positive = 0; state.negative = 0; state.reset = true; }
      state.power = activePower; state.at = at; state.initialized = true;
      if (config.scenario === "gap" && Math.abs(tick - middle) <= 1) continue;
      const missing = config.scenario === "missing" && tick === middle;
      samples.push({ schema_version: "2.0", event_id: simulationUuid(`${config.seed}|${config.scenario}|${meter.deviceId}|${meter.measurementPointId}|${meter.configurationVersion}|${measuredAt}`), device_id: meter.deviceId,
        measurement_point_id: meter.measurementPointId, configuration_version: meter.configurationVersion, measured_at: measuredAt,
        values: missing ? { active_power: null, import_energy: null, export_energy: null } : { active_power: rounded(activePower), import_energy: rounded(state.positive), export_energy: meter.kind === "grid" ? rounded(state.negative) : 0 },
        units: { active_power: "kW", import_energy: "kWh", export_energy: "kWh" }, quality: missing ? "missing" : "measured",
        ...(config.scenario === "device_alarm" ? { alarms: meter.kind === "generation" ? [{ code: "SIMULATED_DEMO", severity: "warning" as const, active: tick < middle }] : [] } : {}) });
    }
  }
  if (config.scenario === "late") samples.sort((a, b) => b.measured_at.localeCompare(a.measured_at) || a.measurement_point_id.localeCompare(b.measurement_point_id));
  if (config.scenario === "duplicates") samples.splice(0, samples.length, ...samples.flatMap((sample, index) => index % 7 === 0 ? [sample, sample] : [sample]));
  const packets: TelemetryPacket[] = [];
  for (let offset = 0; offset < samples.length; offset += 100) {
    const batch = samples.slice(offset, offset + 100);
    packets.push(telemetryPacketSchema.parse({ schema_version: "2.0", gateway_id: config.gatewayId,
      packet_id: simulationUuid(`${config.seed}|packet|${batch.map((sample) => sample.event_id).join("|")}`),
      sent_at: batch.reduce((last, sample) => sample.measured_at > last ? sample.measured_at : last, config.from), samples: batch, loss_reports: [] }));
  }
  return { config, packets, observationCount: samples.length };
}
export function simulationTransport(config: Pick<SimulationConfig, "gatewayId" | "principalId">, receivedAt: Date = new Date()): TelemetryTransportContext {
  return { source: "simulator", principalId: config.principalId, clientId: config.gatewayId, expectedGatewayId: config.gatewayId,
    topic: `solar/v2/gateways/${config.gatewayId}/telemetry`, receivedAt };
}
