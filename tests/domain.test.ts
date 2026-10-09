import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, ConfigurationError } from "../src/lib/config";
import { createDemoAdapter, DemoScenarioError, DemoUnavailableError } from "../src/adapters/demo/adapter";
import { demoOrganizations, demoProjects, DEMO_REFERENCE_TIME } from "../src/adapters/demo/fixtures";
import { gridPower, integrateDailyEnergy } from "../src/modules/telemetry/calculations";
import { telemetrySampleSchema } from "../src/contracts/v1";

const demoConfiguration = readConfig({ APP_ENV: "development", DATA_ADAPTER: "demo", DEMO_MODE: "true" });

test("demo is opt-in, forbidden in customer production, and independent of Next production builds", () => {
  assert.equal(readConfig({}).demoMode, false);
  assert.equal(readConfig({}).dataAdapter, "postgres");
  assert.equal(readConfig({}).appEnv, "production");
  assert.throws(() => readConfig({ DATA_ADAPTER: "demo" }), ConfigurationError);
  assert.throws(() => readConfig({ DEMO_MODE: "true" }), ConfigurationError);
  assert.throws(() => readConfig({ APP_ENV: "production", DATA_ADAPTER: "demo", DEMO_MODE: "true" }), ConfigurationError);
  assert.throws(() => readConfig({ DATA_ADAPTER: "demo", DEMO_MODE: "true" }), ConfigurationError);
  assert.equal(readConfig({ APP_ENV: "development", NODE_ENV: "production", DATA_ADAPTER: "demo", DEMO_MODE: "true" }).demoMode, true);
  assert.throws(() => createDemoAdapter(readConfig({})), DemoUnavailableError);
  assert.throws(() => readConfig({ DATABASE_URL: "https://example.invalid" }), ConfigurationError);
  assert.throws(() => readConfig({ DATABASE_URL: "https://user:secret-must-not-leak@example.invalid" }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.message.includes("secret-must-not-leak"), false);
    return true;
  });
});

test("demo contains exactly two fictitious portfolios with three projects and scoped lookups", () => {
  const adapter = createDemoAdapter(demoConfiguration);
  assert.equal(demoOrganizations.length, 2);
  assert.equal(demoProjects.length, 6);
  for (const organization of demoOrganizations) {
    const portfolio = adapter.getPortfolio(organization.id)!;
    assert.equal(portfolio.projects.length, 3);
    assert.equal(portfolio.referenceTime, DEMO_REFERENCE_TIME);
    assert.ok(portfolio.alerts.every((alert) => portfolio.projects.some((project) => project.id === alert.projectId)));
    const foreignProject = demoProjects.find((project) => project.organizationId !== organization.id)!;
    assert.equal(adapter.getProject(foreignProject.id, organization.id), null);
  }
  assert.equal(adapter.getPortfolio("unknown-organization"), null);
  assert.equal(adapter.getProject("unknown-project"), null);
  assert.deepEqual(adapter.getPortfolio(undefined, "empty")?.projects, []);
  assert.throws(() => adapter.getPortfolio(undefined, "error"), DemoScenarioError);
});

test("each available power snapshot and energy period conserves the generation/grid/load balance", () => {
  for (const project of demoProjects) {
    for (const point of project.dailySeries) {
      if (point.generationKw === null || point.gridKw === null || point.consumptionKw === null) continue;
      assert.ok(Math.abs(point.generationKw + point.gridKw - point.consumptionKw) < 0.000001);
    }
    if (project.generationKwh !== null && project.gridImportKwh !== null && project.gridExportKwh !== null && project.consumptionKwh !== null) {
      assert.ok(Math.abs(project.generationKwh + project.gridImportKwh - project.gridExportKwh - project.consumptionKwh) < 0.000001);
      assert.equal(project.energyThrough, project.lastMeasuredAt);
    }
    if (project.connection !== "online") {
      assert.equal(project.generationKw, null);
      assert.equal(project.consumptionKw, null);
      assert.equal(project.gridKw, null);
    }
    if (project.connection === "offline") {
      assert.equal(project.generationKwh, null);
      assert.ok(project.dailySeries.every((point) => point.generationKw === null));
    }
  }
  assert.equal(gridPower(null, 5), null);
  assert.equal(gridPower(8, 5), -3);
});

test("energy splits import/export at a sign change and never invents energy across missing measurements", () => {
  const result = integrateDailyEnergy([
    { hour: "00:00", measuredAt: "2026-10-08T05:00:00Z", generationKw: 0, consumptionKw: 2, gridKw: 2 },
    { hour: "01:00", measuredAt: "2026-10-08T06:00:00Z", generationKw: 4, consumptionKw: 2, gridKw: -2 },
    { hour: "02:00", measuredAt: "2026-10-08T07:00:00Z", generationKw: null, consumptionKw: null, gridKw: null },
    { hour: "03:00", measuredAt: "2026-10-08T08:00:00Z", generationKw: 4, consumptionKw: 2, gridKw: -2 },
  ]);
  assert.equal(result.generationKwh, 2);
  assert.equal(result.consumptionKwh, 2);
  assert.equal(result.gridImportKwh, 0.5);
  assert.equal(result.gridExportKwh, 0.5);
  assert.equal(result.energyThrough, "2026-10-08T06:00:00Z");
  assert.equal(integrateDailyEnergy([]).generationKwh, null);
});

test("telemetry v1 rejects tenant injection, mismatched units and values disguised as missing", () => {
  const sample = {
    schema_version: "1.0", event_id: "af660f68-9128-4a60-9f24-969616bb35c8", device_id: "registered-device", measurement_point_id: "registered-point", measured_at: "2026-10-08T14:59:00Z", received_at: DEMO_REFERENCE_TIME, configuration_version: 1,
    values: { active_power: -3, import_energy: 25, export_energy: 8 },
    units: { active_power: "kW", import_energy: "kWh", export_energy: "kWh" }, quality: "measured",
  };
  assert.ok(telemetrySampleSchema.safeParse(sample).success);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, organization_id: "untrusted-tenant" }).success, false);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, units: { ...sample.units, active_power: "kWh" } }).success, false);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, quality: "missing" }).success, false);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, received_at: "2026-10-08T14:00:00Z" }).success, false);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, measured_at: "2026-10-08T09:59:00" }).success, false);
  assert.ok(telemetrySampleSchema.safeParse({ ...sample, measured_at: "2026-10-08T09:59:00-05:00" }).success);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, units: { ...sample.units, import_energy: "kW" } }).success, false);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, schema_version: "2.0" }).success, false);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, configuration_version: 0 }).success, false);
  const absentValues = { active_power: null, import_energy: null, export_energy: null };
  assert.ok(telemetrySampleSchema.safeParse({ ...sample, values: absentValues, quality: "missing" }).success);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, values: absentValues, quality: "measured" }).success, false);
  assert.equal(telemetrySampleSchema.safeParse({ ...sample, values: { ...sample.values, import_energy: -1 } }).success, false);
});
