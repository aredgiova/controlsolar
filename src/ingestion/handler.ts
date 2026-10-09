import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { processTelemetryPacket } from "../modules/telemetry/processor";
import { quarantineRaw } from "../modules/telemetry/store";
import { createSqsHandler, type SqsEvent } from "./sqs";
import { validateDatabaseConnection } from "../lib/database-configuration";

const secrets = new SecretsManagerClient({});
let secretLoadedAt = 0;
async function configureDatabase() {
  if (Date.now() - secretLoadedAt < 300_000 && process.env.INGEST_DATABASE_URL) return;
  const arn = process.env.INGEST_DATABASE_SECRET_ARN;
  if (!arn || !/^arn:[a-z-]+:secretsmanager:[a-z0-9-]+:\d{12}:secret:/.test(arn)) throw new Error("Ingestion database secret is not configured.");
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!response.SecretString) throw new Error("Missing ingestion database secret.");
  const value = JSON.parse(response.SecretString) as { INGEST_DATABASE_URL?: unknown };
  if (typeof value.INGEST_DATABASE_URL !== "string") throw new Error("Invalid ingestion database secret.");
  validateDatabaseConnection(value.INGEST_DATABASE_URL, "solar_ingest", "production", "INGEST_DATABASE_URL");
  process.env.INGEST_DATABASE_URL = value.INGEST_DATABASE_URL;
  secretLoadedAt = Date.now();
}

export async function handler(event: SqsEvent, context: { getRemainingTimeInMillis(): number }) {
  try {
    await configureDatabase();
    const queueArn = process.env.INGEST_QUEUE_ARN;
    if (!queueArn) throw new Error("Missing ingestion queue.");
    const result = await createSqsHandler({ queueArn, processPacket: processTelemetryPacket, quarantine: quarantineRaw })(event, context);
    console.info(JSON.stringify({ component: "ingestion", records: event.Records.length, retries: result.batchItemFailures.length }));
    return result;
  } catch {
    console.warn(JSON.stringify({ component: "ingestion", status: "initialization_retry", records: event.Records.length }));
    return { batchItemFailures: event.Records.map((record) => ({ itemIdentifier: record.messageId })) };
  }
}
