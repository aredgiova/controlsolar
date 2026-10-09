import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { createSqsHandler, decodeIotEnvelope, PermanentMessageError, type QuarantineInput, type SqsRecord } from "../src/ingestion/sqs";
const queueArn = "arn:aws:sqs:us-east-1:123456789012:solar-telemetry";
const gateway = "dc379717-7120-4db8-aa1a-2f929cb8ccde";
const principal = "a".repeat(64);
const sample = { schema_version: "2.0", event_id: randomUUID(), device_id: randomUUID(), measurement_point_id: randomUUID(), configuration_version: 1, measured_at: "2026-10-09T12:00:00Z", values: { active_power: 2, import_energy: 100, export_energy: 2 }, units: { active_power: "kW", import_energy: "kWh", export_energy: "kWh" }, quality: "measured" };
const packet = { schema_version: "2.0", gateway_id: gateway, packet_id: randomUUID(), sent_at: sample.measured_at, samples: [sample], loss_reports: [] };
function envelope(payload: unknown = packet) { return { source: "aws_iot", principal, client_id: gateway, topic: `solar/v2/gateways/${gateway}/telemetry`, received_at_ms: Date.parse("2026-10-09T12:00:05Z"), payload_base64: Buffer.from(JSON.stringify(payload)).toString("base64") }; }
function record(body: unknown = envelope()): SqsRecord { return { messageId: randomUUID(), body: typeof body === "string" ? body : JSON.stringify(body), eventSource: "aws:sqs", eventSourceARN: queueArn }; }

test("trusted identity and reception time originate only in the IoT envelope", () => {
  const decoded = decodeIotEnvelope(record(), queueArn); assert.deepEqual(decoded.packet, packet);
  assert.equal(decoded.context.principalId, principal); assert.equal(decoded.context.clientId, gateway);
  assert.equal(decodeIotEnvelope(record({ ...envelope(), principal: principal.toUpperCase() }), queueArn).context.principalId, principal);
  assert.equal(new Date(decoded.context.receivedAt).toISOString(), "2026-10-09T12:00:05.000Z");
  for (const injected of [{ source: "simulator" }, { received_at: sample.measured_at }, { principalId: "forged" }, { organization_id: randomUUID() }]) assert.throws(() => decodeIotEnvelope(record(envelope({ ...packet, ...injected })), queueArn), PermanentMessageError);
});
test("decoder rejects other sources/queues, client/topic mismatch, forged gateway and noncanonical base64", () => {
  const valid = record();
  for (const invalid of [{ ...valid, eventSource: "aws:http" }, { ...valid, eventSourceARN: `${queueArn}-other` }, record({ ...envelope(), topic: `solar/v2/gateways/${randomUUID()}/telemetry` }), record(envelope({ ...packet, gateway_id: randomUUID() })), record({ ...envelope(), principal: "arn:aws:iot:certificate/fake" }), record({ ...envelope(), payload_base64: `${envelope().payload_base64}\n` }), record({ ...envelope(), payload_base64: "////" }), record({ ...envelope(), injected: true })]) assert.throws(() => decodeIotEnvelope(invalid, queueArn), PermanentMessageError);
});
test("partial batch ACKs good data, retries transient failure and ACKs permanent failure only after durable quarantine", async () => {
  const good = record(); const transient = record(); const malformed = record("not-json"); const seen: string[] = []; const quarantine: QuarantineInput[] = [];
  const handler = createSqsHandler({ queueArn, processPacket: async () => { seen.push("packet"); if (seen.length === 2) throw new Error("database offline"); }, quarantine: async (input) => { quarantine.push(input); } });
  assert.deepEqual(await handler({ Records: [good, transient, malformed] }), { batchItemFailures: [{ itemIdentifier: transient.messageId }] });
  assert.equal(quarantine.length, 1); assert.equal(quarantine[0].reason, "INVALID_ENVELOPE_JSON");
  assert.equal(quarantine[0].bodyHash, createHash("sha256").update(malformed.body).digest("hex"));
  assert.deepEqual(await createSqsHandler({ queueArn, processPacket: async () => {}, quarantine: async () => { throw new Error("durability unavailable"); } })({ Records: [malformed] }), { batchItemFailures: [{ itemIdentifier: malformed.messageId }] });
});
test("oversized UTF-8 quarantine stays within storage bounds and retains a complete-body hash", async () => {
  const oversized = record("🙂".repeat(30000)); let quarantined: QuarantineInput | undefined;
  const result = await createSqsHandler({ queueArn, processPacket: async () => assert.fail("invalid message processed"), quarantine: async (input) => { quarantined = input; } })({ Records: [oversized] });
  assert.deepEqual(result.batchItemFailures, []); assert.ok(quarantined); assert.ok(Buffer.byteLength(quarantined.rawBody) <= 65536);
  assert.equal(quarantined.receiptContext.rawBodyTruncated, true); assert.equal(quarantined.bodyHash, createHash("sha256").update(oversized.body).digest("hex"));
});
test("bounded batches and remaining-time reserve retry untouched records", async () => {
  let processed = 0; const records = Array.from({ length: 12 }, () => record());
  const handler = createSqsHandler({ queueArn, processPacket: async () => { processed++; }, quarantine: async () => {} });
  const result = await handler({ Records: records }); assert.equal(processed, 10); assert.deepEqual(result.batchItemFailures.map((failure) => failure.itemIdentifier), records.slice(10).map((entry) => entry.messageId));
  processed = 0; const expired = await handler({ Records: records.slice(0, 2) }, { getRemainingTimeInMillis: () => 2000 }); assert.equal(processed, 0); assert.equal(expired.batchItemFailures.length, 2);
});
