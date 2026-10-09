import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPublicKey, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { commandPlan, deviceSetupTemplate, gatewayFromSetup, newDeviceSetupDirectory, parseDeviceSetup, policyFromSetup, preflightDeviceFiles, writeDevicePackage, type DeviceSetup } from "../src/gateway/onboarding";
import { normalizeCertificateThumbprint } from "../src/modules/telemetry/certificate";

const gatewayId = "dc379717-7120-4db8-aa1a-2f929cb8ccde";
const deviceId = "34597510-36b1-422e-a006-36f83143fb6e";
const pointId = "538c819f-7a6b-4ef5-84cc-837778cab689";
const setup = (): DeviceSetup => parseDeviceSetup({
  version: 1, environment: "staging", aws: { accountId: "123456789012", region: "us-east-1", endpointType: "iot:Data-ATS", dataEndpoint: "example-ats.iot.us-east-1.amazonaws.com", certificateId: "b".repeat(64) },
  registry: { organizationId: "338c819f-7a6b-4ef5-84cc-837778cab689", projectId: "638c819f-7a6b-4ef5-84cc-837778cab689", gatewayId, gatewayDeviceId: "438c819f-7a6b-4ef5-84cc-837778cab689", source: "aws_iot", status: "active", principalId: "a".repeat(64), meterDeviceIds: [deviceId], bindings: [{ deviceId, measurementPointId: pointId, configurationVersion: 1, validFrom: "2026-01-01T00:00:00Z", validTo: null }] },
  gateway: { certificatePath: resolve(".work/test-device.pem"), privateKeyPath: resolve(".work/test-key.pem"), caPath: resolve(".work/test-ca.pem"), bufferPath: resolve(".work/test-buffer.sqlite"), csrPath: resolve(".work/test.csr"), pollIntervalMs: 10000, maxBufferSamples: 50000, maxBufferBytes: 67108864,
    meters: [{ model: "SDM630MCT-v1.7", deviceId, measurementPointId: pointId, configurationVersion: 1, host: "192.168.1.20", port: 502, unitId: 1, wordOrder: "high-first", powerSign: -1 }] },
});

test("certificate thumbprints normalize Windows uppercase hex and reject ARN, separators or nonhex", () => {
  assert.equal(normalizeCertificateThumbprint("AB".repeat(32)), "ab".repeat(32));
  for (const invalid of ["arn:aws:iot:us-east-1:123456789012:cert/abc", "AA:".repeat(32), "g".repeat(64), "a".repeat(63)]) assert.throws(() => normalizeCertificateThumbprint(invalid));
  const input = setup(); input.registry.principalId = "AB".repeat(32); assert.equal(parseDeviceSetup(input).registry.principalId, "ab".repeat(32));
});

test("device setup binds the registered identity, meter assignment and regional ATS endpoint", () => {
  const input = setup(); const gateway = gatewayFromSetup(input);
  assert.equal(gateway.gatewayId, gatewayId); assert.equal(gateway.clientId, gatewayId);
  assert.equal(gateway.topic, `solar/v2/gateways/${gatewayId}/telemetry`); assert.equal(gateway.meters[0].powerSign, -1);
  assert.equal("csrPath" in gateway, false);
  assert.throws(() => parseDeviceSetup(deviceSetupTemplate), /Configuración de incorporación inválida/);
  for (const mutate of [
    (value: DeviceSetup) => { value.aws.region = "eu-west-1"; },
    (value: DeviceSetup) => { value.registry.gatewayId = value.registry.gatewayDeviceId; },
    (value: DeviceSetup) => { value.registry.meterDeviceIds = []; },
    (value: DeviceSetup) => { value.registry.bindings[0].configurationVersion = 2; },
    (value: DeviceSetup) => { value.registry.bindings[0].validTo = "2026-10-01T00:00:00Z"; },
    (value: DeviceSetup) => { value.registry.bindings[0].validFrom = "2099-01-01T00:00:00Z"; },
    (value: DeviceSetup) => { value.gateway.meters = [value.gateway.meters[0], value.gateway.meters[0]]; },
    (value: DeviceSetup) => { value.gateway.privateKeyPath = value.gateway.certificatePath; },
    (value: DeviceSetup) => { value.gateway.meters[0].host = "tcp://192.168.1.20:502"; },
    (value: DeviceSetup) => { value.gateway.meters[0].host = "example.com\nlocalhost"; },
  ]) { const value = setup(); mutate(value); assert.throws(() => parseDeviceSetup(value)); }
  assert.throws(() => parseDeviceSetup({ ...input, extra: "PRIVATE_INPUT_MUST_NOT_APPEAR" }), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE_INPUT_MUST_NOT_APPEAR"));
});

test("IoT policy permits only exact Connect/Publish resources for the attached Thing", () => {
  const policy = policyFromSetup(setup());
  assert.deepEqual(policy.Statement.map((statement) => statement.Action), ["iot:Connect", "iot:Publish"]);
  assert.equal(policy.Statement[0].Resource, `arn:aws:iot:us-east-1:123456789012:client/${gatewayId}`);
  assert.equal(policy.Statement[1].Resource, `arn:aws:iot:us-east-1:123456789012:topic/solar/v2/gateways/${gatewayId}/telemetry`);
  for (const statement of policy.Statement) { assert.equal(statement.Resource.includes("*"), false); assert.equal(statement.Condition.Bool["iot:Connection.Thing.IsAttached"], "true"); }
});

test("review plan separates AWS certificate ID from thumbprint and never generates or outputs a private key", () => {
  const input = setup(); const plan = commandPlan(input, resolve(".work/compiled"));
  const commands = [...plan.bootstrapReference, ...plan.review, ...plan.provision, ...plan.revoke];
  assert.equal(plan.execution, "manual_review_only");
  const bootstrap = plan.bootstrapReference[0].argv;
  assert.ok(bootstrap.includes("create-certificate-from-csr")); assert.ok(bootstrap.includes("--no-set-as-active"));
  assert.equal(JSON.stringify(plan).includes("create-keys-and-certificate"), false);
  assert.equal(JSON.stringify(plan).includes("--private-key-outfile"), false);
  assert.equal(JSON.stringify(plan).includes(input.registry.principalId), false);
  assert.ok(plan.provision.find((entry) => entry.id === "attach-thing")!.argv.includes("EXCLUSIVE_THING"));
  assert.ok(commands.every((entry) => entry.executable === "aws" && entry.argv.includes("--region") && !entry.argv.includes("--no-verify-ssl")));
  assert.ok(plan.revoke.find((entry) => entry.id === "inactivate")!.argv.includes("INACTIVE"));
  assert.ok(plan.revoke.find((entry) => entry.id === "disconnect")!.argv.includes(`https://${input.aws.dataEndpoint}`));
  input.aws.certificateId = null; assert.equal(commandPlan(input, "/private").certificateIdKnown, false);
});

test("offline package is immutable, private, hashes all artifacts and contains no key material", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "solar-device-package-"));
  try {
    const result = await writeDevicePackage(setup(), "pilot", { cwd });
    assert.equal(result.manifest.state, "prepared_offline"); assert.equal(result.manifest.preflight.registryVerified, false);
    for (const file of result.manifest.files) {
      const content = await readFile(join(result.target, file.file));
      assert.equal(createHash("sha256").update(content).digest("hex"), file.sha256);
      assert.equal(content.toString().includes("-----BEGIN PRIVATE KEY-----"), false);
      if (process.platform !== "win32") assert.equal((await lstat(join(result.target, file.file))).mode & 0o077, 0);
    }
    await assert.rejects(writeDevicePackage(setup(), "pilot", { cwd }), { code: "EEXIST" });
    await assert.rejects(newDeviceSetupDirectory("../public", cwd));
    await assert.rejects(newDeviceSetupDirectory("nested/path", cwd));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("private output rejects a symlink or Windows junction replacing .work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "solar-device-link-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "solar-device-target-"));
  try { await symlink(elsewhere, join(cwd, ".work"), process.platform === "win32" ? "junction" : "dir"); await assert.rejects(newDeviceSetupDirectory("pilot", cwd), /enlaces/); }
  finally { await rm(cwd, { recursive: true, force: true }); await rm(elsewhere, { recursive: true, force: true }); }
});

// Generate anonymous, short-lived test certificates in memory. This is never used by the setup CLI.
function testCertificate(ca: boolean, expired = false) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tlv = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts); let length: Buffer;
    if (body.length < 128) length = Buffer.from([body.length]);
    else if (body.length < 256) length = Buffer.from([0x81, body.length]);
    else length = Buffer.from([0x82, body.length >> 8, body.length & 255]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  const algorithm = tlv(0x30, Buffer.from("06092a864886f70d01010b0500", "hex"));
  const name = tlv(0x30, tlv(0x31, tlv(0x30, Buffer.from("0603550403", "hex"), tlv(0x0c, Buffer.from("solar-anonymous-test")))));
  const validity = tlv(0x30, tlv(0x17, Buffer.from("200101000000Z")), tlv(0x17, Buffer.from(expired ? "210101000000Z" : "350101000000Z")));
  const extensions = ca ? tlv(0xa3, tlv(0x30, tlv(0x30, Buffer.from("0603551d130101ff", "hex"), tlv(0x04, tlv(0x30, Buffer.from("0101ff", "hex")))))) : Buffer.alloc(0);
  const body = tlv(0x30, tlv(0xa0, Buffer.from("020102", "hex")), Buffer.from("020101", "hex"), algorithm, name, validity, name, createPublicKey(privateKey).export({ format: "der", type: "spki" }), extensions);
  const der = tlv(0x30, body, algorithm, tlv(0x03, Buffer.from([0]), sign("sha256", body, privateKey)));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { pem, key: privateKey.export({ format: "pem", type: "pkcs8" }), fingerprint: createHash("sha256").update(new X509Certificate(pem).raw).digest("hex") };
}

test("local preflight verifies DER SHA256, certificate/key pair and CA validity without copying credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "solar-device-certificate-")); const input = setup();
  const leaf = testCertificate(false); const ca = testCertificate(true);
  input.gateway.certificatePath = join(directory, "client.pem"); input.gateway.privateKeyPath = join(directory, "client.key"); input.gateway.caPath = join(directory, "ca.pem"); input.registry.principalId = leaf.fingerprint;
  try {
    await writeFile(input.gateway.certificatePath, leaf.pem); await writeFile(input.gateway.privateKeyPath, leaf.key, { mode: 0o600 }); await writeFile(input.gateway.caPath, ca.pem);
    const result = await preflightDeviceFiles(input, new Date("2026-10-09T12:00:00Z"));
    assert.equal(result.status, "local_files_verified"); assert.equal(result.principalId, leaf.fingerprint); assert.equal(result.networkVerified, false); assert.equal(result.registryVerified, false);
    assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
    const wrongPrincipal = { ...input, registry: { ...input.registry, principalId: "f".repeat(64) } }; await assert.rejects(preflightDeviceFiles(wrongPrincipal), /Preflight local fallido/);
    await writeFile(input.gateway.privateKeyPath, ca.key); await assert.rejects(preflightDeviceFiles(input), /Preflight local fallido/);
    await writeFile(input.gateway.privateKeyPath, leaf.key);
    if (process.platform !== "win32") { await chmod(input.gateway.privateKeyPath, 0o644); await assert.rejects(preflightDeviceFiles(input), /Preflight local fallido/); await chmod(input.gateway.privateKeyPath, 0o600); }
    const expired = testCertificate(false, true); await writeFile(input.gateway.certificatePath, expired.pem); input.registry.principalId = expired.fingerprint; await writeFile(input.gateway.privateKeyPath, expired.key); await assert.rejects(preflightDeviceFiles(input), /Preflight local fallido/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI creates an incomplete template locally, rejects overwrite and never echoes malformed input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "solar-device-cli-"));
  const cli = resolve("scripts/prepare-device.ts"); const tsx = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd, encoding: "utf8", windowsHide: true });
  try {
    const first = run("--template", "--output", "pilot"); assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).readyToConnect, false);
    assert.equal(run("--template", "--output", "pilot").status, 1);
    await mkdir(join(cwd, "config")); const malformed = join(cwd, "config", "bad.json"); await writeFile(malformed, '{"secret":"DO_NOT_ECHO_PRIVATE_TEXT"');
    const bad = run("--config", malformed, "--output", "bad"); assert.equal(bad.status, 1); assert.equal(`${bad.stdout}${bad.stderr}`.includes("DO_NOT_ECHO_PRIVATE_TEXT"), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
