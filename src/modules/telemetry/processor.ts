import "server-only";
import { createHash } from "node:crypto";
import { ConfigurationError } from "@/lib/config";
import { buildDailyPointAggregates, DEFAULT_INTEGRATION_GAP_SECONDS, localDateAt, localDayWindow, nextLocalDate, packDailyAggregate, type DailyPointAggregate } from "./energy";
import { canonicalTelemetry, telemetryMessageSchema, telemetryPacketSchema, type TelemetryMessage, type TelemetryTransportContext } from "./protocol";
import { withTelemetryStore, type NormalizedTelemetryInput, type ProjectProcessingContext, type StoredTelemetryResult, type TelemetryStoreTransaction } from "./store";

export interface TelemetryPacketResult {
  packetId: string;
  accepted: number;
  duplicate: number;
  quarantined: number;
  lossReportsRecorded: number;
  results: StoredTelemetryResult[];
}
export interface ProcessorOptions { maxIntegrationGapSeconds?: number }
type StoreRunner = <T>(callback: (store: TelemetryStoreTransaction) => Promise<T>) => Promise<T>;

function integrationGap(options: ProcessorOptions): number {
  const configured = options.maxIntegrationGapSeconds ?? (process.env.TELEMETRY_MAX_INTEGRATION_GAP_SECONDS ? Number(process.env.TELEMETRY_MAX_INTEGRATION_GAP_SECONDS) : DEFAULT_INTEGRATION_GAP_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0 || configured > 3600) throw new ConfigurationError("TELEMETRY_MAX_INTEGRATION_GAP_SECONDS debe estar entre 0 y 3600.");
  return configured;
}
function normalize(message: TelemetryMessage): NormalizedTelemetryInput {
  return {
    schemaVersion: message.schema_version, eventId: message.event_id,
    deviceId: message.device_id, measurementPointId: message.measurement_point_id,
    configurationVersion: message.configuration_version, measuredAt: new Date(message.measured_at).toISOString(),
    activePower: message.values.active_power, importEnergy: message.values.import_energy,
    exportEnergy: message.values.export_energy, quality: message.quality, phases: message.phases ? [...message.phases].sort((a, b) => a.phase.localeCompare(b.phase)) : [],
    ...(message.alarms ? { alarms: [...message.alarms].sort((a, b) => a.code.localeCompare(b.code)) } : {}),
  };
}
async function saveDailyRows(store: TelemetryStoreTransaction, projectId: string, rows: DailyPointAggregate[]) {
  // Leave headroom for the spaces PostgreSQL adds when rendering jsonb::text.
  const maxBytes = 3500000;
  let batch: ReturnType<typeof packDailyAggregate>[] = [], bytes = 2;
  for (const aggregate of rows) {
    const row = packDailyAggregate(aggregate), size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (size + 2 > maxBytes) throw new ConfigurationError("Un punto excede la capacidad diaria de esta versión; aumenta el intervalo de lectura.");
    if (batch.length && (bytes + size > maxBytes || batch.length >= 1000)) { await store.saveDailyAggregates(projectId, batch); batch = []; bytes = 2; }
    batch.push(row); bytes += size;
  }
  if (batch.length) await store.saveDailyAggregates(projectId, batch);
}

/** A new reading changes its previous and next interval, including any crossed civil days. */
export function affectedLocalDates(context: ProjectProcessingContext, events: NormalizedTelemetryInput[]): string[] {
  const pointSamples = new Map<string, number[]>();
  for (const sample of context.samples) {
    const values = pointSamples.get(sample.measurementPointId) ?? [];
    values.push(sample.measuredAt.getTime());
    pointSamples.set(sample.measurementPointId, values);
  }
  for (const values of pointSamples.values()) values.sort((a, b) => a - b);
  const dates = new Set<string>();
  for (const event of events) {
    const at = Date.parse(event.measuredAt);
    const values = pointSamples.get(event.measurementPointId) ?? [];
    let low = 0, high = values.length;
    while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < at) low = middle + 1; else high = middle; }
    const from = values[low - 1] ?? at;
    let after = low;
    while (after < values.length && values[after] <= at) after++;
    const to = values[after] ?? at;
    const lastDate = localDateAt(to, context.timezone);
    let date = localDateAt(from, context.timezone);
    for (let count = 0; date <= lastDate; count++, date = nextLocalDate(date)) {
      if (count > 33) throw new Error("El intervalo de recomputación supera el horizonte permitido.");
      dates.add(date);
    }
  }
  return [...dates].sort();
}

/** The injected runner is only used by server-side tests; callers never select database scope. */
export function createTelemetryProcessor(runStore: StoreRunner = withTelemetryStore) {
  async function processMessages(messages: TelemetryMessage[], context: TelemetryTransportContext, options: ProcessorOptions, store: TelemetryStoreTransaction) {
    const maxIntegrationGapSeconds = integrationGap(options);
    const affectedProjects = new Map<string, { timezone: string; events: NormalizedTelemetryInput[] }>();
    const results: StoredTelemetryResult[] = new Array(messages.length);
    // Stable point order also reduces lock inversions between gateway workers.
    const ordered = messages.map((message, index) => ({ message, index })).sort((a, b) => a.message.measurement_point_id.localeCompare(b.message.measurement_point_id) || a.message.measured_at.localeCompare(b.message.measured_at) || a.message.event_id.localeCompare(b.message.event_id));
    for (const { message, index } of ordered) {
      const payload = normalize(message);
      const hash = createHash("sha256").update(canonicalTelemetry(message)).digest("hex");
      const result = await store.acceptEvent(context, payload, hash);
      results[index] = result;
      if (result.status !== "accepted") continue;
      const affected = affectedProjects.get(result.projectId) ?? { timezone: result.timezone, events: [] };
      affected.events.push(payload);
      affectedProjects.set(result.projectId, affected);
    }
    for (const [projectId, { events, timezone }] of [...affectedProjects].sort(([a], [b]) => a.localeCompare(b))) {
      const byDate = new Map<string, NormalizedTelemetryInput[]>();
      for (const event of events) { const date = localDateAt(event.measuredAt, timezone); const group = byDate.get(date) ?? []; group.push(event); byDate.set(date, group); }
      const contexts = new Map<string, ProjectProcessingContext>(), affectedDays = new Set<string>();
      const loadDay = async (date: string) => {
        let project = contexts.get(date);
        if (!project) { const window = localDayWindow(date, timezone); project = await store.loadProjectContext(projectId, window.from, window.to); contexts.set(date, project); }
        return project;
      };
      // Storage includes each point's immediate neighbours, so midnight and late
      // counter intervals survive without scanning a month on every poll.
      for (const [date, dayEvents] of byDate) for (const affected of affectedLocalDates(await loadDay(date), dayEvents)) affectedDays.add(affected);
      for (const date of [...affectedDays].sort()) {
        await saveDailyRows(store, projectId, buildDailyPointAggregates(await loadDay(date), date, { maxIntegrationGapSeconds }));
      }
    }
    return results;
  }

  return {
    async processTelemetry(message: unknown, context: TelemetryTransportContext, options: ProcessorOptions = {}): Promise<StoredTelemetryResult> {
      const parsed = telemetryMessageSchema.parse(message);
      return runStore(async (store) => (await processMessages([parsed], context, options, store))[0]);
    },
    async processTelemetryPacket(packet: unknown, context: TelemetryTransportContext, options: ProcessorOptions = {}): Promise<TelemetryPacketResult> {
      const parsed = telemetryPacketSchema.parse(packet);
      if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 65536) throw new Error("El paquete supera el límite de 64 KiB.");
      const transport = { ...context, expectedGatewayId: parsed.gateway_id };
      return runStore(async (store) => {
        const results = await processMessages(parsed.samples, transport, options, store);
        const lossReportsRecorded = parsed.loss_reports.length ? await store.recordLossReports(transport, parsed.loss_reports.map((report) => ({ reportId: report.report_id, from: report.from, to: report.to, dropped: report.dropped, reason: report.reason }))) : 0;
        return { packetId: parsed.packet_id, accepted: results.filter((result) => result.status === "accepted").length,
          duplicate: results.filter((result) => result.status === "duplicate").length,
          quarantined: results.filter((result) => result.status === "quarantined").length, lossReportsRecorded, results };
      });
    },
  };
}

const processor = createTelemetryProcessor();
export const processTelemetry = processor.processTelemetry;
export const processTelemetryPacket = processor.processTelemetryPacket;
