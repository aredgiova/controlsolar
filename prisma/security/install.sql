-- Run by a database administrator AFTER the baseline migration, in an isolated
-- database. This file deliberately contains no passwords. Provision login secrets
-- outside version control. Migration credentials must never be used by Next.js.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'solar_migrator') THEN
    CREATE ROLE solar_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'solar_runtime') THEN
    CREATE ROLE solar_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'solar_auth') THEN
    CREATE ROLE solar_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'solar_security_guard') THEN
    CREATE ROLE solar_security_guard NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;
ALTER ROLE solar_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE solar_runtime SET timezone = 'UTC';
ALTER ROLE solar_auth SET timezone = 'UTC';
ALTER ROLE solar_migrator SET timezone = 'UTC';
ALTER ROLE solar_auth NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE solar_security_guard NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE solar_security_guard, solar_migrator FROM solar_runtime, solar_auth;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, solar_runtime, solar_auth;
GRANT USAGE ON SCHEMA public TO solar_runtime, solar_auth, solar_security_guard;
GRANT USAGE, CREATE ON SCHEMA public TO solar_migrator;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, solar_runtime, solar_auth;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, solar_runtime, solar_auth;
GRANT SELECT ON users, organizations, memberships, customers, projects, devices,
  measurement_points, device_bindings, topology_versions, site_access,
  invitations, invitation_projects, audit_events, telemetry_samples TO solar_runtime;
GRANT INSERT, UPDATE ON memberships, customers, projects, devices,
  measurement_points, device_bindings, topology_versions, site_access, invitations,
  invitation_projects TO solar_runtime;
GRANT UPDATE ON organizations TO solar_runtime;
GRANT DELETE ON site_access, invitation_projects TO solar_runtime;
GRANT INSERT ON audit_events TO solar_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, auth_flows, organizations,
  memberships, site_access, invitations, invitation_projects, audit_events TO solar_security_guard;
GRANT SELECT ON projects, devices, measurement_points, device_bindings TO solar_security_guard;
-- The migration role owns structure, but is never a runtime role.
ALTER DEFAULT PRIVILEGES FOR ROLE solar_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.app_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION public.app_organization_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT nullif(current_setting('app.organization_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION public.app_role(p_org uuid) RETURNS public."MembershipRole"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.role FROM public.memberships m
  WHERE m.organization_id = p_org AND p_org = public.app_organization_id()
    AND m.user_id = public.app_user_id() AND m.status = 'active'
$$;
CREATE OR REPLACE FUNCTION public.app_is_admin(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(public.app_role(p_org) IN ('owner', 'administrator'), false)
$$;
CREATE OR REPLACE FUNCTION public.app_can_project(p_org uuid, p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_org = public.app_organization_id() AND (
    public.app_is_admin(p_org) OR EXISTS (
      SELECT 1 FROM public.site_access a JOIN public.memberships m
        ON m.organization_id = a.organization_id AND m.user_id = a.user_id
      WHERE a.organization_id = p_org AND a.project_id = p_project
        AND a.user_id = public.app_user_id() AND m.status = 'active'
        AND a.role = m.role AND m.role IN ('technician', 'customer')))
$$;
CREATE OR REPLACE FUNCTION public.app_can_edit_project(p_org uuid, p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(public.app_role(p_org) IN ('owner', 'administrator', 'technician'), false)
    AND public.app_can_project(p_org, p_project)
$$;
CREATE OR REPLACE FUNCTION public.app_can_user(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_user = public.app_user_id() OR (
    public.app_is_admin(public.app_organization_id()) AND EXISTS (
      SELECT 1 FROM public.memberships m WHERE m.organization_id = public.app_organization_id()
        AND m.user_id = p_user))
$$;
CREATE OR REPLACE FUNCTION public.app_can_device(p_org uuid, p_device uuid, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_org = public.app_organization_id() AND (public.app_is_admin(p_org) OR EXISTS (
    SELECT 1 FROM public.device_bindings b WHERE b.organization_id = p_org AND b.device_id = p_device
      AND (NOT p_write OR (b.valid_to IS NULL AND public.app_can_edit_project(p_org, b.project_id)))
      AND public.app_can_project(p_org, b.project_id)))
$$;
ALTER FUNCTION public.app_role(uuid) OWNER TO solar_security_guard;
ALTER FUNCTION public.app_is_admin(uuid) OWNER TO solar_security_guard;
ALTER FUNCTION public.app_can_project(uuid, uuid) OWNER TO solar_security_guard;
ALTER FUNCTION public.app_can_edit_project(uuid, uuid) OWNER TO solar_security_guard;
ALTER FUNCTION public.app_can_user(uuid) OWNER TO solar_security_guard;
ALTER FUNCTION public.app_can_device(uuid, uuid, boolean) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.app_user_id(), public.app_organization_id(), public.app_role(uuid),
  public.app_is_admin(uuid), public.app_can_project(uuid, uuid), public.app_can_edit_project(uuid, uuid),
  public.app_can_user(uuid), public.app_can_device(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_user_id(), public.app_organization_id(), public.app_role(uuid),
  public.app_is_admin(uuid), public.app_can_project(uuid, uuid), public.app_can_edit_project(uuid, uuid),
  public.app_can_user(uuid), public.app_can_device(uuid, uuid, boolean) TO solar_runtime, solar_security_guard;

-- Every persistent table is protected, including identity and the future samples.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','auth_flows','organizations','memberships','customers',
    'projects','devices','measurement_points','device_bindings','topology_versions',
    'site_access','invitations','invitation_projects','audit_events','telemetry_samples']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
CREATE POLICY users_read ON users FOR SELECT TO solar_runtime USING (public.app_can_user(id));
CREATE POLICY organizations_read ON organizations FOR SELECT TO solar_runtime
  USING (id = public.app_organization_id() AND public.app_role(id) IS NOT NULL);
CREATE POLICY organizations_write ON organizations FOR UPDATE TO solar_runtime
  USING (public.app_is_admin(id)) WITH CHECK (public.app_is_admin(id));
CREATE POLICY memberships_read ON memberships FOR SELECT TO solar_runtime
  USING (organization_id = public.app_organization_id() AND public.app_role(organization_id) IS NOT NULL AND
    (user_id = public.app_user_id() OR public.app_is_admin(organization_id)));
CREATE POLICY memberships_insert ON memberships FOR INSERT TO solar_runtime
  WITH CHECK (public.app_is_admin(organization_id) AND
    (role <> 'owner' OR public.app_role(organization_id) = 'owner'));
CREATE POLICY memberships_update ON memberships FOR UPDATE TO solar_runtime
  USING (public.app_is_admin(organization_id) AND
    (role <> 'owner' OR public.app_role(organization_id) = 'owner'))
  WITH CHECK (public.app_is_admin(organization_id) AND
    (role <> 'owner' OR public.app_role(organization_id) = 'owner'));
CREATE POLICY customers_read ON customers FOR SELECT TO solar_runtime
  USING (organization_id = public.app_organization_id() AND (public.app_is_admin(organization_id) OR EXISTS (
    SELECT 1 FROM public.projects p WHERE p.organization_id = customers.organization_id
      AND p.customer_id = customers.id AND public.app_can_project(p.organization_id, p.id))));
CREATE POLICY customers_insert ON customers FOR INSERT TO solar_runtime WITH CHECK (public.app_is_admin(organization_id));
CREATE POLICY customers_update ON customers FOR UPDATE TO solar_runtime USING (public.app_is_admin(organization_id)) WITH CHECK (public.app_is_admin(organization_id));
CREATE POLICY projects_read ON projects FOR SELECT TO solar_runtime USING (public.app_can_project(organization_id, id));
CREATE POLICY projects_insert ON projects FOR INSERT TO solar_runtime WITH CHECK (public.app_is_admin(organization_id));
CREATE POLICY projects_update ON projects FOR UPDATE TO solar_runtime USING (public.app_is_admin(organization_id)) WITH CHECK (public.app_is_admin(organization_id));
CREATE POLICY devices_read ON devices FOR SELECT TO solar_runtime USING (public.app_can_device(organization_id, id, false));
CREATE POLICY devices_insert ON devices FOR INSERT TO solar_runtime WITH CHECK (public.app_is_admin(organization_id));
CREATE POLICY devices_update ON devices FOR UPDATE TO solar_runtime USING (public.app_can_device(organization_id, id, true)) WITH CHECK (public.app_can_device(organization_id, id, true));
CREATE POLICY site_access_read ON site_access FOR SELECT TO solar_runtime USING (
  organization_id = public.app_organization_id() AND public.app_role(organization_id) IS NOT NULL AND (user_id = public.app_user_id() OR public.app_is_admin(organization_id)));
CREATE POLICY site_access_insert ON site_access FOR INSERT TO solar_runtime WITH CHECK (public.app_is_admin(organization_id));
CREATE POLICY site_access_update ON site_access FOR UPDATE TO solar_runtime USING (public.app_is_admin(organization_id)) WITH CHECK (public.app_is_admin(organization_id));
CREATE POLICY site_access_delete ON site_access FOR DELETE TO solar_runtime USING (public.app_is_admin(organization_id));
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['measurement_points','device_bindings','topology_versions'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO solar_runtime USING (public.app_can_project(organization_id, project_id))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO solar_runtime WITH CHECK (public.app_can_edit_project(organization_id, project_id))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO solar_runtime USING (public.app_can_edit_project(organization_id, project_id)) WITH CHECK (public.app_can_edit_project(organization_id, project_id))', t || '_update', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invitations','invitation_projects'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO solar_runtime USING (public.app_is_admin(organization_id))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO solar_runtime WITH CHECK (public.app_is_admin(organization_id))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO solar_runtime USING (public.app_is_admin(organization_id)) WITH CHECK (public.app_is_admin(organization_id))', t || '_update', t);
  END LOOP;
END $$;
CREATE POLICY invitation_projects_delete ON invitation_projects FOR DELETE TO solar_runtime USING (public.app_is_admin(organization_id));
CREATE POLICY audit_read ON audit_events FOR SELECT TO solar_runtime USING (public.app_is_admin(organization_id));
CREATE POLICY audit_append ON audit_events FOR INSERT TO solar_runtime WITH CHECK (
  organization_id = public.app_organization_id() AND actor_id = public.app_user_id()
  AND public.app_role(organization_id) IS NOT NULL);
CREATE POLICY telemetry_read ON telemetry_samples FOR SELECT TO solar_runtime USING (
  organization_id = public.app_organization_id() AND EXISTS (
    SELECT 1 FROM public.device_bindings b WHERE b.organization_id = telemetry_samples.organization_id
      AND b.id = telemetry_samples.binding_id AND public.app_can_project(b.organization_id, b.project_id)));
-- No runtime write policy or grants for telemetry; ingestion belongs to milestone 4.
COMMIT;

BEGIN;
GRANT SELECT ON telemetry_samples, topology_versions TO solar_security_guard;
CREATE OR REPLACE FUNCTION public.app_preserve_binding_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.project_id, NEW.device_id, NEW.measurement_point_id,
      NEW.configuration_version, NEW.valid_from, NEW.configuration, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.project_id, OLD.device_id, OLD.measurement_point_id,
      OLD.configuration_version, OLD.valid_from, OLD.configuration, OLD.created_at)
    OR OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL THEN
    RAISE EXCEPTION 'Las asignaciones históricas son inmutables; solo puede cerrarse una asignación activa.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT FROM public.telemetry_samples s WHERE s.organization_id = OLD.organization_id
    AND s.binding_id = OLD.id AND s.measured_at >= NEW.valid_to) THEN
    RAISE EXCEPTION 'La sustitución no puede dejar muestras fuera del intervalo original.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_binding_history BEFORE UPDATE ON device_bindings
  FOR EACH ROW EXECUTE FUNCTION public.app_preserve_binding_history();
CREATE OR REPLACE FUNCTION public.app_preserve_topology_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.project_id, NEW.version, NEW.valid_from, NEW.configuration, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.project_id, OLD.version, OLD.valid_from, OLD.configuration, OLD.created_at)
    OR OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL THEN
    RAISE EXCEPTION 'Las versiones históricas son inmutables; cree una versión nueva.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_topology_history BEFORE UPDATE ON topology_versions
  FOR EACH ROW EXECUTE FUNCTION public.app_preserve_topology_history();
CREATE OR REPLACE FUNCTION public.app_preserve_point_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.project_id, NEW.kind, NEW.sign_convention)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.project_id, OLD.kind, OLD.sign_convention) THEN
    RAISE EXCEPTION 'El significado y ámbito del punto de medición son inmutables.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_point_identity BEFORE UPDATE ON measurement_points
  FOR EACH ROW EXECUTE FUNCTION public.app_preserve_point_identity();
CREATE OR REPLACE FUNCTION public.app_preserve_last_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active' AND (NEW.role <> 'owner' OR NEW.status <> 'active') THEN
    PERFORM 1 FROM public.organizations WHERE id = OLD.organization_id FOR UPDATE;
    IF NOT EXISTS (SELECT FROM public.memberships m WHERE m.organization_id = OLD.organization_id
      AND m.id <> OLD.id AND m.role = 'owner' AND m.status = 'active') THEN
      RAISE EXCEPTION 'La organización requiere al menos un administrador propietario activo.' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.user_id) THEN
    RAISE EXCEPTION 'La identidad y organización de una membresía son inmutables.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_last_owner BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION public.app_preserve_last_owner();
CREATE OR REPLACE FUNCTION public.app_validate_site_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM public.memberships m WHERE m.organization_id = NEW.organization_id
    AND m.user_id = NEW.user_id AND m.status = 'active' AND m.role = NEW.role) THEN
    RAISE EXCEPTION 'La asignación requiere una membresía activa con el mismo rol.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_site_role BEFORE INSERT OR UPDATE ON site_access
  FOR EACH ROW EXECUTE FUNCTION public.app_validate_site_role();
ALTER FUNCTION public.app_preserve_binding_history() OWNER TO solar_security_guard;
ALTER FUNCTION public.app_preserve_topology_history() OWNER TO solar_security_guard;
ALTER FUNCTION public.app_preserve_last_owner() OWNER TO solar_security_guard;
ALTER FUNCTION public.app_validate_site_role() OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.app_preserve_binding_history(), public.app_preserve_topology_history(),
  public.app_preserve_point_identity(), public.app_preserve_last_owner(), public.app_validate_site_role() FROM PUBLIC;
COMMIT;

BEGIN;
-- Only the authentication pool can call these routines. Cognito/JWT verification
-- happens before calling auth_create_session; no password or bearer token is stored.
CREATE OR REPLACE FUNCTION public.auth_register_flow(p_state_hash text, p_expires_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_state_hash !~ '^[a-f0-9]{64}$' OR p_expires_at <= clock_timestamp()
    OR p_expires_at > clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'Estado de autenticación inválido.' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.auth_flows WHERE expires_at < clock_timestamp() - interval '1 day';
  INSERT INTO public.auth_flows(state_hash, expires_at) VALUES (p_state_hash, p_expires_at);
END $$;
CREATE OR REPLACE FUNCTION public.auth_consume_flow(p_state_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE flow_expiry timestamptz;
BEGIN
  DELETE FROM public.auth_flows WHERE state_hash = p_state_hash RETURNING expires_at INTO flow_expiry;
  RETURN coalesce(flow_expiry > clock_timestamp(), false);
END $$;
CREATE OR REPLACE FUNCTION public.auth_create_session(
  p_issuer text, p_subject text, p_email text, p_email_verified boolean,
  p_display_name text, p_token_hash text, p_expires_at timestamptz)
RETURNS TABLE(user_id uuid, email text, display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE identity_id uuid;
BEGIN
  IF p_email_verified IS DISTINCT FROM true OR length(p_issuer) NOT BETWEEN 10 AND 500
    OR p_issuer !~ '^https://' OR length(p_subject) NOT BETWEEN 1 AND 200 OR strpos(p_subject, '|') > 0
    OR length(p_email) NOT BETWEEN 3 AND 320 OR p_email NOT LIKE '%@%'
    OR p_token_hash !~ '^[a-f0-9]{64}$' OR p_expires_at <= clock_timestamp()
    OR p_expires_at > clock_timestamp() + interval '8 hours' THEN
    RAISE EXCEPTION 'Identidad o sesión inválida.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.users(id, cognito_subject, email, email_verified, name, created_at, updated_at)
  VALUES (gen_random_uuid(), p_issuer || '|' || p_subject, lower(btrim(p_email)), true, left(p_display_name, 180), now(), now())
  ON CONFLICT (cognito_subject) DO UPDATE SET email = EXCLUDED.email,
    email_verified = true, name = EXCLUDED.name, updated_at = now()
  RETURNING id INTO identity_id;
  INSERT INTO public.sessions(id, token_hash, user_id, expires_at, created_at)
    VALUES (gen_random_uuid(), p_token_hash, identity_id, p_expires_at, now());
  INSERT INTO public.audit_events(id,organization_id,actor_id,action,entity_type,entity_id,detail,created_at)
    SELECT gen_random_uuid(),m.organization_id,identity_id,'session.created','user',identity_id::text,'{}'::jsonb,now()
    FROM public.memberships m WHERE m.user_id = identity_id AND m.status = 'active';
  RETURN QUERY SELECT u.id, u.email, u.name FROM public.users u WHERE u.id = identity_id;
END $$;
CREATE OR REPLACE FUNCTION public.auth_resolve_session(p_token_hash text)
RETURNS TABLE(user_id uuid, email text, display_name text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.email, u.name, s.expires_at FROM public.sessions s
    JOIN public.users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL
    AND s.expires_at > now() AND u.email_verified
$$;
CREATE OR REPLACE FUNCTION public.auth_revoke_session(p_token_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE identity_id uuid;
BEGIN
  UPDATE public.sessions SET revoked_at = clock_timestamp()
    WHERE token_hash = p_token_hash AND revoked_at IS NULL RETURNING user_id INTO identity_id;
  IF identity_id IS NOT NULL THEN
    INSERT INTO public.audit_events(id,organization_id,actor_id,action,entity_type,entity_id,detail,created_at)
      SELECT gen_random_uuid(),m.organization_id,identity_id,'session.revoked','user',identity_id::text,'{}'::jsonb,now()
      FROM public.memberships m WHERE m.user_id = identity_id AND m.status = 'active';
  END IF;
END $$;
ALTER FUNCTION public.auth_register_flow(text,timestamptz) OWNER TO solar_security_guard;
ALTER FUNCTION public.auth_consume_flow(text) OWNER TO solar_security_guard;
ALTER FUNCTION public.auth_create_session(text,text,text,boolean,text,text,timestamptz) OWNER TO solar_security_guard;
ALTER FUNCTION public.auth_resolve_session(text) OWNER TO solar_security_guard;
ALTER FUNCTION public.auth_revoke_session(text) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.auth_register_flow(text,timestamptz), public.auth_consume_flow(text),
  public.auth_create_session(text,text,text,boolean,text,text,timestamptz),
  public.auth_resolve_session(text), public.auth_revoke_session(text) FROM PUBLIC, solar_runtime;
GRANT EXECUTE ON FUNCTION public.auth_register_flow(text,timestamptz), public.auth_consume_flow(text),
  public.auth_create_session(text,text,text,boolean,text,text,timestamptz),
  public.auth_resolve_session(text), public.auth_revoke_session(text) TO solar_auth;

CREATE OR REPLACE FUNCTION public.app_list_organizations() RETURNS SETOF public.organizations
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT o.* FROM public.organizations o JOIN public.memberships m ON m.organization_id = o.id
    WHERE m.user_id = public.app_user_id() AND m.status = 'active' ORDER BY o.name, o.id
$$;
CREATE OR REPLACE FUNCTION public.app_create_organization(p_name text, p_slug text, p_timezone text)
RETURNS public.organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_org public.organizations;
BEGIN
  IF NOT EXISTS (SELECT FROM public.users WHERE id = public.app_user_id() AND email_verified)
    OR length(btrim(p_name)) NOT BETWEEN 1 AND 180 OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    OR length(p_slug) NOT BETWEEN 2 AND 80 OR NOT EXISTS (SELECT FROM pg_catalog.pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'La identidad o datos de organización son inválidos.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.organizations(id,schema_version,name,slug,timezone,created_at,updated_at)
    VALUES (gen_random_uuid(),'2.0',btrim(p_name),p_slug,p_timezone,now(),now()) RETURNING * INTO created_org;
  INSERT INTO public.memberships(id,schema_version,organization_id,user_id,role,status,created_at,updated_at)
    VALUES (gen_random_uuid(),'2.0',created_org.id,public.app_user_id(),'owner','active',now(),now());
  INSERT INTO public.audit_events(id,organization_id,actor_id,action,entity_type,entity_id,detail,created_at)
    VALUES (gen_random_uuid(),created_org.id,public.app_user_id(),'organization.created','organization',created_org.id::text,'{}',now());
  RETURN created_org;
END $$;
CREATE OR REPLACE FUNCTION public.app_accept_invitation(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE inv public.invitations; identity_email text; existing_membership public.memberships;
BEGIN
  SELECT u.email INTO identity_email FROM public.users u WHERE u.id = public.app_user_id() AND u.email_verified;
  IF identity_email IS NULL THEN
    RAISE EXCEPTION 'Se requiere identidad y correo verificados.' USING ERRCODE = '42501';
  END IF;
  SELECT i.* INTO inv FROM public.invitations i WHERE i.token_hash = p_token_hash FOR UPDATE;
  IF inv.id IS NULL OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL
    OR inv.expires_at <= clock_timestamp() OR lower(inv.email) <> identity_email THEN
    RAISE EXCEPTION 'La invitación es inválida, expiró o no pertenece a esta identidad.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT FROM public.memberships m WHERE m.organization_id = inv.organization_id
    AND m.user_id = inv.created_by AND m.status = 'active' AND
    (m.role = 'owner' OR (m.role = 'administrator' AND inv.role <> 'owner'))) THEN
    RAISE EXCEPTION 'El emisor ya no puede autorizar esta invitación.' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations WHERE id = inv.organization_id FOR UPDATE;
  SELECT m.* INTO existing_membership FROM public.memberships m
    WHERE m.organization_id = inv.organization_id AND m.user_id = public.app_user_id() FOR UPDATE;
  IF existing_membership.id IS NOT NULL AND existing_membership.status = 'active' THEN
    RAISE EXCEPTION 'La identidad ya tiene una membresía activa; cambie permisos por el flujo administrativo.' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.memberships(id,schema_version,organization_id,user_id,role,status,created_at,updated_at)
    VALUES (gen_random_uuid(),'2.0',inv.organization_id,public.app_user_id(),inv.role,'active',now(),now())
    ON CONFLICT (organization_id,user_id) DO UPDATE SET role = inv.role,status = 'active',updated_at = now();
  DELETE FROM public.site_access WHERE organization_id = inv.organization_id AND user_id = public.app_user_id();
  IF inv.role IN ('technician','customer') THEN
    INSERT INTO public.site_access(id,organization_id,project_id,user_id,role,created_at)
      SELECT gen_random_uuid(),inv.organization_id,ip.project_id,public.app_user_id(),inv.role,now()
      FROM public.invitation_projects ip WHERE ip.organization_id = inv.organization_id AND ip.invitation_id = inv.id;
  END IF;
  UPDATE public.invitations SET accepted_at = clock_timestamp() WHERE id = inv.id;
  INSERT INTO public.audit_events(id,organization_id,actor_id,action,entity_type,entity_id,detail,created_at)
    VALUES (gen_random_uuid(),inv.organization_id,public.app_user_id(),'invitation.accepted','invitation',inv.id::text,
      jsonb_build_object('role',inv.role),now());
  RETURN inv.organization_id;
END $$;
ALTER FUNCTION public.app_list_organizations() OWNER TO solar_security_guard;
ALTER FUNCTION public.app_create_organization(text,text,text) OWNER TO solar_security_guard;
ALTER FUNCTION public.app_accept_invitation(text) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.app_list_organizations(), public.app_create_organization(text,text,text),
  public.app_accept_invitation(text) FROM PUBLIC, solar_auth;
GRANT EXECUTE ON FUNCTION public.app_list_organizations(), public.app_create_organization(text,text,text),
  public.app_accept_invitation(text) TO solar_runtime;
COMMIT;



BEGIN;
-- Invitations cannot be forged using another administrator's identity, elevated
-- to owner by an administrator, or rewritten after the token was issued.
DROP POLICY invitations_insert ON public.invitations;
DROP POLICY invitations_update ON public.invitations;
CREATE POLICY invitations_insert ON public.invitations FOR INSERT TO solar_runtime
  WITH CHECK (public.app_is_admin(organization_id) AND created_by = public.app_user_id()
    AND accepted_at IS NULL AND revoked_at IS NULL
    AND (role <> 'owner' OR public.app_role(organization_id) = 'owner'));
CREATE POLICY invitations_update ON public.invitations FOR UPDATE TO solar_runtime
  USING (public.app_is_admin(organization_id) AND (role <> 'owner' OR public.app_role(organization_id) = 'owner'))
  WITH CHECK (public.app_is_admin(organization_id) AND (role <> 'owner' OR public.app_role(organization_id) = 'owner'));
CREATE OR REPLACE FUNCTION public.app_preserve_invitation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user = 'solar_runtime' AND (
    ROW(NEW.id,NEW.organization_id,NEW.token_hash,NEW.email,NEW.role,NEW.expires_at,NEW.accepted_at,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.token_hash,OLD.email,OLD.role,OLD.expires_at,OLD.accepted_at,OLD.created_by,OLD.created_at)
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'La invitación emitida solo puede revocarse una vez.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_invitation BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.app_preserve_invitation();
REVOKE ALL ON FUNCTION public.app_preserve_invitation() FROM PUBLIC;
COMMIT;

