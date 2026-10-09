import "server-only";
import { randomUUID } from "node:crypto";
import { gatewayEnrollmentSchema, gatewayRevocationSchema } from "@/contracts/gateway-management";
import { normalizeCertificateThumbprint } from "@/modules/telemetry/certificate";
import { listQuerySchema, uuidSchema } from "@/contracts/management";
import { readConfig } from "@/lib/config";
import { withTenant } from "@/lib/tenant";
import { audit, DomainError, notFound, pageWindow, requireManager, type Actor } from "@/modules/organizations/access";

export async function listGateways(actor: Actor, organizationId: string, input: unknown = {}) {
  const query = listQuerySchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx);
    const where = { organizationId, ...(query.search ? { name: { contains: query.search, mode: "insensitive" as const } } : {}) };
    const [items, total] = await Promise.all([
      tx.gatewayIdentity.findMany({ where, ...pageWindow(query), orderBy: { createdAt: "desc" }, include: { gatewayDevice: { select: { name: true, serial: true } }, meters: { include: { meterDevice: { select: { name: true, serial: true } } } } } }),
      tx.gatewayIdentity.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  });
}

export async function enrollGateway(actor: Actor, organizationId: string, input: unknown) {
  const data = gatewayEnrollmentSchema.parse(input);
  if (data.source === "simulator" && readConfig().appEnv === "production") throw new DomainError(400, "SIMULATOR_DISABLED", "El simulador se admite en desarrollo y staging.");
  // For X.509 MQTT, principal() is the SHA256 thumbprint of the certificate DER.
  // AWS certificateId and certificateArn are management identifiers; do not infer this value from them.
  if (data.source === "aws_iot" && !/^[a-f0-9]{64}$/i.test(data.principalId)) throw new DomainError(400, "INVALID_CERTIFICATE_ID", "Usa la huella SHA256 del certificado X.509: 64 caracteres hexadecimales, sin separadores.");
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx);
    const gatewayDevice = await tx.device.findFirst({ where: { id: data.gatewayDeviceId, organizationId, kind: "gateway", status: "active" } });
    if (!gatewayDevice) notFound("Selecciona un gateway activo de esta empresa.");
    const meters = await tx.device.findMany({ where: { organizationId, id: { in: data.meterDeviceIds }, kind: "meter", status: "active" }, select: { id: true } });
    if (meters.length !== data.meterDeviceIds.length) throw new DomainError(400, "INVALID_METERS", "Selecciona medidores activos de esta empresa.");
    const id = randomUUID();
    const gateway = await tx.gatewayIdentity.create({ data: {
      id, clientId: id,
      organizationId, gatewayDeviceId: data.gatewayDeviceId, name: data.name, source: data.source,
      principalId: data.source === "aws_iot" ? normalizeCertificateThumbprint(data.principalId) : data.principalId,
    } });
    await tx.gatewayMeter.createMany({ data: data.meterDeviceIds.map((meterDeviceId) => ({ organizationId, gatewayIdentityId: id, meterDeviceId })) });
    await audit(tx, actor, organizationId, "gateway.enrolled", "gateway", gateway.id, { source: data.source, meterDeviceIds: data.meterDeviceIds });
    return gateway;
  });
}

export async function revokeGateway(actor: Actor, organizationId: string, gatewayId: string, input: unknown) {
  gatewayRevocationSchema.parse(input);
  return withTenant(actor, uuidSchema.parse(organizationId), async (tx) => {
    await requireManager(tx);
    const gateway = await tx.gatewayIdentity.findFirst({ where: { id: uuidSchema.parse(gatewayId), organizationId } });
    if (!gateway) notFound("No se encontró la identidad autorizada.");
    if (gateway.status === "revoked") return gateway;
    const result = await tx.gatewayIdentity.update({ where: { id: gatewayId }, data: { status: "revoked", revokedAt: new Date() } });
    await audit(tx, actor, organizationId, "gateway.revoked", "gateway", gatewayId);
    return result;
  });
}
