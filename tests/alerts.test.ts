import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { alertRuleSchema, incidentUpdateSchema, maintenanceWindowSchema } from "../src/contracts/alerts";
import { advanceAlertState, evaluateProject, observeRule, withinGenerationWindow } from "../src/modules/alerts/evaluator";
import { createMonitoringWorker } from "../src/modules/alerts/worker";
import { telemetryMessageSchema } from "../src/modules/telemetry/protocol";
import type { AlertObservation, AlertRuleRecord, AlertState, AlertTransition, WorkerSnapshot } from "../src/modules/alerts/types";
import type { AlertWorkerTransaction } from "../src/modules/alerts/store";

const at = new Date("2026-10-09T17:00:00Z"), generation = randomUUID(), grid = randomUUID();
function fixture(kind: AlertRuleRecord["kind"] = "communication"): WorkerSnapshot {
  const projectId = randomUUID(), organizationId = randomUUID(), ruleId = randomUUID();
  const rule: AlertRuleRecord = { id: ruleId, organizationId, projectId, kind, name: "Política de prueba", enabled: true, persistenceSeconds: 60, recoverySeconds: 30, configuration: kind === "communication" ? { staleAfterSeconds: 300 } : kind === "generation" ? { startLocalTime: "06:00", endLocalTime: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6], minimumPowerKw: 1, maxMeasurementAgeSeconds: 300 } : kind === "device_alarm" ? { minimumSeverity: "warning", maxMeasurementAgeSeconds: 300 } : { maxMeasurementAgeSeconds: 300 }, createdAt: new Date(at.getTime() - 3600000) };
  const bindings = [generation, grid].map((measurementPointId) => ({ id: randomUUID(), measurementPointId, deviceId: randomUUID(), configurationVersion: 1, validFrom: new Date(at.getTime() - 86400000), validTo: null, configuration: { multiplier: 1 } }));
  return { evaluatedAt: at, project: { id: projectId, organizationId, name: "Proyecto simulado", timezone: "America/Bogota", commissionedAt: new Date(at.getTime() - 86400000) }, rules: [rule], points: [{ id: generation, kind: "generation" }, { id: grid, kind: "grid" }], bindings,
    topologyVersions: [{ id: randomUUID(), version: 1, validFrom: new Date(at.getTime() - 86400000), validTo: null, configuration: { type: "grid_tied_no_battery", generationPointId: generation, gridPointId: grid, consumptionPointId: null } }],
    latestSamples: bindings.map((binding, index) => ({ ...binding, eventId: randomUUID(), bindingId: binding.id, measuredAt: new Date(at.getTime() - 10000), receivedAt: new Date(at.getTime() - 5000), activePower: index ? 1 : 4, importEnergy: 100, exportEnergy: 0, quality: "measured", source: "simulator", alarms: null })), states: [], maintenanceWindows: [] };
}
const state = (transition: AlertTransition): AlertState => ({ ...transition, id: randomUUID() });
const bad: AlertObservation = { dedupKey: "project", condition: "abnormal", title: "Umbral configurado", message: "Requiere revisión del contexto.", severity: "warning", detail: {} };

test("strict alert policies require an explicit generation schedule and protect scope/closure inputs", () => {
  const projectId = randomUUID();
  assert.throws(() => alertRuleSchema.parse({ projectId, name: "Generación", kind: "generation", configuration: {} }));
  assert.throws(() => alertRuleSchema.parse({ projectId, name: "Datos", kind: "invalid_data", configuration: {}, organizationId: randomUUID() }));
  assert.throws(() => incidentUpdateSchema.parse({ status: "closed" }));
  assert.throws(() => maintenanceWindowSchema.parse({ projectId, from: at.toISOString(), to: at.toISOString(), reason: "Mantenimiento" }));
  const parsed = alertRuleSchema.parse({ projectId, name: "Generación", kind: "generation", configuration: { startLocalTime: "06:00", endLocalTime: "18:00", minimumPowerKw: 0.5 } });
  assert.equal(parsed.persistenceSeconds, 300);
});

test("persistence/recovery hysteresis suppresses repeats and stale evaluations, and new episodes get new identities", () => {
  const rule = fixture().rules[0];
  const pending = advanceAlertState(rule, undefined, bad, at)!; assert.equal(pending.status, "pending"); assert.equal(pending.event, null);
  const active = advanceAlertState(rule, state(pending), bad, new Date(at.getTime() + 60000))!; assert.equal(active.event, "activated");
  assert.equal(advanceAlertState(rule, state(active), bad, new Date(at.getTime() + 70000))!.event, null);
  assert.equal(advanceAlertState(rule, state(active), bad, at), null);
  const recovering = advanceAlertState(rule, state(active), { ...bad, condition: "normal" }, new Date(at.getTime() + 80000))!;
  assert.equal(recovering.status, "active"); assert.equal(recovering.event, null);
  const interrupted = advanceAlertState(rule, state(recovering), { ...bad, condition: "unknown" }, new Date(at.getTime() + 90000))!; assert.equal(interrupted.recoverySince, null);
  const retry = advanceAlertState(rule, state(interrupted), { ...bad, condition: "normal" }, new Date(at.getTime() + 100000))!;
  const resolved = advanceAlertState(rule, state(retry), { ...bad, condition: "normal" }, new Date(at.getTime() + 130000))!; assert.equal(resolved.event, "resolved");
  const next = advanceAlertState(rule, state(resolved), bad, new Date(at.getTime() + 140000))!; assert.notEqual(next.episodeId, resolved.episodeId); assert.equal(next.activatedAt, null);
  assert.deepEqual(advanceAlertState(rule, undefined, bad, at), pending);
  const cancelled = advanceAlertState(rule, state(pending), { ...bad, condition: "unknown" }, new Date(at.getTime() + 1000))!;
  assert.equal(cancelled.status, "resolved"); assert.equal(cancelled.event, null); assert.equal(cancelled.activatedAt, null);
  const changedPolicy = advanceAlertState({ ...rule, updatedAt: new Date(at.getTime() + 30000) }, state(pending), bad, new Date(at.getTime() + 60000))!;
  assert.equal(changedPolicy.status, "pending"); assert.equal(changedPolicy.candidateSince, new Date(at.getTime() + 60000).toISOString());
});

test("communication and invalid quality are distinct observations and stale simulated measurements stay stale", () => {
  const snapshot = fixture();
  assert.equal(observeRule(snapshot.rules[0], snapshot)[0].condition, "normal");
  snapshot.latestSamples[0].measuredAt = new Date(at.getTime() - 3600000);
  assert.equal(observeRule(snapshot.rules[0], snapshot)[0].condition, "abnormal");
  snapshot.project.commissionedAt = null; assert.equal(observeRule(snapshot.rules[0], snapshot)[0].condition, "unknown");
  const invalid = fixture("invalid_data"); invalid.latestSamples[0].quality = "invalid";
  assert.equal(observeRule(invalid.rules[0], invalid)[0].condition, "abnormal");
  const communication = { ...invalid.rules[0], kind: "communication" as const, configuration: { staleAfterSeconds: 300 } };
  assert.equal(observeRule(communication, invalid)[0].condition, "normal");
  invalid.latestSamples[0].quality = "missing"; assert.equal(observeRule(invalid.rules[0], invalid)[0].condition, "unknown");
});

test("generation uses local explicit windows including overnight weekdays, never missing-as-zero or a failure diagnosis", () => {
  const snapshot = fixture("generation"), rule = snapshot.rules[0];
  snapshot.latestSamples[0].activePower = 0;
  const zero = observeRule(rule, snapshot)[0]; assert.equal(zero.condition, "abnormal"); assert.doesNotMatch(zero.message, /avería|fallo|falla/i);
  snapshot.latestSamples[0].activePower = null; assert.equal(observeRule(rule, snapshot)[0].condition, "unknown");
  snapshot.evaluatedAt = new Date("2026-10-10T03:00:00Z"); assert.equal(observeRule(rule, snapshot)[0].condition, "normal");
  const overnight = { startLocalTime: "22:00", endLocalTime: "02:00", weekdays: [5] };
  assert.equal(withinGenerationWindow(new Date("2026-10-10T06:00:00Z"), "America/Bogota", overnight), true);
  assert.equal(withinGenerationWindow(new Date("2026-10-10T08:00:00Z"), "America/Bogota", overnight), false);
});

test("only explicit equipment alarm reports create/clear alarms; omitted reports do not claim recovery", () => {
  const snapshot = fixture("device_alarm"), rule = snapshot.rules[0]; rule.persistenceSeconds = 0; rule.recoverySeconds = 0;
  assert.deepEqual(observeRule(rule, snapshot), []);
  snapshot.latestSamples[0].alarms = [{ code: "VENDOR_ACTUAL_CODE", severity: "critical", active: true }];
  const activated = evaluateProject(snapshot)[0]; assert.equal(activated.event, "activated"); assert.equal(activated.severity, "critical");
  snapshot.states = [state(activated)]; snapshot.evaluatedAt = new Date(at.getTime() + 1000); snapshot.latestSamples[0].alarms = null;
  assert.equal(evaluateProject(snapshot)[0].event, null); assert.equal(evaluateProject(snapshot)[0].status, "active");
  snapshot.latestSamples[0].alarms = []; assert.equal(evaluateProject(snapshot)[0].event, "resolved");
  const wire = { schema_version: "2.0", event_id: randomUUID(), device_id: randomUUID(), measurement_point_id: randomUUID(), configuration_version: 1, measured_at: at.toISOString(), values: { active_power: 1, import_energy: null, export_energy: null }, units: { active_power: "kW", import_energy: "kWh", export_energy: "kWh" }, quality: "measured", alarms: [{ code: "EXPLICIT", severity: "warning", active: true }] };
  assert.ok(telemetryMessageSchema.safeParse(wire).success);
  assert.equal(telemetryMessageSchema.safeParse({ ...wire, alarms: [...wire.alarms, ...wire.alarms] }).success, false);
});

test("scheduled maintenance interrupts pending windows and preserves active incidents; disabling a rule resolves explicitly", () => {
  const snapshot = fixture(), rule = snapshot.rules[0];
  snapshot.latestSamples.forEach((sample) => { sample.measuredAt = new Date(at.getTime() - 3600000); });
  const pending = evaluateProject(snapshot)[0]; snapshot.states = [state(pending)];
  snapshot.evaluatedAt = new Date(at.getTime() + 61000);
  snapshot.maintenanceWindows = [{ id: randomUUID(), from: at, to: new Date(at.getTime() + 3600000), cancelledAt: null, reason: "Mantenimiento programado" }];
  assert.equal(evaluateProject(snapshot)[0].status, "resolved"); assert.equal(evaluateProject(snapshot)[0].event, null);
  snapshot.maintenanceWindows = []; rule.persistenceSeconds = 0; const active = evaluateProject({ ...snapshot, states: [] })[0];
  snapshot.states = [state(active)]; snapshot.evaluatedAt = new Date(at.getTime() + 62000); snapshot.maintenanceWindows = [{ id: randomUUID(), from: at, to: new Date(at.getTime() + 3600000), cancelledAt: null, reason: "Mantenimiento" }];
  assert.equal(evaluateProject(snapshot)[0].status, "active"); assert.equal(evaluateProject(snapshot)[0].event, null);
  rule.enabled = false; assert.equal(evaluateProject(snapshot)[0].event, "resolved");
});

test("the independent monitor publishes in-app outbox records and persists bounded failure outcomes for retry", async () => {
  const row = { id: randomUUID(), organizationId: randomUUID(), projectId: randomUUID(), eventKey: "one-episode", payload: { title: "Prueba", message: "Simulada", severity: "warning" as const, alertId: randomUUID(), episodeId: randomUUID() }, attempts: 0, createdAt: at };
  let claimed = false; const completions: Array<{ success: boolean; error?: string }> = [];
  const store: AlertWorkerTransaction = { async claimProject() { return null; }, async saveEvaluation() { return { activated: 0, resolved: 0 }; }, async claimNotification() { if (claimed) return null; claimed = true; return row; }, async completeNotification(_id, success, error) { completions.push({ success, error }); } };
  const failed = createMonitoringWorker(async (callback) => callback(store), async () => { throw new Error("private transport details"); });
  assert.equal((await failed()).notificationsFailed, 1); assert.deepEqual(completions, [{ success: false, error: "IN_APP_PUBLICATION_FAILED" }]);
  claimed = false; const recovered = createMonitoringWorker(async (callback) => callback(store));
  assert.equal((await recovered()).notificationsDelivered, 1); assert.equal(completions[1].success, true);
});
