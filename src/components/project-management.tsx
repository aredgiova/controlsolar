import { ApiForm, type ManagementField } from "@/components/management-form";
import { EmptyState } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import { managementDate, roleLabels } from "@/components/management-state";
import { getProjectManagement } from "@/modules/projects/persistent";
import { listMembers } from "@/modules/organizations/service";
import { listCustomers } from "@/modules/customers/service";
import { listDevices } from "@/modules/assets/service";
import type { Identity } from "@/modules/auth/security";

const pointLabels = { generation: "Generación", consumption: "Consumo", grid: "Red" } as const;
const auditLabels: Record<string, string> = { "project.created": "Proyecto creado", "project.updated": "Información actualizada", "point.created": "Punto de medición registrado", "participant.assigned": "Participante asignado", "participant.removed": "Participante retirado", "binding.created": "Medidor vinculado", "binding.replaced": "Medidor sustituido", "topology.versioned": "Topología versionada", "project.commissioned": "Puesta en marcha registrada" };

export async function ProjectManagement({ identity, organizationId, projectId, canManage, customerSearch = "", deviceSearch = "" }: { identity: Identity; organizationId: string; projectId: string; canManage: boolean; customerSearch?: string; deviceSearch?: string }) {
  const project = await getProjectManagement(identity, organizationId, projectId);
  const [customers, devices, members] = canManage ? await Promise.all([
    listCustomers(identity, organizationId, { pageSize: 100, search: customerSearch }), listDevices(identity, organizationId, { pageSize: 100, search: deviceSearch }), listMembers(identity, organizationId),
  ]) : [null, null, null];
  const endpoint = `/api/v1/organizations/${organizationId}/projects/${projectId}`;
  const customerOptions = customers?.items.map((customer) => ({ value: customer.id, label: customer.name })) ?? [];
  if (!customerOptions.some((option) => option.value === project.customerId)) customerOptions.unshift({ value: project.customerId, label: project.customer.name });
  const date = (value: Date | null) => value ? managementDate(value, project.timezone) : "Vigente";
  const points = project.measurementPoints;
  const options = (kind: keyof typeof pointLabels) => points.filter((point) => point.kind === kind).map((point) => ({ value: point.id, label: point.name }));
  const dateField: ManagementField = { name: "validFrom", label: "Vigente desde", type: "datetime-local", required: true, hint: "Hora local de tu navegador. La fecha debe ser actual o pasada." };
  const pointName = (id: unknown) => points.find((point) => point.id === id)?.name ?? "Sin punto de consumo";
  return <>
    {canManage && <form className="toolbar selection-search" method="get"><input type="hidden" name="org" value={organizationId} />
      <label className="field">Buscar cliente para editar<input name="customerSearch" type="search" defaultValue={customerSearch} maxLength={100} /></label>
      <label className="field">Buscar medidor para vincular<input name="deviceSearch" type="search" defaultValue={deviceSearch} maxLength={100} /></label>
      <button className="button button-secondary" type="submit">Buscar opciones</button><span className="muted">Hasta 100 opciones por búsqueda</span>
    </form>}
    <section className="panel"><div className="panel-header"><h2>Información de la instalación</h2><span className="muted">Registro persistente</span></div><dl className="definition-list">
      <div><dt>Cliente</dt><dd>{project.customer.name}</dd></div><div><dt>Capacidad instalada</dt><dd>{formatNumber(Number(project.capacityKwp))} kWp</dd></div>
      <div><dt>Ubicación</dt><dd>{project.location}</dd></div><div><dt>Coordenadas</dt><dd>{project.latitude != null ? `${project.latitude}, ${project.longitude}` : "Sin registrar"}</dd></div>
      <div><dt>Zona horaria</dt><dd>{project.timezone}</dd></div><div><dt>Topología</dt><dd>Conectada a red sin batería</dd></div>
      <div><dt>Puesta en marcha</dt><dd>{project.commissionedAt ? date(project.commissionedAt) : "Pendiente"}</dd></div>
    </dl>{canManage && <details className="management-details"><summary>Editar información del proyecto</summary><ApiForm endpoint={endpoint} method="PATCH" submitLabel="Guardar proyecto" fields={[
      { name: "name", label: "Nombre", required: true, defaultValue: project.name },
      { name: "customerId", label: "Cliente", required: true, type: "select", defaultValue: project.customerId, options: customerOptions },
      { name: "location", label: "Ubicación", required: true, defaultValue: project.location },
      { name: "capacityKwp", label: "Capacidad (kWp)", required: true, type: "number", min: 0.001, max: 1000000, defaultValue: project.capacityKwp.toString() },
      { name: "timezone", label: "Zona horaria", required: true, defaultValue: project.timezone },
      { name: "latitude", label: "Latitud", type: "number", min: -90, max: 90, defaultValue: project.latitude?.toString(), blankValue: null },
      { name: "longitude", label: "Longitud", type: "number", min: -180, max: 180, defaultValue: project.longitude?.toString(), blankValue: null },
    ]} /></details>}</section>
    <div className="management-grid">
      <section className="panel"><div className="panel-header"><h2>Puntos de medición</h2></div>{points.length ? <ul className="record-list">{points.map((point) => <li key={point.id}><h3>{point.name}</h3><p>{pointLabels[point.kind]} · {point.signConvention === "positive_import" ? "Positivo: importación" : point.signConvention === "positive_generation" ? "Positivo: generación" : "Positivo: consumo"}</p></li>)}</ul> : <EmptyState title="Sin puntos registrados" description="Registra los puntos de generación y red para definir la instalación." />}
        {canManage && <details className="management-details"><summary>Registrar un punto</summary>{(["generation", "grid", "consumption"] as const).map((kind) => <ApiForm key={kind} title={pointLabels[kind]} endpoint={`${endpoint}/points`} submitLabel={`Registrar punto de ${pointLabels[kind].toLowerCase()}`} fixed={{ kind, signConvention: kind === "generation" ? "positive_generation" : kind === "grid" ? "positive_import" : "positive_consumption" }} fields={[{ name: "name", label: "Nombre del punto", required: true, defaultValue: pointLabels[kind] }]} />)}</details>}
      </section>
      <section className="panel"><div className="panel-header"><h2>Personas asignadas</h2></div>{project.siteAccess.length ? <ul className="record-list">{project.siteAccess.map((access) => <li key={access.id}><h3>{access.user.name || access.user.email}</h3><p>{roleLabels[access.role]} · {access.user.email}</p>{canManage && <ApiForm endpoint={`${endpoint}/participants/${access.userId}`} method="DELETE" submitLabel="Retirar asignación" />}</li>)}</ul> : <EmptyState title="Sin personas asignadas" description="Los titulares y administradores acceden por su rol. Asigna técnicos y propietarios de este sitio." />}
        {canManage && <details className="management-details"><summary>Asignar una persona</summary><ApiForm endpoint={`${endpoint}/participants`} submitLabel="Asignar al proyecto" fields={[
          { name: "userId", label: "Miembro activo", type: "select", required: true, options: members!.filter((member) => member.status === "active" && ["technician", "customer"].includes(member.role)).map((member) => ({ value: member.userId, label: `${member.user.email} · ${roleLabels[member.role]}` })) },
          { name: "role", label: "Rol en el proyecto", type: "select", required: true, options: [{ value: "technician", label: "Técnico" }, { value: "customer", label: "Propietario del sitio" }], hint: "Debe coincidir con el rol de su membresía." },
        ]} /></details>}
      </section>
    </div>
    <section className="panel"><div className="panel-header"><h2>Vinculaciones e historial de equipos</h2></div>{project.bindings.length ? <><p className="table-scroll-hint">Desliza la tabla para consultar configuración, fechas y vigencia.</p><div className="table-wrap" tabIndex={0} role="region" aria-label="Vinculaciones de medidores"><table className="data-table management-table"><thead><tr><th scope="col">Punto</th><th scope="col">Medidor</th><th scope="col">Versión</th><th scope="col">Desde</th><th scope="col">Hasta</th></tr></thead><tbody>{project.bindings.map((binding) => { const configuration = binding.configuration as Record<string, unknown>; return <tr key={binding.id}><th scope="row">{binding.measurementPoint.name}</th><td>{binding.device.name}<span className="table-subtitle">Serie: {binding.device.serial}</span><span className="table-subtitle">Canal: {String(configuration.channel ?? "—")} · Multiplicador: {String(configuration.multiplier ?? "—")}</span></td><td>{binding.configurationVersion}</td><td>{date(binding.validFrom)}</td><td>{date(binding.validTo)}</td></tr>; })}</tbody></table></div></> : <EmptyState title="Sin medidores vinculados" description="Los equipos se registran en Dispositivos y se vinculan a un punto de esta instalación." />}
      {canManage && <details className="management-details"><summary>Vincular o sustituir un medidor</summary><p className="notice">Al sustituir se cierra la vinculación anterior y se conserva su historial. Un medidor solo puede estar vinculado a un punto a la vez.</p><ApiForm endpoint={`${endpoint}/bindings`} submitLabel="Guardar vinculación" fields={[
        { name: "measurementPointId", label: "Punto de medición", type: "select", required: true, options: points.map((point) => ({ value: point.id, label: point.name })) },
        { name: "deviceId", label: "Medidor activo", type: "select", required: true, options: devices!.items.filter((device) => device.kind === "meter" && device.status === "active").map((device) => ({ value: device.id, label: `${device.name} · ${device.serial}` })) }, dateField,
        { name: "configuration.channel", label: "Canal del medidor", required: true, defaultValue: "main" },
        { name: "configuration.multiplier", label: "Multiplicador", type: "number", min: 0.000001, max: 100000, required: true, defaultValue: "1" },
      ]} /></details>}
    </section>
    <section className="panel"><div className="panel-header"><h2>Versiones de topología</h2></div>{project.topologyVersions.length ? <ul className="record-list">{project.topologyVersions.map((version) => { const configuration = version.configuration as Record<string, unknown>; return <li key={version.id}><h3>Versión {version.version} · Conectada a red sin batería</h3><p>Desde {date(version.validFrom)} · Hasta: {date(version.validTo)}</p><p>Generación: {pointName(configuration.generationPointId)} · Red: {pointName(configuration.gridPointId)} · Consumo: {configuration.consumptionPointId ? pointName(configuration.consumptionPointId) : "Por balance"}</p></li>; })}</ul> : <EmptyState title="Topología pendiente" description="Define qué puntos representan la generación, la red y el consumo de esta instalación." />}
      {canManage && <details className="management-details"><summary>Crear una versión de topología</summary><ApiForm endpoint={`${endpoint}/topology`} submitLabel="Guardar versión de topología" fixed={{ configuration: { type: "grid_tied_no_battery", consumptionPointId: null } }} fields={[
        dateField, { name: "configuration.generationPointId", label: "Punto de generación", type: "select", required: true, options: options("generation") },
        { name: "configuration.gridPointId", label: "Punto de red", type: "select", required: true, options: options("grid") },
        { name: "configuration.consumptionPointId", label: "Punto de consumo (opcional)", type: "select", options: options("consumption"), hint: "Deja vacío si el consumo se calculará por balance." },
      ]} /></details>}
    </section>
    {canManage && <>
      {!project.commissionedAt && <details className="panel management-section"><summary>Registrar puesta en marcha</summary><p className="notice">Requiere una topología y medidores vigentes en la fecha indicada. Este registro no confirma la recepción de mediciones.</p><ApiForm endpoint={`${endpoint}/commissioning`} submitLabel="Registrar puesta en marcha" fields={[
        { name: "commissionedAt", label: "Fecha de puesta en marcha", type: "datetime-local", required: true }, { name: "notes", label: "Observaciones de la verificación", type: "textarea", required: true },
      ]} /></details>}
      <details className="panel management-section"><summary>Historial de cambios ({project.history.length})</summary><ul className="record-list">{project.history.map((event) => <li key={event.id}><h3>{auditLabels[event.action] ?? event.action}</h3><p>{date(event.createdAt)}</p></li>)}</ul></details>
    </>}
  </>;
}
