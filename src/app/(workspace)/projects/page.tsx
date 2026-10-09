import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/ui";
import { ProjectTable } from "@/components/project-table";
import { getPortfolio } from "@/modules/projects/service";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
function single(value: string | string[] | undefined) { return typeof value === "string" ? value : undefined; }

export const metadata = { title: "Proyectos" };

export default async function ProjectsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = (single(params.q) ?? "").trim();
  const connection = single(params.connection) ?? "all";
  const scenario = single(params.scenario);
  const portfolio = await getPortfolio(single(params.org), scenario === "empty" || scenario === "error" ? scenario : "normal");
  if (!portfolio) notFound();
  const projects = portfolio.projects.filter((project) => {
    const matchesQuery = `${project.name} ${project.location} ${project.customerName}`.toLocaleLowerCase("es").includes(query.toLocaleLowerCase("es"));
    return matchesQuery && (connection === "all" || project.connection === connection);
  });
  const reset = new URLSearchParams({ org: portfolio.organization.id });
  if (scenario === "empty") reset.set("scenario", scenario);

  return (
    <>
      <PageHeader title="Proyectos" description="Consulta las instalaciones y revisa la disponibilidad de sus lecturas.">{portfolio.canManage && <Link className="button" href={`/projects/new?${reset}`}>Crear proyecto</Link>}</PageHeader>
      <section className="panel" aria-labelledby="project-list-title">
        <div className="panel-header"><div><h2 className="section-title" id="project-list-title">Cartera de instalaciones</h2><p className="muted">{portfolio.projects.length} proyectos {portfolio.isDemo ? "simulados" : "autorizados"} · {projects.length} resultados</p></div>{!portfolio.isDemo && <a className="inline-link" href={`/api/v1/organizations/${portfolio.organization.id}/projects/export`}>Exportar CSV</a>}</div>
        <form className="toolbar" method="get" action="/projects">
          <input type="hidden" name="org" value={portfolio.organization.id} />
          {scenario === "empty" && <input type="hidden" name="scenario" value="empty" />}
          <label className="field" htmlFor="project-search"><span>Buscar proyecto</span><input id="project-search" name="q" type="search" placeholder="Nombre, ubicación o cliente" defaultValue={query} /></label>
          <label className="field" htmlFor="project-connection"><span>Estado de conexión</span><select id="project-connection" name="connection" defaultValue={connection}><option value="all">Todos los estados</option><option value="online">En línea</option><option value="stale">Datos desactualizados</option><option value="offline">Sin conexión</option></select></label>
          <div className="form-actions"><button className="button" type="submit">Aplicar filtros</button><Link className="button button-secondary" href={`/projects?${reset.toString()}`}>Limpiar</Link></div>
        </form>
        {projects.length ? <ProjectTable projects={projects} organizationId={portfolio.organization.id} scenario={scenario === "empty" ? scenario : undefined} /> : <EmptyState title={portfolio.projects.length ? "No hay coincidencias" : "Aún no hay proyectos"} description={portfolio.projects.length ? "Prueba otro nombre o cambia el estado de conexión." : portfolio.isDemo ? "Este escenario de demostración muestra una organización sin instalaciones." : portfolio.canManage ? "Registra un cliente y crea la primera instalación." : "El administrador debe asignarte una instalación para que puedas consultarla."} href={portfolio.canManage ? `/projects/new?org=${portfolio.organization.id}` : portfolio.isDemo ? `/projects?org=${encodeURIComponent(portfolio.organization.id)}` : undefined} action={portfolio.canManage ? "Crear proyecto" : "Volver a la demostración"} />}
      </section>
      <p className="muted">{portfolio.isDemo ? "La potencia corresponde al corte de referencia de la demostración." : "Las instalaciones registradas aún no reciben mediciones."} Las lecturas ausentes se indican como no disponibles; no equivalen a cero.</p>
    </>
  );
}
