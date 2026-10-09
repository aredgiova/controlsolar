import Link from "next/link";
import { PageHeader, EmptyState } from "@/components/ui";
import { ApiForm } from "@/components/management-form";
import { ManagementDemo } from "@/components/management-state";
import { readWorkspace } from "@/lib/workspace";
import { listCustomers } from "@/modules/customers/service";

export const metadata = { title: "Clientes" };
export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const workspace = await readWorkspace(typeof params.org === "string" ? params.org : undefined);
  const { organization, identity, canManage } = workspace;
  if (workspace.isDemo || !identity) return <><PageHeader title="Clientes" description="Empresas y personas responsables de las instalaciones." /><ManagementDemo area="La gestión de clientes" organizationId={organization.id} /></>;
  const search = typeof params.search === "string" ? params.search.slice(0, 100) : "";
  const page = Math.max(1, Math.min(10000, Math.trunc(Number(params.page)) || 1));
  const result = await listCustomers(identity, organization.id, { search, page, pageSize: 25 });
  const endpoint = `/api/v1/organizations/${organization.id}/customers`;
  const query = `org=${encodeURIComponent(organization.id)}&search=${encodeURIComponent(search)}`;
  return <>
    <PageHeader title="Clientes" description="Registra al responsable de cada instalación y mantén sus datos de identificación." />
    {canManage && <section className="panel"><div className="panel-header"><h2 className="section-title">Nuevo cliente</h2></div><ApiForm endpoint={endpoint} submitLabel="Crear cliente" fields={[{ name: "name", label: "Nombre del cliente", required: true }]} /></section>}
    <section className="panel">
      <div className="panel-header"><h2 className="section-title">Directorio de clientes</h2><span className="muted">{result.total} registros</span></div>
      <form className="toolbar" action="/customers"><input type="hidden" name="org" value={organization.id} /><label className="field">Buscar cliente<input name="search" type="search" defaultValue={search} maxLength={100} /></label><button className="button button-secondary" type="submit">Buscar</button></form>
      {result.items.length === 0 ? <EmptyState title={search ? "No hay coincidencias" : "Aún no hay clientes"} description={search ? "Prueba con otro nombre o elimina el filtro." : canManage ? "Crea el primer cliente para registrar su instalación solar." : "Los clientes aparecerán cuando tengas un proyecto asignado."} /> : <div className="table-wrap" tabIndex={0} role="region" aria-label="Directorio de clientes, desplazable"><table className="data-table"><caption className="visually-hidden">Clientes de la empresa autorizada</caption><thead><tr><th scope="col">Cliente</th>{canManage && <th scope="col">Gestión</th>}</tr></thead><tbody>{result.items.map((customer) => <tr key={customer.id}><th scope="row">{customer.name}</th>{canManage && <td><details><summary>Editar cliente</summary><ApiForm endpoint={`${endpoint}/${customer.id}`} method="PATCH" submitLabel="Guardar nombre" fields={[{ name: "name", label: "Nombre del cliente", required: true, defaultValue: customer.name }]} /></details></td>}</tr>)}</tbody></table></div>}
      {result.total > result.pageSize && <div className="page-actions">{page > 1 && <Link className="button button-secondary" href={`/customers?${query}&page=${page - 1}`}>Anterior</Link>}<span className="muted">Página {page} de {Math.ceil(result.total / result.pageSize)}</span>{page * result.pageSize < result.total && <Link className="button button-secondary" href={`/customers?${query}&page=${page + 1}`}>Siguiente</Link>}</div>}
    </section>
  </>;
}
