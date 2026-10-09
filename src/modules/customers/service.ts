import "server-only";
import { withTenant } from "@/lib/tenant";
import { customerCreateSchema, customerUpdateSchema, listQuerySchema } from "@/contracts/management";
import { audit, notFound, pageWindow, requireManager, type Actor } from "@/modules/organizations/access";

export async function listCustomers(identity: Actor, organizationId: string, queryInput: unknown = {}) {
  const query = listQuerySchema.parse(queryInput);
  return withTenant(identity, organizationId, async (tx) => {
    const where = { organizationId, name: { contains: query.search, mode: "insensitive" as const } };
    const items = await tx.customer.findMany({ where, ...pageWindow(query), orderBy: [{ name: "asc" }, { id: "asc" }] });
    const total = await tx.customer.count({ where });
    return { items, total, page: query.page, pageSize: query.pageSize };
  });
}
export async function createCustomer(identity: Actor, organizationId: string, input: unknown) {
  const data = customerCreateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    const customer = await tx.customer.create({ data: { ...data, organizationId } });
    await audit(tx, identity, organizationId, "customer.created", "customer", customer.id);
    return customer;
  });
}
export async function updateCustomer(identity: Actor, organizationId: string, id: string, input: unknown) {
  const data = customerUpdateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    if (!await tx.customer.findFirst({ where: { id, organizationId } })) notFound("No se encontró el cliente autorizado.");
    const customer = await tx.customer.update({ where: { id }, data });
    await audit(tx, identity, organizationId, "customer.updated", "customer", id);
    return customer;
  });
}
