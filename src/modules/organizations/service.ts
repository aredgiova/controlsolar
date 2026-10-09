import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { acceptInvitation as acceptInvitationInDatabase, createOrganization as createOrganizationInDatabase, listOrganizations as listOrganizationsInDatabase, readTenantContext, withTenant } from "@/lib/tenant";
import { invitationAcceptSchema, invitationCreateSchema, membershipUpdateSchema, organizationCreateSchema } from "@/contracts/management";
import { audit, conflict, DomainError, notFound, requireManager, type Actor } from "./access";

export async function listOrganizations(identity: Actor) { return listOrganizationsInDatabase(identity); }
export async function createOrganization(identity: Actor, input: unknown) {
  return createOrganizationInDatabase(identity, organizationCreateSchema.parse(input));
}
export async function listMembers(identity: Actor, organizationId: string) {
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    const entries = await tx.membership.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, email: true, name: true } }, siteAccess: { select: { projectId: true, role: true } } } });
    return entries.map((entry) => ({ ...entry, user: { ...entry.user, displayName: entry.user.name } }));
  });
}
export async function updateMembership(identity: Actor, organizationId: string, id: string, input: unknown) {
  const data = membershipUpdateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    const context = await requireManager(tx);
    // Lock a common row so two concurrent demotions cannot remove the last owner.
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
    const membership = await tx.membership.findFirst({ where: { id, organizationId } });
    if (!membership) notFound("No se encontró la membresía autorizada.");
    if ((membership.role === "owner" || data.role === "owner") && context.role !== "owner") throw new DomainError(403, "OWNER_REQUIRED", "Solo un titular puede administrar otros titulares.");
    const role = data.role ?? membership.role;
    const status = data.status ?? membership.status;
    if (membership.role === "owner" && membership.status === "active" && (role !== "owner" || status !== "active")) {
      if (await tx.membership.count({ where: { organizationId, role: "owner", status: "active" } }) <= 1) conflict("Debe permanecer al menos un titular activo.");
    }
    if (role !== membership.role || status !== "active") await tx.siteAccess.deleteMany({ where: { organizationId, userId: membership.userId } });
    // Append before an allowed self-demotion removes this transaction's tenant role.
    await audit(tx, identity, organizationId, "membership.updated", "membership", id, { previousRole: membership.role, previousStatus: membership.status, role, status });
    await tx.membership.updateMany({ where: { id, organizationId }, data });
    return { ...membership, ...data };
  });
}
const invitationSelect = { id: true, organizationId: true, email: true, role: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true, createdBy: true, projects: { select: { projectId: true } } } as const;
export async function listInvitations(identity: Actor, organizationId: string) {
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    const entries = await tx.invitation.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 100, select: invitationSelect });
    return entries.map((entry) => ({ ...entry, status: entry.revokedAt ? "revoked" : entry.acceptedAt ? "accepted" : entry.expiresAt <= new Date() ? "expired" : "pending" }));
  });
}
export async function createInvitation(identity: Actor, organizationId: string, input: unknown) {
  const data = invitationCreateSchema.parse(input);
  return withTenant(identity, organizationId, async (tx) => {
    await requireManager(tx);
    const context = await readTenantContext(tx);
    if (data.role === "owner" && context.role !== "owner") throw new DomainError(403, "OWNER_REQUIRED", "Solo un titular puede invitar a otro titular.");
    const projects = [...new Set(data.projectIds)];
    if (projects.length && await tx.project.count({ where: { organizationId, id: { in: projects } } }) !== projects.length) throw new DomainError(400, "INVALID_PROJECT_SCOPE", "Todos los proyectos deben pertenecer a esta organización.");
    if (await tx.membership.findFirst({ where: { organizationId, status: "active", user: { email: data.email } } })) conflict("La persona ya tiene una membresía activa.");
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const created = await tx.invitation.create({ data: { organizationId, email: data.email, role: data.role, tokenHash, createdBy: identity.userId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }, select: { id: true } });
    if (projects.length) await tx.invitationProject.createMany({ data: projects.map((projectId) => ({ organizationId, projectId, invitationId: created.id })) });
    const invitation = await tx.invitation.findUniqueOrThrow({ where: { id: created.id }, select: invitationSelect });
    await audit(tx, identity, organizationId, "invitation.created", "invitation", invitation.id, { email: data.email, role: data.role, projectIds: projects });
    // The raw token is returned once, never persisted or placed in audit logs.
    return { ...invitation, token, invitationPath: `/invitations/${token}` };
  });
}
export async function revokeInvitation(identity: Actor, organizationId: string, id: string) {
  return withTenant(identity, organizationId, async (tx) => {
    const context = await requireManager(tx);
    await tx.$queryRaw`SELECT id FROM invitations WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
    const entry = await tx.invitation.findFirst({ where: { id, organizationId }, select: invitationSelect });
    if (!entry) notFound("No se encontró la invitación autorizada.");
    if (entry.role === "owner" && context.role !== "owner") throw new DomainError(403, "OWNER_REQUIRED", "Solo un titular puede administrar invitaciones de titulares.");
    if (entry.acceptedAt) conflict("La invitación ya fue aceptada. Administra su membresía para revocar el acceso.");
    const invitation = await tx.invitation.update({ where: { id }, data: { revokedAt: new Date() }, select: invitationSelect });
    await audit(tx, identity, organizationId, "invitation.revoked", "invitation", id);
    return invitation;
  });
}
export async function acceptInvitation(identity: Actor, input: unknown) {
  const { token } = invitationAcceptSchema.parse(input);
  return { organizationId: await acceptInvitationInDatabase(identity, createHash("sha256").update(token).digest("hex")) };
}
