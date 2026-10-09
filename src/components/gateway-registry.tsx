import Link from "next/link";
import { ApiForm } from "./management-form";
import { EmptyState } from "./ui";
import { listGateways } from "@/modules/gateways/service";
import { listDevices } from "@/modules/assets/service";
import { readConfig } from "@/lib/config";
import type { Actor } from "@/modules/organizations/access";

export async function GatewayRegistry({ identity, organizationId, search, page }: { identity: Actor; organizationId: string; search: string; page: number }) {
  const [registry, choices] = await Promise.all([
    listGateways(identity, organizationId, { page, pageSize: 25 }),
    listDevices(identity, organizationId, { search, page: 1, pageSize: 100 }),
  ]);
  const gateways = choices.items.filter((device) => device.kind === "gateway" && device.status === "active");
  const meters = choices.items.filter((device) => device.kind === "meter" && device.status === "active");
  const endpoint = `/api/v1/organizations/${organizationId}/gateways`;
  const sources = [{ value: "aws_iot", label: "AWS IoT · certificado del equipo" }, ...(readConfig().appEnv !== "production" ? [{ value: "simulator", label: "Simulador local" }] : [])];
  return <section className="panel" aria-labelledby="gateway-registry-title">
    <div className="panel-header"><div><h2 className="section-title" id="gateway-registry-title">Acceso a las mediciones</h2><p className="muted">Autoriza qué medidores puede transmitir cada identidad de gateway.</p></div></div>
    <p className="notice">Al autorizar, obtendrás el identificador MQTT para configurar el gateway. Para AWS, configura también el certificado y su política en IoT Core. Cada identidad conserva su origen y su lista de medidores.</p>
    <details><summary>Autorizar un gateway</summary>
      <form className="toolbar" action="/devices"><input type="hidden" name="org" value={organizationId} /><label className="field">Filtrar equipos disponibles<input name="enrollSearch" type="search" defaultValue={search} maxLength={100} /></label><button className="button button-secondary" type="submit">Filtrar equipos</button></form>
      {choices.total > 100 && <p className="muted">Se muestran los primeros 100 equipos. Acota el filtro por nombre o serie.</p>}
      {gateways.length && meters.length ? <ApiForm endpoint={endpoint} submitLabel="Autorizar gateway" fields={[
        { name: "name", label: "Nombre de esta identidad", required: true },
        { name: "gatewayDeviceId", label: "Equipo gateway", type: "select", required: true, options: gateways.map((device) => ({ value: device.id, label: `${device.name} · ${device.serial}` })) },
        { name: "source", label: "Origen", type: "select", required: true, defaultValue: sources[0].value, options: sources },
        { name: "principalId", label: "Huella del certificado o identificador del simulador", required: true, hint: "AWS: SHA256 del certificado X.509, 64 caracteres hexadecimales sin separadores. Simulador: identificador local único. No introduzcas claves privadas." },
        { name: "meterDeviceIds", label: "Medidores autorizados", type: "multiselect", required: true, options: meters.map((device) => ({ value: device.id, label: `${device.name} · ${device.serial}` })) },
      ]} /> : <p className="notice">Necesitas un gateway y al menos un medidor activos entre los equipos disponibles. Regístralos en el inventario o ajusta el filtro.</p>}
    </details>
    {registry.items.length === 0 ? <EmptyState title="Sin identidades autorizadas" description="Autoriza un gateway para recibir datos de los medidores vinculados a tus proyectos." /> : <ul className="gateway-list">{registry.items.map((gateway) => <li key={gateway.id}>
      <h3>{gateway.name} <span className="muted">· {gateway.status === "active" ? "Autorizado" : "Revocado"}</span></h3>
      <p>{gateway.gatewayDevice.name} · {gateway.source === "simulator" ? "Simulador local" : "AWS IoT"}</p>
      <dl className="definition-list"><div><dt>Cliente MQTT</dt><dd>{gateway.clientId}</dd></div><div><dt>Identificador</dt><dd className="break-anywhere">{gateway.principalId}</dd></div><div><dt>Medidores</dt><dd>{gateway.meters.map((meter) => meter.meterDevice.name).join(", ")}</dd></div></dl>
      {gateway.status === "active" && <details><summary>Revocar acceso</summary><p className="muted">La plataforma rechazará nuevas lecturas de esta identidad. La revocación es permanente. Si usa AWS, desactiva también su certificado en IoT Core.</p><ApiForm endpoint={`${endpoint}/${gateway.id}`} method="PATCH" fixed={{ status: "revoked" }} submitLabel="Revocar esta identidad" /></details>}
    </li>)}</ul>}
    {registry.total > registry.pageSize && <div className="page-actions">{page > 1 && <Link className="button button-secondary" href={`/devices?org=${organizationId}&gatewayPage=${page - 1}`}>Identidades anteriores</Link>}<span className="muted">Página {page} de {Math.ceil(registry.total / registry.pageSize)}</span>{page * registry.pageSize < registry.total && <Link className="button button-secondary" href={`/devices?org=${organizationId}&gatewayPage=${page + 1}`}>Más identidades</Link>}</div>}
  </section>;
}
