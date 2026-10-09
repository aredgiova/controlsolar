import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deviceSetupTemplate, newDeviceSetupDirectory, parseDeviceSetup, writeDevicePackage } from "../src/gateway/onboarding";

async function main() {
  const args = process.argv.slice(2);
  let config: string | undefined; let output: string | undefined; let template = false; let preflight = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw new Error("Opción repetida.");
    seen.add(option);
    if (option === "--config" || option === "--output") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Falta valor de una opción.");
      if (option === "--config") config = value; else output = value;
    } else if (option === "--template") template = true;
    else if (option === "--preflight") preflight = true;
    else throw new Error("Opción desconocida.");
  }
  if (!output || (template ? Boolean(config) || preflight : !config)) throw new Error("Uso: npm run prepare:device -- --template --output nombre; o --config archivo.json --output nombre [--preflight].");
  if (template) {
    const target = await newDeviceSetupDirectory(output);
    await writeFile(join(target, "input.template.json"), `${JSON.stringify(deviceSetupTemplate, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: "template_created", directory: target, readyToConnect: false }));
    return;
  }
  const path = resolve(config!); const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("La configuración debe ser un archivo JSON regular de hasta 64 KiB.");
  const input = parseDeviceSetup(JSON.parse(await readFile(path, "utf8")));
  const result = await writeDevicePackage(input, output, { preflight });
  console.log(JSON.stringify({ status: result.manifest.state, directory: result.target, preflight: result.manifest.preflight.status, readyToConnect: false }));
}
main().catch((error: unknown) => {
  // Do not serialize parse errors, OpenSSL errors or raw input: those can contain file contents.
  const message = error instanceof Error && (error.message.startsWith("Configuración de incorporación inválida:") || error.message.startsWith("Uso:") || error.message.startsWith("Preflight local fallido:")) ? error.message : "Preparación fallida: revisa opciones, JSON, rutas privadas y que el directorio de salida sea nuevo. No se mostraron contenidos.";
  console.error(message); process.exitCode = 1;
});
