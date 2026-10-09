export type PowerPoint = {
  hour: string;
  measuredAt: string;
  generationKw: number | null;
  consumptionKw: number | null;
  gridKw: number | null;
};

export function gridPower(generationKw: number | null, consumptionKw: number | null) {
  if (generationKw === null || consumptionKw === null) return null;
  return Math.round((consumptionKw - generationKw) * 1000) / 1000;
}

// Integrates linear segments, splitting import/export where signed power crosses zero.
// Gaps are never interpolated. Values are a simulated calculation, not meter counters.
export function integrateDailyEnergy(series: PowerPoint[]) {
  let intervals = 0;
  let generationKwh = 0;
  let consumptionKwh = 0;
  let gridImportKwh = 0;
  let gridExportKwh = 0;
  let energyThrough: string | null = null;
  for (let index = 1; index < series.length; index += 1) {
    const a = series[index - 1];
    const b = series[index];
    if ([a.generationKw, a.consumptionKw, a.gridKw, b.generationKw, b.consumptionKw, b.gridKw].some((value) => value === null)) continue;
    const hours = (Date.parse(b.measuredAt) - Date.parse(a.measuredAt)) / 3_600_000;
    if (hours <= 0 || hours > 1) throw new Error("La integración requiere intervalos consecutivos de hasta una hora.");
    // Nulls have been excluded together to preserve the three-channel energy balance.
    const generationA = a.generationKw as number;
    const generationB = b.generationKw as number;
    const consumptionA = a.consumptionKw as number;
    const consumptionB = b.consumptionKw as number;
    const gridA = a.gridKw as number;
    const gridB = b.gridKw as number;
    generationKwh += ((generationA + generationB) / 2) * hours;
    consumptionKwh += ((consumptionA + consumptionB) / 2) * hours;
    if (gridA * gridB < 0) {
      const fractionA = Math.abs(gridA) / (Math.abs(gridA) + Math.abs(gridB));
      const areaA = (Math.abs(gridA) * hours * fractionA) / 2;
      const areaB = (Math.abs(gridB) * hours * (1 - fractionA)) / 2;
      gridImportKwh += gridA > 0 ? areaA : areaB;
      gridExportKwh += gridA < 0 ? areaA : areaB;
    } else {
      const signedEnergy = ((gridA + gridB) / 2) * hours;
      gridImportKwh += Math.max(0, signedEnergy);
      gridExportKwh += Math.max(0, -signedEnergy);
    }
    intervals += 1;
    energyThrough = b.measuredAt;
  }
  if (intervals === 0) {
    return { generationKwh: null, consumptionKwh: null, gridImportKwh: null, gridExportKwh: null, energyThrough: null };
  }
  // Retain precision for aggregation; the presentation rounds individual readings.
  return { generationKwh, consumptionKwh, gridImportKwh, gridExportKwh, energyThrough };
}
