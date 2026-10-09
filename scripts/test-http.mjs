import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "pg";

// Explicitly local fixtures. This script is never imported by the application.
const base = process.env.TEST_BASE_URL;
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
if (process.env.TEST_VERIFY_PERSISTENCE === "true") {
  const fixture = JSON.parse(await readFile(new URL("../.work/http-fixture.json", import.meta.url), "utf8"));
  assert.equal(base, fixture.base, "Use the same local application origin as the preceding HTTP test.");
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
  const response = await fetch(`${base}/api/v1/organizations/${fixture.organization.id}/projects/${fixture.project.id}`, { headers: { Cookie: `solar_session=${fixture.identities.owner.token}` } });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.name, fixture.project.name);
  assert.equal(saved.bindings.length, 3);
  assert.equal(saved.topologyVersions.length, 1);
  assert.ok(saved.commissionedAt && saved.history.length >= 8);
  console.log("PASS persistence: session, project, bindings, topology, commissioning and audit survived restart.");
} else {
assert.ok(base && adminUrl, "Provide TEST_BASE_URL and TEST_ADMIN_DATABASE_URL for an isolated local test database.");
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
assert.ok(["127.0.0.1", "localhost"].includes(new URL(adminUrl).hostname));
assert.match(new URL(adminUrl).pathname, /_test$/);
const database = new Client({ connectionString: adminUrl });
await database.connect();
const tag = randomBytes(5).toString("hex");
const identities = {};
try {
  for (const name of ["owner", "other", "customer", "outsider"]) {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const email = `${name}-${tag}@example.invalid`;
    await database.query("INSERT INTO users(id,cognito_subject,email,email_verified,name,created_at,updated_at) VALUES ($1,$2,$3,true,$4,now(),now())", [id, `http-fixture-${tag}-${name}`, email, `Prueba ${name}`]);
    await database.query("INSERT INTO sessions(id,token_hash,user_id,expires_at,created_at) VALUES ($1,$2,$3,now()+interval '2 hours',now())", [randomUUID(), createHash("sha256").update(token).digest("hex"), id]);
    identities[name] = { id, token, email };
  }
} finally { await database.end(); }

async function api(actor, path, method = "GET", body, expected = 200, origin = base) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method, headers: { ...(actor ? { Cookie: `solar_session=${identities[actor].token}` } : {}),
      ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const result = contentType.includes("application/json") ? await response.json() : await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${typeof result === "object" ? result.error?.code ?? "JSON response" : contentType}`);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return result;
}

await api(null, "/organizations", "GET", undefined, 401);
await api("owner", "/organizations", "POST", { name: "Forbidden", slug: `bad-${tag}` }, 403, "https://attacker.invalid");
const organization = await api("owner", "/organizations", "POST", { name: "Pruebas Solar", slug: `http-solar-${tag}`, timezone: "America/Bogota" }, 201);
const otherOrganization = await api("other", "/organizations", "POST", { name: "Otra Empresa", slug: `http-other-${tag}`, timezone: "America/Bogota" }, 201);
const root = `/organizations/${organization.id}`;
const otherRoot = `/organizations/${otherOrganization.id}`;
const customer = await api("owner", `${root}/customers`, "POST", { name: "Cliente de prueba" }, 201);
const projectInput = { customerId: customer.id, name: "Instalación de prueba", location: "Yopal, Casanare", capacityKwp: 12.5, timezone: "America/Bogota", topologyType: "grid_tied_no_battery" };
const project = await api("owner", `${root}/projects`, "POST", projectInput, 201);
const secondProject = await api("owner", `${root}/projects`, "POST", { ...projectInput, name: "Instalación sin asignar" }, 201);
await api("owner", `${root}/customers`, "POST", { name: "Injected", organizationId: otherOrganization.id }, 400);
await api("other", `${root}/projects`, "GET", undefined, 403);
await api("owner", `${otherRoot}/projects/${project.id}`, "GET", undefined, 403);
await api("outsider", `${root}/projects/${project.id}`, "GET", undefined, 403);
const invitation = await api("owner", `${root}/invitations`, "POST", { email: identities.customer.email, role: "customer", projectIds: [project.id] }, 201);
const accepted = await api("customer", "/invitations/accept", "POST", { token: invitation.token });
assert.equal(accepted.organizationId, organization.id);
await api("customer", "/invitations/accept", "POST", { token: invitation.token }, 409);
const customerProjects = await api("customer", `${root}/projects`);
assert.deepEqual(customerProjects.items.map((item) => item.id), [project.id]);
await api("customer", `${root}/projects/${secondProject.id}`, "GET", undefined, 404);
await api("customer", `${root}/customers`, "POST", { name: "Not allowed" }, 403);
const csv = await api("customer", `${root}/projects/export`);
assert.ok(csv.includes(project.id) && !csv.includes(secondProject.id));
const points = {};
for (const kind of ["generation", "grid"]) {
  points[kind] = await api("owner", `${root}/projects/${project.id}/points`, "POST", { name: kind === "grid" ? "Red" : "Generación", kind, signConvention: kind === "grid" ? "positive_import" : "positive_generation" }, 201);
}
const start = new Date(Date.now() - 3600000).toISOString();
const meters = [];
for (let i = 0; i < 3; i++) meters.push(await api("owner", `${root}/devices`, "POST", { name: `Medidor ${i + 1}`, serialNumber: `HTTP-${tag}-${i}`, kind: "meter" }, 201));
for (const [i, kind] of ["generation", "grid"].entries()) await api("owner", `${root}/projects/${project.id}/bindings`, "POST", { deviceId: meters[i].id, measurementPointId: points[kind].id, validFrom: start, configuration: { channel: "main", multiplier: 1 } }, 201);
await api("owner", `${root}/projects/${project.id}/topology`, "POST", { validFrom: start, configuration: { type: "grid_tied_no_battery", generationPointId: points.generation.id, gridPointId: points.grid.id, consumptionPointId: null } }, 201);
await api("owner", `${root}/projects/${project.id}/commissioning`, "POST", { commissionedAt: new Date(Date.now() - 1800000).toISOString(), notes: "Verificación de puesta en marcha local ficticia." });
await api("owner", `${root}/projects/${project.id}/bindings`, "POST", { deviceId: meters[2].id, measurementPointId: points.generation.id, validFrom: new Date(Date.now() - 600000).toISOString(), configuration: { channel: "main", multiplier: 1 } }, 201);
await api("owner", `${root}/devices/${meters[0].id}/retire`, "POST", {});
const saved = await api("owner", `${root}/projects/${project.id}`);
assert.equal(saved.bindings.length, 3);
assert.equal(saved.bindings.filter((binding) => binding.validTo).length, 1);
assert.ok(saved.commissionedAt && saved.history.length >= 8);
const authorizedPage = await fetch(`${base}/projects/${project.id}?org=${organization.id}`, { headers: { Cookie: `solar_session=${identities.customer.token}` } });
assert.equal(authorizedPage.status, 200);
const html = await authorizedPage.text();
assert.ok(html.includes("Aún no hay mediciones") && !html.includes("Demostración con datos simulados"));
const noSession = await fetch(`${base}/dashboard`, { redirect: "manual" });
assert.equal(noSession.status, 307);
assert.match(noSession.headers.get("location"), /^\/login\?/);

// Private fixture for browser QA / restart verification, ignored by Git.
await mkdir(new URL("../.work/", import.meta.url), { recursive: true });
await writeFile(new URL("../.work/http-fixture.json", import.meta.url), JSON.stringify({ base, identities, organization, otherOrganization, project, secondProject, customer, meters }, null, 2));
console.log("PASS HTTP: identity required, CSRF, CRUD, scoped IDs/export/customer, invitations, commissioning and meter replacement.");
}
