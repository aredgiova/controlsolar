import Link from "next/link";
import { PageHeader, EmptyState } from "@/components/ui";
import { ApiForm } from "@/components/management-form";
import { ManagementDemo } from "@/components/management-state";
import { readWorkspace } from "@/lib/workspace";
import { listDevices } from "@/modules/assets/service";
import { GatewayRegistry } from "@/components/gateway-registry";

export const metadata = { title: "Dispositivos" };
export default async function DevicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const workspace = await readWorkspace(typeof params.org === "string" ? params.org : undefined);
  const { organization, identity, canManage } = workspace;
  if (workspace.isDemo || !identity) return <><PageHeader title="Dispositivos" description="Inventario de medidores y gateways de la empresa." /><ManagementDemo area="La gestión de dispositivos" organizationId={organization.id} /></>;
  const search = typeof params.search === "string" ? params.search.slice(0, 100) : "";
  const page = Math.max(1, Math.min(10000, Math.trunc(Number(params.page)) || 1));
  const result = await listDevices(identity, organization.id, { search, page, pageSize: 25 });
  const endpoint = `/api/v1/organizations/${organization.id}/devices`;
  const query = `org=${encodeURIComponent(organization.id)}&search=${encodeURIComponent(search)}`;
  return <>
    <PageHeader title="Dispositivos" description="Registra los equipos y vincula cada medidor desde el proyecto correspondiente." />
    <p className="notice">El número de serie identifica al equipo. Su vinculación requiere una sesión y permisos de administración.</p>
    {canManage && <section className="panel"><div className="panel-header"><h2 className="section-title">Registrar equipo</h2></div><ApiForm endpoint={endpoint} submitLabel="Registrar equipo" fields={[{ name: "name", label: "Nombre del equipo", required: true }, { name: "serialNumber", label: "Número de serie", required: true }, { name: "kind", label: "Tipo de equipo", type: "select", required: true, defaultValue: "meter", options: [{ value: "meter", label: "Medidor" }, { value: "gateway", label: "Gateway" }] }]} /></section>}
    <section className="panel"><div className="panel-header"><h2 className="section-title">Inventario autorizado</h2><span className="muted">{result.total} equipos</span></div>
      <form className="toolbar" action="/devices"><input type="hidden" name="org" value={organization.id} /><label className="field">Buscar por nombre o serie<input name="search" type="search" defaultValue={search} maxLength={100} /></label><button className="button button-secondary" type="submit">Buscar</button></form>
      {result.items.length === 0 ? <EmptyState title={search ? "No hay coincidencias" : "Aún no hay equipos"} description={search ? "Prueba con otro nombre o número de serie." : canManage ? "Registra un medidor para asignarlo a un punto de medición." : "Los equipos aparecerán cuando estén vinculados a tus proyectos asignados."} /> : <div className="table-container"><p className="table-scroll-hint">Desliza la tabla para consultar todos los datos y acciones.</p><div className="table-wrap" tabIndex={0} role="region" aria-label="Inventario de equipos, desplazable"><table className="data-table management-table"><caption className="visually-hidden">Equipos de la empresa autorizada</caption><thead><tr><th scope="col">Equipo</th><th scope="col">Tipo</th><th scope="col">Estado</th>{canManage && <th scope="col">Gestión</th>}</tr></thead><tbody>{result.items.map((device) => <tr key={device.id}><th scope="row">{device.name}<span className="table-subtitle muted">Serie: {device.serial}</span></th><td>{device.kind === "meter" ? "Medidor" : "Gateway"}</td><td>{device.status === "retired" ? "Retirado" : device.bindings.length ? "Vinculado" : "Disponible"}</td>{canManage && <td><details><summary>Editar equipo</summary><ApiForm endpoint={`${endpoint}/${device.id}`} method="PATCH" submitLabel="Guardar nombre" fields={[{ name: "name", label: "Nombre del equipo", required: true, defaultValue: device.name }]} />{device.status !== "retired" && device.bindings.length === 0 && <ApiForm endpoint={`${endpoint}/${device.id}/retire`} submitLabel="Retirar equipo" fixed={{}} />}{device.bindings.length > 0 && <p className="muted">Sustituye las asignaciones antes de retirar este medidor.</p>}</details></td>}</tr>)}</tbody></table></div></div>}
      {result.total > result.pageSize && <div className="page-actions">{page > 1 && <Link className="button button-secondary" href={`/devices?${query}&page=${page - 1}`}>Anterior</Link>}<span className="muted">Página {page} de {Math.ceil(result.total / result.pageSize)}</span>{page * result.pageSize < result.total && <Link className="button button-secondary" href={`/devices?${query}&page=${page + 1}`}>Siguiente</Link>}</div>}
    </section>
    {canManage && <GatewayRegistry identity={identity} organizationId={organization.id} search={typeof params.enrollSearch === "string" ? params.enrollSearch.slice(0, 100) : ""} page={Math.max(1, Math.min(10000, Math.trunc(Number(params.gatewayPage)) || 1))} />}
  </>;
}
