import "server-only";
import { withTenant } from "@/lib/tenant";
import { bindingSchema, commissioningSchema, csvCell, listQuerySchema, participantSchema, pointCreateSchema, projectCreateSchema, projectUpdateSchema, topologySchema } from "@/contracts/management";
import { audit, conflict, DomainError, notFound, pageWindow, requireManager, requireProject, type Actor, type Transaction } from "@/modules/organizations/access";

export async function listProjects(identity: Actor, organizationId: string, queryInput: unknown = {}) {
  const query = listQuerySchema.parse(queryInput);
  return withTenant(identity, organizationId, async (tx) => {
    const where = { organizationId, OR: [{ name: { contains: query.search, mode: "insensitive" as const } }, { location: { contains: query.search, mode: "insensitive" as const } }] };
    const items = await tx.project.findMany({ where, ...pageWindow(query), orderBy: [{ name: "asc" }, { id: "asc" }], include: { customer: true } });
    const total = await tx.project.count({ where });
    return { items, total, page: query.page, pageSize: query.pageSize };
  });
}
export async function createProject(identity: Actor, organizationId: string, input: unknown) {
  const { topologyType, ...data } = projectCreateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    if (!await tx.customer.findFirst({ where: { id: data.customerId, organizationId } })) notFound("No se encontró el cliente autorizado.");
    const project = await tx.project.create({ data: { ...data, organizationId, topology: topologyType } });
    await audit(tx, identity, organizationId, "project.created", "project", project.id);
    return project;
  });
}
export async function updateProject(identity: Actor, organizationId: string, id: string, input: unknown) {
  const { topologyType, ...data } = projectUpdateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    const project = await requireProject(tx, organizationId, id);
    if (data.customerId && !await tx.customer.findFirst({ where: { id: data.customerId, organizationId } })) notFound("No se encontró el cliente autorizado.");
    const lat = data.latitude === undefined ? project.latitude : data.latitude;
    const lon = data.longitude === undefined ? project.longitude : data.longitude;
    if ((lat == null) !== (lon == null)) throw new DomainError(400, "INVALID_LOCATION", "Latitud y longitud deben definirse juntas.");
    const updated = await tx.project.update({ where: { id }, data: { ...data, ...(topologyType ? { topology: topologyType } : {}) } });
    await audit(tx, identity, organizationId, "project.updated", "project", id);
    return updated;
  });
}
export async function getProjectManagement(identity: Actor, organizationId: string, id: string) {
  return withTenant(identity, organizationId, async (tx) => {
    const project = await tx.project.findFirst({ where: { id, organizationId }, include: {
      customer: true, measurementPoints: { orderBy: { createdAt: "asc" } },
      bindings: { orderBy: [{ validFrom: "desc" }, { id: "asc" }], include: { device: true, measurementPoint: true } },
      topologyVersions: { orderBy: { version: "desc" } },
      siteAccess: { include: { membership: { include: { user: { select: { id: true, email: true, name: true } } } } } },
    } });
    if (!project) notFound("No se encontró el proyecto autorizado.");
    const pointIds = project.measurementPoints.map((point) => point.id);
    const history = await tx.auditEvent.findMany({ where: { organizationId, OR: [{ entityType: "project", entityId: id }, { entityType: "measurement_point", entityId: { in: pointIds } }] }, orderBy: { createdAt: "desc" }, take: 100 });
    return { ...project, deviceBindings: project.bindings, siteAccess: project.siteAccess.map((entry) => ({ ...entry, user: entry.membership.user })), history };
  });
}
export async function createMeasurementPoint(identity: Actor, organizationId: string, projectId: string, input: unknown) {
  const data = pointCreateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx); await requireProject(tx, organizationId, projectId);
    const point = await tx.measurementPoint.create({ data: { ...data, organizationId, projectId } });
    await audit(tx, identity, organizationId, "point.created", "measurement_point", point.id, { projectId });
    return point;
  });
}
export async function assignParticipant(identity: Actor, organizationId: string, projectId: string, input: unknown) {
  const data = participantSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx); await requireProject(tx, organizationId, projectId);
    const membership = await tx.membership.findFirst({ where: { organizationId, userId: data.userId, status: "active" } });
    if (!membership || membership.role !== data.role) throw new DomainError(400, "INVALID_PARTICIPANT", "La persona debe tener una membresía activa con el mismo rol.");
    const entry = await tx.siteAccess.upsert({ where: { organizationId_projectId_userId: { organizationId, projectId, userId: data.userId } }, create: { organizationId, projectId, ...data }, update: { role: data.role } });
    await audit(tx, identity, organizationId, "participant.assigned", "project", projectId, data);
    return entry;
  });
}
export async function removeParticipant(identity: Actor, organizationId: string, projectId: string, userId: string) {
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx); await requireProject(tx, organizationId, projectId);
    const result = await tx.siteAccess.deleteMany({ where: { organizationId, projectId, userId } });
    await audit(tx, identity, organizationId, "participant.removed", "project", projectId, { userId });
    return { removed: result.count };
  });
}

function pastDate(value: string) {
  const date = new Date(value);
  if (date.getTime() > Date.now()) throw new DomainError(400, "FUTURE_EFFECTIVE_DATE", "La fecha efectiva no puede estar en el futuro.");
  return date;
}
export async function replaceBinding(identity: Actor, organizationId: string, projectId: string, input: unknown) {
  const data = bindingSchema.parse(input);
  const validFrom = pastDate(data.validFrom);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx); await requireProject(tx, organizationId, projectId);
    await tx.$queryRaw`SELECT id FROM measurement_points WHERE id = ${data.measurementPointId}::uuid AND organization_id = ${organizationId}::uuid AND project_id = ${projectId}::uuid FOR UPDATE`;
    const point = await tx.measurementPoint.findFirst({ where: { id: data.measurementPointId, organizationId, projectId } });
    if (!point) notFound("No se encontró el punto autorizado.");
    await tx.$queryRaw`SELECT id FROM devices WHERE id = ${data.deviceId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
    const device = await tx.device.findFirst({ where: { id: data.deviceId, organizationId } });
    if (!device) notFound("No se encontró el equipo autorizado.");
    if (device.kind !== "meter" || device.status !== "active") conflict("Solo un medidor activo puede vincularse a un punto.");
    const previous = await tx.deviceBinding.findFirst({ where: { organizationId, measurementPointId: point.id }, orderBy: { configurationVersion: "desc" } });
    if (previous) {
      if (validFrom <= previous.validFrom || (previous.validTo && validFrom < previous.validTo)) conflict("La fecha debe ser posterior a la asignación anterior.");
      if (await tx.telemetrySample.count({ where: { organizationId, bindingId: previous.id, measuredAt: { gte: validFrom } } })) conflict("La fecha modificaría la interpretación de mediciones históricas.");
      if (!previous.validTo) await tx.deviceBinding.update({ where: { id: previous.id }, data: { validTo: validFrom } });
    }
    const binding = await tx.deviceBinding.create({ data: { organizationId, projectId, deviceId: device.id, measurementPointId: point.id, validFrom, configurationVersion: (previous?.configurationVersion ?? 0) + 1, configuration: data.configuration } });
    await audit(tx, identity, organizationId, previous ? "binding.replaced" : "binding.created", "project", projectId, { bindingId: binding.id, previousBindingId: previous?.id ?? null, measurementPointId: point.id, deviceId: device.id, validFrom: validFrom.toISOString() });
    return binding;
  });
}
async function validateTopologyPoints(tx: Transaction, organizationId: string, projectId: string, configuration: { generationPointId: string; gridPointId: string; consumptionPointId: string | null }) {
  const entries = [[configuration.generationPointId, "generation"], [configuration.gridPointId, "grid"], ...(configuration.consumptionPointId ? [[configuration.consumptionPointId, "consumption"]] : [])];
  for (const [id, kind] of entries) {
    if (!await tx.measurementPoint.findFirst({ where: { id, kind: kind as "generation" | "grid" | "consumption", organizationId, projectId } })) throw new DomainError(400, "INVALID_TOPOLOGY", "La topología requiere puntos del proyecto y de la función indicada.");
  }
}
export async function createTopologyVersion(identity: Actor, organizationId: string, projectId: string, input: unknown) {
  const data = topologySchema.parse(input);
  const validFrom = pastDate(data.validFrom);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx); await requireProject(tx, organizationId, projectId);
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
    await validateTopologyPoints(tx, organizationId, projectId, data.configuration);
    const previous = await tx.topologyVersion.findFirst({ where: { organizationId, projectId }, orderBy: { version: "desc" } });
    if (previous) {
      if (validFrom <= previous.validFrom || (previous.validTo && validFrom < previous.validTo)) conflict("La versión nueva debe ser posterior a la anterior.");
      const points = await tx.measurementPoint.findMany({ where: { organizationId, projectId }, select: { id: true } });
      if (await tx.telemetrySample.count({ where: { organizationId, measurementPointId: { in: points.map((point) => point.id) }, measuredAt: { gte: validFrom } } })) conflict("La fecha modificaría la interpretación de mediciones históricas.");
      if (!previous.validTo) await tx.topologyVersion.update({ where: { id: previous.id }, data: { validTo: validFrom } });
    }
    const version = await tx.topologyVersion.create({ data: { organizationId, projectId, version: (previous?.version ?? 0) + 1, validFrom, configuration: data.configuration } });
    await audit(tx, identity, organizationId, "topology.versioned", "project", projectId, { topologyVersionId: version.id, version: version.version, validFrom: validFrom.toISOString() });
    return version;
  });
}
export async function commissionProject(identity: Actor, organizationId: string, projectId: string, input: unknown) {
  const data = commissioningSchema.parse(input);
  const commissionedAt = pastDate(data.commissionedAt);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
    const project = await requireProject(tx, organizationId, projectId);
    if (project.commissionedAt) conflict("El proyecto ya tiene una puesta en marcha registrada.");
    const version = await tx.topologyVersion.findFirst({ where: { organizationId, projectId, validFrom: { lte: commissionedAt }, OR: [{ validTo: null }, { validTo: { gt: commissionedAt } }] } });
    if (!version) conflict("Registra una topología vigente antes de la puesta en marcha.");
    const configuration = topologySchema.shape.configuration.parse(version.configuration);
    await validateTopologyPoints(tx, organizationId, projectId, configuration);
    const requiredIds = [configuration.generationPointId, configuration.gridPointId, ...(configuration.consumptionPointId ? [configuration.consumptionPointId] : [])];
    for (const pointId of requiredIds) {
      const binding = await tx.deviceBinding.findFirst({ where: { organizationId, projectId, measurementPointId: pointId, validFrom: { lte: commissionedAt }, OR: [{ validTo: null }, { validTo: { gt: commissionedAt } }], device: { status: "active", kind: "meter" } } });
      if (!binding) conflict("Cada punto de la topología requiere un medidor vigente al ponerlo en marcha.");
    }
    const updated = await tx.project.update({ where: { id: projectId }, data: { commissionedAt } });
    await audit(tx, identity, organizationId, "project.commissioned", "project", projectId, { commissionedAt: commissionedAt.toISOString(), notes: data.notes, topologyVersionId: version.id });
    return updated;
  });
}
export async function exportProjects(identity: Actor, organizationId: string, search = "") {
  return withTenant(identity, organizationId, async (tx) => {
    // RLS applies the same site scope as the project API. No cache or privileged client.
    const items = await tx.project.findMany({ where: { organizationId, name: { contains: search, mode: "insensitive" } }, orderBy: { id: "asc" }, include: { customer: true }, take: 10001 });
    if (items.length > 10000) throw new DomainError(400, "EXPORT_LIMIT", "Limita la búsqueda a 10.000 proyectos por exportación.");
    await audit(tx, identity, organizationId, "projects.exported", "organization", organizationId, { count: items.length });
    return "\uFEFF" + [["id", "nombre", "cliente", "ubicacion", "potencia_kWp", "zona_horaria"], ...items.map((project) => [project.id, project.name, project.customer.name, project.location, project.capacityKwp.toString(), project.timezone])].map((row) => row.map(csvCell).join(",")).join("\r\n");
  });
}
