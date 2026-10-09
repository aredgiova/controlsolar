import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { resolve } from "node:path";

if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("El bundle de workers requiere Node.js 24.");
const root = process.cwd();
const output = resolve(root, ".work/workers");
await mkdir(output, { recursive: true });
const entries = [
  { name: "monitor", source: "scripts/monitor.ts" },
  { name: "report-worker", source: "scripts/report-worker.ts" },
  { name: "gateway", source: "scripts/gateway.ts" },
  { name: "prepare-device", source: "scripts/prepare-device.ts" },
];
const artifacts = [];
for (const entry of entries) {
  const filename = `${entry.name}.mjs`;
  const result = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, entry.source)],
    outfile: resolve(output, filename),
    tsconfig: resolve(root, "tsconfig.json"),
    bundle: true,
    packages: "bundle",
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: false,
    metafile: true,
    // MQTT/TLS does not need ws's optional native acceleration addons.
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    // This artifact is a server executable, with no browser import context.
    alias: { "server-only": resolve(root, "src/ingestion/server-only.ts") },
    external: ["pg-native"],
    banner: { js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);' },
  });
  for (const details of Object.values(result.metafile.outputs)) {
    const unexpected = details.imports.filter((dependency) => dependency.external && dependency.path !== "pg-native" && !isBuiltin(dependency.path));
    if (unexpected.length) {
      throw new Error(`El artefacto ${filename} conserva imports sin empaquetar: ${unexpected.map((dependency) => dependency.path).join(", ")}.`);
    }
  }
  const bytes = await readFile(resolve(output, filename));
  artifacts.push({ file: filename, entry: entry.source, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength });
}
const lockfile = await readFile(resolve(root, "package-lock.json"));
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({
  runtime: "node24",
  nodeVersion: process.versions.node,
  lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
  artifacts,
}, null, 2)}\n`);
console.log("Bundles de monitor, reportes, gateway y preparación offline creados en .work/workers; servicios no instalados ni iniciados.");
