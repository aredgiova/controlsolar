import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { readWorkspace } from "@/lib/workspace";
import { getAuthenticationStatus, getPublicConfiguration } from "@/lib/config";

export const metadata = { title: "Configuración" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const workspace = await readWorkspace(typeof params.org === "string" ? params.org : undefined);
  const configuration = getPublicConfiguration();
  const authentication = getAuthenticationStatus();
  const orgQuery = `org=${encodeURIComponent(workspace.organization.id)}`;
  return <>
    <PageHeader title="Configuración" description="Entorno de operación y alcance de los hitos implementados." />
    <div className="settings-grid">
      <section className="panel"><div className="panel-header"><h2>Entorno de operación</h2></div><dl className="definition-list">
        <div><dt>Entorno</dt><dd>{configuration.appEnv === "development" ? "Desarrollo" : configuration.appEnv === "staging" ? "Pruebas" : "Producción"}</dd></div>
        <div><dt>Origen de los datos</dt><dd>{workspace.isDemo ? "Conjunto ficticio local" : "PostgreSQL"}</dd></div>
        <div><dt>Modo de operación</dt><dd>{workspace.isDemo ? "Demostración de solo lectura" : workspace.canManage ? "Gestión de instalaciones" : "Consulta de instalaciones asignadas"}</dd></div>
        <div><dt>Zona horaria de organización</dt><dd>{workspace.organization.timezone}</dd></div>
        <div><dt>Identidad</dt><dd>{authentication.configured ? "Cognito configurado" : "Pendiente de configurar Cognito"}</dd></div>
        <div><dt>Unidades</dt><dd>kW · kWh · kWp</dd></div>
      </dl></section>
      <section className="panel"><div className="panel-header"><h2>Estado de implementación</h2></div><dl className="definition-list">
        <div><dt>Hitos 0 y 1</dt><dd>Base técnica y panel de demostración</dd></div>
        <div><dt>Hito 2</dt><dd>Identidad, invitaciones, sesiones y permisos</dd></div>
        <div><dt>Hito 3</dt><dd>Clientes, proyectos, equipos y topología versionada</dd></div>
        <div><dt>Hito 4</dt><dd>Simulador, ingesta persistente y consulta de mediciones</dd></div>
        <div><dt>Hito 5</dt><dd>Gateway y conexión AWS preparados para el piloto</dd></div>
        <div><dt>Hito 6</dt><dd>Alertas, incidencias, portal e informes privados</dd></div>
        <div><dt>Hito 7</dt><dd>Seguridad, respaldo y ensayo de carga locales</dd></div>
        <div><dt>Piloto real</dt><dd>Pendientes los equipos, AWS y la validación con instaladoras y propietarios</dd></div>
      </dl><p className="muted">La conexión efectiva con Cognito y el despliegue de staging requieren validación con los servicios configurados.</p></section>
    </div>
    {workspace.isDemo ? <section className="panel"><div className="panel-header"><h2>Escenarios de revisión</h2></div><div className="page-actions"><Link className="button button-secondary" href={`/dashboard?${orgQuery}`}>Ver datos de ejemplo</Link><Link className="button button-secondary" href={`/dashboard?${orgQuery}&scenario=empty`}>Ver estado vacío</Link><Link className="button button-secondary" href={`/dashboard?${orgQuery}&scenario=error`}>Ver estado de error</Link></div></section> : <section className="panel"><div className="panel-header"><h2>Organizaciones</h2></div><div className="page-actions"><Link className="button button-secondary" href="/organizations/new">Crear otra organización</Link></div></section>}
    <p className="notice">{workspace.isDemo ? "La demostración usa datos ficticios y no guarda cambios. Para gestionar instalaciones se requiere PostgreSQL y Cognito." : "Los cambios de gestión se guardan con auditoría y permisos por organización. Esta etapa no realiza acciones sobre los equipos."}</p>
  </>;
}
