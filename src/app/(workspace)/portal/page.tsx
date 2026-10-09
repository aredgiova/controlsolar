import Link from "next/link";
import { notFound } from "next/navigation";
import { getPortfolio } from "@/modules/projects/service";
import { PageHeader, EmptyState } from "@/components/ui";
import { ProjectTable } from "@/components/project-table";

export const metadata = { title: "Mi portal" };
export default async function Portal({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const portfolio = await getPortfolio(typeof query.org === "string" ? query.org : undefined);
  if (!portfolio) notFound();
  return <><PageHeader title="Mi portal" description="Consulta tus instalaciones, su cobertura de medición y los reportes de cada periodo." /><section className="panel" aria-labelledby="portal-projects"><div className="panel-header"><div><h2 id="portal-projects">Instalaciones disponibles</h2><p>Abre un proyecto para consultar sus lecturas y solicitar o descargar un informe privado.</p></div></div>{portfolio.projects.length ? <ProjectTable projects={portfolio.projects} organizationId={portfolio.organization.id} /> : <EmptyState title="Sin proyectos asignados" description="Solicita a tu instalador que revise las asignaciones de tu cuenta." />}</section><p className="muted">Los informes muestran el periodo, la zona horaria, las unidades, el origen y la cobertura de los datos. Las descargas requieren una sesión y una autorización temporal.</p><Link className="inline-link" href={`/alerts?org=${portfolio.organization.id}`}>Consultar alertas e incidencias</Link></>;
}
