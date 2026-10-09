import assert from "node:assert/strict";
import test from "node:test";
import { bindingSchema, commissioningSchema, csvCell, customerCreateSchema, deviceCreateSchema, invitationAcceptSchema, invitationCreateSchema, listQuerySchema, pointCreateSchema, projectCreateSchema, projectUpdateSchema, topologySchema } from "../src/contracts/management";

const id = "f0bf609c-cd5c-4712-9f4c-dea943e81b00";
const secondId = "21a2d2be-43fe-49e7-8b3f-f83c6ef10377";
test("management inputs reject tenant/role injection and unknown fields instead of assigning them", () => {
  assert.equal(customerCreateSchema.safeParse({ name: "Cliente", organizationId: id }).success, false);
  assert.equal(projectCreateSchema.safeParse({ customerId: id, name: "Solar", location: "Yopal", capacityKwp: 6, role: "owner" }).success, false);
  assert.equal(deviceCreateSchema.safeParse({ name: "Medidor", serialNumber: "0001", kind: "meter", status: "active", organizationId: id }).success, false);
  assert.equal(projectUpdateSchema.safeParse({}).success, false);
});
test("project contract validates physical coordinates, power, timezone, and initial topology", () => {
  const valid = { customerId: id, name: "Solar", location: "Yopal", capacityKwp: 6 };
  assert.equal(projectCreateSchema.parse(valid).timezone, "America/Bogota");
  assert.equal(projectCreateSchema.safeParse({ ...valid, latitude: 5 }).success, false);
  assert.equal(projectCreateSchema.safeParse({ ...valid, latitude: 5, longitude: -72 }).success, true);
  assert.equal(projectCreateSchema.safeParse({ ...valid, capacityKwp: 0 }).success, false);
  assert.equal(projectCreateSchema.safeParse({ ...valid, timezone: "Bogota" }).success, false);
  assert.equal(projectCreateSchema.safeParse({ ...valid, topologyType: "hybrid_battery" }).success, false);
});
test("point and topology contracts preserve generation, consumption and grid meanings", () => {
  assert.equal(pointCreateSchema.safeParse({ name: "Red", kind: "grid", signConvention: "positive_generation" }).success, false);
  assert.equal(pointCreateSchema.safeParse({ name: "Red", kind: "grid", signConvention: "positive_import" }).success, true);
  const topology = { validFrom: "2026-10-09T12:00:00Z", configuration: { type: "grid_tied_no_battery", generationPointId: id, gridPointId: secondId, consumptionPointId: null } };
  assert.equal(topologySchema.safeParse(topology).success, true);
  assert.equal(topologySchema.safeParse({ ...topology, configuration: { ...topology.configuration, gridPointId: id } }).success, false);
  assert.equal(bindingSchema.safeParse({ deviceId: id, measurementPointId: secondId, validFrom: "2026-10-09T12:00:00", configuration: { channel: "1", multiplier: 1 } }).success, false);
  assert.equal(bindingSchema.safeParse({ deviceId: id, measurementPointId: secondId, validFrom: "2026-10-09T12:00:00Z", configuration: { channel: "1", multiplier: -1 } }).success, false);
  assert.equal(commissioningSchema.safeParse({ commissionedAt: "2026-10-09T12:00:00Z", notes: "Equipo y polaridad verificados." }).success, true);
});
test("invitations restrict scope and enforce opaque token syntax", () => {
  assert.equal(invitationCreateSchema.safeParse({ email: "owner@example.test", role: "owner", projectIds: [id] }).success, false);
  assert.equal(invitationCreateSchema.safeParse({ email: "client@example.test", role: "customer", projectIds: [id] }).success, true);
  assert.equal(invitationAcceptSchema.safeParse({ token: id }).success, false);
  assert.equal(invitationAcceptSchema.safeParse({ token: "a".repeat(64), email: "spoof@example.test" }).success, false);
});
test("pagination is bounded and CSV cannot execute spreadsheet formulas", () => {
  assert.equal(listQuerySchema.safeParse({ pageSize: 101 }).success, false);
  assert.equal(listQuerySchema.safeParse({ page: -1 }).success, false);
  assert.equal(listQuerySchema.safeParse({ search: "", organizationId: id }).success, false);
  for (const payload of ["=HYPERLINK(\"https://bad.example\")", "+SUM(1,2)", "-1+1", "@SUM(1,2)", "\t=1+1", "\n+CMD()"] ) assert.ok(csvCell(payload).startsWith('"\''));
  assert.equal(csvCell('Solar "A"'), '"Solar ""A"""');
});
