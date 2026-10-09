import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { formatDate, formatNumber } from "@/lib/format";

type ProjectRow = {
  id: string;
  name: string;
  location: string;
  capacityKwp: number;
  connection: "online" | "stale" | "offline";
  lastMeasuredAt: string | null;
  generationKw: number | null;
  customerName: string;
  timezone?: string;
  telemetrySource?: "simulator" | "aws_iot" | "mixed" | "missing";
};

export function ProjectTable({ projects, organizationId, scenario }: { projects: ProjectRow[]; organizationId: string; scenario?: string }) {
  function detailHref(id: string) {
    const params = new URLSearchParams({ org: organizationId });
    if (scenario) params.set("scenario", scenario);
    return `/projects/${encodeURIComponent(id)}?${params.toString()}`;
  }

  return (
    <><p className="table-scroll-hint">Desliza la tabla para ver potencia, fecha y detalle.</p><div className="table-wrap" role="region" aria-label="Tabla de proyectos con desplazamiento horizontal" tabIndex={0}>
      <table className="data-table project-table">
        <caption className="visually-hidden">Proyectos autorizados de la organización seleccionada.</caption>
        <thead><tr><th scope="col">Proyecto</th><th scope="col">Capacidad</th><th scope="col">Estado</th><th scope="col">Generación al corte</th><th scope="col">Última lectura</th><th scope="col"><span className="visually-hidden">Acción</span></th></tr></thead>
        <tbody>
          {projects.map((project) => <tr key={project.id}>
            <th scope="row"><Link className="project-name inline-link" href={detailHref(project.id)}>{project.name}</Link><span className="muted table-subtitle">{project.location} · {project.customerName}</span>{project.telemetrySource && project.telemetrySource !== "missing" && <span className="muted table-subtitle">{project.telemetrySource === "simulator" ? "Lecturas simuladas" : project.telemetrySource === "mixed" ? "Incluye lecturas simuladas" : "Lecturas de gateway AWS IoT"}</span>}</th>
            <td>{formatNumber(project.capacityKwp, 1)} <span className="muted">kWp</span></td>
            <td><StatusBadge status={project.telemetrySource === "missing" ? "missing" : project.connection} /></td>
            <td>{formatNumber(project.generationKw)}{project.generationKw !== null && <span className="muted"> kW</span>}</td>
            <td>{formatDate(project.lastMeasuredAt, project.timezone)}</td>
            <td><Link className="inline-link" href={detailHref(project.id)} aria-label={`Ver detalle de ${project.name}`}>Ver detalle <Icon name="arrow" size={15} /></Link></td>
          </tr>)}
        </tbody>
      </table>
    </div></>
  );
}
