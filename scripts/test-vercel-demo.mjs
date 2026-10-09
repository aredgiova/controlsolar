import assert from "node:assert/strict";

// No credentials, cookie jar, database access, or redirects to external services.
const base = new URL(process.env.DEMO_BASE_URL || "http://127.0.0.1:3000");
assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === "/", "DEMO_BASE_URL debe ser un origen sin credenciales, ruta, consulta ni fragmento.");
assert.ok(base.protocol === "https:" || (base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)), "Usa HTTPS para destinos remotos; HTTP solo está permitido en loopback.");

async function request(path, options = {}) {
  const url = new URL(path, base);
  assert.equal(url.origin, base.origin, "Todas las solicitudes deben permanecer en el origen de la demo.");
  return fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(30_000) });
}

function noSession(response) {
  assert.ok(!response.headers.getSetCookie().some((cookie) => /^solar_session=/i.test(cookie)), "La demo no debe emitir una sesión real.");
}

function redirectTo(response, pathname, error) {
  assert.equal(response.status, 303, pathname);
  const location = response.headers.get("location");
  assert.ok(location, "Falta la redirección esperada.");
  const target = new URL(location, base);
  assert.equal(target.origin, base.origin, "No se debe redirigir a Cognito ni a otro origen.");
  assert.equal(target.pathname, pathname);
  assert.equal(target.searchParams.get("error"), error);
  noSession(response);
}

async function demoPage(path, title) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get("content-type") || "", /text\/html/, path);
  noSession(response);
  const html = await response.text();
  assert.ok(html.includes("Demostración con datos simulados"), `${path}: falta la marca de demo.`);
  assert.ok(html.includes("Información ficticia, sin equipos conectados."), `${path}: falta el alcance ficticio.`);
  if (title) assert.ok(html.includes(`<h1>${title}</h1>`), `${path}: falta el contenido esperado.`);
  console.log(`OK ${path}`);
  return html;
}

async function unauthenticatedApi(path, options) {
  const response = await request(path, options);
  assert.equal(response.status, 401, `${options?.method || "GET"} ${path}: la demo no autoriza gestión persistente.`);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(await response.json(), { error: { code: "UNAUTHENTICATED", message: "Inicia sesión para continuar." } });
  noSession(response);
  console.log(`OK ${options?.method || "GET"} ${path}: sin identidad ni escritura`);
}

async function main() {
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  console.log("OK /api/health: disponibilidad HTTP");

  const home = await request("/");
  assert.ok([307, 308].includes(home.status), "La portada debe redirigir al resumen.");
  const destination = new URL(home.headers.get("location") || "", base);
  assert.equal(destination.origin, base.origin);
  assert.equal(destination.pathname, "/dashboard");
  noSession(home);

  const dashboard = await demoPage("/dashboard", "Vista de la cartera");
  assert.ok(dashboard.includes("Requieren atención"));
  const detail = dashboard.match(/href="(\/projects\/[^?"/]+\?org=[^"]+)"/);
  assert.ok(detail, "El resumen debe enlazar un proyecto ficticio.");
  const detailPath = detail[1].replaceAll("&amp;", "&");
  const organizationId = new URL(detailPath, base).searchParams.get("org");
  assert.ok(organizationId, "El proyecto debe conservar su organización de demostración.");

  for (const [path, title] of [["/projects", "Proyectos"], ["/customers", "Clientes"], ["/devices", "Dispositivos"], ["/alerts", "Alertas"], ["/portal", "Mi portal"], ["/settings", "Configuración"], ["/team", "Equipo y accesos"]]) {
    await demoPage(path, title);
  }
  await demoPage(detailPath);
  const empty = await demoPage(`/projects?org=${encodeURIComponent(organizationId)}&q=sin-coincidencias-000`);
  assert.ok(empty.includes("No hay coincidencias"));

  const login = await request("/login");
  assert.equal(login.status, 200);
  const loginHtml = await login.text();
  assert.ok(loginHtml.includes("Explorar la demostración"));
  assert.ok(!/href="\/auth\/login(?:[?"/])/.test(loginHtml), "La demo no debe ofrecer un inicio de sesión real.");
  noSession(login);
  redirectTo(await request("/auth/login?next=%2Fdashboard"), "/login", "demo");
  const callback = await request("/auth/callback");
  redirectTo(callback, "/login", "authentication");
  assert.ok(callback.headers.getSetCookie().some((cookie) => /^solar_auth_flow=/i.test(cookie) && /Max-Age=0/i.test(cookie)), "El callback debe eliminar el flujo incompleto.");
  console.log("OK autenticación deshabilitada y callback sin credenciales controlado");

  // Check the rendered demo and denied GET before this deliberately rejected POST.
  // /api/v1/organizations is a real route; no session or authorization is supplied.
  await unauthenticatedApi("/api/v1/organizations");
  await unauthenticatedApi("/api/v1/organizations", { method: "POST", headers: { "Content-Type": "application/json", Origin: base.origin }, body: "{}" });
  console.log("Demo HTTP verificada. No se han comprobado PostgreSQL, Cognito, AWS ni equipos físicos.");
}

main().catch((error) => {
  console.error(`Fallo en la verificación de demo: ${error.message}`);
  process.exitCode = 1;
});
