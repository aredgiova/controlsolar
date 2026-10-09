import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateSimulation, simulationTransport } from "../src/modules/telemetry/simulator";
import { processTelemetryPacket } from "../src/modules/telemetry/processor";
import { closeTelemetryStore } from "../src/modules/telemetry/store";

async function main() {
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const configPath = option("--config"), outputPath = option("--output");
const allowed = new Set(["--config", "--output", "--ingest"]);
for (let index = 0; index < args.length; index++) {
  if (!allowed.has(args[index]) || (args[index] !== "--ingest" && (!args[index + 1] || args[index + 1].startsWith("--")))) throw new Error("Uso: npm run simulate -- --config archivo.json [--output paquetes.jsonl] [--ingest]");
  if (args[index] !== "--ingest") index++;
}
if (!configPath || (!outputPath && !args.includes("--ingest"))) throw new Error("Indica --config y al menos --output o --ingest.");
const contents = await readFile(resolve(configPath), "utf8");
if (Buffer.byteLength(contents) > 65536) throw new Error("La configuración supera 64 KiB.");
const generated = generateSimulation(JSON.parse(contents));
if (outputPath) await writeFile(resolve(outputPath), `${generated.packets.map((packet) => JSON.stringify(packet)).join("\n")}\n`, { flag: "wx" });
let accepted = 0, duplicate = 0, quarantined = 0;
try {
  if (args.includes("--ingest")) {
    if (!["development", "staging"].includes(process.env.APP_ENV ?? "production")) throw new Error("El simulador requiere APP_ENV=development o staging.");
    if (Date.parse(generated.config.to) > Date.now() + 5 * 60000 || Date.parse(generated.config.from) < Date.now() - 30 * 86400000) throw new Error("La ingesta admite hasta 30 días de atraso y 5 minutos de reloj adelantado.");
    for (const packet of generated.packets) {
      const result = await processTelemetryPacket(packet, simulationTransport(generated.config));
      accepted += result.accepted; duplicate += result.duplicate; quarantined += result.quarantined;
    }
  }
  console.log(JSON.stringify({ packets: generated.packets.length, observations: generated.observationCount, accepted, duplicate, quarantined, source: "simulator" }));
  if (quarantined) process.exitCode = 1;
} finally { await closeTelemetryStore(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "La simulación no pudo completarse."); process.exitCode = 1; });
