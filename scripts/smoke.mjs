import assert from "node:assert/strict";

const base = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: "ok" });
console.log("OK /api/health: respuesta mínima");

const dashboard = await fetch(`${base}/dashboard`);
assert.equal(dashboard.status, 200);
const html = await dashboard.text();
assert.ok(html.includes("Demostración con datos simulados"));
assert.ok(html.includes("Requieren atención"));
const detail = html.match(/href="(\/projects\/[^?"/]+\?org=[^"]+)"/);
assert.ok(detail, "El resumen debe enlazar a un detalle de proyecto");
const org = new URL(`${base}${detail[1].replaceAll("&amp;", "&")}`).searchParams.get("org");

for (const path of ["/projects", detail[1].replaceAll("&amp;", "&"), "/alerts", "/settings"]) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  assert.ok((await response.text()).includes("Demostración con datos simulados"), path);
  console.log(`OK ${path}`);
}

const emptySearch = await fetch(`${base}/projects?org=${encodeURIComponent(org)}&q=sin-coincidencias-000`);
assert.equal(emptySearch.status, 200);
assert.ok((await emptySearch.text()).includes("No hay coincidencias"));
console.log("OK búsqueda sin coincidencias");

const unknown = await fetch(`${base}/projects/proyecto-inexistente?org=${encodeURIComponent(org)}`);
// Next may stream a not-found boundary after headers; verify rendered content too.
const unknownBody = await unknown.text();
assert.ok(unknown.status === 404 || unknownBody.includes("No encontramos"));
console.log("OK proyecto inexistente");
console.log("Smoke HTTP completado con fixtures; no verifica identidad ni aislamiento real.");
