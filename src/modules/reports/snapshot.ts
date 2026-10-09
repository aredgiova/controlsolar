import { buildDailyPointAggregates, composeProjectEnergy, localDayWindow, missingMetric, type EnergyContext, type EnergyMetrics, type TelemetryMetric } from "../telemetry/energy";
export type ReportSource = "simulator" | "aws_iot" | "mixed" | "missing";
export interface ReportDay { date: string; from: string; to: string; energyThrough: string | null; energy: EnergyMetrics; source: ReportSource; coverage: { coveredSeconds: number; daySeconds: number; gapCount: number; resetCount: number; invalidCount: number; sampleCount: number } }
export interface ReportSnapshot {
  schemaVersion: "solar-report/1.0"; reportId: string; organizationId: string; projectId: string; projectName: string;
  timezone: string; startDate: string; endDate: string; generatedAt: string; requestedAt: string;
  source: ReportSource; energy: EnergyMetrics; coverage: ReportDay["coverage"]; days: ReportDay[];
  basis: { methodVersion: "energy-v2"; integrationGapSeconds: number; topologies: EnergyContext["topologyVersions"]; bindings: EnergyContext["bindings"] };
}
export function reportDay(context: EnergyContext, date: string, integrationGapSeconds = 300): ReportDay {
  const rows = buildDailyPointAggregates(context, date, { maxIntegrationGapSeconds: integrationGapSeconds });
  const energy = composeProjectEnergy(context, date, rows); const window = localDayWindow(date, context.timezone);
  const sources = new Set(rows.flatMap((row) => row.detailJson.source === "mixed" ? ["simulator", "aws_iot"] : row.detailJson.source === "missing" ? [] : [row.detailJson.source]));
  return { date, from: window.from.toISOString(), to: window.to.toISOString(), energyThrough: energy.energyThrough, energy: energy.energy, source: sources.size > 1 ? "mixed" : sources.values().next().value as ReportSource | undefined ?? "missing",
    coverage: { coveredSeconds: energy.coveredSeconds, daySeconds: window.seconds, gapCount: rows.reduce((sum, row) => sum + row.gapCount, 0), resetCount: rows.reduce((sum, row) => sum + row.resetCount, 0), invalidCount: rows.reduce((sum, row) => sum + row.detailJson.invalidCount, 0), sampleCount: rows.reduce((sum, row) => sum + row.sampleCount, 0) } };
}
function aggregateMetric(values: TelemetryMetric[]): TelemetryMetric {
  if (!values.length || values.some((metric) => metric.value === null)) return { ...missingMetric(), coverageSeconds: values.reduce((sum, metric) => sum + metric.coverageSeconds, 0) };
  const quality = values.some((metric) => metric.quality === "estimated") ? "estimated" : values.some((metric) => metric.quality === "calculated") ? "calculated" : "measured";
  const methods = new Set(values.map((metric) => metric.method));
  return { value: values.reduce((sum, metric) => sum + metric.value!, 0), quality, coverageSeconds: values.reduce((sum, metric) => sum + metric.coverageSeconds, 0), measuredAt: values.map((metric) => metric.measuredAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null, method: methods.size === 1 ? values[0].method : null };
}
export function finalizeSnapshot(input: Omit<ReportSnapshot, "schemaVersion" | "source" | "energy" | "coverage">): ReportSnapshot {
  if (!input.days.length || input.days.length > 31) throw new Error("El informe requiere entre 1 y 31 días.");
  const sources = new Set(input.days.flatMap((day) => day.source === "mixed" ? ["simulator", "aws_iot"] : day.source === "missing" ? [] : [day.source]));
  const energy = Object.fromEntries((Object.keys(input.days[0].energy) as (keyof EnergyMetrics)[]).map((key) => [key, aggregateMetric(input.days.map((day) => day.energy[key]))])) as EnergyMetrics;
  const coverage = Object.fromEntries((Object.keys(input.days[0].coverage) as (keyof ReportDay["coverage"])[]).map((key) => [key, input.days.reduce((sum, day) => sum + day.coverage[key], 0)])) as ReportDay["coverage"];
  return { ...input, schemaVersion: "solar-report/1.0", source: sources.size > 1 ? "mixed" : sources.values().next().value as ReportSource | undefined ?? "missing", energy, coverage };
}
