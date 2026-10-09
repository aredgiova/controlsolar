import "server-only";
import { incidentCreateSchema, incidentListQuerySchema, incidentObservationSchema, incidentUpdateSchema } from "@/contracts/alerts";
import { uuidSchema } from "@/contracts/management";
import { withTenant } from "@/lib/tenant";
import { audit, conflict, DomainError, notFound, pageWindow, requireManager, requireProject, type Actor, type Transaction } from "@/modules/organizations/access";

async function validateAssignee(tx: Transaction, organizationId: string, projectId: string, userId: string | null | undefined) {
  if (!userId) return;
  const membership = await tx.membership.findFirst({ where: { organizationId, userId, status: "active" } });
  if (!membership || (!(membership.role === "owner" || membership.role === "administrator") && !(membership.role === "technician" && await tx.siteAccess.findFirst({ where: { organizationId, projectId, userId, role: "technician" } })))) throw new DomainError(400, "INVALID_ASSIGNEE", "El responsable debe ser administrador o técnico activo asignado a este proyecto.");
}
export async function listIncidents(actor: Actor, organizationId: string, input: unknown = {}) {
  const query = incidentListQuerySchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    const where = { organizationId, ...(query.projectId ? { projectId: query.projectId } : {}), ...(query.status ? { status: query.status } : {}), title: { contains: query.search, mode: "insensitive" as const } };
    const items = await tx.incident.findMany({ where, ...pageWindow(query), orderBy: [{ createdAt: "desc" }, { id: "asc" }], include: { project: { select: { id: true, name: true } }, alert: { select: { id: true, status: true, title: true, episodeId: true } } } });
    return { items, total: await tx.incident.count({ where }), page: query.page, pageSize: query.pageSize };
  });
}
export async function getIncident(actor: Actor, organizationId: string, incidentId: string) {
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    const incident = await tx.incident.findFirst({ where: { id: uuidSchema.parse(incidentId), organizationId }, include: { project: { select: { id: true, name: true } }, alert: { select: { id: true, status: true, title: true, episodeId: true } } } });
    if (!incident) notFound("No se encontró la incidencia autorizada.");
    const events = await tx.incidentEvent.findMany({ where: { organizationId, incidentId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 });
    return { incident, events: events.reverse() };
  });
}
export async function createIncident(actor: Actor, organizationId: string, input: unknown) {
  const data = incidentCreateSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx); await requireProject(tx, organizationId, data.projectId); await validateAssignee(tx, organizationId, data.projectId, data.assigneeUserId);
    let alertEpisodeId: string | undefined;
    if (data.alertId) {
      await tx.$queryRaw`SELECT id FROM alerts WHERE id=${data.alertId}::uuid AND organization_id=${organizationId}::uuid AND project_id=${data.projectId}::uuid FOR UPDATE`;
      const alert = await tx.alert.findFirst({ where: { id: data.alertId, organizationId, projectId: data.projectId, activatedAt: { not: null } } }); if (!alert) notFound("No se encontró una alerta emitida de este proyecto.");
      alertEpisodeId = alert.episodeId;
      const existing = await tx.incident.findFirst({ where: { organizationId, alertId: data.alertId, alertEpisodeId } }); if (existing) return existing;
    }
    const incident = await tx.incident.create({ data: { ...data, organizationId, alertEpisodeId, createdById: actor.userId } });
    await tx.incidentEvent.createMany({ data: [{ organizationId, projectId: data.projectId, incidentId: incident.id, actorId: actor.userId, kind: "created", note: data.description || null, detail: { assigneeUserId: data.assigneeUserId ?? null } }] });
    await audit(tx, actor, organizationId, "incident.created", "incident", incident.id, { projectId: data.projectId, alertId: data.alertId ?? null });
    return incident;
  });
}
export async function updateIncident(actor: Actor, organizationId: string, incidentId: string, input: unknown) {
  const data = incidentUpdateSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx);
    await tx.$queryRaw`SELECT id FROM incidents WHERE id=${uuidSchema.parse(incidentId)}::uuid AND organization_id=${organizationId}::uuid FOR UPDATE`;
    const current = await tx.incident.findFirst({ where: { id: incidentId, organizationId } }); if (!current) notFound("No se encontró la incidencia autorizada.");
    if (current.status === "closed") conflict("La incidencia cerrada conserva su resolución; puedes añadir observaciones al historial.");
    if (data.resolution && data.status !== "closed") throw new DomainError(400, "RESOLUTION_REQUIRES_CLOSE", "La resolución se registra al cerrar la incidencia.");
    await validateAssignee(tx, organizationId, current.projectId, data.assigneeUserId);
    const incident = await tx.incident.update({ where: { id: incidentId }, data: { ...data, ...(data.status === "closed" ? { closedAt: new Date() } : {}) } });
    if (data.assigneeUserId !== undefined && data.assigneeUserId !== current.assigneeUserId) await tx.incidentEvent.createMany({ data: [{ organizationId, projectId: current.projectId, incidentId, actorId: actor.userId, kind: "assigned", detail: { from: current.assigneeUserId, to: data.assigneeUserId } }] });
    if (data.status && data.status !== current.status) await tx.incidentEvent.createMany({ data: [{ organizationId, projectId: current.projectId, incidentId, actorId: actor.userId, kind: data.status === "closed" ? "closed" : "status_changed", note: data.resolution ?? null, detail: { from: current.status, to: data.status } }] });
    await audit(tx, actor, organizationId, data.status === "closed" ? "incident.closed" : "incident.updated", "incident", incidentId, { projectId: current.projectId, fields: Object.keys(data) });
    return incident;
  });
}
export async function addIncidentObservation(actor: Actor, organizationId: string, incidentId: string, input: unknown) {
  const data = incidentObservationSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx);
    const incident = await tx.incident.findFirst({ where: { id: uuidSchema.parse(incidentId), organizationId } }); if (!incident) notFound("No se encontró la incidencia autorizada.");
    const event = await tx.incidentEvent.create({ data: { organizationId, projectId: incident.projectId, incidentId, actorId: actor.userId, kind: "observation", note: data.note } });
    await audit(tx, actor, organizationId, "incident.observation_added", "incident", incidentId, { projectId: incident.projectId, eventId: event.id });
    return event;
  });
}
