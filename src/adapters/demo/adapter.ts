import "server-only";
import type { AppConfiguration } from "../../lib/config";
import { demoOrganizations, demoProjects, demoAlerts, DEMO_REFERENCE_TIME, DEFAULT_DEMO_ORGANIZATION_ID } from "./fixtures";

export class DemoUnavailableError extends Error {
  constructor() {
    super("El recorrido requiere la demostración habilitada explícitamente. El acceso a datos persistentes y la identidad real pertenecen a los siguientes hitos.");
    this.name = "DemoUnavailableError";
  }
}

export class DemoScenarioError extends Error {
  constructor() {
    super("Error simulado de lectura. Los datos de demostración siguen disponibles al volver al estado normal.");
    this.name = "DemoScenarioError";
  }
}

// This adapter only has access to fictitious fixtures. Organization selection is a
// demo boundary, not authentication or a claim of verified multi-tenant isolation.
export function createDemoAdapter(configuration: AppConfiguration) {
  if (!configuration.demoMode || configuration.dataAdapter !== "demo" || configuration.appEnv === "production") {
    throw new DemoUnavailableError();
  }
  return {
    getPortfolio(organizationId = DEFAULT_DEMO_ORGANIZATION_ID, scenario: "normal" | "empty" | "error" = "normal") {
      const organization = demoOrganizations.find((item) => item.id === organizationId);
      if (!organization) return null;
      if (scenario === "error") throw new DemoScenarioError();
      return structuredClone({
        organization,
        organizations: demoOrganizations,
        projects: scenario === "empty" ? [] : demoProjects.filter((project) => project.organizationId === organization.id),
        alerts: scenario === "empty" ? [] : demoAlerts.filter((alert) => alert.organizationId === organization.id),
        referenceTime: DEMO_REFERENCE_TIME,
      });
    },
    getProject(id: string, organizationId = DEFAULT_DEMO_ORGANIZATION_ID) {
      const project = demoProjects.find((item) => item.id === id && item.organizationId === organizationId);
      return project ? structuredClone(project) : null;
    },
  };
}
