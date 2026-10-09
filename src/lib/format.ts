export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "No disponible";
  return new Intl.NumberFormat("es-CO", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

export function formatDate(value: string | null | undefined, timezone = "America/Bogota"): string {
  if (!value) return "Sin datos recibidos";
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium", timeStyle: "short", timeZone: timezone,
  }).format(new Date(value));
}
