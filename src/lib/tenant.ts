import "server-only";
import type { Prisma, MembershipRole, Organization } from "@/generated/prisma/client";
import { getDatabase } from "@/lib/db";
import { HttpError } from "@/modules/auth/errors";

/** This identity must come from the verified server session, never request JSON. */
export interface TenantIdentity { userId: string }
export interface TenantContext {
  userId: string;
  organizationId: string;
  role: MembershipRole;
  canManageOrganization: boolean;
  canManageAssets: boolean;
}
export class TenantAuthorizationError extends HttpError {
  constructor(message = "No tienes acceso a esta empresa o instalación.") {
    super(403, "FORBIDDEN", message);
    this.name = "TenantAuthorizationError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function assertRuntimeRole(tx: Prisma.TransactionClient) {
  const [effective] = await tx.$queryRaw<Array<{ safe: boolean }>>`
    SELECT current_user = 'solar_runtime' AND session_user = 'solar_runtime'
      AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
      AND current_setting('TimeZone') = 'UTC'
      AND NOT pg_has_role(current_user, 'solar_security_guard', 'MEMBER')
      AND NOT pg_has_role(current_user, 'solar_migrator', 'MEMBER')
      AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
          AND (c.relowner = r.oid OR pg_has_role(current_user, c.relowner, 'MEMBER')))
      AND NOT EXISTS (SELECT FROM pg_roles privileged
        WHERE (privileged.rolsuper OR privileged.rolbypassrls)
          AND pg_has_role(current_user, privileged.oid, 'MEMBER'))
      AND (SELECT count(*) = 32 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN
          ('users','sessions','auth_flows','organizations','memberships','customers','projects','devices',
           'measurement_points','device_bindings','topology_versions','site_access','invitations',
           'invitation_projects','audit_events','telemetry_samples','gateway_identities','gateway_meters',
           'telemetry_latest','telemetry_daily_aggregates','ingestion_quarantine','gateway_loss_reports',
           'alert_rules','alerts','alert_events','incidents','incident_events','maintenance_windows',
           'notification_outbox','report_jobs','download_leases','request_rate_limits')) AS safe
    FROM pg_roles r WHERE r.rolname = current_user`;
  if (!effective?.safe) {
    throw new HttpError(503, "UNSAFE_DATABASE_ROLE", "La base de datos no tiene el aislamiento requerido.");
  }
}

/** A separate scope for the three audited identity bootstrap functions only. */
export async function withIdentity<T>(identity: TenantIdentity, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!uuid.test(identity.userId)) throw new TenantAuthorizationError();
  return getDatabase().$transaction(async (tx) => {
    await assertRuntimeRole(tx);
    await tx.$queryRaw`SELECT set_config('app.user_id', ${identity.userId}, true), set_config('app.organization_id', '', true)`;
    return callback(tx);
  }, { maxWait: 5_000, timeout: 15_000 });
}

export async function readTenantContext(tx: Prisma.TransactionClient): Promise<TenantContext> {
  const [row] = await tx.$queryRaw<Array<{ userId: string | null; organizationId: string | null; role: MembershipRole | null }>>`
    SELECT public.app_user_id()::text AS "userId", public.app_organization_id()::text AS "organizationId",
      public.app_role(public.app_organization_id()) AS role`;
  if (!row?.userId || !row.organizationId || !row.role) throw new TenantAuthorizationError();
  return {
    userId: row.userId,
    organizationId: row.organizationId,
    role: row.role,
    canManageOrganization: row.role === "owner" || row.role === "administrator",
    canManageAssets: row.role !== "customer",
  };
}

/** SET LOCAL and membership checks share the same transaction and pooled connection. */
export async function withTenant<T>(identity: TenantIdentity, organizationId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!uuid.test(organizationId)) throw new TenantAuthorizationError();
  return withIdentity(identity, async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    await readTenantContext(tx);
    return callback(tx);
  });
}

type OrganizationRow = {
  id: string; schema_version: string; name: string; slug: string; timezone: string;
  created_at: Date; updated_at: Date;
};
function organizationModel(row: OrganizationRow): Organization {
  return { id: row.id, schemaVersion: row.schema_version, name: row.name, slug: row.slug,
    timezone: row.timezone, createdAt: row.created_at, updatedAt: row.updated_at };
}
export async function listOrganizations(identity: TenantIdentity): Promise<Array<Organization & { role: MembershipRole }>> {
  return withIdentity(identity, async (tx) => {
    const rows = await tx.$queryRaw<OrganizationRow[]>`SELECT * FROM public.app_list_organizations()`;
    const organizations: Array<Organization & { role: MembershipRole }> = [];
    for (const row of rows) {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${row.id}, true)`;
      const { role } = await readTenantContext(tx);
      organizations.push({ ...organizationModel(row), role });
    }
    return organizations;
  });
}
export async function createOrganization(identity: TenantIdentity, input: { name: string; slug: string; timezone: string }): Promise<Organization> {
  return withIdentity(identity, async (tx) => {
    const [row] = await tx.$queryRaw<OrganizationRow[]>`SELECT * FROM public.app_create_organization(${input.name}, ${input.slug}, ${input.timezone})`;
    return organizationModel(row);
  });
}
export async function acceptInvitation(identity: TenantIdentity, tokenHash: string): Promise<string> {
  return withIdentity(identity, async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ organizationId: string }>>`SELECT public.app_accept_invitation(${tokenHash})::text AS "organizationId"`;
    return row.organizationId;
  });
}
