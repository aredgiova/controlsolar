import "server-only";
import { HttpError } from "@/modules/auth/errors";
import { readTenantContext } from "@/lib/tenant";
import type { Prisma } from "@/generated/prisma/client";

export type Actor = { userId: string; email?: string };
export type Transaction = Prisma.TransactionClient;
export class DomainError extends HttpError {
  constructor(status: number, code: string, message: string) { super(status, code, message); }
}
export async function requireManager(tx: Transaction) {
  const context = await readTenantContext(tx);
  if (!context.canManageOrganization) throw new DomainError(403, "FORBIDDEN", "Se requiere permiso de administración.");
  return context;
}
export async function requireProject(tx: Transaction, organizationId: string, projectId: string) {
  const project = await tx.project.findFirst({ where: { id: projectId, organizationId } });
  if (!project) throw new DomainError(404, "NOT_FOUND", "No se encontró el proyecto autorizado.");
  return project;
}
export async function audit(tx: Transaction, actor: Actor, organizationId: string, action: string, entityType: string, entityId: string, detail: Prisma.InputJsonValue = {}) {
  // Append without RETURNING: a customer may audit an export but cannot read the audit log.
  await tx.auditEvent.createMany({ data: [{ organizationId, actorId: actor.userId, action, entityType, entityId, detail }] });
}
export function pageWindow(query: { page: number; pageSize: number }) { return { skip: (query.page - 1) * query.pageSize, take: query.pageSize }; }
export function notFound(message: string): never { throw new DomainError(404, "NOT_FOUND", message); }
export function conflict(message: string): never { throw new DomainError(409, "CONFLICT", message); }
