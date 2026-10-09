import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeWorkerDatabase } from "../src/lib/worker-db";
import { runReportWorkerOnce } from "../src/modules/reports/worker";
import { runMonitoringCycle } from "../src/modules/alerts/worker";
import { localDateAt } from "../src/modules/telemetry/energy";

// Trusted local fixtures are created offline by test:http; this script is never
// imported by application routes and does not add a runtime authentication bypass.
async function main() {
  assert.equal(Number(process.versions.node.split(".")[0]), 24, "Use the verified Node24 test runtime.");
  const fixturePath = resolve(".work/http-fixture.json"), fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const base = process.env.TEST_BASE_URL ?? fixture.base; assert.equal(base, fixture.base); assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
  const urls = process.env.TEST_ENV_FILE ? JSON.parse(await readFile(process.env.TEST_ENV_FILE, "utf8")) : {};
  const workerUrl = process.env.TEST_WORKER_DATABASE_URL ?? urls.worker; assert.ok(workerUrl); assert.ok(["127.0.0.1", "localhost"].includes(new URL(workerUrl).hostname)); assert.match(new URL(workerUrl).pathname, /_test$/);
  process.env.APP_ENV = "development"; process.env.DATA_ADAPTER = "postgres"; process.env.DEMO_MODE = "false"; process.env.WORKER_DATABASE_URL = workerUrl; process.env.REPORT_STORAGE = "local";
  const root = `/api/v1/organizations/${fixture.organization.id}`, projectId = fixture.project.id, secondProjectId = fixture.secondProject.id;
  async function api(actor: string, path: string, method = "GET", body?: unknown, status = 200) {
    const response = await fetch(`${base}${path}`, { method, headers: { Cookie: `solar_session=${fixture.identities[actor].token}`, Origin: base, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const content = await response.json(); assert.equal(response.status, status, `${method} ${path.split("?")[0]}: ${content.error?.code ?? "JSON"}`); assert.match(response.headers.get("cache-control") ?? "", /no-store/); return content;
  }
  const ruleInput = { projectId, name: "Comunicación - prueba HTTP local", kind: "communication", persistenceSeconds: 0, recoverySeconds: 0, configuration: { staleAfterSeconds: 10 } };
  await api("customer", `${root}/alert-rules`, "POST", ruleInput, 403); await api("other", `${root}/alert-rules`, "GET", undefined, 403);
  await api("owner", `${root}/alert-rules`, "POST", { ...ruleInput, organizationId: fixture.otherOrganization.id }, 400);
  const rule = await api("owner", `${root}/alert-rules`, "POST", ruleInput, 201);
  const maintenance = await api("owner", `${root}/maintenance-windows`, "POST", { projectId, from: new Date(Date.now() + 3600000).toISOString(), to: new Date(Date.now() + 7200000).toISOString(), reason: "Ventana futura ficticia de validación HTTP." }, 201);
  await api("customer", `${root}/maintenance-windows/${maintenance.id}`, "PATCH", { cancelled: true }, 403);
  await api("owner", `${root}/maintenance-windows/${maintenance.id}`, "PATCH", { cancelled: true });
  const incident = await api("owner", `${root}/incidents`, "POST", { projectId, title: "Incidencia ficticia HTTP", description: "Ensayo local sin intervención física." }, 201);
  await api("owner", `${root}/incidents/${incident.id}`, "PATCH", { assigneeUserId: fixture.identities.owner.id, status: "in_progress" });
  await api("owner", `${root}/incidents/${incident.id}/observations`, "POST", { note: "Observación local registrada para validar el historial." }, 201);
  await api("customer", `${root}/incidents/${incident.id}/observations`, "POST", { note: "Escritura no autorizada" }, 403);
  await api("owner", `${root}/incidents/${incident.id}`, "PATCH", { status: "closed" }, 400);
  await api("owner", `${root}/incidents/${incident.id}`, "PATCH", { status: "closed", resolution: "Cierre ficticio documentado; sin acciones en equipos." });
  const incidentRead = await api("customer", `${root}/incidents/${incident.id}`); assert.equal(incidentRead.incident.status, "closed"); assert.ok(incidentRead.events.length >= 4);
  const hiddenIncident = await api("owner", `${root}/incidents`, "POST", { projectId: secondProjectId, title: "Incidencia sin asignación al cliente" }, 201);
  await api("customer", `${root}/incidents/${hiddenIncident.id}`, "GET", undefined, 404); await api("other", `${root}/incidents/${incident.id}`, "GET", undefined, 403);
  const visible = await api("customer", `${root}/incidents`); assert.ok(visible.items.some((item: { id: string }) => item.id === incident.id)); assert.ok(!visible.items.some((item: { id: string }) => item.id === hiddenIncident.id));
  await runMonitoringCycle({ maxProjects: 100, maxNotifications: 0 });
  const alerts = await api("customer", `${root}/alerts?projectId=${projectId}`); assert.ok(alerts.items.some((item: { ruleId: string }) => item.ruleId === rule.id));
  await api("customer", `${root}/alert-rules?projectId=${projectId}`); await api("customer", `${root}/maintenance-windows?projectId=${projectId}`);
  const date = localDateAt(new Date(), fixture.project.timezone), reportInput = { startDate: date, endDate: date, idempotencyKey: randomUUID() };
  await api("customer", `${root}/projects/${secondProjectId}/reports`, "POST", reportInput, 404); await api("other", `${root}/projects/${projectId}/reports`, "POST", reportInput, 403);
  const report = await api("customer", `${root}/projects/${projectId}/reports`, "POST", reportInput, 202);
  const duplicate = await api("customer", `${root}/projects/${projectId}/reports`, "POST", reportInput, 202); assert.equal(duplicate.id, report.id);
  for (let attempt = 0; attempt < 10; attempt++) { const listed = await api("customer", `${root}/projects/${projectId}/reports`); if (listed.items.some((item: { id: string; status: string }) => item.id === report.id && item.status === "completed")) break; assert.equal(await runReportWorkerOnce(`http-report-${randomUUID()}`), "completed"); }
  const reports = await api("customer", `${root}/projects/${projectId}/reports`); assert.equal(reports.items.find((item: { id: string }) => item.id === report.id)?.status, "completed");
  const lease = await api("customer", `${root}/reports/${report.id}/download-lease`, "POST", {}, 201); assert.ok(Date.parse(lease.expiresAt) > Date.now() && Date.parse(lease.expiresAt) <= Date.now() + 300000);
  const downloadUrl = `${root}/reports/${report.id}/download?token=${lease.token}`;
  await api("owner", downloadUrl, "GET", undefined, 404);
  const download = await fetch(`${base}${downloadUrl}`, { headers: { Cookie: `solar_session=${fixture.identities.customer.token}` } }); assert.equal(download.status, 200); assert.equal(download.headers.get("content-type"), "application/pdf"); assert.match(download.headers.get("cache-control") ?? "", /no-store/); assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/); const bytes = new Uint8Array(await download.arrayBuffer()); assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  await api("customer", downloadUrl, "GET", undefined, 404);
  const revoked = await api("customer", `${root}/reports/${report.id}/download-lease`, "POST", {}, 201);
  try { await api("owner", `${root}/projects/${projectId}/participants/${fixture.identities.customer.id}`, "DELETE"); await api("customer", `${root}/reports/${report.id}/download?token=${revoked.token}`, "GET", undefined, 404); }
  finally { await api("owner", `${root}/projects/${projectId}/participants`, "POST", { userId: fixture.identities.customer.id, role: "customer" }, 201); }
  fixture.h67 = { ruleId: rule.id, incidentId: incident.id, maintenanceId: maintenance.id, reportId: report.id, pdfBytes: bytes.byteLength }; await writeFile(fixturePath, JSON.stringify(fixture, null, 2));
  console.log("PASS H6/H7 HTTP: rules/maintenance/incidents/history, scoped reads and denied writes, worker PDF/snapshot, proxy headers, token replay/user binding and revoked access.");
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : "H6/H7 HTTP test failed."); process.exitCode = 1; }).finally(closeWorkerDatabase);
