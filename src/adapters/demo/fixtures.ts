import "server-only";
import { organizationSchema, projectSchema, customerSchema, deviceSchema, measurementPointSchema, SCHEMA_VERSION } from "../../contracts/v1";
import { gridPower, integrateDailyEnergy, type PowerPoint } from "../../modules/telemetry/calculations";

export const DEMO_REFERENCE_TIME = "2026-10-08T15:00:00.000Z";
export const DEFAULT_DEMO_ORGANIZATION_ID = "org-norte-demo";

export const demoOrganizations = [
  organizationSchema.parse({ schema_version: SCHEMA_VERSION, id: DEFAULT_DEMO_ORGANIZATION_ID, name: "Norte Solar · Demo", slug: "norte-solar-demo", timezone: "America/Bogota" }),
  organizationSchema.parse({ schema_version: SCHEMA_VERSION, id: "org-horizonte-demo", name: "Horizonte Solar · Demo", slug: "horizonte-solar-demo", timezone: "America/Bogota" }),
];

export type ConnectionStatus = "online" | "stale" | "offline";
export type DemoProject = {
  id: string;
  organizationId: string;
  customerName: string;
  name: string;
  location: string;
  capacityKwp: number;
  connection: ConnectionStatus;
  lastMeasuredAt: string;
  generationKw: number | null;
  consumptionKw: number | null;
  gridKw: number | null;
  generationKwh: number | null;
  consumptionKwh: number | null;
  gridImportKwh: number | null;
  gridExportKwh: number | null;
  energyThrough: string | null;
  dailySeries: PowerPoint[];
  lastKnownPower: { generationKw: number; consumptionKw: number; gridKw: number; measuredAt: string };
  source: "simulated";
  energyMethod: "trapezoidal";
};

export type DemoAlert = {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  severity: "warning" | "critical" | "info";
  status: "open" | "resolved";
  occurredAt: string;
  description: string;
};

const definitions: { id: string; organizationId: string; name: string; customerName: string; location: string; capacityKwp: number; connection: ConnectionStatus }[] = [
  { id: "centro-aurora", organizationId: DEFAULT_DEMO_ORGANIZATION_ID, name: "Centro Aurora", customerName: "Servicios Aurora · ficticio", location: "Yopal, Casanare", capacityKwp: 18, connection: "online" },
  { id: "bodega-horizonte", organizationId: DEFAULT_DEMO_ORGANIZATION_ID, name: "Bodega Horizonte", customerName: "Almacenes Horizonte · ficticio", location: "Aguazul, Casanare", capacityKwp: 32, connection: "stale" },
  { id: "taller-arrayan", organizationId: DEFAULT_DEMO_ORGANIZATION_ID, name: "Taller Arrayán", customerName: "Talleres Arrayán · ficticio", location: "Tauramena, Casanare", capacityKwp: 12, connection: "offline" },
  { id: "casa-mirador", organizationId: "org-horizonte-demo", name: "Casa Mirador", customerName: "Residencial Mirador · ficticio", location: "Yopal, Casanare", capacityKwp: 6, connection: "online" },
  { id: "oficina-rio-claro", organizationId: "org-horizonte-demo", name: "Oficina Río Claro", customerName: "Servicios Río Claro · ficticio", location: "Villanueva, Casanare", capacityKwp: 15, connection: "stale" },
  { id: "comercio-cedro", organizationId: "org-horizonte-demo", name: "Comercio Cedro", customerName: "Comercial Cedro · ficticio", location: "Paz de Ariporo, Casanare", capacityKwp: 10, connection: "offline" },
];

export const demoCustomers = definitions.map((definition) => customerSchema.parse({
  schema_version: SCHEMA_VERSION, id: `customer-${definition.id}`, organization_id: definition.organizationId, name: definition.customerName,
}));

export const demoProjectRecords = definitions.map((definition) => projectSchema.parse({
  schema_version: SCHEMA_VERSION, id: definition.id, organization_id: definition.organizationId, customer_id: `customer-${definition.id}`, name: definition.name, location: definition.location, capacity_kwp: definition.capacityKwp, timezone: "America/Bogota",
}));

export const demoDevices = definitions.map((definition) => deviceSchema.parse({
  schema_version: SCHEMA_VERSION, id: `meter-${definition.id}`, organization_id: definition.organizationId, project_id: definition.id, name: `Medidor simulado · ${definition.name}`, kind: "meter", status: "active", configuration_version: 1,
}));

export const demoMeasurementPoints = definitions.flatMap((definition) => ["generation", "consumption", "grid"].map((kind) => measurementPointSchema.parse({
  schema_version: SCHEMA_VERSION, id: `point-${definition.id}-${kind}`, device_id: `meter-${definition.id}`, project_id: definition.id, name: kind === "generation" ? "Generación" : kind === "consumption" ? "Consumo" : "Red", kind, sign_convention: kind === "generation" ? "positive_generation" : kind === "consumption" ? "positive_consumption" : "positive_import",
})));

function makeDailySeries(capacity: number, connection: ConnectionStatus): PowerPoint[] {
  const generationProfile = [0, 0, 0, 0, 0, 0, 0.08, 0.22, 0.4, 0.6, 0.72];
  const consumptionProfile = [0.12, 0.11, 0.1, 0.1, 0.11, 0.13, 0.2, 0.3, 0.38, 0.43, 0.46];
  return generationProfile.map((fraction, hour) => {
    const available = connection === "online" || (connection === "stale" && hour <= 8);
    const generationKw = available ? Math.round(capacity * fraction * 1000) / 1000 : null;
    const consumptionKw = available ? Math.round(capacity * consumptionProfile[hour] * 1000) / 1000 : null;
    return {
      hour: `${String(hour).padStart(2, "0")}:00`,
      measuredAt: `2026-10-08T${String(hour + 5).padStart(2, "0")}:00:00.000Z`,
      generationKw,
      consumptionKw,
      gridKw: gridPower(generationKw, consumptionKw),
    };
  });
}

export const demoProjects: DemoProject[] = definitions.map((definition) => {
  const dailySeries = makeDailySeries(definition.capacityKwp, definition.connection);
  const lastMeasuredAt = definition.connection === "online" ? DEMO_REFERENCE_TIME : definition.connection === "stale" ? "2026-10-08T13:00:00.000Z" : "2026-10-07T21:00:00.000Z";
  const lastAvailable = dailySeries.findLast((point) => point.generationKw !== null);
  const lastKnownPower = lastAvailable ? {
    generationKw: lastAvailable.generationKw as number,
    consumptionKw: lastAvailable.consumptionKw as number,
    gridKw: lastAvailable.gridKw as number,
    measuredAt: lastMeasuredAt,
  } : { generationKw: 1.8, consumptionKw: 3.2, gridKw: 1.4, measuredAt: lastMeasuredAt };
  return {
    ...definition,
    lastMeasuredAt,
    generationKw: definition.connection === "online" ? lastKnownPower.generationKw : null,
    consumptionKw: definition.connection === "online" ? lastKnownPower.consumptionKw : null,
    gridKw: definition.connection === "online" ? lastKnownPower.gridKw : null,
    ...integrateDailyEnergy(dailySeries),
    dailySeries,
    lastKnownPower,
    source: "simulated",
    energyMethod: "trapezoidal",
  };
});

export const demoAlerts: DemoAlert[] = demoOrganizations.flatMap((organization) => {
  const projects = demoProjects.filter((project) => project.organizationId === organization.id);
  const online = projects.find((project) => project.connection === "online")!;
  const stale = projects.find((project) => project.connection === "stale")!;
  const offline = projects.find((project) => project.connection === "offline")!;
  return [
    { id: `alert-${offline.id}`, organizationId: organization.id, projectId: offline.id, title: "Sin comunicación", severity: "critical", status: "open", occurredAt: "2026-10-08T14:00:00.000Z", description: "Ejemplo simulado: no se reciben mediciones desde ayer. Revisar alimentación y conectividad del medidor." },
    { id: `alert-${stale.id}`, organizationId: organization.id, projectId: stale.id, title: "Datos desactualizados", severity: "warning", status: "open", occurredAt: "2026-10-08T13:20:00.000Z", description: "Ejemplo simulado: última medición a las 08:00. La potencia actual no está disponible; la energía de hoy es parcial." },
    { id: `alert-${online.id}`, organizationId: organization.id, projectId: online.id, title: "Comunicación restablecida", severity: "info", status: "resolved", occurredAt: "2026-10-08T11:40:00.000Z", description: "Ejemplo simulado de evento resuelto. La instalación vuelve a enviar mediciones." },
  ];
});
