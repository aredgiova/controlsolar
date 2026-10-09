import { createHash } from "node:crypto";
import { z } from "zod";
import { telemetryPacketSchema, type TelemetryPacket, type TelemetryTransportContext } from "../modules/telemetry/protocol";
import { normalizeCertificateThumbprint } from "../modules/telemetry/certificate";

export type SqsRecord = { messageId: string; body: string; eventSource: string; eventSourceARN: string };
export type SqsEvent = { Records: SqsRecord[] };
export type QuarantineInput = { messageId: string; bodyHash: string; reason: string; rawBody: string; receiptContext: Record<string, unknown> };
export type BatchResult = { batchItemFailures: { itemIdentifier: string }[] };
export interface IngestionDependencies {
  queueArn: string;
  processPacket(packet: TelemetryPacket, context: TelemetryTransportContext): Promise<unknown>;
  quarantine(input: QuarantineInput): Promise<unknown>;
}
const envelopeSchema = z.strictObject({
  source: z.literal("aws_iot"), principal: z.string().regex(/^[a-f0-9]{64}$/i).transform(normalizeCertificateThumbprint),
  client_id: z.uuid(), topic: z.string().regex(/^solar\/v2\/gateways\/[0-9a-f-]{36}\/telemetry$/i),
  received_at_ms: z.number().int().positive().max(8640000000000000),
  payload_base64: z.string().min(4).max(87384),
});

export class PermanentMessageError extends Error { constructor(public readonly reason: string) { super(reason); } }

export function decodeIotEnvelope(record: SqsRecord, queueArn: string) {
  if (record.eventSource !== "aws:sqs" || record.eventSourceARN !== queueArn) throw new PermanentMessageError("UNTRUSTED_EVENT_SOURCE");
  if (Buffer.byteLength(record.body) > 100_000) throw new PermanentMessageError("ENVELOPE_TOO_LARGE");
  let raw: unknown;
  try { raw = JSON.parse(record.body); } catch { throw new PermanentMessageError("INVALID_ENVELOPE_JSON"); }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw new PermanentMessageError("INVALID_IOT_ENVELOPE");
  const envelope = parsed.data;
  if (envelope.topic !== `solar/v2/gateways/${envelope.client_id}/telemetry`) throw new PermanentMessageError("CLIENT_TOPIC_MISMATCH");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.payload_base64)) throw new PermanentMessageError("INVALID_BASE64");
  const bytes = Buffer.from(envelope.payload_base64, "base64");
  if (bytes.length > 65536 || bytes.toString("base64") !== envelope.payload_base64) throw new PermanentMessageError("INVALID_PAYLOAD_SIZE_OR_ENCODING");
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new PermanentMessageError("INVALID_PAYLOAD_JSON"); }
  const packet = telemetryPacketSchema.safeParse(payload);
  if (!packet.success) throw new PermanentMessageError("INVALID_TELEMETRY_PACKET");
  if (packet.data.gateway_id !== envelope.client_id) throw new PermanentMessageError("GATEWAY_CLIENT_MISMATCH");
  const context: TelemetryTransportContext = {
    source: "aws_iot", principalId: envelope.principal, clientId: envelope.client_id,
    topic: envelope.topic, receivedAt: new Date(envelope.received_at_ms), expectedGatewayId: packet.data.gateway_id,
  };
  return { packet: packet.data, context };
}

export function createSqsHandler(dependencies: IngestionDependencies) {
  return async (event: SqsEvent, invocation?: { getRemainingTimeInMillis(): number }): Promise<BatchResult> => {
    const failures: { itemIdentifier: string }[] = [];
    for (let index = 0; index < event.Records.length; index++) {
      const record = event.Records[index];
      if (index >= 10 || (invocation && invocation.getRemainingTimeInMillis() < 3000)) {
        failures.push({ itemIdentifier: record.messageId }); continue;
      }
      try {
        const { packet, context } = decodeIotEnvelope(record, dependencies.queueArn);
        await dependencies.processPacket(packet, context);
      } catch (error) {
        if (!(error instanceof PermanentMessageError)) { failures.push({ itemIdentifier: record.messageId }); continue; }
        try {
          const bytes = Buffer.from(record.body);
          // Leave room for UTF-8 replacement at a truncation boundary while
          // retaining a hash of the complete original envelope.
          const rawBody = bytes.subarray(0, 65_530).toString("utf8");
          await dependencies.quarantine({
            messageId: record.messageId, bodyHash: createHash("sha256").update(bytes).digest("hex"), reason: error.reason,
            rawBody,
            receiptContext: { source: "sqs", eventSourceARN: record.eventSourceARN.slice(0, 512), rawBodyTruncated: bytes.length > 65_530 },
          });
        } catch { failures.push({ itemIdentifier: record.messageId }); }
      }
    }
    return { batchItemFailures: failures };
  };
}
