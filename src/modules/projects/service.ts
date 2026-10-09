import "server-only";
import { createDemoAdapter } from "../../adapters/demo/adapter";
import { readConfig } from "../../lib/config";
import { readWorkspace } from "@/lib/workspace";
import { withTenant } from "@/lib/tenant";
import type { DemoProject } from "../../adapters/demo/fixtures";
import { getPortfolioTelemetry, type TelemetryProvenance } from "@/modules/telemetry/queries";

export type { DemoProject, DemoAlert, ConnectionStatus } from "../../adapters/demo/fixtures";
export { DEFAULT_DEMO_ORGANIZATION_ID, DEMO_REFERENCE_TIME } from "../../adapters/demo/fixtures";

export function getDemoPortfolio(organizationId?: string, scenario: "normal" | "empty" | "error" = "normal") {
  return createDemoAdapter(readConfig()).getPortfolio(organizationId, scenario);
}

export function getDemoProject(id: string, organizationId?: string) {
  return createDemoAdapter(readConfig()).getProject(id, organizationId);
}

export type ProjectView = Omit<DemoProject, "source" | "lastMeasuredAt" | "lastKnownPower"> & {
  source: "simulated" | "persistent";
  lastMeasuredAt: string | null;
  lastKnownPower: { generationKw: number | null; consumptionKw: number | null; gridKw: number | null; measuredAt: string | null };
  timezone?: string;
  telemetrySource?: TelemetryProvenance;
};

export async function getPortfolio(organizationId?: string, scenario: "normal" | "empty" | "error" = "normal") {
  const workspace = await readWorkspace(organizationId);
  if (workspace.isDemo) {
    const portfolio = getDemoPortfolio(workspace.organization.id, scenario)!;
    return { ...portfolio, ...workspace, projects: portfolio.projects as ProjectView[] };
  }
  const [projects, telemetry] = await Promise.all([
    withTenant(workspace.identity, workspace.organization.id, (tx) => tx.project.findMany({ where: { organizationId: workspace.organization.id }, include: { customer: true }, orderBy: { name: "asc" } })),
    getPortfolioTelemetry(workspace.identity, workspace.organization.id),
  ]);
  const views: ProjectView[] = projects.map((project) => {
    const reading = telemetry[project.id];
    const connection = reading?.connection === "missing" ? "offline" : reading?.connection ?? "offline";
    const power = reading?.power;
    return {
    id: project.id, organizationId: project.organizationId, name: project.name, customerName: project.customer.name,
    location: project.location, capacityKwp: Number(project.capacityKwp), connection, lastMeasuredAt: reading?.latestMeasuredAt ?? null,
    timezone: project.timezone, telemetrySource: reading?.source ?? "missing",
    generationKw: connection === "online" ? power?.generationKw.value ?? null : null,
    consumptionKw: connection === "online" ? power?.consumptionKw.value ?? null : null,
    gridKw: connection === "online" ? power?.gridKw.value ?? null : null, generationKwh: null, consumptionKwh: null,
    gridImportKwh: null, gridExportKwh: null, energyThrough: null, dailySeries: [],
    lastKnownPower: { generationKw: power?.generationKw.value ?? null, consumptionKw: power?.consumptionKw.value ?? null, gridKw: power?.gridKw.value ?? null, measuredAt: reading?.latestMeasuredAt ?? null },
    source: "persistent", energyMethod: "trapezoidal",
  }; });
  return { ...workspace, projects: views, alerts: [] as import("../../adapters/demo/fixtures").DemoAlert[], referenceTime: null };
}
