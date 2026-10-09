import { EnergyChart } from "./energy-chart";
import { EmptyState, Metric, StatusBadge } from "./ui";
import { formatNumber } from "@/lib/format";
import { getTelemetryProjection } from "@/modules/telemetry/queries";
import type { Actor } from "@/modules/organizations/access";

const qualities = { measured: "Medida", calculated: "Calculada", estimated: "Estimada", missing: "Sin datos" };
const sources = { simulator: "Simulador local", aws_iot: "Gateway AWS IoT", mixed: "Simulador y gateway AWS IoT", missing: "Sin lecturas recibidas" };
function validDate(value?: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : undefined;
}

export async function ProjectTelemetry({ identity, organizationId, projectId, date }: { identity: Actor; organizationId: string; projectId: string; date?: string }) {
  const selectedDate = validDate(date);
  const telemetry = await getTelemetryProjection(identity, organizationId, projectId, { date: selectedDate });
  const localTime = (value: string | null) => value ? new Intl.DateTimeFormat("es-CO", { timeZone: telemetry.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Sin datos";
  const quality = (metric: { quality: keyof typeof qualities; measuredAt: string | null }) => `${qualities[metric.quality]}${metric.measuredAt ? ` · ${localTime(metric.measuredAt)}` : ""}`;
  const energyNote = (metric: { quality: keyof typeof qualities; coverageSeconds: number }) => `${qualities[metric.quality]} · ${formatNumber(metric.coverageSeconds / 3600, 2)} h con cobertura`;
  const simulation = telemetry.source === "simulator" || telemetry.source === "mixed";
  return <>
    <section className="panel" aria-labelledby="telemetry-state-title">
      <div className="panel-header"><h2 className="section-title" id="telemetry-state-title">Recepción de mediciones</h2>{telemetry.connection !== "missing" && <StatusBadge status={telemetry.connection} />}</div>
      <p className={simulation ? "notice notice-warning" : "notice"}>{sources[telemetry.source]}{simulation ? ". Incluye valores ficticios para probar la ingesta; no representan mediciones físicas." : "."}</p>
      <dl className="definition-list"><div><dt>Última medición</dt><dd>{localTime(telemetry.latestMeasuredAt)}</dd></div><div><dt>Última recepción</dt><dd>{localTime(telemetry.latestReceivedAt)}</dd></div><div><dt>Zona horaria</dt><dd>{telemetry.timezone}</dd></div></dl>
      {telemetry.connection === "stale" || telemetry.connection === "offline" ? <p className="muted">La última lectura está desactualizada. Un reenvío de datos históricos no confirma que haya mediciones recientes.</p> : null}
    </section>
    <section aria-labelledby="received-power-title"><div className="detail-heading"><h2 className="section-title" id="received-power-title">Potencia de la última lectura</h2><span className="muted">Independiente de la fecha consultada</span></div><div className="metric-grid">
      <Metric label="Generación solar" value={formatNumber(telemetry.power.generationKw.value)} unit={telemetry.power.generationKw.value === null ? undefined : "kW"} note={quality(telemetry.power.generationKw)} />
      <Metric label="Consumo" value={formatNumber(telemetry.power.consumptionKw.value)} unit={telemetry.power.consumptionKw.value === null ? undefined : "kW"} note={quality(telemetry.power.consumptionKw)} />
      <Metric label="Intercambio de red" value={formatNumber(telemetry.power.gridKw.value)} unit={telemetry.power.gridKw.value === null ? undefined : "kW"} note={quality(telemetry.power.gridKw)} />
    </div><p className="muted">Los valores calculados usan el balance entre puntos compatibles y alineados. Sin lectura suficiente, se indica «No disponible».</p></section>
    <section className="panel" aria-labelledby="received-day-title"><div className="panel-header"><div><h2 className="section-title" id="received-day-title">Consulta diaria</h2><p className="muted">La fecha y las horas corresponden a {telemetry.timezone}.</p></div></div>
      <form action={`/projects/${projectId}`} className="toolbar telemetry-filter"><input type="hidden" name="org" value={organizationId} /><label className="field">Fecha de medición<input type="date" name="date" defaultValue={telemetry.date} required /></label><button type="submit" className="button button-secondary">Consultar fecha</button></form>
      {date && !selectedDate && <p role="status" className="notice notice-warning">La fecha no es válida. Se muestra el día actual del proyecto.</p>}
      <EnergyChart id={`received-${projectId}`} samples={telemetry.series} timezoneLabel={telemetry.timezone} description={`${sources[telemetry.daySource]}. Generación y red: puntos de medición; consumo: medido o calculado según la topología vigente.`} />
    </section>
    <section aria-labelledby="received-energy-title"><div className="detail-heading"><h2 className="section-title" id="received-energy-title">Energía del {telemetry.date}</h2><span className="muted">Acumulados de los intervalos cubiertos</span></div><div className="metric-grid">
      <Metric label="Generación" value={formatNumber(telemetry.energy.generationKwh.value)} unit={telemetry.energy.generationKwh.value === null ? undefined : "kWh"} note={energyNote(telemetry.energy.generationKwh)} />
      <Metric label="Consumo" value={formatNumber(telemetry.energy.consumptionKwh.value)} unit={telemetry.energy.consumptionKwh.value === null ? undefined : "kWh"} note={energyNote(telemetry.energy.consumptionKwh)} />
      <Metric label="Importación de red" value={formatNumber(telemetry.energy.gridImportKwh.value)} unit={telemetry.energy.gridImportKwh.value === null ? undefined : "kWh"} note={energyNote(telemetry.energy.gridImportKwh)} />
      <Metric label="Exportación de red" value={formatNumber(telemetry.energy.gridExportKwh.value)} unit={telemetry.energy.gridExportKwh.value === null ? undefined : "kWh"} note={energyNote(telemetry.energy.gridExportKwh)} />
    </div><p className="muted">{sources[telemetry.daySource]}. {telemetry.energyThrough ? `Cobertura hasta ${localTime(telemetry.energyThrough)}. ` : "No hay intervalos suficientes para calcular energía. "}Medida: diferencia de contadores. Estimada: integración de potencia. Los huecos y reinicios interrumpen los intervalos.</p>
      <p className="muted">{telemetry.coverage.sampleCount} muestras · {telemetry.coverage.gapCount} huecos · {telemetry.coverage.resetCount} reinicios · {telemetry.coverage.invalidCount} lecturas inválidas. Un acumulado parcial no representa un día completo.</p>
    </section>
    {telemetry.source === "missing" && <EmptyState title="Aún no hay mediciones" description="Las lecturas aparecerán cuando un administrador vincule los medidores del proyecto y autorice su gateway desde Dispositivos." />}
  </>;
}
