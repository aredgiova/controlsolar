import { EmptyState } from "./ui";

export function ManagementDemo({ area, organizationId }: { area: string; organizationId: string }) {
  return <section className="panel"><EmptyState title={`${area} requiere una sesión de gestión`} description="La demostración conserva sus ejemplos en modo de consulta. Para guardar cambios, inicia la versión local con PostgreSQL y el proveedor de identidad configurados." href={`/settings?org=${encodeURIComponent(organizationId)}`} action="Ver configuración" /></section>;
}
export function ManagementForbidden() {
  return <section className="panel"><EmptyState title="Se requiere permiso de administración" description="El titular y los administradores de la empresa gestionan miembros e invitaciones. Puedes seguir consultando los proyectos que tienes asignados." href="/projects" action="Ver mis proyectos" /></section>;
}
export const roleLabels = { owner: "Titular de empresa", administrator: "Administrador", technician: "Técnico", customer: "Propietario de instalación" } as const;
export function managementDate(value: Date | string, timezone: string) { return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value)); }
