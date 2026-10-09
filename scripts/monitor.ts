import { setTimeout as delay } from "node:timers/promises";
import { runMonitoringCycle } from "../src/modules/alerts/worker";
import { closeWorkerDatabase } from "../src/lib/worker-db";

async function main() {
  const args = process.argv.slice(2);
  const usage = "Uso: monitor [--once] [--interval-ms 30000] [--max-projects 100] [--max-notifications 100]";
  const allowed = new Set(["--once", "--interval-ms", "--max-projects", "--max-notifications"]);
  for (let index = 0; index < args.length; index++) { if (!allowed.has(args[index])) throw new Error(usage); if (args[index] !== "--once" && (!args[++index] || !/^\d+$/.test(args[index]))) throw new Error(usage); }
  const number = (flag: string, fallback: number) => { const index = args.indexOf(flag); return index < 0 ? fallback : Number(args[index + 1]); };
  const intervalMs = number("--interval-ms", 30000), maxProjects = number("--max-projects", 100), maxNotifications = number("--max-notifications", 100);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new Error("El intervalo debe estar entre 1 segundo y 1 hora.");
  let stopped = false;
  process.once("SIGINT", () => { stopped = true; }); process.once("SIGTERM", () => { stopped = true; });
  try {
    do {
      const result = await runMonitoringCycle({ maxProjects, maxNotifications });
      console.log(JSON.stringify({ worker: "monitor", evaluatedAt: new Date().toISOString(), ...result, notifications: "in_app" }));
      if (args.includes("--once") || stopped) break;
      await delay(intervalMs);
    } while (!stopped);
  } finally { await closeWorkerDatabase(); }
}
main().catch(() => { console.error("El monitor no pudo completar el ciclo. Revisa la configuración y disponibilidad del worker."); process.exitCode = 1; });
