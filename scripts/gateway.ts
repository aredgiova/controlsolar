import { readFile, mkdir, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readGatewayConfiguration } from "../src/gateway/config";
import { DurableOutbox } from "../src/gateway/outbox";
import { createMqttPublisher } from "../src/gateway/mqtt";
import { runGateway } from "../src/gateway/runtime";

async function main() {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("El gateway requiere Node.js 24.");
  const file = process.argv[2];
  if (!file) throw new Error("Uso: npm run gateway -- /ruta/privada/gateway.json");
  const configuration = readGatewayConfiguration(JSON.parse(await readFile(resolve(file), "utf8")));
  await mkdir(dirname(resolve(configuration.bufferPath)), { recursive: true, mode: 0o700 });
  const buffer = new DurableOutbox(configuration.bufferPath, { maxSamples: configuration.maxBufferSamples, maxBytes: configuration.maxBufferBytes });
  if (process.platform !== "win32") await chmod(configuration.bufferPath, 0o600);
  const publisher = await createMqttPublisher(configuration).catch((error) => { buffer.close(); throw error; });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  await runGateway(configuration, buffer, publisher, controller.signal);
}
main().catch(() => { console.error("Gateway detenido. Revisa su configuración, almacenamiento y conectividad. No se mostraron credenciales ni mediciones."); process.exitCode = 1; });
