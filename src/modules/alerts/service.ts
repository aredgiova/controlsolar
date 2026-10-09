import "server-only";
import { alertListQuerySchema, alertRuleSchema, alertRuleUpdateSchema, maintenanceCancelSchema, maintenanceWindowSchema, projectFilterSchema } from "@/contracts/alerts";
import { uuidSchema } from "@/contracts/management";
import { withTenant } from "@/lib/tenant";
import { audit, DomainError, notFound, pageWindow, requireManager, requireProject, type Actor } from "@/modules/organizations/access";

export async function listAlertRules(actor: Actor, organizationId: string, input: unknown = {}) {
  const query = projectFilterSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    const where = { organizationId, ...(query.projectId ? { projectId: query.projectId } : {}), name: { contains: query.search, mode: "insensitive" as const } };
    const items = await tx.alertRule.findMany({ where, ...pageWindow(query), orderBy: [{ createdAt: "desc" }, { id: "asc" }], include: { project: { select: { id: true, name: true } } } });
    return { items, total: await tx.alertRule.count({ where }), page: query.page, pageSize: query.pageSize };
  });
}
export async function createAlertRule(actor: Actor, organizationId: string, input: unknown) {
  const data = alertRuleSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx); await requireProject(tx, organizationId, data.projectId);
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${data.projectId}::uuid AND organization_id=${organizationId}::uuid FOR UPDATE`;
    if (await tx.alertRule.count({ where: { organizationId, projectId: data.projectId } }) >= 32) throw new DomainError(400, "RULE_LIMIT", "Este proyecto admite hasta 32 reglas.");
    const rule = await tx.alertRule.create({ data: { ...data, organizationId } });
    await audit(tx, actor, organizationId, "alert_rule.created", "alert_rule", rule.id, { projectId: data.projectId, kind: data.kind });
    return rule;
  });
}
export async function updateAlertRule(actor: Actor, organizationId: string, ruleId: string, input: unknown) {
  const changes = alertRuleUpdateSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx);
    await tx.$queryRaw`SELECT id FROM alert_rules WHERE id=${uuidSchema.parse(ruleId)}::uuid AND organization_id=${organizationId}::uuid FOR UPDATE`;
    const rule = await tx.alertRule.findFirst({ where: { id: ruleId, organizationId } }); if (!rule) notFound("No se encontró la regla autorizada.");
    const data = alertRuleSchema.parse({ projectId: rule.projectId, kind: rule.kind, name: changes.name ?? rule.name, enabled: changes.enabled ?? rule.enabled, persistenceSeconds: changes.persistenceSeconds ?? rule.persistenceSeconds, recoverySeconds: changes.recoverySeconds ?? rule.recoverySeconds, configuration: changes.configuration ?? rule.configuration });
    const updated = await tx.alertRule.update({ where: { id: ruleId }, data: { name: data.name, enabled: data.enabled, persistenceSeconds: data.persistenceSeconds, recoverySeconds: data.recoverySeconds, configuration: data.configuration } });
    await audit(tx, actor, organizationId, "alert_rule.updated", "alert_rule", ruleId, { projectId: rule.projectId, fields: Object.keys(changes) });
    return updated;
  });
}
export async function listAlerts(actor: Actor, organizationId: string, input: unknown = {}) {
  const query = alertListQuerySchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    const where = { organizationId, ...(query.projectId ? { projectId: query.projectId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.status === "pending" ? {} : { activatedAt: { not: null } }), ...(query.kind ? { rule: { kind: query.kind } } : {}), title: { contains: query.search, mode: "insensitive" as const } };
    const items = await tx.alert.findMany({ where, ...pageWindow(query), orderBy: [{ lastEvaluatedAt: "desc" }, { id: "asc" }], include: { project: { select: { id: true, name: true } }, rule: { select: { id: true, name: true, kind: true } } } });
    return { items, total: await tx.alert.count({ where }), page: query.page, pageSize: query.pageSize };
  });
}
export async function getAlertHistory(actor: Actor, organizationId: string, alertId: string) {
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    const alert = await tx.alert.findFirst({ where: { id: uuidSchema.parse(alertId), organizationId }, include: { project: { select: { id: true, name: true } }, rule: { select: { id: true, name: true, kind: true } } } });
    if (!alert) notFound("No se encontró la alerta autorizada.");
    return { alert, events: await tx.alertEvent.findMany({ where: { organizationId, alertId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 200 }) };
  });
}
export async function listMaintenanceWindows(actor: Actor, organizationId: string, input: unknown = {}) {
  const query = projectFilterSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    const where = { organizationId, ...(query.projectId ? { projectId: query.projectId } : {}), reason: { contains: query.search, mode: "insensitive" as const } };
    const items = await tx.maintenanceWindow.findMany({ where, ...pageWindow(query), orderBy: [{ from: "desc" }, { id: "asc" }], include: { project: { select: { id: true, name: true } } } });
    return { items, total: await tx.maintenanceWindow.count({ where }), page: query.page, pageSize: query.pageSize };
  });
}
export async function createMaintenanceWindow(actor: Actor, organizationId: string, input: unknown) {
  const data = maintenanceWindowSchema.parse(input);
  if (Date.parse(data.to) <= Date.now()) throw new DomainError(400, "EXPIRED_MAINTENANCE", "El mantenimiento debe terminar en el futuro.");
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx); await requireProject(tx, organizationId, data.projectId);
    const window = await tx.maintenanceWindow.create({ data: { ...data, from: new Date(data.from), to: new Date(data.to), organizationId, createdById: actor.userId } });
    await audit(tx, actor, organizationId, "maintenance.created", "maintenance_window", window.id, { projectId: data.projectId, from: data.from, to: data.to });
    return window;
  });
}
export async function cancelMaintenanceWindow(actor: Actor, organizationId: string, windowId: string, input: unknown) {
  maintenanceCancelSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx);
    const current = await tx.maintenanceWindow.findFirst({ where: { id: uuidSchema.parse(windowId), organizationId } }); if (!current) notFound("No se encontró el mantenimiento autorizado.");
    if (current.cancelledAt) return current;
    const window = await tx.maintenanceWindow.update({ where: { id: windowId }, data: { cancelledAt: new Date() } });
    await audit(tx, actor, organizationId, "maintenance.cancelled", "maintenance_window", windowId, { projectId: current.projectId });
    return window;
  });
}
export async function listNotifications(actor: Actor, organizationId: string, input: unknown = {}) {
  const query = projectFilterSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    const where = { organizationId, status: "delivered" as const, ...(query.projectId ? { projectId: query.projectId } : {}) };
    const items = await tx.notificationOutbox.findMany({ where, ...pageWindow(query), orderBy: [{ deliveredAt: "desc" }, { id: "asc" }], select: { id: true, projectId: true, alertId: true, episodeId: true, eventKind: true, payload: true, createdAt: true, deliveredAt: true, project: { select: { id: true, name: true } } } });
    return { items, total: await tx.notificationOutbox.count({ where }), page: query.page, pageSize: query.pageSize };
  });
}
