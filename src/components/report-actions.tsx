"use client";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
type ReportItem = { id: string; timezone: string; startDate: string; endDate: string; status: "queued" | "processing" | "completed" | "failed"; createdAt: string; errorCode: string | null };
const statusLabels = { queued: "Pendiente", processing: "Generando", completed: "Disponible", failed: "No se pudo generar" };
function todayAt(timezone: string) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}-${parts.find((part) => part.type === "day")!.value}`; }
async function responseError(response: Response) { try { const body = await response.json(); return typeof body.error?.message === "string" ? body.error.message : "No se pudo completar la operación."; } catch { return "No se pudo completar la operación."; } }
async function loadReports(endpoint: string, signal?: AbortSignal): Promise<ReportItem[]> { const response = await fetch(endpoint, { cache: "no-store", signal }); if (!response.ok) throw new Error(await responseError(response)); return (await response.json()).items; }
export function ReportActions({ organizationId, projectId, timezone }: { organizationId: string; projectId: string; timezone: string }) {
  const id = useId(), today = todayAt(timezone); const [startDate, setStartDate] = useState(today), [endDate, setEndDate] = useState(today);
  const [items, setItems] = useState<ReportItem[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const base = `/api/v1/organizations/${organizationId}`, endpoint = `${base}/projects/${projectId}/reports`;
  const refresh = useCallback(async () => { try { setItems(await loadReports(endpoint)); } catch (failure) { setError(failure instanceof Error ? failure.message : "No se pudo consultar el estado."); } finally { setLoading(false); } }, [endpoint]);
  useEffect(() => { const controller = new AbortController(); loadReports(endpoint, controller.signal).then(setItems).catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "No se pudo consultar el estado."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [endpoint]);
  useEffect(() => { if (!items.some((item) => item.status === "queued" || item.status === "processing")) return; const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [items, refresh]);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy("request"); setError(""); setMessage("");
    try { const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startDate, endDate, idempotencyKey: crypto.randomUUID() }) }); if (!response.ok) throw new Error(await responseError(response)); setMessage("Informe solicitado. Su estado se actualizará mientras se genera."); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : "No se pudo solicitar el informe."); } finally { setBusy(null); }
  }
  async function download(report: ReportItem) { setBusy(report.id); setError(""); setMessage("");
    try {
      const leaseResponse = await fetch(`${base}/reports/${report.id}/download-lease`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); if (!leaseResponse.ok) throw new Error(await responseError(leaseResponse)); const lease = await leaseResponse.json();
      const response = await fetch(`${base}/reports/${report.id}/download?token=${encodeURIComponent(lease.token)}`, { cache: "no-store" }); if (!response.ok) throw new Error(await responseError(response));
      const url = URL.createObjectURL(await response.blob()), anchor = document.createElement("a"); anchor.href = url; anchor.download = `informe-solar-${report.startDate.slice(0, 10)}-${report.endDate.slice(0, 10)}.pdf`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage("Descarga autorizada. El enlace temporal ya fue utilizado.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "No se pudo descargar el informe."); } finally { setBusy(null); }
  }
  return <section className="panel"><div className="panel-header"><h2>Informes de energía</h2><button type="button" className="button button-secondary" onClick={() => { setError(""); void refresh(); }} disabled={Boolean(busy)}>Actualizar estado</button></div>
    <p className="muted">PDF privado de hasta 31 días, con calidad, origen y cobertura. Las fechas usan {timezone}; la zona queda conservada en cada informe.</p>
    <form className="management-form" onSubmit={submit}><div className="form-grid"><label className="field" htmlFor={`${id}-start`}>Desde<input id={`${id}-start`} type="date" required max={endDate || today} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label className="field" htmlFor={`${id}-end`}>Hasta<input id={`${id}-end`} type="date" required min={startDate} max={today} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div><button className="button" type="submit" disabled={Boolean(busy)}>{busy === "request" ? "Solicitando…" : "Solicitar informe"}</button></form>
    {error && <p className="notice" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    {loading ? <p role="status">Consultando informes…</p> : items.length ? <ul className="record-list">{items.map((report) => <li key={report.id}><h3>{report.startDate.slice(0, 10)} al {report.endDate.slice(0, 10)}</h3><p>{statusLabels[report.status]} · {report.timezone}</p>{report.status === "completed" && <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => void download(report)}>{busy === report.id ? "Preparando descarga…" : "Descargar PDF"}</button>}{report.status === "failed" && <p className="muted">Puedes solicitar otro informe cuando los datos o el servicio estén disponibles.</p>}</li>)}</ul> : <p className="muted">Aún no has solicitado informes para este proyecto.</p>}
    <p className="muted">Cada descarga requiere tu sesión y una autorización de un solo uso que vence en cinco minutos.</p>
  </section>;
}

