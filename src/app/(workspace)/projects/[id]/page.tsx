import Link from "next/link";
import { notFound } from "next/navigation";
import { EnergyChart } from "@/components/energy-chart";
import { Icon } from "@/components/icon";
import { EmptyState, Metric, PageHeader, StatusBadge } from "@/components/ui";
import { getPortfolio, getDemoProject } from "@/modules/projects/service";
import { ProjectManagement } from "@/components/project-management";
import { ProjectTelemetry } from "@/components/project-telemetry";
import { formatDate, formatNumber } from "@/lib/format";
import { ReportActions } from "@/components/report-actions";

export const metadata = { title: "Detalle del proyecto" };

export default async function ProjectDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const query = await searchParams;
  const organizationId = typeof query.org === "string" ? query.org : undefined;
  const portfolio = await getPortfolio(organizationId);
  if (!portfolio) notFound();
  if (!portfolio.isDemo) {
    const registered = portfolio.projects.find((project) => project.id === id);
    if (!registered) notFound();
    return <><Link className="inline-link back-link" href={`/projects?org=${portfolio.organization.id}`}>Todos los proyectos</Link>
      <PageHeader title={registered.name} description={`${registered.location} · ${registered.customerName}`} />
      <ProjectTelemetry identity={portfolio.identity} organizationId={portfolio.organization.id} projectId={id} date={typeof query.date === "string" ? query.date : undefined} />
      <ReportActions key={`${portfolio.organization.id}:${id}`} organizationId={portfolio.organization.id} projectId={id} timezone={registered.timezone ?? "America/Bogota"} />
      <ProjectManagement identity={portfolio.identity} organizationId={portfolio.organization.id} projectId={id} canManage={portfolio.canManage} customerSearch={typeof query.customerSearch === "string" ? query.customerSearch.slice(0, 100) : ""} deviceSearch={typeof query.deviceSearch === "string" ? query.deviceSearch.slice(0, 100) : ""} />
    </>;
  }
  const project = getDemoProject(id, portfolio.organization.id);
  if (!project) notFound();
  const projectAlerts = portfolio.alerts.filter((alert) => alert.projectId === project.id);
  const orgQuery = `org=${encodeURIComponent(portfolio.organization.id)}`;

  return (
    <>
      <Link className="inline-link back-link" href={`/projects?${orgQuery}`}><Icon name="arrow" size={16} style={{ transform: "rotate(180deg)" }} />Todos los proyectos</Link>
      <PageHeader title={project.name} description={`${project.location} · ${project.customerName}`}><StatusBadge status={project.connection} /></PageHeader>
      {project.connection !== "online" && <div className="notice notice-warning" role="status">{project.connection === "stale" ? "Las lecturas de este proyecto están desactualizadas." : "Este proyecto no está recibiendo lecturas."} Última lectura disponible: {formatDate(project.lastMeasuredAt)}.</div>}
      <section className="panel" aria-labelledby="project-information-title">
        <div className="panel-header"><h2 id="project-information-title" className="section-title">Información de la instalación</h2><span className="muted">Proyecto de demostración</span></div>
        <dl className="definition-list"><div><dt>Capacidad instalada</dt><dd>{formatNumber(project.capacityKwp, 1)} kWp</dd></div><div><dt>Ubicación</dt><dd>{project.location}</dd></div><div><dt>Cliente</dt><dd>{project.customerName}</dd></div><div><dt>Última lectura</dt><dd>{formatDate(project.lastMeasuredAt)}</dd></div></dl>
      </section>
      <section aria-labelledby="power-title"><div className="detail-heading"><h2 className="section-title" id="power-title">Potencia de la última lectura</h2><span className="muted">Valores históricos simulados · kW</span></div><div className="metric-grid"><Metric label="Generación solar" value={formatNumber(project.lastKnownPower.generationKw)} unit="kW" note="Potencia registrada en la última lectura" /><Metric label="Consumo" value={formatNumber(project.lastKnownPower.consumptionKw)} unit="kW" note="Potencia registrada en la última lectura" /><Metric label="Intercambio de red" value={formatNumber(project.lastKnownPower.gridKw)} unit="kW" note="Calculado: consumo − generación" /></div><p className="muted">Estos valores corresponden a {formatDate(project.lastKnownPower.measuredAt)}; no son una lectura en tiempo real. Generación y consumo son muestras simuladas; el intercambio de red se calcula por balance. Red positiva: importación; negativa: exportación.</p></section>
      <section className="panel" aria-labelledby="power-chart-title"><div className="panel-header"><div><h2 id="power-chart-title" className="section-title">Perfil de potencia</h2><p className="muted">Muestras horarias de la fecha de referencia de la demostración</p></div></div><EnergyChart samples={project.dailySeries} id={`power-${project.id}`} /></section>
      <section aria-labelledby="energy-title"><div className="detail-heading"><h2 className="section-title" id="energy-title">Energía del día de referencia</h2><span className="muted">Acumulados parciales calculados · kWh</span></div><div className="metric-grid"><Metric label="Generación" value={formatNumber(project.generationKwh)} unit={project.generationKwh === null ? undefined : "kWh"} /><Metric label="Consumo" value={formatNumber(project.consumptionKwh)} unit={project.consumptionKwh === null ? undefined : "kWh"} /><Metric label="Importación de red" value={formatNumber(project.gridImportKwh)} unit={project.gridImportKwh === null ? undefined : "kWh"} /><Metric label="Exportación de red" value={formatNumber(project.gridExportKwh)} unit={project.gridExportKwh === null ? undefined : "kWh"} /></div><p className="muted">{project.energyThrough ? `Energía calculada a partir de muestras simuladas hasta ${formatDate(project.energyThrough)}. No representa un día completo.` : "No hay muestras suficientes para calcular la energía del día de referencia."}</p></section>
      <section className="panel" aria-labelledby="project-alerts-title"><div className="panel-header"><h2 id="project-alerts-title" className="section-title">Alertas del proyecto</h2><Link className="inline-link" href={`/alerts?${orgQuery}`}>Todas las alertas</Link></div>{projectAlerts.length ? <ul className="alert-list">{projectAlerts.map((alert) => <li className="alert-card" key={alert.id}><div className="alert-meta"><StatusBadge status={alert.severity} /><StatusBadge status={alert.status} /><time dateTime={alert.occurredAt}>{formatDate(alert.occurredAt)}</time></div><h3>{alert.title}</h3><p>{alert.description}</p></li>)}</ul> : <EmptyState title="Sin alertas registradas" description="No hay alertas simuladas para esta instalación." />}</section>
    </>
  );
}
