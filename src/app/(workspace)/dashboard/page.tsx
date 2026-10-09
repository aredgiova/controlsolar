import Link from "next/link";
import { notFound } from "next/navigation";
import { EnergyChart } from "@/components/energy-chart";
import { ProjectTable } from "@/components/project-table";
import { EmptyState, Metric, PageHeader, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { formatDate, formatNumber } from "@/lib/format";
import { getPortfolio } from "@/modules/projects/service";
import { AttentionQueue } from "@/components/operational-alerts";

export const metadata = { title: "Resumen" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const org = typeof params.org === "string" ? params.org : undefined;
  const scenario = params.scenario === "empty" || params.scenario === "error" ? params.scenario : "normal";
  const portfolio = await getPortfolio(org, scenario);
  if (!portfolio) notFound();
  const { organization, projects, alerts, referenceTime } = portfolio;
  const query = new URLSearchParams({ org: organization.id });
  const attention = projects.filter((project) => project.connection !== "online" || alerts.some((alert) => alert.projectId === project.id && alert.status === "open"));
  const openAlerts = alerts.filter((alert) => alert.status === "open");
  const online = projects.filter((project) => project.connection === "online").length;
  const representative = projects.find((project) => project.connection === "online");

  return <>
    <PageHeader title="Vista de la cartera" description={`${organization.name} · Identifica las instalaciones que necesitan atención.`}>
      <Link className="button" href={`/projects?${query}`}>Consultar proyectos <Icon name="arrow" size={16} /></Link>
    </PageHeader>
    {portfolio.isDemo && scenario === "empty" ? <div className="panel"><EmptyState title="Todavía no hay instalaciones" description="Este escenario muestra una cartera vacía. Vuelve a los datos de demostración para explorar proyectos y lecturas ficticias." href={`/dashboard?${query}`} action="Restablecer demostración" /></div> : <>
      <div className="metric-grid">
        <Metric label="Instalaciones de la cartera" value={projects.length} note={`${formatNumber(projects.reduce((total, project) => total + project.capacityKwp, 0))} kWp de capacidad nominal${portfolio.isDemo ? " simulada" : ""}`} />
        <Metric label={portfolio.isDemo ? "Con lectura vigente al corte" : "Con mediciones recientes"} value={`${online} / ${projects.length}`} note={portfolio.isDemo ? "Vigencia al corte fijo de la demo" : "Según la antigüedad de medición y recepción"} />
        <Metric label={portfolio.isDemo ? "Alertas abiertas" : "Ámbito de consulta"} value={portfolio.isDemo ? openAlerts.length : "Autorizado"} note={portfolio.isDemo ? `${attention.length} instalaciones requieren revisión` : "Según tu organización y asignaciones"} />
      </div>
      {portfolio.isDemo && <section className="panel attention-panel" aria-labelledby="attention-title">
        <div className="panel-header"><div className="attention-title"><h2 id="attention-title">Requieren atención</h2><span className="attention-count">{attention.length}</span></div><Link className="inline-link" href={`/alerts?${query}`}>Consultar alertas <Icon name="arrow" size={15} /></Link></div>
        {attention.length ? attention.map((project) => {
          const alert = openAlerts.find((item) => item.projectId === project.id);
          return <div className="attention-row" key={project.id}><div><div className="attention-row-title"><h3>{project.name}</h3><StatusBadge status={project.connection} /></div><p>{alert?.title ?? "Revisar continuidad de las lecturas"} · Último dato: {formatDate(project.lastMeasuredAt)}</p></div><Link className="inline-link" href={`/projects/${project.id}?${query}`} aria-label={`Revisar ${project.name}`}>Revisar <Icon name="arrow" size={16} /></Link></div>;
        }) : <EmptyState title="Sin instalaciones pendientes de revisión" description="Todas las instalaciones de esta demostración tienen lecturas vigentes al corte." />}
      </section>}
      {!portfolio.isDemo && <AttentionQueue identity={portfolio.identity} organizationId={organization.id} />}
      <section className="panel" aria-labelledby="portfolio-title"><div className="panel-header"><div><h2 id="portfolio-title">Instalaciones</h2><p>Potencia disponible al corte; la ausencia de lectura se muestra explícitamente.</p></div><Link className="inline-link" href={`/projects?${query}`}>Ver todas <Icon name="arrow" size={15} /></Link></div><ProjectTable projects={projects} organizationId={organization.id} /></section>
      {portfolio.isDemo && representative && <section className="panel" aria-labelledby="energy-title"><div className="panel-header"><div><h2 id="energy-title">Potencia durante el día</h2><p>{representative.name} · 8 de octubre de 2026 · Datos simulados en kW</p></div><Link className="inline-link" href={`/projects/${representative.id}?${query}`}>Ver instalación <Icon name="arrow" size={15} /></Link></div><EnergyChart samples={representative.dailySeries} id="portfolio-power" /></section>}
    </>}
    <p className="simulation-note">{portfolio.isDemo ? `Corte fijo de la demostración: ${formatDate(referenceTime)} (Bogotá). El estado de conexión se refiere a ese momento. No hay datos en tiempo real.` : "La cartera usa lecturas persistidas. Cada proyecto muestra el origen, la fecha y la cobertura de sus mediciones; los datos simulados se identifican expresamente."}</p>
  </>;
}
