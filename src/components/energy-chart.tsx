import { formatNumber } from "@/lib/format";

type PowerSample = {
  hour: string;
  generationKw: number | null;
  consumptionKw: number | null;
  gridKw: number | null;
  measuredAt: string;
};

const series = [
  { key: "generationKw", label: "Generación", color: "#16845b" },
  { key: "consumptionKw", label: "Consumo", color: "#4367a0" },
  { key: "gridKw", label: "Red neta", color: "#b57821" },
] as const;

export function EnergyChart({
  samples,
  id,
  timezoneLabel = "Hora de Colombia",
  description = "Generación y consumo: muestras simuladas. Red: calculada por balance.",
}: {
  samples: PowerSample[];
  id: string;
  timezoneLabel?: string;
  description?: string;
}) {
  const values = samples.flatMap((sample) =>
    series.flatMap(({ key }) => sample[key] === null ? [] : [sample[key]]),
  );
  const width = 900;
  const height = 280;
  const left = 54;
  const right = 22;
  const top = 18;
  const bottom = 42;
  const minimum = values.length ? Math.min(0, ...values) : 0;
  const maximum = values.length ? Math.max(1, ...values) : 1;
  const padding = (maximum - minimum) * 0.1;
  const low = minimum < 0 ? minimum - padding : 0;
  const high = maximum + padding;
  const x = (index: number) => left + (samples.length <= 1 ? (width - left - right) / 2 : index * (width - left - right) / (samples.length - 1));
  const y = (value: number) => top + (high - value) * (height - top - bottom) / (high - low);

  function segments(key: typeof series[number]["key"]) {
    const result: Array<Array<{ index: number; value: number }>> = [];
    let current: Array<{ index: number; value: number }> = [];
    samples.forEach((sample, index) => {
      const value = sample[key];
      if (value === null) {
        if (current.length) result.push(current);
        current = [];
      } else {
        current.push({ index, value });
      }
    });
    if (current.length) result.push(current);
    return result;
  }

  return (
    <div className="chart">
      <ul className="chart-legend" aria-label="Series del gráfico">
        {series.map(({ key, label, color }) => (
          <li key={key}>
            <span className="legend-dot" style={{ backgroundColor: color }} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
      <p className="chart-scroll-hint">Desliza el gráfico para recorrer todas las horas.</p>
      {values.length ? (
        <div className="chart-plot" role="region" aria-label="Gráfico de potencia con desplazamiento horizontal" tabIndex={0}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
          <title id={`${id}-title`}>Generación, consumo e intercambio de red por hora</title>
          <desc id={`${id}-description`}>{description} Valores en kilovatios. Red positiva indica importación y negativa indica exportación. Las lecturas ausentes interrumpen las líneas. La tabla situada debajo contiene los valores.</desc>
          {Array.from({ length: 5 }, (_, index) => {
            const value = low + (high - low) * index / 4;
            return (
              <g key={index}>
                <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e5e9e7" />
                <text x={left - 10} y={y(value) + 4} textAnchor="end" fill="#64716a" fontSize="12">{formatNumber(value, 1)}</text>
              </g>
            );
          })}
          <text x={left} y={height - 3} fill="#64716a" fontSize="12">{timezoneLabel} · kW</text>
          {samples.map((sample, index) => (index % Math.max(1, Math.ceil(samples.length / 7)) === 0 || index === samples.length - 1) && (
            <text key={`${sample.measuredAt}-${index}`} x={x(index)} y={height - 22} textAnchor="middle" fill="#64716a" fontSize="12">{sample.hour}</text>
          ))}
          {low < 0 && <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke="#a1aca6" strokeDasharray="4 4" />}
          {series.map(({ key, color }) => (
            <g key={key}>
              {segments(key).map((segment, index) => (
                <g key={index}>
                  {segment.length > 1 && <polyline points={segment.map((point) => `${x(point.index)},${y(point.value)}`).join(" ")} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
                  {segment.map((point) => <circle key={point.index} cx={x(point.index)} cy={y(point.value)} r="2.6" fill={color} />)}
                </g>
              ))}
            </g>
          ))}
        </svg>
        </div>
      ) : (
        <p className="notice">No hay lecturas de potencia para este período.</p>
      )}
      <p className="muted">{description} Los tramos sin lectura se muestran como huecos. Red +: importación; red −: exportación.</p>
      <details className="chart-table">
        <summary>Consultar valores del gráfico</summary>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">{description} Potencias en kW. Las lecturas ausentes se indican como no disponibles.</caption>
            <thead><tr><th scope="col">{timezoneLabel}</th><th scope="col">Generación (kW)</th><th scope="col">Consumo (kW)</th><th scope="col">Red neta (kW)</th></tr></thead>
            <tbody>
              {samples.map((sample, index) => <tr key={`${sample.measuredAt}-${index}`}><th scope="row">{sample.hour}</th><td>{formatNumber(sample.generationKw)}</td><td>{formatNumber(sample.consumptionKw)}</td><td>{formatNumber(sample.gridKw)}</td></tr>)}
              {!samples.length && <tr><td colSpan={4}>Sin muestras disponibles.</td></tr>}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
