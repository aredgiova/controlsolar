import { z } from "zod";
import { apiHandler } from "@/modules/auth/api";
import { HttpError } from "@/modules/auth/errors";
import { uuidSchema, listQuerySchema } from "@/contracts/management";
import { createCustomer, listCustomers, updateCustomer } from "@/modules/customers/service";
import { createDevice, listDevices, retireDevice, updateDevice } from "@/modules/assets/service";
import { acceptInvitation, createInvitation, createOrganization, listInvitations, listMembers, listOrganizations, revokeInvitation, updateMembership } from "@/modules/organizations/service";
import { assignParticipant, commissionProject, createMeasurementPoint, createProject, createTopologyVersion, exportProjects, getProjectManagement, listProjects, removeParticipant, replaceBinding, updateProject } from "@/modules/projects/persistent";
import type { Actor } from "@/modules/organizations/access";
import { enrollGateway, listGateways, revokeGateway } from "@/modules/gateways/service";
import { getTelemetryProjection } from "@/modules/telemetry/queries";
import { cancelMaintenanceWindow, createAlertRule, createMaintenanceWindow, getAlertHistory, listAlertRules, listAlerts, listMaintenanceWindows, listNotifications, updateAlertRule } from "@/modules/alerts/service";
import { addIncidentObservation, createIncident, getIncident, listIncidents, updateIncident } from "@/modules/incidents/service";
import { createDownloadLease, downloadReport, listReports, requestReport } from "@/modules/reports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ segments?: string[] }> };

async function body(request: Request) {
  const type = request.headers.get("content-type")?.split(";")[0].trim();
  if (type !== "application/json") throw new HttpError(415, "JSON_REQUIRED", "Envía el cuerpo como application/json.");
  if (Number(request.headers.get("content-length")) > 32768) throw new HttpError(413, "BODY_TOO_LARGE", "El cuerpo excede el límite permitido.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_JSON", "El cuerpo JSON es inválido.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32768) {
        await reader.cancel();
        throw new HttpError(413, "BODY_TOO_LARGE", "El cuerpo excede el límite permitido.");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; } catch { throw new HttpError(400, "INVALID_JSON", "El cuerpo JSON es inválido."); }
}
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } }); }
function query(request: Request) { return listQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams)); }
function operationalQuery(request: Request) { return Object.fromEntries(new URL(request.url).searchParams); }
function unsupported(): never { throw new HttpError(405, "METHOD_NOT_ALLOWED", "Método no permitido en esta ruta."); }

async function dispatch(request: Request, identity: Actor, context: RouteContext) {
  const { segments = [] } = await context.params;
  const method = request.method;
  if (segments.join("/") === "invitations/accept") {
    if (method !== "POST") unsupported();
    return json(await acceptInvitation(identity, await body(request)));
  }
  if (segments.length === 1 && segments[0] === "organizations") {
    if (method === "GET") return json(await listOrganizations(identity));
    if (method === "POST") return json(await createOrganization(identity, await body(request)), 201);
    unsupported();
  }
  if (segments[0] !== "organizations" || segments.length < 3) throw new HttpError(404, "NOT_FOUND", "Ruta de gestión no encontrada.");
  const organizationId = uuidSchema.parse(segments[1]);
  const collection = segments[2];
  const id = segments[3];
  if (segments.length === 3) {
    if (collection === "alert-rules") {
      if (method === "GET") return json(await listAlertRules(identity, organizationId, operationalQuery(request)));
      if (method === "POST") return json(await createAlertRule(identity, organizationId, await body(request)), 201);
      unsupported();
    }
    if (collection === "alerts") {
      if (method === "GET") return json(await listAlerts(identity, organizationId, operationalQuery(request)));
      unsupported();
    }
    if (collection === "incidents") {
      if (method === "GET") return json(await listIncidents(identity, organizationId, operationalQuery(request)));
      if (method === "POST") return json(await createIncident(identity, organizationId, await body(request)), 201);
      unsupported();
    }
    if (collection === "maintenance-windows") {
      if (method === "GET") return json(await listMaintenanceWindows(identity, organizationId, operationalQuery(request)));
      if (method === "POST") return json(await createMaintenanceWindow(identity, organizationId, await body(request)), 201);
      unsupported();
    }
    if (collection === "notifications") {
      if (method === "GET") return json(await listNotifications(identity, organizationId, operationalQuery(request)));
      unsupported();
    }
    if (collection === "customers") {
      if (method === "GET") return json(await listCustomers(identity, organizationId, query(request)));
      if (method === "POST") return json(await createCustomer(identity, organizationId, await body(request)), 201);
    } else if (collection === "projects") {
      if (method === "GET") return json(await listProjects(identity, organizationId, query(request)));
      if (method === "POST") return json(await createProject(identity, organizationId, await body(request)), 201);
    } else if (collection === "devices") {
      if (method === "GET") return json(await listDevices(identity, organizationId, query(request)));
      if (method === "POST") return json(await createDevice(identity, organizationId, await body(request)), 201);
    } else if (collection === "gateways") {
      if (method === "GET") return json(await listGateways(identity, organizationId, query(request)));
      if (method === "POST") return json(await enrollGateway(identity, organizationId, await body(request)), 201);
    } else if (collection === "memberships") {
      if (method === "GET") return json(await listMembers(identity, organizationId));
    } else if (collection === "invitations") {
      if (method === "GET") return json(await listInvitations(identity, organizationId));
      if (method === "POST") return json(await createInvitation(identity, organizationId, await body(request)), 201);
    } else throw new HttpError(404, "NOT_FOUND", "Ruta de gestión no encontrada.");
    unsupported();
  }
  if (collection === "projects" && id === "export" && segments.length === 4) {
    if (method !== "GET") unsupported();
    const { search } = query(request);
    const csv = await exportProjects(identity, organizationId, search);
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="proyectos.csv"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const entityId = uuidSchema.parse(id);
  if (segments.length === 4) {
    if (collection === "alert-rules" && method === "PATCH") return json(await updateAlertRule(identity, organizationId, entityId, await body(request)));
    if (collection === "alerts" && method === "GET") return json(await getAlertHistory(identity, organizationId, entityId));
    if (collection === "maintenance-windows" && method === "PATCH") return json(await cancelMaintenanceWindow(identity, organizationId, entityId, await body(request)));
    if (collection === "incidents") {
      if (method === "GET") return json(await getIncident(identity, organizationId, entityId));
      if (method === "PATCH") return json(await updateIncident(identity, organizationId, entityId, await body(request)));
    }
    if (collection === "gateways" && method === "PATCH") return json(await revokeGateway(identity, organizationId, entityId, await body(request)));
    if (collection === "customers" && method === "PATCH") return json(await updateCustomer(identity, organizationId, entityId, await body(request)));
    if (collection === "devices" && method === "PATCH") return json(await updateDevice(identity, organizationId, entityId, await body(request)));
    if (collection === "memberships" && method === "PATCH") return json(await updateMembership(identity, organizationId, entityId, await body(request)));
    if (collection === "invitations" && method === "DELETE") return json(await revokeInvitation(identity, organizationId, entityId));
    if (collection === "projects") {
      if (method === "GET") return json(await getProjectManagement(identity, organizationId, entityId));
      if (method === "PATCH") return json(await updateProject(identity, organizationId, entityId, await body(request)));
    }
    unsupported();
  }
  if (collection === "incidents" && segments.length === 5 && segments[4] === "observations") {
    if (method !== "POST") unsupported();
    return json(await addIncidentObservation(identity, organizationId, entityId, await body(request)), 201);
  }
  if (collection === "reports" && segments.length === 5) {
    if (segments[4] === "download-lease" && method === "POST") {
      z.strictObject({}).parse(await body(request));
      return json(await createDownloadLease(identity, organizationId, entityId), 201);
    }
    if (segments[4] === "download" && method === "GET") {
      const input = z.strictObject({ token: z.string() }).parse(operationalQuery(request));
      const file = await downloadReport(identity, organizationId, entityId, input.token);
      return new Response(Buffer.from(file.bytes), { headers: { "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${file.filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
    }
    unsupported();
  }
  if (collection === "devices" && segments.length === 5 && segments[4] === "retire") {
    if (method !== "POST") unsupported();
    z.strictObject({}).parse(await body(request));
    return json(await retireDevice(identity, organizationId, entityId));
  }
  if (collection === "projects" && segments.length === 5) {
    const resource = segments[4];
    if (resource === "reports") {
      if (method === "GET") return json(await listReports(identity, organizationId, entityId));
      if (method === "POST") return json(await requestReport(identity, organizationId, entityId, await body(request)), 202);
      unsupported();
    }
    if (method === "GET" && resource === "telemetry") {
      const options = z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(Object.fromEntries(new URL(request.url).searchParams));
      return json(await getTelemetryProjection(identity, organizationId, entityId, options));
    }
    if (method === "GET" && ["history", "points", "participants", "bindings", "topology"].includes(resource)) {
      const project = await getProjectManagement(identity, organizationId, entityId);
      return json(resource === "history" ? project.history : resource === "points" ? project.measurementPoints : resource === "participants" ? project.siteAccess : resource === "bindings" ? project.bindings : project.topologyVersions);
    }
    if (method === "POST") {
      const input = await body(request);
      if (resource === "points") return json(await createMeasurementPoint(identity, organizationId, entityId, input), 201);
      if (resource === "participants") return json(await assignParticipant(identity, organizationId, entityId, input), 201);
      if (resource === "bindings") return json(await replaceBinding(identity, organizationId, entityId, input), 201);
      if (resource === "topology") return json(await createTopologyVersion(identity, organizationId, entityId, input), 201);
      if (resource === "commissioning") return json(await commissionProject(identity, organizationId, entityId, input));
    }
    unsupported();
  }
  if (collection === "projects" && segments.length === 6 && segments[4] === "participants") {
    if (method !== "DELETE") unsupported();
    return json(await removeParticipant(identity, organizationId, entityId, uuidSchema.parse(segments[5])));
  }
  throw new HttpError(404, "NOT_FOUND", "Ruta de gestión no encontrada.");
}

const handle = apiHandler<RouteContext>(dispatch);
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
