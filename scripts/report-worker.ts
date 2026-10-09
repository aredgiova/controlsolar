import "dotenv/config";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { runReportWorkerOnce } from "../src/modules/reports/worker";
import { closeWorkerDatabase } from "../src/lib/worker-db";
async function main() {
  const controller = new AbortController(); process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  const workerId = `report-${randomUUID()}`, once = process.argv.includes("--once");
  try { do { const status = await runReportWorkerOnce(workerId); console.info(JSON.stringify({ component: "report-worker", status })); if (once || controller.signal.aborted) break;
    if (status === "empty" || status === "retry") await setTimeout(5000, undefined, { signal: controller.signal }).catch(() => {});
  } while (!controller.signal.aborted); } finally { await closeWorkerDatabase(); }
}
void main().catch(() => { console.error("El worker de informes no pudo continuar. Revisa su configuración privada, migraciones y almacenamiento."); process.exitCode = 1; });
