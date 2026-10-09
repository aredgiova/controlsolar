import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getPortfolio } from "@/modules/projects/service";
import { formatDate } from "@/lib/format";
import { OperationalAlerts } from "@/components/operational-alerts";

export const metadata = { title: "Alertas" };

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const single = (key: string) => typeof params[key] === "string" ? params[key] : undefined;
  const status = single("status") ?? "all";
  const severity = single("severity") ?? "all";
  const scenario = single("scenario");
  const portfolio = await getPortfolio(single("org"), scenario === "empty" || scenario === "error" ? scenario : "normal");
  if (!portfolio) notFound();
  if (!portfolio.isDemo) return <OperationalAlerts identity={portfolio.identity} organizationId={portfolio.organization.id} projects={portfolio.projects} canManage={portfolio.canManage} status={single("status")} page={Math.max(1, Math.min(100000, Number.parseInt(single("page") ?? "1", 10) || 1))} />;
  const alerts = portfolio.alerts.filter((alert) => (status === "all" || alert.status === status) && (severity === "all" || alert.severity === severity));
  const orgQuery = `org=${encodeURIComponent(portfolio.organization.id)}`;
  const resetQuery = scenario === "empty" ? `${orgQuery}&scenario=empty` : orgQuery;

  return (
    <>
      <PageHeader title="Alertas" description="Revisa incidencias de conexión y medición en los proyectos de la organización." />
      <section className="panel" aria-labelledby="alerts-title"><div className="panel-header"><div><h2 id="alerts-title" className="section-title">Registro de alertas</h2><p className="muted">{alerts.length} resultados · {portfolio.isDemo ? "Datos simulados" : "La detección automática se implementará posteriormente"}</p></div></div>
        <form className="toolbar" method="get" action="/alerts"><input type="hidden" name="org" value={portfolio.organization.id} />{scenario === "empty" && <input type="hidden" name="scenario" value="empty" />}<label className="field" htmlFor="alert-status"><span>Estado</span><select id="alert-status" name="status" defaultValue={status}><option value="all">Todos los estados</option><option value="open">Abiertas</option><option value="resolved">Resueltas</option></select></label><label className="field" htmlFor="alert-severity"><span>Severidad</span><select id="alert-severity" name="severity" defaultValue={severity}><option value="all">Todas las severidades</option><option value="critical">Crítica</option><option value="warning">Advertencia</option><option value="info">Informativa</option></select></label><div className="form-actions"><button className="button" type="submit">Aplicar filtros</button><Link className="button button-secondary" href={`/alerts?${resetQuery}`}>Limpiar</Link></div></form>
        {alerts.length ? <div className="table-wrap"><table className="data-table"><caption className="visually-hidden">Alertas simuladas de la organización seleccionada.</caption><thead><tr><th scope="col">Alerta</th><th scope="col">Proyecto</th><th scope="col">Severidad</th><th scope="col">Estado</th><th scope="col">Fecha</th></tr></thead><tbody>{alerts.map((alert) => { const project = portfolio.projects.find((item) => item.id === alert.projectId); return <tr key={alert.id}><th scope="row"><span>{alert.title}</span><span className="muted table-subtitle">{alert.description}</span></th><td>{project ? <Link className="inline-link" href={`/projects/${encodeURIComponent(project.id)}?${orgQuery}`}>{project.name}</Link> : "Proyecto no disponible"}</td><td><StatusBadge status={alert.severity} /></td><td><StatusBadge status={alert.status} /></td><td><time dateTime={alert.occurredAt}>{formatDate(alert.occurredAt)}</time></td></tr>; })}</tbody></table></div> : <EmptyState title={portfolio.alerts.length ? "No hay alertas con estos filtros" : "Sin alertas registradas"} description={portfolio.alerts.length ? "Cambia el estado o la severidad para consultar otras alertas." : "Este escenario de demostración no contiene alertas."} href={`/alerts?${orgQuery}`} action={portfolio.alerts.length ? "Quitar filtros" : "Volver a la demostración"} />}
      </section><p className="muted">El estado se consulta en modo de solo lectura. La gestión de alertas se implementará en un hito posterior.</p>
      {!portfolio.isDemo && <p className="notice">La adquisición de telemetría y la detección de alertas se implementarán en un hito posterior.</p>}
    </>
  );
}
