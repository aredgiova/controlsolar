import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import type { ReportSnapshot } from "./snapshot";
import type { TelemetryMetric } from "../telemetry/energy";
const labels = { measured: "Medida", calculated: "Calculada", estimated: "Estimada", missing: "Sin datos" };
const origins = { simulator: "SIMULADA", aws_iot: "AWS IoT", mixed: "MIXTA", missing: "Sin datos" };
const codes = { measured: "M", calculated: "C", estimated: "E", missing: "F" };
const number = (value: number | null) => value === null ? "-" : Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 0.001) ? value.toExponential(3).replace(".", ",") : value.toLocaleString("es-CO", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const printable = (value: string) => value.replace(/[^\u0020-\u007E\u00A0-\u00FF]/gu, "?");
export async function renderReportPdf(snapshot: ReportSnapshot): Promise<Uint8Array> {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(`Informe solar ${snapshot.startDate} a ${snapshot.endDate}`); doc.setAuthor("Monitoreo Solar"); doc.setCreationDate(new Date(snapshot.generatedAt)); doc.setModificationDate(new Date(snapshot.generatedAt));
  const ink = rgb(0.09, 0.16, 0.22), muted = rgb(0.34, 0.40, 0.45), green = rgb(0.04, 0.42, 0.32), pale = rgb(0.94, 0.97, 0.96);
  let page!: PDFPage; let y = 0;
  function text(value: string, x: number, at: number, size = 10, face: PDFFont = font, color = ink) { page.drawText(printable(value), { x, y: at, size, font: face, color }); }
  function newPage() { page = doc.addPage([595.28, 841.89]); y = 786; text("MONITOREO SOLAR", 44, y, 11, bold, green); text(`${snapshot.startDate} / ${snapshot.endDate}`, 390, y, 9, font, muted); y -= 34; }
  function ensure(height: number) { if (y - height < 65) newPage(); }
  function wrapped(value: string, size = 10, color = ink) {
    const words: string[] = [];
    for (const word of printable(value).split(/\s+/)) { let fragment = ""; for (const character of word) { if (font.widthOfTextAtSize(fragment + character, size) > 506 && fragment) { words.push(fragment); fragment = ""; } fragment += character; } if (fragment) words.push(fragment); }
    let line = "";
    for (const word of words) { const next = line ? `${line} ${word}` : word; if (font.widthOfTextAtSize(next, size) > 506 && line) { ensure(16); text(line, 44, y, size, font, color); y -= 15; line = word; } else line = next; }
    if (line) { ensure(16); text(line, 44, y, size, font, color); y -= 15; }
  }
  newPage(); text("Informe de energía", 44, y, 25, bold); y -= 32; wrapped(snapshot.projectName, 14); wrapped(`Proyecto: ${snapshot.projectId}`, 8, muted); wrapped(`Zona del informe: ${snapshot.timezone}. Fechas locales inclusivas.`, 10, muted); y -= 12;
  page.drawRectangle({ x: 44, y: y - 42, width: 507, height: 55, color: pale }); text(`Origen: ${origins[snapshot.source]}`, 56, y - 4, 12, bold, green); text("La calidad de cálculo y el origen se indican por separado.", 56, y - 23, 9, font, muted); y -= 70;
  const metrics: [string, TelemetryMetric][] = [["Generación", snapshot.energy.generationKwh], ["Importación de red", snapshot.energy.gridImportKwh], ["Exportación de red", snapshot.energy.gridExportKwh], ["Consumo", snapshot.energy.consumptionKwh]];
  metrics.forEach(([label, metric], index) => { const x = index % 2 === 0 ? 44 : 306; const rowY = y - Math.floor(index / 2) * 76; text(label, x, rowY, 10, bold); text(`${number(metric.value)} kWh`, x, rowY - 24, 21, bold, green); text(`${labels[metric.quality]} / cobertura ${(metric.coverageSeconds / 3600).toFixed(2)} h`, x, rowY - 42, 9, font, muted); }); y -= 160;
  wrapped(`Cobertura común: ${(snapshot.coverage.coveredSeconds / 3600).toFixed(2)} de ${(snapshot.coverage.daySeconds / 3600).toFixed(2)} h. Observaciones: ${snapshot.coverage.sampleCount}. Huecos: ${snapshot.coverage.gapCount}. Reinicios de contador: ${snapshot.coverage.resetCount}. Inválidas: ${snapshot.coverage.invalidCount}.`, 9, muted); y -= 10;
  wrapped("Un guion significa dato ausente. Los totales se omiten si falta un día; no se completan con ceros. El balance usa intervalos comunes y conserva la calidad estimada cuando hay prorrateo.", 9, muted); y -= 15;
  const columns = [44, 111, 185, 259, 333, 407, 475];
  function tableHeader() { ensure(48); text("Detalle diario (kWh)", 44, y, 13, bold); y -= 26; ["Fecha", "Generación", "Importación", "Exportación", "Consumo", "Cobertura", "Origen"].forEach((label, index) => text(label, columns[index], y, 8, bold)); y -= 18; }
  tableHeader();
  for (const day of snapshot.days) {
    if (y < 100) { newPage(); tableHeader(); }
    page.drawLine({ start: { x: 44, y: y + 10 }, end: { x: 551, y: y + 10 }, thickness: 0.3, color: rgb(0.8, 0.85, 0.83) });
    const metric = (value: TelemetryMetric) => `${number(value.value)} ${codes[value.quality]}`;
    [day.date, metric(day.energy.generationKwh), metric(day.energy.gridImportKwh), metric(day.energy.gridExportKwh), metric(day.energy.consumptionKwh), `${(day.coverage.coveredSeconds / 3600).toFixed(2)} h`, origins[day.source]].forEach((value, index) => text(value, columns[index], y, index === 6 ? 7 : 8)); y -= 24;
  }
  y -= 6; wrapped("Calidad: M = medida; C = calculada; E = estimada; F = sin datos. SIMULADA identifica datos del simulador, aunque sus contadores produzcan una diferencia medida. Cifras redondeadas; valores extremos usan notación científica. El snapshot conserva la precisión de cálculo.", 8, muted); y -= 14;
  ensure(95); text("Trazabilidad del informe", 44, y, 13, bold); y -= 24;
  wrapped(`Solicitado: ${snapshot.requestedAt}. Generado: ${snapshot.generatedAt}.`, 8, muted);
  wrapped(`Informe: ${snapshot.reportId}. Snapshot: ${snapshot.schemaVersion}. Método: ${snapshot.basis.methodVersion}; integración máxima ${snapshot.basis.integrationGapSeconds} s.`, 8, muted);
  wrapped(`Versiones de topología incluidas: ${snapshot.basis.topologies.map((entry) => `${entry.version} (${entry.id})`).join(", ") || "ninguna"}.`, 8, muted);
  wrapped(`Bindings temporales: ${snapshot.basis.bindings.map((entry) => `${entry.id} / configuración ${entry.configurationVersion}`).join(", ") || "ninguno"}.`, 8, muted);
  wrapped("Este documento conserva la zona, versiones y resultados del snapshot al generarse; nuevas lecturas tardías requieren un nuevo informe. No certifica precisión física ni sustituye la puesta en servicio.", 8, muted);
  const pages = doc.getPages(); pages.forEach((entry, index) => { entry.drawText(`Informe privado / ${index + 1} de ${pages.length}`, { x: 44, y: 35, size: 8, font, color: muted }); });
  return doc.save();
}
