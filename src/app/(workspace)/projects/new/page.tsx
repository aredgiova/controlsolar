import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, EmptyState } from "@/components/ui";
import { ApiForm } from "@/components/management-form";
import { readWorkspace } from "@/lib/workspace";
import { listCustomers } from "@/modules/customers/service";

export const metadata = { title: "Crear proyecto" };
export default async function NewProjectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const workspace = await readWorkspace(typeof params.org === "string" ? params.org : undefined);
  const org = workspace.organization.id;
  if (workspace.isDemo) return <EmptyState title="Gestión de proyectos" description="Configura PostgreSQL y Cognito para crear instalaciones persistentes." href={`/projects?org=${org}`} action="Consultar demostración" />;
  if (!workspace.canManage) notFound();
  const customerSearch = typeof params.customerSearch === "string" ? params.customerSearch.slice(0, 100) : "";
  const customers = await listCustomers(workspace.identity, org, { pageSize: 100, search: customerSearch });
  return <><Link className="inline-link back-link" href={`/projects?org=${org}`}>Volver a proyectos</Link><PageHeader title="Crear proyecto" description="Registra una instalación conectada a red sin batería." />
    <form className="toolbar selection-search" method="get"><input type="hidden" name="org" value={org} /><label className="field">Buscar cliente para el proyecto<input name="customerSearch" type="search" defaultValue={customerSearch} maxLength={100} placeholder="Nombre del cliente" /></label><button className="button button-secondary" type="submit">Buscar cliente</button><span className="muted">{customers.total} coincidencias · Hasta 100 opciones</span></form>
    {!customers.items.length ? <div className="panel"><EmptyState title={customerSearch ? "No hay clientes con ese nombre" : "Primero registra un cliente"} description={customerSearch ? "Prueba con otro nombre o elimina la búsqueda." : "Cada instalación debe pertenecer a un cliente de esta organización."} href={customerSearch ? `/projects/new?org=${org}` : `/customers?org=${org}`} action={customerSearch ? "Quitar búsqueda" : "Ir a clientes"} /></div> : <section className="panel"><ApiForm endpoint={`/api/v1/organizations/${org}/projects`} submitLabel="Crear proyecto" redirectTo={`/projects/{id}?org=${org}`} fixed={{ topologyType: "grid_tied_no_battery" }} fields={[
      { name: "customerId", label: "Cliente", type: "select", required: true, options: customers.items.map((customer) => ({ value: customer.id, label: customer.name })) },
      { name: "name", label: "Nombre del proyecto", required: true },
      { name: "location", label: "Ubicación", required: true, hint: "Municipio, departamento y dirección o referencia." },
      { name: "capacityKwp", label: "Capacidad instalada (kWp)", type: "number", required: true, min: 0.001, max: 1000000 },
      { name: "timezone", label: "Zona horaria", defaultValue: workspace.organization.timezone, required: true },
      { name: "latitude", label: "Latitud (opcional)", type: "number", min: -90, max: 90, hint: "Ingresa ambas coordenadas o deja las dos vacías." },
      { name: "longitude", label: "Longitud (opcional)", type: "number", min: -180, max: 180 },
    ]} /></section>}
  </>;
}
