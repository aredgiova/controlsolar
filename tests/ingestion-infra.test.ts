import assert from "node:assert/strict";
import test from "node:test";
import template from "../infra/ingestion.json";

function walk(value: unknown, visit: (object: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item) => walk(item, visit)); return; }
  visit(value as Record<string, unknown>);
  Object.values(value).forEach((item) => walk(item, visit));
}
test("CloudFormation references exist and its resource dependency graph is acyclic", () => {
  const resources = new Set(Object.keys(template.Resources)); const parameters = new Set(Object.keys(template.Parameters));
  const graph = new Map<string, Set<string>>();
  const check = (name: string) => assert.ok(resources.has(name) || parameters.has(name) || name.startsWith("AWS::"), `Unknown reference: ${name}`);
  walk(template, (object) => {
    if (typeof object.Ref === "string") check(object.Ref);
    if (Array.isArray(object["Fn::GetAtt"])) check(String(object["Fn::GetAtt"][0]));
    if (typeof object["Fn::Sub"] === "string") for (const match of object["Fn::Sub"].matchAll(/\$\{([^}]+)\}/g)) check(match[1].split(".")[0]);
  });
  for (const [name, definition] of Object.entries(template.Resources)) {
    const dependencies = new Set<string>();
    walk(definition, (object) => {
      if (typeof object.Ref === "string" && resources.has(object.Ref)) dependencies.add(object.Ref);
      if (Array.isArray(object["Fn::GetAtt"])) dependencies.add(String(object["Fn::GetAtt"][0]));
      if (typeof object["Fn::Sub"] === "string") for (const match of object["Fn::Sub"].matchAll(/\$\{([^}]+)\}/g)) if (resources.has(match[1].split(".")[0])) dependencies.add(match[1].split(".")[0]);
      if (typeof object.DependsOn === "string") dependencies.add(object.DependsOn);
      if (Array.isArray(object.DependsOn)) object.DependsOn.forEach((dependency) => dependencies.add(String(dependency)));
    });
    graph.set(name, dependencies);
  }
  const visited = new Set<string>(); const visiting = new Set<string>();
  function dfs(name: string) { if (visited.has(name)) return; assert.ok(!visiting.has(name), `Dependency cycle at ${name}`); visiting.add(name); graph.get(name)?.forEach(dfs); visiting.delete(name); visited.add(name); }
  resources.forEach(dfs);
});

test("IoT rule envelopes trusted broker functions and queue denies alternative producers", () => {
  const rule = template.Resources.TelemetryRule.Properties.TopicRulePayload;
  assert.ok(!/SELECT\s+\*/i.test(rule.Sql));
  for (const fragment of ["principal() AS principal", "clientid() AS client_id", "topic() AS topic", "timestamp() AS received_at_ms", "encode(*, 'base64') AS payload_base64"]) assert.ok(rule.Sql.includes(fragment));
  assert.equal(rule.Actions[0].Sqs.UseBase64, false); assert.ok(rule.ErrorAction.S3);
  const deny = template.Resources.QueuePolicy.Properties.PolicyDocument.Statement.find((entry) => entry.Action === "sqs:SendMessage");
  assert.equal(deny?.Effect, "Deny"); assert.deepEqual(deny?.Condition.ArnNotEquals, { "aws:PrincipalArn": { "Fn::GetAtt": ["IotRuleRole", "Arn"] } });
  const gateway = template.Resources.GatewayPublishPolicy.Properties.PolicyDocument.Statement;
  assert.deepEqual(gateway.map((entry) => entry.Action), ["iot:Connect", "iot:Publish"]);
  assert.ok(gateway.every((entry) => entry.Condition.Bool["iot:Connection.Thing.IsAttached"] === "true"));
  assert.ok(JSON.stringify(gateway).includes("${iot:Connection.Thing.ThingName}"));
});

test("SQS retry budget, partial failures, restricted secrets and bounded concurrency agree", () => {
  const queue = template.Resources.TelemetryQueue.Properties; const consumer = template.Resources.TelemetryConsumer.Properties; const lambda = template.Resources.IngestionFunction.Properties;
  assert.equal(queue.SqsManagedSseEnabled, true); assert.equal(template.Resources.DeadLetterQueue.Properties.SqsManagedSseEnabled, true);
  assert.ok(queue.VisibilityTimeout >= 6 * lambda.Timeout + consumer.MaximumBatchingWindowInSeconds);
  assert.ok(queue.RedrivePolicy.maxReceiveCount >= 5); assert.deepEqual(consumer.FunctionResponseTypes, ["ReportBatchItemFailures"]);
  assert.equal(consumer.BatchSize, 10); assert.equal(lambda.Runtime, "nodejs24.x"); assert.equal(lambda.ReservedConcurrentExecutions, consumer.ScalingConfig.MaximumConcurrency);
  assert.ok(lambda.VpcConfig); assert.deepEqual(Object.keys(lambda.Environment.Variables).sort(), ["INGEST_DATABASE_SECRET_ARN", "INGEST_QUEUE_ARN"]);
  walk(template.Resources.IngestionRole, (object) => {
    if (object.Effect === "Allow" && object.Resource === "*") assert.ok(Array.isArray(object.Action) && object.Action.every((action) => typeof action === "string" && action.startsWith("ec2:")), "Broad resource grant outside required VPC operations");
    if (object.Action === "secretsmanager:GetSecretValue") assert.deepEqual(object.Resource, { Ref: "IngestDatabaseSecretArn" });
  });
  assert.equal(template.Resources.ErrorArchive.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
  assert.equal(template.Resources.ErrorArchive.DeletionPolicy, "Retain"); assert.equal(template.Resources.DeadLetterQueue.DeletionPolicy, "Retain");
});
