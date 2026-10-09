import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const output = resolve(".work/ingestion");
await mkdir(output, { recursive: true });
await build({ absWorkingDir: process.cwd(), entryPoints: [resolve("src/ingestion/handler.ts")], tsconfig: resolve("tsconfig.json"), outfile: `${output}/handler.mjs`, bundle: true,
  platform: "node", target: "node24", format: "esm", packages: "bundle", sourcemap: false,
  alias: { "server-only": resolve("src/ingestion/server-only.ts") }, external: ["pg-native"],
  banner: { js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);' } });

// ZIP "stored" method: one deterministic, dependency-free file with CRC32.
const data = await readFile(`${output}/handler.mjs`);
const name = Buffer.from("handler.mjs");
let crc = 0xffffffff;
for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
crc = (crc ^ 0xffffffff) >>> 0;
const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
const zip = Buffer.concat([local, name, data, central, name, end]);
await writeFile(`${output}/ingestion.zip`, zip);
await writeFile(`${output}/manifest.json`, JSON.stringify({ runtime: "nodejs24.x", handler: "handler.handler", sha256: createHash("sha256").update(zip).digest("hex"), size: zip.length }, null, 2));
console.log("Bundle local de ingesta creado en .work/ingestion/ingestion.zip; no se desplegó infraestructura.");
