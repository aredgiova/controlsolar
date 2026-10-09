import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { gatewayConfigurationSchema, readGatewayConfiguration } from "./config";
import { normalizeCertificateThumbprint } from "../modules/telemetry/certificate";

const uuid = z.uuid();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/i).transform(normalizeCertificateThumbprint);
const privatePath = z.string().min(1).max(1024).refine((value) => !/[\0\r\n]/.test(value) && (isAbsolute(value) || win32.isAbsolute(value)), "Usa una ruta absoluta local.");
const bindingSchema = z.strictObject({ deviceId: uuid, measurementPointId: uuid, configurationVersion: z.number().int().positive(), validFrom: z.iso.datetime({ offset: true }), validTo: z.iso.datetime({ offset: true }).nullable() });

export const deviceSetupSchema = z.strictObject({
  version: z.literal(1),
  environment: z.enum(["staging", "production"]),
  aws: z.strictObject({
    accountId: z.string().regex(/^[0-9]{12}$/), region: z.string().regex(/^(af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-[0-9]+$/),
    endpointType: z.literal("iot:Data-ATS"), dataEndpoint: z.string().regex(/^[a-z0-9-]+\.iot\.[a-z0-9-]+\.amazonaws\.com$/),
    profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), certificateId: fingerprint.nullable(),
  }),
  registry: z.strictObject({
    organizationId: uuid, projectId: uuid, gatewayId: uuid, gatewayDeviceId: uuid, source: z.literal("aws_iot"), status: z.literal("active"),
    principalId: fingerprint, meterDeviceIds: z.array(uuid).min(1).max(100), bindings: z.array(bindingSchema).min(1).max(8),
  }),
  gateway: z.strictObject({
    certificatePath: privatePath, privateKeyPath: privatePath, caPath: privatePath, bufferPath: privatePath, csrPath: privatePath,
    pollIntervalMs: z.number().int().min(5000).max(300000),
    maxBufferSamples: z.number().int().min(100).max(1000000), maxBufferBytes: z.number().int().min(65536).max(1073741824),
    meters: z.array(gatewayConfigurationSchema.shape.meters.element.extend({
      port: z.number().int().min(1).max(65535), wordOrder: z.enum(["high-first", "low-first"]),
    })).min(1).max(8),
  }),
}).superRefine((input, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
  if (!input.aws.dataEndpoint.endsWith(`.iot.${input.aws.region}.amazonaws.com`)) issue(["aws", "dataEndpoint"], "El endpoint no corresponde a la región.");
  if (input.registry.gatewayId === input.registry.gatewayDeviceId) issue(["registry", "gatewayId"], "Identidad y equipo físico son UUID distintos.");
  if (new Set(input.registry.meterDeviceIds).size !== input.registry.meterDeviceIds.length) issue(["registry", "meterDeviceIds"], "Allowlist repetida.");
  if (new Set(input.gateway.meters.map((meter) => meter.deviceId)).size !== input.gateway.meters.length) issue(["gateway", "meters"], "Medidor repetido.");
  if (new Set(input.gateway.meters.map((meter) => meter.measurementPointId)).size !== input.gateway.meters.length) issue(["gateway", "meters"], "Punto de medición repetido.");
  if (new Set(input.registry.bindings.map((binding) => binding.deviceId)).size !== input.registry.bindings.length) issue(["registry", "bindings"], "Una asignación vigente por medidor.");
  if (input.registry.bindings.length !== input.gateway.meters.length) issue(["registry", "bindings"], "Incluye exactamente las asignaciones seleccionadas.");
  const paths = [input.gateway.certificatePath, input.gateway.privateKeyPath, input.gateway.caPath, input.gateway.bufferPath, input.gateway.csrPath];
  if (new Set(paths.map((path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path))).size !== paths.length) issue(["gateway"], "Los cinco archivos deben tener rutas distintas.");
  input.gateway.meters.forEach((meter, index) => {
    if (!isIP(meter.host) && !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(meter.host)) issue(["gateway", "meters", index, "host"], "Usa una dirección IP o un hostname sin esquema ni puerto.");
    if (meter.configurationVersion > 2147483647) issue(["gateway", "meters", index, "configurationVersion"], "La versión debe caber en INTEGER de PostgreSQL.");
    if (!input.registry.meterDeviceIds.includes(meter.deviceId) || [input.registry.gatewayId, input.registry.gatewayDeviceId].includes(meter.deviceId)) issue(["gateway", "meters", index, "deviceId"], "Medidor fuera de la allowlist o confundido con gateway.");
    const binding = input.registry.bindings.find((item) => item.deviceId === meter.deviceId);
    if (!binding || binding.measurementPointId !== meter.measurementPointId || binding.configurationVersion !== meter.configurationVersion) issue(["gateway", "meters", index], "La asignación no coincide con el snapshot.");
    if (binding?.validTo !== null || !binding || Date.parse(binding.validFrom) > Date.now()) issue(["registry", "bindings"], "La asignación debe estar vigente y sin fecha de fin.");
  });
  input.gateway.meters.forEach((meter, index, meters) => {
    if (meters.some((other, otherIndex) => otherIndex < index && other.host.toLowerCase() === meter.host.toLowerCase() && other.port === meter.port && other.unitId === meter.unitId)) issue(["gateway", "meters", index], "Dirección Modbus repetida.");
  });
});

export type DeviceSetup = z.infer<typeof deviceSetupSchema>;

export function parseDeviceSetup(input: unknown): DeviceSetup {
  const parsed = deviceSetupSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Configuración de incorporación inválida: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ")}. No se mostraron valores.`);
  return parsed.data;
}

export function gatewayFromSetup(input: DeviceSetup) {
  const { certificatePath, privateKeyPath, caPath, bufferPath, pollIntervalMs, maxBufferSamples, maxBufferBytes, meters } = input.gateway;
  return readGatewayConfiguration({ certificatePath, privateKeyPath, caPath, bufferPath, pollIntervalMs, maxBufferSamples, maxBufferBytes, meters,
    gatewayId: input.registry.gatewayId, clientId: input.registry.gatewayId, topic: `solar/v2/gateways/${input.registry.gatewayId}/telemetry`, endpoint: input.aws.dataEndpoint });
}

export function policyFromSetup(input: DeviceSetup) {
  const prefix = `arn:aws:iot:${input.aws.region}:${input.aws.accountId}`;
  return { Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: "iot:Connect", Resource: `${prefix}:client/${input.registry.gatewayId}`, Condition: { Bool: { "iot:Connection.Thing.IsAttached": "true" } } },
    { Effect: "Allow", Action: "iot:Publish", Resource: `${prefix}:topic/solar/v2/gateways/${input.registry.gatewayId}/telemetry`, Condition: { Bool: { "iot:Connection.Thing.IsAttached": "true" } } },
  ] };
}

export function commandPlan(input: DeviceSetup, outputDirectory: string) {
  const common = ["--region", input.aws.region, "--no-cli-pager", ...(input.aws.profile ? ["--profile", input.aws.profile] : [])];
  const command = (id: string, service: string, operation: string, args: string[], gate: string) => ({ id, executable: "aws", argv: [service, operation, ...args, ...common], gate });
  const certificateId = input.aws.certificateId ?? "REPLACE_WITH_AWS_CERTIFICATE_ID";
  const certificateArn = `arn:aws:iot:${input.aws.region}:${input.aws.accountId}:cert/${certificateId}`;
  const policyName = `solar-${input.environment}-${input.registry.gatewayId}`;
  return { version: 1, execution: "manual_review_only", certificateIdKnown: input.aws.certificateId !== null,
    bootstrapReference: [command("certificate-from-device-csr", "iot", "create-certificate-from-csr", ["--certificate-signing-request", `file://${input.gateway.csrPath}`, "--no-set-as-active", "--certificate-pem-outfile", input.gateway.certificatePath, "--query", "{certificateId:certificateId,certificateArn:certificateArn}", "--output", "json"], "Solo antes del enrolamiento inicial, con clave y CSR creados en el gateway. Crea un certificado nuevo en cada ejecución; no ejecutar para el certificado ya enrolado. No sobreescribir archivos existentes.")],
    review: [
      command("account", "sts", "get-caller-identity", ["--query", "Account", "--output", "text"], `Debe coincidir exactamente con ${input.aws.accountId}; si difiere, detener.`),
      command("endpoint", "iot", "describe-endpoint", ["--endpoint-type", "iot:Data-ATS", "--query", "endpointAddress", "--output", "text"], "Comparar con dataEndpoint. La primera llamada puede crear el endpoint de la cuenta."),
      command("certificate", "iot", "describe-certificate", ["--certificate-id", certificateId, "--query", "certificateDescription.{certificateId:certificateId,certificateArn:certificateArn,status:status}", "--output", "json"], "ID obtenido de AWS, separado del thumbprint; comparar PEM con preflight local y estado INACTIVE antes de conectar."),
    ],
    provision: [
      command("thing", "iot", "create-thing", ["--thing-name", input.registry.gatewayId], "UUID devuelto por el registry y confirmado activo. Revisar que no exista un Thing ajeno con ese nombre."),
      command("policy", "iot", "create-policy", ["--policy-name", policyName, "--policy-document", `file://${join(outputDirectory, "iot-policy.json")}`], "Política nueva y revisada; si existe, inspeccionar sus versiones, no sustituirla automáticamente."),
      command("attach-thing", "iot", "attach-thing-principal", ["--thing-name", input.registry.gatewayId, "--principal", certificateArn, "--thing-principal-type", "EXCLUSIVE_THING"], "Certificado exclusivo de este Thing; comprobar que no tenga otras políticas o asociaciones que amplíen permisos."),
      command("attach-policy", "iot", "attach-policy", ["--policy-name", policyName, "--target", certificateArn], "Mismo ARN del certificado revisado."),
      command("activate", "iot", "update-certificate", ["--certificate-id", certificateId, "--new-status", "ACTIVE"], "Solo después de preflight local, registry vigente, plantilla desplegada y prueba negativa de permisos planificada."),
    ],
    revoke: [
      command("inactivate", "iot", "update-certificate", ["--certificate-id", certificateId, "--new-status", "INACTIVE"], "Primero revocar en la aplicación; luego bloquear nuevas conexiones AWS. La desconexión automática puede tardar minutos."),
      command("disconnect", "iot-data", "delete-connection", ["--client-id", input.registry.gatewayId, "--endpoint-url", `https://${input.aws.dataEndpoint}`, "--clean-session", "--prevent-will-message"], "Después de inactivar; evita que el cliente se reconecte. Verificar resultado y rechazo de reconexión."),
      command("detach-policy", "iot", "detach-policy", ["--policy-name", policyName, "--target", certificateArn], "Preservar evidencias y certificado; no borrar ni marcar REVOKED automáticamente."),
      command("detach-thing", "iot", "detach-thing-principal", ["--thing-name", input.registry.gatewayId, "--principal", certificateArn], "Separar la asociación después de bloquear conexiones."),
    ],
  };
}

async function regularFile(path: string, maxSize: number, secret = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > maxSize) throw new Error("Archivo local ausente, no regular o fuera de límite.");
  if (secret && process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("La clave requiere permisos 0600.");
  return readFile(path);
}

export async function preflightDeviceFiles(input: DeviceSetup, now = new Date()) {
  try {
    const [certificatePem, privateKeyPem, caPem] = await Promise.all([
      regularFile(input.gateway.certificatePath, 65536), regularFile(input.gateway.privateKeyPath, 65536, true), regularFile(input.gateway.caPath, 262144),
    ]);
    try {
      const certificate = new X509Certificate(certificatePem);
      if (certificate.ca || Date.parse(certificate.validFrom) > now.getTime() || Date.parse(certificate.validTo) <= now.getTime()) throw new Error("Certificado cliente inválido o fuera de vigencia.");
      const principalId = createHash("sha256").update(certificate.raw).digest("hex");
      if (principalId !== input.registry.principalId || !certificate.checkPrivateKey(createPrivateKey(privateKeyPem))) throw new Error("Certificado, clave y principal del registry no coinciden.");
      const authorities = caPem.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      if (!authorities?.length || authorities.some((pem) => { const ca = new X509Certificate(pem); return !ca.ca || Date.parse(ca.validFrom) > now.getTime() || Date.parse(ca.validTo) <= now.getTime(); })) throw new Error("Bundle CA local inválido o fuera de vigencia.");
      return { status: "local_files_verified", principalId, certificateValidTo: certificate.validTo, caCertificates: authorities.length, networkVerified: false, registryVerified: false, privateKeyPermissionsVerified: process.platform !== "win32" };
    } finally { privateKeyPem.fill(0); }
  } catch { throw new Error("Preflight local fallido: revisa archivos regulares, permisos, vigencia, par certificado/clave y thumbprint. No se mostraron claves ni contenidos."); }
}

export async function newDeviceSetupDirectory(name: string, cwd = process.cwd()) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("Nombre de salida inválido; usa hasta 64 letras, números, guiones o guion bajo.");
  let parent = resolve(cwd);
  if (/(?:^|[\\/])public(?:[\\/]|$)/i.test(parent)) throw new Error("La salida no puede quedar dentro de public.");
  for (const part of [".work", "device-setup"]) {
    parent = join(parent, part);
    try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("La salida privada no puede usar enlaces.");
  }
  const target = join(parent, name);
  await mkdir(target, { mode: 0o700 });
  return target;
}

export async function writeDevicePackage(input: DeviceSetup, name: string, options: { cwd?: string; preflight?: boolean } = {}) {
  const checked = parseDeviceSetup(input);
  const preflight = options.preflight ? await preflightDeviceFiles(checked) : { status: "not_requested", networkVerified: false, registryVerified: false };
  const target = await newDeviceSetupDirectory(name, options.cwd);
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const files: Record<string, string> = {
    "gateway.json": json(gatewayFromSetup(checked)), "iot-policy.json": json(policyFromSetup(checked)), "commands.review.json": json(commandPlan(checked, target)),
    "registry-snapshot.json": json(checked.registry),
    "README.md": "# Paquete local de conexión\n\nEstado: preparado para revisión; no se ejecutó AWS ni se verificó el registry en vivo. No contiene claves privadas ni certificados.\n\n1. Revisar cuenta, región, endpoint ATS y snapshot contra el registro actual.\n2. Revisar commands.review.json por etapas. bootstrapReference es una referencia anterior al enrolamiento, no se repite para este certificado. Sustituir el ID AWS pendiente antes de ejecutar comandos.\n3. Verificar archivos del gateway con --preflight y permisos/ACL del sistema; no copiar la clave al equipo de administración.\n4. Revisar la política exacta, asociaciones exclusivas y todas las políticas del certificado.\n5. Activar y conectar solo tras completar la infraestructura. Ensayar conexión, lectura, rechazo entre Things y revocación.\n\nEl modelo soportado es SDM630MCT-v1.7 vía Modbus FC04. No se validó hardware, orientación, relación CT, firmware, red ni TLS remoto. El gateway usa Node24 y el artefacto standalone gateway.mjs: node /opt/solar-gateway/gateway.mjs /etc/solar-gateway/gateway.json. La herramienta standalone prepare-device.mjs permite --preflight sin tsx ni node_modules. Construir los artefactos con npm run build:workers y verificar manifest.json. Las rutas de este archivo pertenecen al host del gateway.\n\nRevocación de aplicación: PATCH /api/v1/organizations/{organizationId}/gateways/{gatewayId}, body {\"status\":\"revoked\"}, sesión de titular/administrador y Origin del sitio. Es permanente; conservar histórico y crear nueva identidad para sustituir certificado. Después ejecutar la etapa revoke revisada en AWS.\n",
  };
  for (const [file, content] of Object.entries(files)) await writeFile(join(target, file), content, { flag: "wx", mode: 0o600 });
  const manifest = { version: 1, state: "prepared_offline", environment: checked.environment, gatewayId: checked.registry.gatewayId, generatedAt: new Date().toISOString(), preflight,
    files: Object.entries(files).map(([file, content]) => ({ file, sha256: createHash("sha256").update(content).digest("hex") })),
    unresolved: [...(checked.aws.certificateId === null ? ["aws_certificate_id"] : []), "aws_account_endpoint_and_permissions", "live_registry_and_bindings", "windows_acl_when_applicable", "physical_meter_and_ct_orientation", "aws_ingestion_deployment", "remote_mtls_and_negative_authorization_tests"],
  };
  await writeFile(join(target, "manifest.json"), json(manifest), { flag: "wx", mode: 0o600 });
  return { target, manifest };
}

export const deviceSetupTemplate = {
  version: 1, environment: "staging", aws: { accountId: "", region: "", endpointType: "iot:Data-ATS", dataEndpoint: "", certificateId: null },
  registry: { organizationId: "", projectId: "", gatewayId: "", gatewayDeviceId: "", source: "aws_iot", status: "active", principalId: "", meterDeviceIds: [""], bindings: [{ deviceId: "", measurementPointId: "", configurationVersion: 1, validFrom: "", validTo: null }] },
  gateway: { certificatePath: "", privateKeyPath: "", caPath: "", bufferPath: "", csrPath: "", pollIntervalMs: 10000, maxBufferSamples: 50000, maxBufferBytes: 67108864,
    meters: [{ model: "SDM630MCT-v1.7", deviceId: "", measurementPointId: "", configurationVersion: 1, host: "", port: 502, unitId: 1, wordOrder: "high-first", powerSign: 1 }] },
};
