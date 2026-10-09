import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getPortfolio } from "@/modules/projects/service";
import { getAlertHistory } from "@/modules/alerts/service";
import { listIncidents } from "@/modules/incidents/service";
import { HttpError } from "@/modules/auth/errors";
import { PageHeader, StatusBadge } from "@/components/ui";
import { alertKindLabels } from "@/components/operational-alerts";
import { formatDate } from "@/lib/format";

export const metadata = { title: "Historial de alerta" };
export default async function AlertDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params; if (!z.uuid().safeParse(id).success) notFound();
  const query = await searchParams, portfolio = await getPortfolio(typeof query.org === "string" ? query.org : undefined);
  if (!portfolio || portfolio.isDemo) notFound();
  let history;
  try { history = await getAlertHistory(portfolio.identity, portfolio.organization.id, id); } catch (error) { if (error instanceof HttpError && error.status === 404) notFound(); throw error; }
  const { alert, events } = history, org = `org=${portfolio.organization.id}`;
  const zone = portfolio.projects.find((project) => project.id === alert.projectId)?.timezone;
  const incidents = await listIncidents(portfolio.identity, portfolio.organization.id, { projectId: alert.projectId, pageSize: 100 });
  return <><Link className="inline-link back-link" href={`/alerts?${org}`}>Alertas y seguimiento</Link><PageHeader title={alert.title} description={`${alert.project.name} · ${alertKindLabels[alert.rule.kind]}`}><StatusBadge status={alert.status} /></PageHeader><section className="panel"><div className="panel-header"><h2>Condición observada</h2></div><p className="panel-copy">{alert.message}</p><dl className="definition-list"><div><dt>Regla</dt><dd>{alert.rule.name}</dd></div><div><dt>Última evaluación</dt><dd>{formatDate(alert.lastEvaluatedAt.toISOString(), zone)}</dd></div><div><dt>Emisión</dt><dd>{alert.activatedAt ? formatDate(alert.activatedAt.toISOString(), zone) : "En observación"}</dd></div><div><dt>Recuperación</dt><dd>{alert.resolvedAt ? formatDate(alert.resolvedAt.toISOString(), zone) : "Sin recuperación registrada"}</dd></div></dl></section><section className="panel"><div className="panel-header"><h2>Historial de transiciones</h2><span className="muted">Hasta 200 registros · {zone}</span></div><ul className="alert-list">{events.map((event) => <li className="alert-card" key={event.id}><h3>{event.kind === "activated" ? "Alerta emitida" : "Recuperación registrada"}</h3><p>{formatDate(event.createdAt.toISOString(), zone)}</p></li>)}</ul>{!events.length && <p className="empty-inline">Todavía no hay transiciones emitidas.</p>}</section><section className="panel"><div className="panel-header"><h2>Seguimiento asociado</h2></div><ul className="alert-list">{incidents.items.filter((incident) => incident.alertId === id).map((incident) => <li className="alert-card" key={incident.id}><Link className="inline-link" href={`/incidents/${incident.id}?${org}`}>{incident.title}</Link> <StatusBadge status={incident.status} /></li>)}</ul></section></>;
}
