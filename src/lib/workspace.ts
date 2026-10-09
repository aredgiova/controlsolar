import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { readConfig } from "@/lib/config";
import { createDemoAdapter } from "@/adapters/demo/adapter";
import { requireIdentity } from "@/modules/auth/session";
import { listOrganizations } from "@/modules/organizations/service";

const authorizedWorkspace = cache(async () => {
  const identity = await requireIdentity();
  const organizations = await listOrganizations(identity);
  return { identity, organizations };
});

export async function readWorkspace(organizationId?: string) {
  const config = readConfig();
  if (config.demoMode) {
    const portfolio = createDemoAdapter(config).getPortfolio(organizationId);
    if (!portfolio) notFound();
    return { isDemo: true as const, identity: null, organizations: portfolio.organizations,
      organization: { ...portfolio.organization, role: "demo" as const }, canManage: false };
  }
  const { identity, organizations } = await authorizedWorkspace();
  if (!organizations.length) redirect("/organizations/new");
  const organization = organizationId ? organizations.find((item) => item.id === organizationId) : organizations[0];
  if (!organization) notFound();
  return { isDemo: false as const, identity, organizations, organization,
    canManage: organization.role === "owner" || organization.role === "administrator" };
}
