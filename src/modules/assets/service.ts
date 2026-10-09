import "server-only";
import { withTenant } from "@/lib/tenant";
import { deviceCreateSchema, deviceUpdateSchema, listQuerySchema } from "@/contracts/management";
import { audit, conflict, notFound, pageWindow, requireManager, type Actor } from "@/modules/organizations/access";

export async function listDevices(identity: Actor, organizationId: string, queryInput: unknown = {}) {
  const query = listQuerySchema.parse(queryInput);
  return withTenant(identity, organizationId, async (tx) => {
    const where = { organizationId, OR: [{ name: { contains: query.search, mode: "insensitive" as const } }, { serial: { contains: query.search, mode: "insensitive" as const } }] };
    const items = await tx.device.findMany({ where, ...pageWindow(query), orderBy: [{ name: "asc" }, { id: "asc" }], include: { bindings: { where: { validTo: null }, select: { projectId: true, measurementPointId: true } } } });
    const total = await tx.device.count({ where });
    return { items, total, page: query.page, pageSize: query.pageSize };
  });
}
export async function createDevice(identity: Actor, organizationId: string, input: unknown) {
  const data = deviceCreateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    const device = await tx.device.create({ data: { organizationId, name: data.name, serial: data.serialNumber, kind: data.kind } });
    await audit(tx, identity, organizationId, "device.created", "device", device.id);
    return device;
  });
}
export async function updateDevice(identity: Actor, organizationId: string, id: string, input: unknown) {
  const data = deviceUpdateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    if (!await tx.device.findFirst({ where: { id, organizationId } })) notFound("No se encontró el equipo autorizado.");
    const device = await tx.device.update({ where: { id }, data });
    await audit(tx, identity, organizationId, "device.updated", "device", id);
    return device;
  });
}
export async function retireDevice(identity: Actor, organizationId: string, id: string) {
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    // The row lock serializes retirement and bindings referencing this device.
    await tx.$queryRaw`SELECT id FROM devices WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
    if (!await tx.device.findFirst({ where: { id, organizationId } })) notFound("No se encontró el equipo autorizado.");
    if (await tx.deviceBinding.count({ where: { organizationId, deviceId: id, validTo: null } })) conflict("Sustituye o cierra las asignaciones activas antes de retirar el equipo.");
    const device = await tx.device.update({ where: { id }, data: { status: "retired" } });
    await audit(tx, identity, organizationId, "device.retired", "device", id);
    return device;
  });
}
