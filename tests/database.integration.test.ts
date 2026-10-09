import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const environmentFile = process.env.SOLAR_DATABASE_TEST_ENV;
const integrationRequested = Boolean(environmentFile || process.env.TEST_ADMIN_DATABASE_URL || process.env.TEST_RUNTIME_DATABASE_URL || process.env.TEST_AUTH_DATABASE_URL);
const hash = () => randomBytes(32).toString("hex");
type DatabaseEnvironment = { admin: string; runtime: string; auth: string; migration?: string };

test("PostgreSQL real: roles, aislamiento, permisos, invitaciones e históricos", { skip: !integrationRequested }, async (t) => {
  const env: DatabaseEnvironment = environmentFile ? JSON.parse(await readFile(environmentFile, "utf8")) as DatabaseEnvironment : {
    admin: process.env.TEST_ADMIN_DATABASE_URL!, runtime: process.env.TEST_RUNTIME_DATABASE_URL!, auth: process.env.TEST_AUTH_DATABASE_URL!,
  };
  assert.ok(env.admin && env.runtime && env.auth, "La integración requiere tres conexiones de prueba separadas.");
  const admin = new pg.Client({ connectionString: env.admin });
  const runtime = new pg.Client({ connectionString: env.runtime });
  const auth = new pg.Client({ connectionString: env.auth });
  await Promise.all([admin.connect(), runtime.connect(), auth.connect()]);
  const id = Object.fromEntries(["orgA", "orgB", "ownerA", "adminA", "techA", "customerA", "ownerB", "outsider", "disabled", "invitee", "customerRecordA", "customerRecordB", "projectA", "projectA2", "projectB", "pointA", "pointA2", "pointB", "deviceA", "replacement", "deviceB", "bindingA", "bindingB"].map((key) => [key, randomUUID()]));
  const users = ["ownerA", "adminA", "techA", "customerA", "ownerB", "outsider", "disabled", "invitee"];
  const email = (key: string) => `${id[key]}@example.test`;
  const start = "2026-01-01T00:00:00Z";
  async function scope<T>(user: string | null, org: string | null, action: () => Promise<T>): Promise<T> {
    await runtime.query("BEGIN");
    try {
      await runtime.query("SELECT set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true)", [user ?? "", org ?? ""]);
      return await action();
    } finally { await runtime.query("ROLLBACK"); }
  }
  const deny = (action: () => Promise<unknown>, code = "42501") => assert.rejects(action, (error: unknown) => (error as { code?: string }).code === code);
  try {
    for (const key of users) await admin.query("INSERT INTO users(id,cognito_subject,email,email_verified,updated_at) VALUES($1,$2,$3,true,now())", [id[key], `sql-test|${id[key]}`, email(key)]);
    for (const org of ["orgA", "orgB"]) await admin.query("INSERT INTO organizations(id,name,slug,updated_at) VALUES($1,$2,$3,now())", [id[org], org, id[org]]);
    for (const [user, org, role] of [["ownerA", "orgA", "owner"], ["adminA", "orgA", "administrator"], ["techA", "orgA", "technician"], ["customerA", "orgA", "customer"], ["disabled", "orgA", "technician"], ["ownerB", "orgB", "owner"]]) {
      await admin.query("INSERT INTO memberships(id,organization_id,user_id,role,status,updated_at) VALUES($1,$2,$3,$4,'active',now())", [randomUUID(), id[org], id[user], role]);
    }
    for (const [customer, org] of [["customerRecordA", "orgA"], ["customerRecordB", "orgB"]]) await admin.query("INSERT INTO customers(id,organization_id,name,updated_at) VALUES($1,$2,'Cliente de prueba',now())", [id[customer], id[org]]);
    for (const [project, org, customer] of [["projectA", "orgA", "customerRecordA"], ["projectA2", "orgA", "customerRecordA"], ["projectB", "orgB", "customerRecordB"]]) {
      await admin.query("INSERT INTO projects(id,organization_id,customer_id,name,location,capacity_kwp,updated_at) VALUES($1,$2,$3,$4,'Prueba local',10,now())", [id[project], id[org], id[customer], project]);
    }
    for (const [user, role, project] of [["techA", "technician", "projectA"], ["customerA", "customer", "projectA"], ["disabled", "technician", "projectA2"]]) await admin.query("INSERT INTO site_access(id,organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4,$5)", [randomUUID(), id.orgA, id[project], id[user], role]);
    await admin.query("UPDATE memberships SET status='disabled' WHERE user_id=$1", [id.disabled]);
    for (const [device, org] of [["deviceA", "orgA"], ["replacement", "orgA"], ["deviceB", "orgB"]]) await admin.query("INSERT INTO devices(id,organization_id,serial,name,kind,updated_at) VALUES($1,$2,$3,$3,'meter',now())", [id[device], id[org], id[device]]);
    for (const [point, org, project] of [["pointA", "orgA", "projectA"], ["pointA2", "orgA", "projectA2"], ["pointB", "orgB", "projectB"]]) await admin.query("INSERT INTO measurement_points(id,organization_id,project_id,name,kind,sign_convention) VALUES($1,$2,$3,$4,'generation','positive_generation')", [id[point], id[org], id[project], point]);
    for (const [binding, org, project, device, point] of [["bindingA", "orgA", "projectA", "deviceA", "pointA"], ["bindingB", "orgB", "projectB", "deviceB", "pointB"]]) {
      await admin.query("INSERT INTO device_bindings(id,organization_id,project_id,device_id,measurement_point_id,valid_from) VALUES($1,$2,$3,$4,$5,$6)", [id[binding], id[org], id[project], id[device], id[point], start]);
      await admin.query("INSERT INTO telemetry_samples(event_id,organization_id,binding_id,device_id,measurement_point_id,configuration_version,measured_at,received_at,active_power,quality) VALUES($1,$2,$3,$4,$5,1,'2026-01-02',now(),2.5,'measured')", [randomUUID(), id[org], id[binding], id[device], id[point]]);
    }

    await t.test("credenciales efectivas no tienen bypass, ownership ni acceso directo a sesiones", async () => {
      for (const [client, expected] of [[runtime, "solar_runtime"], [auth, "solar_auth"]] as const) {
        const { rows: [role] } = await client.query("SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
        assert.equal(role.name, expected); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
        await deny(() => client.query("SELECT * FROM sessions"));
        await deny(() => client.query("SET ROLE solar_security_guard"));
      }
      await deny(() => auth.query("SELECT * FROM users"));
      await deny(() => runtime.query("SELECT public.auth_resolve_session($1)", [hash()]));
      const { rows: [owned] } = await runtime.query("SELECT count(*)::int AS total FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=current_user AND c.relkind IN ('r','p')");
      assert.equal(owned.total, 0);
    });
    await t.test("empresa A no lee ni cambia empresa B por identificador, SQL o exportación", async () => {
      await scope(id.ownerA, id.orgA, async () => {
        assert.equal((await runtime.query("SELECT * FROM projects")).rowCount, 2);
        assert.equal((await runtime.query("SELECT * FROM projects WHERE id=$1", [id.projectB])).rowCount, 0);
        assert.equal((await runtime.query("UPDATE projects SET name='Prohibido' WHERE id=$1", [id.projectB])).rowCount, 0);
        assert.equal((await runtime.query("SELECT * FROM telemetry_samples")).rowCount, 1);
        const exported = await runtime.query("COPY (SELECT * FROM projects) TO STDOUT WITH CSV");
        assert.equal(exported.command, "COPY");
      });
      await deny(() => scope(id.ownerA, id.orgA, () => runtime.query("INSERT INTO customers(id,organization_id,name,updated_at) VALUES($1,$2,'Prohibido',now())", [randomUUID(), id.orgB])));
      await scope(id.ownerA, id.orgB, async () => assert.equal((await runtime.query("SELECT * FROM projects")).rowCount, 0));
      await scope(null, null, async () => assert.equal((await runtime.query("SELECT * FROM projects")).rowCount, 0));
    });
    await t.test("técnico y cliente solo ven sitios asignados; revocación bloquea también SQL", async () => {
      for (const user of [id.techA, id.customerA]) await scope(user, id.orgA, async () => {
        assert.deepEqual((await runtime.query("SELECT id FROM projects")).rows.map((row) => row.id), [id.projectA]);
        assert.equal((await runtime.query("SELECT * FROM telemetry_samples")).rowCount, 1);
        assert.equal((await runtime.query("UPDATE measurement_points SET name='No autorizado' WHERE id=$1", [id.pointA2])).rowCount, 0);
      });
      await scope(id.customerA, id.orgA, async () => assert.equal((await runtime.query("UPDATE measurement_points SET name='Prohibido' WHERE id=$1", [id.pointA])).rowCount, 0));
      await scope(id.techA, id.orgA, async () => assert.equal((await runtime.query("UPDATE measurement_points SET name='Nombre autorizado' WHERE id=$1", [id.pointA])).rowCount, 1));
      for (const user of [id.outsider, id.disabled]) await scope(user, id.orgA, async () => {
        for (const table of ["projects", "measurement_points", "memberships", "site_access", "telemetry_samples"]) assert.equal((await runtime.query(`SELECT * FROM ${table}`)).rowCount, 0);
      });
      await deny(() => scope(id.techA, id.orgA, () => runtime.query("INSERT INTO customers(id,organization_id,name,updated_at) VALUES($1,$2,'Prohibido',now())", [randomUUID(), id.orgA])));
    });
    await t.test("FK compuestas y restricciones temporales impiden equipos ajenos y solapamiento", async () => {
      await deny(() => scope(id.ownerA, id.orgA, () => runtime.query("INSERT INTO device_bindings(id,organization_id,project_id,device_id,measurement_point_id,configuration_version,valid_from) VALUES($1,$2,$3,$4,$5,2,now())", [randomUUID(), id.orgA, id.projectA2, id.deviceB, id.pointA2])), "23503");
      await deny(() => scope(id.ownerA, id.orgA, () => runtime.query("INSERT INTO device_bindings(id,organization_id,project_id,device_id,measurement_point_id,configuration_version,valid_from) VALUES($1,$2,$3,$4,$5,2,now())", [randomUUID(), id.orgA, id.projectA, id.replacement, id.pointA])), "23P01");
      await deny(() => scope(id.ownerA, id.orgA, () => runtime.query("UPDATE device_bindings SET valid_to='2026-01-02' WHERE id=$1", [id.bindingA])), "23514");
      await scope(id.ownerA, id.orgA, async () => {
        await runtime.query("UPDATE device_bindings SET valid_to='2026-01-03' WHERE id=$1", [id.bindingA]);
        await runtime.query("INSERT INTO device_bindings(id,organization_id,project_id,device_id,measurement_point_id,configuration_version,valid_from) VALUES($1,$2,$3,$4,$5,2,'2026-01-03')", [randomUUID(), id.orgA, id.projectA, id.replacement, id.pointA]);
        const { rows: [sample] } = await runtime.query("SELECT device_id,binding_id,configuration_version,active_power FROM telemetry_samples WHERE binding_id=$1", [id.bindingA]);
        assert.equal(sample.device_id, id.deviceA); assert.equal(sample.binding_id, id.bindingA); assert.equal(sample.configuration_version, 1); assert.equal(Number(sample.active_power), 2.5);
      });
      await deny(() => scope(id.ownerA, id.orgA, () => runtime.query("UPDATE measurement_points SET sign_convention='changed' WHERE id=$1", [id.pointA])), "23514");
      await deny(() => scope(id.ownerA, id.orgA, () => runtime.query("UPDATE memberships SET status='disabled' WHERE user_id=$1", [id.ownerA])), "23514");
    });
    await t.test("un administrador no puede forjar invitaciones de propietario ni reescribir un token", async () => {
      await deny(() => scope(id.adminA, id.orgA, () => runtime.query("INSERT INTO invitations(id,organization_id,token_hash,email,role,expires_at,created_by) VALUES($1,$2,$3,$4,'owner',now()+interval '1 day',$5)", [randomUUID(), id.orgA, hash(), email("invitee"), id.ownerA])));
      await deny(() => scope(id.adminA, id.orgA, () => runtime.query("INSERT INTO invitations(id,organization_id,token_hash,email,role,expires_at,created_by) VALUES($1,$2,$3,$4,'owner',now()+interval '1 day',$5)", [randomUUID(), id.orgA, hash(), email("invitee"), id.adminA])));
      const invitation = randomUUID();
      await admin.query("INSERT INTO invitations(id,organization_id,token_hash,email,role,expires_at,created_by) VALUES($1,$2,$3,$4,'customer',now()+interval '1 day',$5)", [invitation, id.orgA, hash(), email("invitee"), id.ownerA]);
      await deny(() => scope(id.adminA, id.orgA, () => runtime.query("UPDATE invitations SET role='owner' WHERE id=$1", [invitation])), "23514");
      await deny(() => scope(id.ownerA, id.orgA, () => runtime.query("UPDATE invitations SET token_hash=$1 WHERE id=$2", [hash(), invitation])), "23514");
    });
    await t.test("aceptación de invitación exige correo verificado, vigencia e impide repetición", async () => {
      const invitation = randomUUID(); const token = hash();
      await admin.query("INSERT INTO invitations(id,organization_id,token_hash,email,role,expires_at,created_by) VALUES($1,$2,$3,$4,'customer',now()+interval '1 day',$5)", [invitation, id.orgA, token, email("invitee"), id.ownerA]);
      await admin.query("INSERT INTO invitation_projects(organization_id,invitation_id,project_id) VALUES($1,$2,$3)", [id.orgA, invitation, id.projectA]);
      await deny(() => scope(id.outsider, null, () => runtime.query("SELECT public.app_accept_invitation($1)", [token])));
      await runtime.query("BEGIN");
      await runtime.query("SELECT set_config('app.user_id',$1,true)", [id.invitee]);
      const { rows: [accepted] } = await runtime.query("SELECT public.app_accept_invitation($1) AS org", [token]);
      await runtime.query("COMMIT"); assert.equal(accepted.org, id.orgA);
      await deny(() => scope(id.invitee, null, () => runtime.query("SELECT public.app_accept_invitation($1)", [token])));
      await scope(id.invitee, id.orgA, async () => assert.equal((await runtime.query("SELECT * FROM projects")).rowCount, 1));
      const expired = hash();
      await admin.query("INSERT INTO invitations(id,organization_id,token_hash,email,role,created_at,expires_at,created_by) VALUES($1,$2,$3,$4,'customer',now()-interval '2 days',now()-interval '1 day',$5)", [randomUUID(), id.orgA, expired, email("outsider"), id.ownerA]);
      await deny(() => scope(id.outsider, null, () => runtime.query("SELECT public.app_accept_invitation($1)", [expired])));
    });
    await t.test("sesiones persistidas y estado OIDC se consumen y revocan atómicamente", async () => {
      const flow = hash();
      await auth.query("SELECT public.auth_register_flow($1,now()+interval '5 minutes')", [flow]);
      assert.equal((await auth.query("SELECT public.auth_consume_flow($1) AS consumed", [flow])).rows[0].consumed, true);
      assert.equal((await auth.query("SELECT public.auth_consume_flow($1) AS consumed", [flow])).rows[0].consumed, false);
      await deny(() => auth.query("SELECT public.auth_register_flow($1,now()+interval '20 minutes')", [hash()]), "22023");
      const token = hash(); const subject = randomUUID();
      const result = await auth.query("SELECT * FROM public.auth_create_session($1,$2,$3,true,'Usuario local',$4,now()+interval '1 hour')", ["https://cognito-idp.us-east-1.amazonaws.com/local-test", subject, `${subject}@example.test`, token]);
      const userId = result.rows[0].user_id; users.push("sessionUser"); id.sessionUser = userId;
      assert.equal((await auth.query("SELECT * FROM public.auth_resolve_session($1)", [token])).rowCount, 1);
      await auth.query("SELECT public.auth_revoke_session($1)", [token]);
      assert.equal((await auth.query("SELECT * FROM public.auth_resolve_session($1)", [token])).rowCount, 0);
      await deny(() => auth.query("SELECT * FROM public.auth_create_session($1,$2,$3,false,'Usuario',$4,now()+interval '1 hour')", ["https://cognito-idp.us-east-1.amazonaws.com/local-test", randomUUID(), "unverified@example.test", hash()]), "22023");
    });
    await t.test("SET LOCAL no filtra contexto entre usuarios de una conexión reutilizada", async () => {
      await scope(id.ownerA, id.orgA, async () => assert.equal((await runtime.query("SELECT * FROM projects")).rowCount, 2));
      assert.equal((await runtime.query("SELECT * FROM projects")).rowCount, 0);
      await scope(id.ownerB, id.orgB, async () => assert.equal((await runtime.query("SELECT * FROM projects")).rowCount, 1));
      assert.equal((await runtime.query("SELECT * FROM projects")).rowCount, 0);
    });
  } finally {
    await runtime.query("ROLLBACK");
    for (const table of ["telemetry_samples", "invitation_projects", "invitations", "audit_events", "site_access", "device_bindings", "topology_versions", "measurement_points", "devices", "projects", "customers", "memberships"]) await admin.query(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, [[id.orgA, id.orgB]]);
    await admin.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [[id.orgA, id.orgB]]);
    await admin.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users.map((key) => id[key])]);
    await Promise.all([admin.end(), runtime.end(), auth.end()]);
  }
});
