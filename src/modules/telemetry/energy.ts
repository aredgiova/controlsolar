import type { TelemetryQuality, TelemetrySource } from "./protocol";

export type PointKind = "generation" | "consumption" | "grid";
export interface EnergySample {
  eventId: string; bindingId: string; deviceId: string; measurementPointId: string; configurationVersion: number;
  measuredAt: Date | string; receivedAt?: Date | string; activePower: number | null;
  importEnergy: number | null; exportEnergy: number | null; quality: TelemetryQuality; source: TelemetrySource;
}
export interface EnergyBinding { id: string; measurementPointId: string; deviceId: string; configurationVersion: number; validFrom: Date | string; validTo: Date | string | null; configuration: unknown }
export interface EnergyTopology { id: string; version: number; validFrom: Date | string; validTo: Date | string | null; configuration: unknown }
export interface EnergyContext { projectId: string; timezone: string; points: { id: string; kind: PointKind; signConvention?: string }[]; bindings: EnergyBinding[]; topologyVersions: EnergyTopology[]; samples: EnergySample[] }
export interface EnergyInterval { from: string; to: string; positiveKwh: number; negativeKwh: number; quality: "measured" | "estimated"; bindingId: string; method: "meter_counter" | "power_integration"; source: TelemetrySource; startPower: number | null; endPower: number | null }
export interface DailyPointAggregate {
  localDate: string; measurementPointId: string; importEnergyKwh: number | null; exportEnergyKwh: number | null;
  integratedPositiveKwh: number | null; integratedNegativeKwh: number | null;
  sampleCount: number; gapCount: number; resetCount: number; quality: "measured" | "estimated" | "missing";
  detailJson: { coverageSeconds: number; daySeconds: number; firstAt: string | null; lastAt: string | null; source: TelemetrySource | "mixed" | "missing"; invalidCount: number; intervals: EnergyInterval[] };
}
type PackedInterval = [string, string, number, number, EnergyInterval["quality"], string, EnergyInterval["method"], TelemetrySource, number | null, number | null];
/** Repeated JSON keys otherwise exceed a single PostgreSQL row budget at 5-second polling. */
export function packDailyAggregate(row: DailyPointAggregate) {
  return { ...row, detailJson: { ...row.detailJson, intervalEncoding: "tuple-v1", intervals: row.detailJson.intervals.map((interval): PackedInterval => [interval.from, interval.to, interval.positiveKwh, interval.negativeKwh, interval.quality, interval.bindingId, interval.method, interval.source, interval.startPower, interval.endPower]) } };
}
export function unpackAggregateDetail(value: unknown): DailyPointAggregate["detailJson"] {
  if (!value || typeof value !== "object" || !("intervals" in value) || !Array.isArray(value.intervals)) throw new Error("Agregado diario inválido.");
  const detail = value as Record<string, unknown>;
  if (detail.intervalEncoding === undefined) return value as DailyPointAggregate["detailJson"];
  if (detail.intervalEncoding !== "tuple-v1") throw new Error("Formato de intervalos no compatible.");
  const intervals = value.intervals.map((entry: unknown): EnergyInterval => {
    if (!Array.isArray(entry) || entry.length !== 10) throw new Error("Intervalo diario inválido.");
    const [from, to, positiveKwh, negativeKwh, quality, bindingId, method, source, startPower, endPower] = entry as PackedInterval;
    if (typeof from !== "string" || typeof to !== "string" || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from) || !Number.isFinite(positiveKwh) || positiveKwh < 0 || !Number.isFinite(negativeKwh) || negativeKwh < 0 || !["measured", "estimated"].includes(quality) || typeof bindingId !== "string" || !["meter_counter", "power_integration"].includes(method) || !["simulator", "aws_iot"].includes(source) || (startPower !== null && !Number.isFinite(startPower)) || (endPower !== null && !Number.isFinite(endPower))) throw new Error("Intervalo diario inválido.");
    return { from, to, positiveKwh, negativeKwh, quality, bindingId, method, source, startPower, endPower };
  });
  return { ...value as DailyPointAggregate["detailJson"], intervals };
}
export interface TelemetryMetric { value: number | null; quality: "measured" | "calculated" | "estimated" | "missing"; measuredAt: string | null; coverageSeconds: number; method: "meter_counter" | "power_integration" | "balance" | null }
export type EnergyMetrics = { generationKwh: TelemetryMetric; gridImportKwh: TelemetryMetric; gridExportKwh: TelemetryMetric; consumptionKwh: TelemetryMetric };
export const DEFAULT_INTEGRATION_GAP_SECONDS = 300;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const time = (value: Date | string) => new Date(value).getTime();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const dayWindows = new Map<string, { date: string; from: Date; to: Date; seconds: number }>();

export function localDateAt(value: Date | string | number, timezone: string): string {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    if (dateFormatters.size >= 64) dateFormatters.delete(dateFormatters.keys().next().value!);
    dateFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function dateNumber(date: string) {
  if (!datePattern.test(date)) throw new Error("Fecha local inválida.");
  const value = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error("Fecha local inválida.");
  return value;
}
export function nextLocalDate(date: string) { return new Date(dateNumber(date) + 86400000).toISOString().slice(0, 10); }
/** Find the first instant in a civil day, including zones that change offset at midnight. */
function dateBoundary(date: string, timezone: string) {
  const center = dateNumber(date);
  let low = center - 36 * 3600000;
  let high = center + 36 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDateAt(mid, timezone) < date) low = mid + 1; else high = mid;
  }
  return low;
}
export function localDayWindow(date: string, timezone: string) {
  const cacheKey = `${timezone}|${date}`;
  const saved = dayWindows.get(cacheKey);
  if (saved) return { ...saved, from: new Date(saved.from), to: new Date(saved.to) };
  const from = dateBoundary(date, timezone);
  if (localDateAt(from, timezone) !== date) throw new Error("La fecha no existe en esta zona horaria.");
  const to = dateBoundary(nextLocalDate(date), timezone);
  const window = { date, from: new Date(from), to: new Date(to), seconds: (to - from) / 1000 };
  if (dayWindows.size >= 512) dayWindows.delete(dayWindows.keys().next().value!);
  dayWindows.set(cacheKey, window);
  return { ...window, from: new Date(window.from), to: new Date(window.to) };
}
export function missingMetric(): TelemetryMetric { return { value: null, quality: "missing", measuredAt: null, coverageSeconds: 0, method: null }; }
export function missingEnergy(): EnergyMetrics { return { generationKwh: missingMetric(), gridImportKwh: missingMetric(), gridExportKwh: missingMetric(), consumptionKwh: missingMetric() }; }
export function bindingMultiplier(binding: EnergyBinding): number {
  if (binding.configuration && typeof binding.configuration === "object" && "multiplier" in binding.configuration) {
    const multiplier = Number(binding.configuration.multiplier);
    if (Number.isFinite(multiplier) && multiplier > 0 && multiplier <= 100000) return multiplier;
    throw new Error("Multiplicador de medición inválido en el registro.");
  }
  return 1;
}
/** Linear signed integration splits at zero; import and export never cancel each other. */
export function signedPowerEnergy(startKw: number, endKw: number, seconds: number) {
  if (![startKw, endKw, seconds].every(Number.isFinite) || seconds <= 0) throw new Error("Intervalo de potencia inválido.");
  const hours = seconds / 3600;
  if (startKw * endKw < 0) {
    const fraction = Math.abs(startKw) / (Math.abs(startKw) + Math.abs(endKw));
    const first = Math.abs(startKw) * hours * fraction / 2;
    const second = Math.abs(endKw) * hours * (1 - fraction) / 2;
    return { positiveKwh: startKw > 0 ? first : second, negativeKwh: startKw < 0 ? first : second };
  }
  const signed = (startKw + endKw) * hours / 2;
  return { positiveKwh: Math.max(0, signed), negativeKwh: Math.max(0, -signed) };
}
function withinBinding(sample: EnergySample, binding: EnergyBinding) {
  const at = time(sample.measuredAt);
  return sample.deviceId === binding.deviceId && sample.configurationVersion === binding.configurationVersion &&
    at >= time(binding.validFrom) && (binding.validTo === null || at < time(binding.validTo));
}
function usableSamples(samples: EnergySample[]) {
  const distinct = [...new Map(samples.map((sample) => [sample.eventId, sample])).values()].sort((a, b) => time(a.measuredAt) - time(b.measuredAt) || a.eventId.localeCompare(b.eventId));
  const grouped: EnergySample[] = [];
  for (let index = 0; index < distinct.length;) {
    const first = distinct[index];
    let next = index + 1;
    while (next < distinct.length && time(distinct[next].measuredAt) === time(first.measuredAt)) next++;
    grouped.push(next - index === 1 ? first : { ...first, quality: "invalid", activePower: null, importEnergy: null, exportEnergy: null });
    index = next;
  }
  return grouped;
}
export function clipEnergyInterval(interval: EnergyInterval, from: number, to: number): EnergyInterval | null {
  const start = time(interval.from), end = time(interval.to);
  const clippedStart = Math.max(start, from), clippedEnd = Math.min(end, to);
  if (clippedEnd <= clippedStart) return null;
  if (clippedStart === start && clippedEnd === end) return interval;
  const fractionStart = (clippedStart - start) / (end - start), fractionEnd = (clippedEnd - start) / (end - start);
  if (interval.method === "power_integration" && interval.startPower !== null && interval.endPower !== null) {
    const startPower = interval.startPower + (interval.endPower - interval.startPower) * fractionStart;
    const endPower = interval.startPower + (interval.endPower - interval.startPower) * fractionEnd;
    return { ...interval, from: new Date(clippedStart).toISOString(), to: new Date(clippedEnd).toISOString(), ...signedPowerEnergy(startPower, endPower, (clippedEnd - clippedStart) / 1000), startPower, endPower, quality: "estimated" };
  }
  const fraction = fractionEnd - fractionStart;
  return { ...interval, from: new Date(clippedStart).toISOString(), to: new Date(clippedEnd).toISOString(), positiveKwh: interval.positiveKwh * fraction, negativeKwh: interval.negativeKwh * fraction, quality: "estimated" };
}
export function buildDailyPointAggregates(context: EnergyContext, date: string, options: { maxIntegrationGapSeconds?: number } = {}): DailyPointAggregate[] {
  const window = localDayWindow(date, context.timezone);
  const from = window.from.getTime(), to = window.to.getTime();
  const maxGap = options.maxIntegrationGapSeconds ?? DEFAULT_INTEGRATION_GAP_SECONDS;
  if (!Number.isFinite(maxGap) || maxGap <= 0 || maxGap > 3600) throw new Error("El intervalo máximo de integración debe estar entre 0 y 3600 segundos.");
  const bindings = new Map(context.bindings.map((binding) => [binding.id, binding]));
  return context.points.map((point) => {
    const samples = usableSamples(context.samples.filter((sample) => sample.measurementPointId === point.id));
    const intervals: EnergyInterval[] = [];
    let gapCount = 0, resetCount = 0;
    for (let index = 1; index < samples.length; index++) {
      const a = samples[index - 1], b = samples[index];
      const start = time(a.measuredAt), end = time(b.measuredAt), seconds = (end - start) / 1000;
      if (seconds <= 0 || end <= from || start >= to) continue;
      const binding = bindings.get(a.bindingId);
      if (a.quality !== "measured" || b.quality !== "measured" || !binding || a.bindingId !== b.bindingId || !withinBinding(a, binding) || !withinBinding(b, binding) || a.source !== b.source) { gapCount++; continue; }
      const multiplier = bindingMultiplier(binding);
      const positive = a.importEnergy !== null && b.importEnergy !== null ? (b.importEnergy - a.importEnergy) * multiplier : null;
      const negative = point.kind === "grid" && a.exportEnergy !== null && b.exportEnergy !== null ? (b.exportEnergy - a.exportEnergy) * multiplier : point.kind === "grid" ? null : 0;
      const reset = (positive !== null && positive < -1e-9) || (negative !== null && negative < -1e-9);
      if (reset) resetCount++;
      if (seconds > maxGap) gapCount++;
      let interval: EnergyInterval | null = null;
      if (!reset && positive !== null && negative !== null) {
        interval = { from: new Date(start).toISOString(), to: new Date(end).toISOString(), positiveKwh: Math.max(0, positive), negativeKwh: Math.max(0, negative), quality: "measured", bindingId: binding.id, method: "meter_counter", source: a.source, startPower: null, endPower: null };
      } else if (seconds <= maxGap && a.activePower !== null && b.activePower !== null && (point.kind === "grid" || (a.activePower >= 0 && b.activePower >= 0))) {
        const startPower = a.activePower * multiplier, endPower = b.activePower * multiplier;
        interval = { from: new Date(start).toISOString(), to: new Date(end).toISOString(), ...signedPowerEnergy(startPower, endPower, seconds), quality: "estimated", bindingId: binding.id, method: "power_integration", source: a.source, startPower, endPower };
      } else if (seconds <= maxGap) gapCount++;
      if (interval) { const clipped = clipEnergyInterval(interval, from, to); if (clipped) intervals.push(clipped); }
    }
    const sum = (method: EnergyInterval["method"], key: "positiveKwh" | "negativeKwh") => { const entries = intervals.filter((interval) => interval.method === method); return entries.length ? entries.reduce((total, interval) => total + interval[key], 0) : null; };
    const sources = new Set(intervals.map((interval) => interval.source));
    const daySamples = samples.filter((sample) => time(sample.measuredAt) >= from && time(sample.measuredAt) < to);
    return { localDate: date, measurementPointId: point.id, importEnergyKwh: sum("meter_counter", "positiveKwh"), exportEnergyKwh: sum("meter_counter", "negativeKwh"), integratedPositiveKwh: sum("power_integration", "positiveKwh"), integratedNegativeKwh: sum("power_integration", "negativeKwh"),
      sampleCount: daySamples.length, gapCount, resetCount, quality: intervals.length === 0 ? "missing" : intervals.some((interval) => interval.quality === "estimated") ? "estimated" : "measured",
      detailJson: { coverageSeconds: intervals.reduce((total, interval) => total + (time(interval.to) - time(interval.from)) / 1000, 0), daySeconds: window.seconds, firstAt: intervals[0]?.from ?? null, lastAt: intervals.at(-1)?.to ?? null, source: sources.size > 1 ? "mixed" : sources.values().next().value ?? "missing", invalidCount: daySamples.filter((sample) => sample.quality === "invalid").length, intervals } };
  });
}
export interface TopologyConfiguration { type: "grid_tied_no_battery"; generationPointId: string; gridPointId: string; consumptionPointId: string | null }
export function topologyConfiguration(value: unknown): TopologyConfiguration | null {
  if (!value || typeof value !== "object") return null;
  const configuration = value as Partial<TopologyConfiguration>;
  if (configuration.type !== "grid_tied_no_battery" || typeof configuration.generationPointId !== "string" || typeof configuration.gridPointId !== "string" || (configuration.consumptionPointId != null && typeof configuration.consumptionPointId !== "string")) return null;
  const ids = [configuration.generationPointId, configuration.gridPointId, ...(configuration.consumptionPointId ? [configuration.consumptionPointId] : [])];
  if (new Set(ids).size !== ids.length) return null;
  return { type: configuration.type, generationPointId: configuration.generationPointId, gridPointId: configuration.gridPointId, consumptionPointId: configuration.consumptionPointId ?? null };
}
/** All displayed project totals share intervals and topology; no subtraction of unrelated daily totals. */
export function composeProjectEnergy(context: EnergyContext, date: string, aggregates: DailyPointAggregate[]): { energy: EnergyMetrics; coveredSeconds: number; energyThrough: string | null } {
  const window = localDayWindow(date, context.timezone);
  const energy = missingEnergy();
  let coveredSeconds = 0;
  const contributions: Record<keyof EnergyMetrics, { value: number; quality: TelemetryMetric["quality"]; method: TelemetryMetric["method"]; to: string; seconds: number }[]> = { generationKwh: [], gridImportKwh: [], gridExportKwh: [], consumptionKwh: [] };
  const intervalMap = new Map(aggregates.map((aggregate) => [aggregate.measurementPointId, aggregate.detailJson.intervals]));
  for (const topology of [...context.topologyVersions].sort((a, b) => time(a.validFrom) - time(b.validFrom))) {
    const configuration = topologyConfiguration(topology.configuration);
    if (!configuration) continue;
    const start = Math.max(window.from.getTime(), time(topology.validFrom));
    const end = Math.min(window.to.getTime(), topology.validTo ? time(topology.validTo) : Infinity);
    if (end <= start) continue;
    const lists = [configuration.generationPointId, configuration.gridPointId, ...(configuration.consumptionPointId ? [configuration.consumptionPointId] : [])].map((id) => intervalMap.get(id) ?? []);
    const cursors = lists.map(() => 0);
    while (lists.every((list, index) => cursors[index] < list.length)) {
      const intervals = lists.map((list, index) => list[cursors[index]]);
      const from = Math.max(start, ...intervals.map((interval) => time(interval.from)));
      const to = Math.min(end, ...intervals.map((interval) => time(interval.to)));
      if (to > from) {
        const pieces = intervals.map((interval) => clipEnergyInterval(interval, from, to)!);
        const consumption = configuration.consumptionPointId ? pieces[2].positiveKwh : pieces[0].positiveKwh + pieces[1].positiveKwh - pieces[1].negativeKwh;
        if (consumption >= -1e-6) {
          const seconds = (to - from) / 1000;
          const endpoint = new Date(to).toISOString();
          const pieceQuality = (piece: EnergyInterval) => piece.quality === "estimated" ? "estimated" as const : "measured" as const;
          contributions.generationKwh.push({ value: pieces[0].positiveKwh, quality: pieceQuality(pieces[0]), method: pieces[0].method, to: endpoint, seconds });
          contributions.gridImportKwh.push({ value: pieces[1].positiveKwh, quality: pieceQuality(pieces[1]), method: pieces[1].method, to: endpoint, seconds });
          contributions.gridExportKwh.push({ value: pieces[1].negativeKwh, quality: pieceQuality(pieces[1]), method: pieces[1].method, to: endpoint, seconds });
          contributions.consumptionKwh.push({ value: Math.max(0, consumption), quality: configuration.consumptionPointId ? pieceQuality(pieces[2]) : pieces.some((piece) => piece.quality === "estimated") ? "estimated" : "calculated", method: configuration.consumptionPointId ? pieces[2].method : "balance", to: endpoint, seconds });
          coveredSeconds += seconds;
        }
      }
      const earliest = Math.min(...intervals.map((interval) => time(interval.to)));
      intervals.forEach((interval, index) => { if (time(interval.to) === earliest) cursors[index]++; });
      if (earliest >= end) break;
    }
  }
  for (const key of Object.keys(contributions) as (keyof EnergyMetrics)[]) {
    const parts = contributions[key];
    if (!parts.length) continue;
    energy[key] = { value: parts.reduce((total, part) => total + part.value, 0), quality: parts.some((part) => part.quality === "estimated") ? "estimated" : parts.some((part) => part.quality === "calculated") ? "calculated" : "measured", measuredAt: parts.at(-1)!.to, coverageSeconds: parts.reduce((total, part) => total + part.seconds, 0), method: parts.some((part) => part.method === "balance") ? "balance" : parts.some((part) => part.method === "power_integration") ? "power_integration" : "meter_counter" };
  }
  return { energy, coveredSeconds, energyThrough: energy.consumptionKwh.measuredAt };
}
