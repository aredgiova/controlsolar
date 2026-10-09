import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getPortfolio } from "@/modules/projects/service";
import { getIncident } from "@/modules/incidents/service";
import { listMembers } from "@/modules/organizations/service";
import { HttpError } from "@/modules/auth/errors";
import { ApiForm } from "@/components/management-form";
import { PageHeader, StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";

export const metadata = { title: "Seguimiento de incidencia" };
const eventLabels = { created: "Registrada", assigned: "Responsable actualizado", status_changed: "Estado actualizado", observation: "Observación", closed: "Cerrada" };
export default async function IncidentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params; if (!z.uuid().safeParse(id).success) notFound();
  const query = await searchParams, portfolio = await getPortfolio(typeof query.org === "string" ? query.org : undefined);
  if (!portfolio || portfolio.isDemo) notFound();
  let history;
  try { history = await getIncident(portfolio.identity, portfolio.organization.id, id); } catch (error) { if (error instanceof HttpError && error.status === 404) notFound(); throw error; }
  const { incident, events } = history, org = `org=${portfolio.organization.id}`, endpoint = `/api/v1/organizations/${portfolio.organization.id}/incidents/${id}`;
  const zone = portfolio.projects.find((project) => project.id === incident.projectId)?.timezone;
  const members = portfolio.canManage ? await listMembers(portfolio.identity, portfolio.organization.id) : [];
  const options = members.filter((member) => member.status === "active" && (member.role === "owner" || member.role === "administrator" || member.role === "technician" && member.siteAccess.some((access) => access.projectId === incident.projectId))).map((member) => ({ value: member.userId, label: member.user.displayName || member.user.email }));
  const assignee = options.find((option) => option.value === incident.assigneeUserId)?.label;
  return <><Link className="inline-link back-link" href={`/alerts?${org}`}>Alertas y seguimiento</Link><PageHeader title={incident.title} description={incident.project.name}><StatusBadge status={incident.status} /></PageHeader><section className="panel"><div className="panel-header"><h2>Datos del seguimiento</h2></div><p className="panel-copy">{incident.description || "Sin descripción adicional."}</p><dl className="definition-list"><div><dt>Responsable</dt><dd>{assignee || (incident.assigneeUserId ? "Responsable asignado" : "Por asignar")}</dd></div><div><dt>Registro</dt><dd>{formatDate(incident.createdAt.toISOString(), zone)}</dd></div><div><dt>Resolución</dt><dd>{incident.resolution || "Pendiente"}</dd></div><div><dt>Cierre</dt><dd>{incident.closedAt ? formatDate(incident.closedAt.toISOString(), zone) : "Pendiente"}</dd></div></dl>{incident.alertId && <p className="panel-copy"><Link className="inline-link" href={`/alerts/${incident.alertId}?${org}`}>Consultar alerta asociada</Link></p>}</section>
    {portfolio.canManage && <section className="panel"><div className="panel-header"><h2>Actualizar seguimiento</h2></div>{incident.status !== "closed" && <><ApiForm endpoint={endpoint} method="PATCH" title="Responsable" submitLabel="Guardar responsable" fields={[{ name: "assigneeUserId", label: "Responsable", type: "select", options, defaultValue: incident.assigneeUserId ?? "", blankValue: null }]} />{incident.status === "open" && <ApiForm endpoint={endpoint} method="PATCH" fixed={{ status: "in_progress" }} submitLabel="Iniciar seguimiento" />}<details className="management-details"><summary>Cerrar incidencia</summary><ApiForm endpoint={endpoint} method="PATCH" submitLabel="Registrar cierre" fixed={{ status: "closed" }} fields={[{ name: "resolution", label: "Resolución", type: "textarea", required: true, hint: "Describe la acción y su resultado para conservar la trazabilidad." }]} /></details></>}<ApiForm endpoint={`${endpoint}/observations`} title="Añadir observación" submitLabel="Guardar observación" fields={[{ name: "note", label: "Observación", type: "textarea", required: true }]} /></section>}
    <section className="panel"><div className="panel-header"><h2>Historial</h2><span className="muted">Hasta 200 registros · {zone}</span></div><ol className="incident-timeline">{events.map((event) => <li key={event.id}><h3>{eventLabels[event.kind]}</h3><time dateTime={event.createdAt.toISOString()}>{formatDate(event.createdAt.toISOString(), zone)}</time>{event.note && <p>{event.note}</p>}</li>)}</ol></section></>;
}

