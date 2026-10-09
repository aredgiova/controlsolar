import "server-only";
import { withTenant } from "@/lib/tenant";
import { DomainError, type Actor } from "@/modules/organizations/access";
import { bindingMultiplier, composeProjectEnergy, localDateAt, localDayWindow, missingMetric, topologyConfiguration, unpackAggregateDetail, type DailyPointAggregate, type EnergyContext, type EnergyMetrics, type EnergySample, type TelemetryMetric } from "./energy";
import type { TelemetrySource } from "./protocol";

export interface TelemetryPower { generationKw: TelemetryMetric; gridKw: TelemetryMetric; consumptionKw: TelemetryMetric }
export type TelemetryProvenance = TelemetrySource | "mixed" | "missing";
export type TelemetrySourceLabel = TelemetryProvenance;
export type TelemetryConnection = "online" | "stale" | "offline" | "missing";
export interface PortfolioTelemetry { connection: TelemetryConnection; latestMeasuredAt: string | null; latestReceivedAt: string | null; power: TelemetryPower; source: TelemetryProvenance }
export interface TelemetryProjection extends PortfolioTelemetry {
  projectId: string; timezone: string; date: string; dayStart: string; dayEnd: string; daySource: TelemetryProvenance; energyThrough: string | null; energy: EnergyMetrics;
  series: { measuredAt: string; hour: string; generationKw: number | null; gridKw: number | null; consumptionKw: number | null }[];
  coverage: { coveredSeconds: number; daySeconds: number; gapCount: number; resetCount: number; invalidCount: number; sampleCount: number };
}
const epoch = (value: Date | string) => new Date(value).getTime();
function provenance(samples: EnergySample[]): TelemetryProvenance { const sources = new Set(samples.map((sample) => sample.source)); return sources.size > 1 ? "mixed" : sources.values().next().value ?? "missing"; }
function topologyAt(context: EnergyContext, at: number) { return context.topologyVersions.find((version) => epoch(version.validFrom) <= at && (!version.validTo || epoch(version.validTo) > at)); }
function powerMetric(context: EnergyContext, sample: EnergySample | undefined): TelemetryMetric {
  if (!sample || sample.quality !== "measured" || sample.activePower === null) return missingMetric();
  const binding = context.bindings.find((entry) => entry.id === sample.bindingId);
  const at = epoch(sample.measuredAt);
  if (!binding || at < epoch(binding.validFrom) || (binding.validTo && at >= epoch(binding.validTo))) return missingMetric();
  return { value: sample.activePower * bindingMultiplier(binding), quality: "measured", measuredAt: new Date(at).toISOString(), coverageSeconds: 0, method: null };
}
export function summarizeLatestTelemetry(context: EnergyContext, now = new Date(), options: { freshSeconds?: number; staleSeconds?: number } = {}): PortfolioTelemetry {
  const power: TelemetryPower = { generationKw: missingMetric(), gridKw: missingMetric(), consumptionKw: missingMetric() };
  const observedAt = Math.max(...context.samples.map((sample) => epoch(sample.measuredAt)));
  const topology = Number.isFinite(observedAt) ? topologyAt(context, observedAt) : undefined;
  const configuration = topology ? topologyConfiguration(topology.configuration) : null;
  const latest = (id: string) => context.samples.filter((sample) => sample.measurementPointId === id).sort((a, b) => epoch(b.measuredAt) - epoch(a.measuredAt) || a.eventId.localeCompare(b.eventId))[0];
  let selected: EnergySample[] = [];
  if (configuration && topology) {
    const generation = latest(configuration.generationPointId), grid = latest(configuration.gridPointId);
    const consumption = configuration.consumptionPointId ? latest(configuration.consumptionPointId) : undefined;
    const eligible = (sample: EnergySample | undefined) => sample && epoch(sample.measuredAt) >= epoch(topology.validFrom) && (!topology.validTo || epoch(sample.measuredAt) < epoch(topology.validTo)) ? sample : undefined;
    power.generationKw = powerMetric(context, eligible(generation));
    if (power.generationKw.value !== null && power.generationKw.value < 0) power.generationKw = missingMetric();
    power.gridKw = powerMetric(context, eligible(grid));
    if (configuration.consumptionPointId) {
      power.consumptionKw = powerMetric(context, eligible(consumption));
      if (power.consumptionKw.value !== null && power.consumptionKw.value < 0) power.consumptionKw = missingMetric();
    } else if (power.generationKw.value !== null && power.gridKw.value !== null && power.generationKw.measuredAt === power.gridKw.measuredAt) {
      const value = power.generationKw.value + power.gridKw.value;
      if (value >= -1e-6) power.consumptionKw = { value: Math.max(0, value), quality: "calculated", measuredAt: power.generationKw.measuredAt, coverageSeconds: 0, method: "balance" };
    }
    selected = [generation, grid, ...(configuration.consumptionPointId ? [consumption] : [])].filter((sample): sample is EnergySample => Boolean(sample));
  }
  const samples = selected.length ? selected : context.samples;
  const latestMeasuredAt = samples.length ? new Date(Math.max(...samples.map((sample) => epoch(sample.measuredAt)))).toISOString() : null;
  const received = samples.flatMap((sample) => sample.receivedAt ? [epoch(sample.receivedAt)] : []);
  const latestReceivedAt = received.length ? new Date(Math.max(...received)).toISOString() : null;
  let connection: TelemetryConnection = "missing";
  if (samples.length && configuration) {
    const requiredCount = configuration.consumptionPointId ? 3 : 2;
    const age = Math.max(...samples.map((sample) => Math.max(now.getTime() - epoch(sample.measuredAt), sample.receivedAt ? now.getTime() - epoch(sample.receivedAt) : Infinity))) / 1000;
    const currentTopology = topologyAt(context, now.getTime());
    const allMeasured = currentTopology?.id === topology?.id && selected.length === requiredCount && selected.every((sample) => {
      const binding = context.bindings.find((entry) => entry.id === sample.bindingId);
      return sample.quality === "measured" && sample.activePower !== null && binding && epoch(binding.validFrom) <= now.getTime() && (!binding.validTo || epoch(binding.validTo) > now.getTime());
    });
    connection = !allMeasured || age > (options.staleSeconds ?? 900) ? "offline" : age > (options.freshSeconds ?? 300) ? "stale" : "online";
  }
  return { power, connection, latestMeasuredAt, latestReceivedAt, source: provenance(samples) };
}
export function buildPowerSeries(context: EnergyContext, date: string, maximumBuckets = 288): TelemetryProjection["series"] {
  const window = localDayWindow(date, context.timezone);
  const count = Math.min(288, Math.max(1, Math.trunc(maximumBuckets)));
  const milliseconds = (window.to.getTime() - window.from.getTime()) / count;
  const buckets = new Map<number, EnergySample[]>();
  for (const sample of context.samples) {
    const index = Math.floor((epoch(sample.measuredAt) - window.from.getTime()) / milliseconds);
    if (index < 0 || index >= count) continue;
    const group = buckets.get(index) ?? []; group.push(sample); buckets.set(index, group);
  }
  const formatter = new Intl.DateTimeFormat("es-CO", { timeZone: context.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(window.from.getTime() + index * milliseconds);
    const samples = buckets.get(index) ?? [];
    const summary = summarizeLatestTelemetry({ ...context, samples }, at);
    return { measuredAt: at.toISOString(), hour: formatter.format(at), generationKw: summary.power.generationKw.value, gridKw: summary.power.gridKw.value, consumptionKw: summary.power.consumptionKw.value };
  });
}
function asNumber(value: unknown): number | null { return value == null ? null : Number(value); }
function sampleModel(sample: { eventId: string; bindingId: string; deviceId: string; measurementPointId: string; configurationVersion: number; measuredAt: Date; receivedAt: Date; activePower: unknown; importEnergy: unknown; exportEnergy: unknown; quality: EnergySample["quality"]; source: TelemetrySource }): EnergySample { return { ...sample, activePower: asNumber(sample.activePower), importEnergy: asNumber(sample.importEnergy), exportEnergy: asNumber(sample.exportEnergy) }; }
export async function getPortfolioTelemetry(identity: Actor, organizationId: string): Promise<Record<string, PortfolioTelemetry>> {
  return withTenant(identity, organizationId, async (tx) => {
    const projects = await tx.project.findMany({ where: { organizationId }, include: { measurementPoints: { select: { id: true, kind: true, signConvention: true } }, topologyVersions: true, latestTelemetry: { include: { sample: { include: { binding: true } } } } } });
    const now = new Date();
    return Object.fromEntries(projects.map((project) => [project.id, summarizeLatestTelemetry({ projectId: project.id, timezone: project.timezone, points: project.measurementPoints, topologyVersions: project.topologyVersions, samples: project.latestTelemetry.map((entry) => sampleModel(entry.sample)), bindings: project.latestTelemetry.map((entry) => entry.sample.binding) }, now)]));
  });
}
export async function getTelemetryProjection(identity: Actor, organizationId: string, projectId: string, options: { date?: string } = {}): Promise<TelemetryProjection> {
  return withTenant(identity, organizationId, async (tx) => {
    const project = await tx.project.findFirst({ where: { id: projectId, organizationId }, include: { measurementPoints: { select: { id: true, kind: true, signConvention: true } }, topologyVersions: true, bindings: true, latestTelemetry: { include: { sample: true } } } });
    if (!project) throw new DomainError(404, "NOT_FOUND", "No se encontró el proyecto autorizado.");
    const date = options.date ?? localDateAt(new Date(), project.timezone);
    let window: ReturnType<typeof localDayWindow>;
    try { window = localDayWindow(date, project.timezone); } catch { throw new DomainError(400, "INVALID_DATE", "La fecha no es válida para la zona horaria del proyecto."); }
    const records = await tx.telemetrySample.findMany({ where: { organizationId, binding: { projectId }, measuredAt: { gte: window.from, lt: window.to } }, orderBy: [{ measuredAt: "asc" }, { eventId: "asc" }], take: 200001 });
    if (records.length > 200000) throw new DomainError(413, "DAY_SAMPLE_LIMIT", "El día excede el límite de 200 000 observaciones de esta versión.");
    const saved = await tx.telemetryDailyAggregate.findMany({ where: { organizationId, projectId, localDate: new Date(`${date}T00:00:00.000Z`) } });
    const context: EnergyContext = { projectId, timezone: project.timezone, points: project.measurementPoints, bindings: project.bindings, topologyVersions: project.topologyVersions, samples: records.map(sampleModel) };
    const rows: DailyPointAggregate[] = saved.map((row) => ({ localDate: date, measurementPointId: row.measurementPointId, importEnergyKwh: asNumber(row.importEnergyKwh), exportEnergyKwh: asNumber(row.exportEnergyKwh), integratedPositiveKwh: asNumber(row.integratedPositiveKwh), integratedNegativeKwh: asNumber(row.integratedNegativeKwh), quality: row.quality, sampleCount: row.sampleCount, gapCount: row.gapCount, resetCount: row.resetCount, detailJson: unpackAggregateDetail(row.detailJson) }));
    const composed = composeProjectEnergy(context, date, rows);
    const latest = summarizeLatestTelemetry({ ...context, samples: project.latestTelemetry.map((entry) => sampleModel(entry.sample)) });
    return { ...latest, projectId, timezone: project.timezone, date, dayStart: window.from.toISOString(), dayEnd: window.to.toISOString(), daySource: provenance(context.samples), energyThrough: composed.energyThrough, energy: composed.energy, series: buildPowerSeries(context, date),
      coverage: { coveredSeconds: composed.coveredSeconds, daySeconds: window.seconds, gapCount: rows.reduce((total, row) => total + row.gapCount, 0), resetCount: rows.reduce((total, row) => total + row.resetCount, 0), invalidCount: rows.reduce((total, row) => total + row.detailJson.invalidCount, 0), sampleCount: rows.reduce((total, row) => total + row.sampleCount, 0) } };
  });
}
