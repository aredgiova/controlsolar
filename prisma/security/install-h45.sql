-- Incremental security installation AFTER 202610090002_h45_telemetry.
-- Run once as database administrator; never use the credential in Next.js/worker.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname='solar_ingest') THEN
  CREATE ROLE solar_ingest LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
END $$;
ALTER ROLE solar_ingest NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE solar_ingest SET timezone='UTC';
REVOKE solar_security_guard, solar_migrator FROM solar_ingest;
REVOKE CREATE ON SCHEMA public FROM solar_ingest;
GRANT USAGE ON SCHEMA public TO solar_ingest;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM solar_ingest;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM solar_ingest;
GRANT SELECT,INSERT,UPDATE,DELETE ON gateway_identities,gateway_meters,telemetry_latest,
 telemetry_daily_aggregates,ingestion_quarantine,gateway_loss_reports TO solar_security_guard;
GRANT INSERT ON telemetry_samples TO solar_security_guard;
GRANT SELECT ON topology_versions TO solar_security_guard;
GRANT SELECT,INSERT,UPDATE ON gateway_identities TO solar_runtime;
GRANT SELECT,INSERT,DELETE ON gateway_meters TO solar_runtime;
GRANT SELECT ON telemetry_latest,telemetry_daily_aggregates,ingestion_quarantine,gateway_loss_reports TO solar_runtime;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['gateway_identities','gateway_meters','telemetry_latest','telemetry_daily_aggregates','ingestion_quarantine','gateway_loss_reports'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['gateway_identities','gateway_meters'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO solar_runtime USING (public.app_is_admin(organization_id))',t||'_read',t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO solar_runtime WITH CHECK (public.app_is_admin(organization_id))',t||'_insert',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['telemetry_latest','telemetry_daily_aggregates'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO solar_runtime USING (public.app_can_project(organization_id,project_id))',t||'_read',t);
 END LOOP;
END $$;
CREATE POLICY gateway_identities_revoke ON gateway_identities FOR UPDATE TO solar_runtime USING(public.app_is_admin(organization_id)) WITH CHECK(public.app_is_admin(organization_id));
CREATE POLICY gateway_meters_remove ON gateway_meters FOR DELETE TO solar_runtime USING(public.app_is_admin(organization_id));
CREATE POLICY quarantine_admin_read ON ingestion_quarantine FOR SELECT TO solar_runtime USING(public.app_is_admin(organization_id));
CREATE POLICY loss_admin_read ON gateway_loss_reports FOR SELECT TO solar_runtime USING(public.app_is_admin(organization_id));

CREATE FUNCTION public.ingest_validate_gateway_device() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='gateway_identities' THEN
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT FROM public.devices d WHERE d.organization_id=NEW.organization_id AND d.id=NEW.gateway_device_id AND d.kind='gateway' AND d.status='active') THEN
   RAISE EXCEPTION 'La identidad requiere un gateway activo de la misma organización.' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.organization_id,NEW.gateway_device_id,NEW.name,NEW.source,NEW.client_id,NEW.principal_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.gateway_device_id,OLD.name,OLD.source,OLD.client_id,OLD.principal_id,OLD.created_at)
   OR OLD.status='revoked' OR NEW.status<>'revoked' OR NEW.revoked_at IS NULL) THEN
   RAISE EXCEPTION 'La identidad de gateway solo puede revocarse una vez.' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT FROM public.devices d WHERE d.organization_id=NEW.organization_id AND d.id=NEW.meter_device_id AND d.kind='meter')
   OR NOT EXISTS(SELECT FROM public.gateway_identities g WHERE g.organization_id=NEW.organization_id AND g.id=NEW.gateway_identity_id AND g.status='active') THEN
   RAISE EXCEPTION 'El medidor debe pertenecer a la misma organización y a un gateway activo.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION public.ingest_validate_gateway_device() OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.ingest_validate_gateway_device() FROM PUBLIC;
CREATE TRIGGER validate_gateway_device BEFORE INSERT OR UPDATE ON gateway_identities FOR EACH ROW EXECUTE FUNCTION public.ingest_validate_gateway_device();
CREATE TRIGGER validate_gateway_meter BEFORE INSERT ON gateway_meters FOR EACH ROW EXECUTE FUNCTION public.ingest_validate_gateway_device();

CREATE FUNCTION public.ingest_resolve_gateway(p_context jsonb) RETURNS public.gateway_identities
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE gateway public.gateway_identities;
BEGIN
 IF jsonb_typeof(p_context)<>'object' OR octet_length(p_context::text)>8192 THEN RAISE EXCEPTION 'Envelope inválido.' USING ERRCODE='42501'; END IF;
 SELECT g.* INTO gateway FROM public.gateway_identities g JOIN public.devices d ON d.organization_id=g.organization_id AND d.id=g.gateway_device_id
  WHERE g.source::text=p_context->>'source' AND g.client_id=p_context->>'clientId' AND g.principal_id=p_context->>'principalId'
   AND g.status='active' AND d.kind='gateway' AND d.status='active' FOR SHARE OF g;
 IF gateway.id IS NULL OR p_context->>'topic' <> 'solar/v2/gateways/'||gateway.client_id||'/telemetry'
  OR (p_context ? 'expectedGatewayId' AND ((p_context->>'expectedGatewayId') IS NULL OR (p_context->>'expectedGatewayId')::uuid<>gateway.id))
  OR (p_context->>'receivedAt')::timestamptz>clock_timestamp()+interval '5 minutes'
  OR (p_context->>'receivedAt')::timestamptz<clock_timestamp()-interval '30 days'
  OR p_context->>'receivedAt' IS NULL OR p_context->>'topic' IS NULL THEN
  RAISE EXCEPTION 'Gateway, principal, topic o recibo no autorizados.' USING ERRCODE='42501';
 END IF;
 RETURN gateway;
END $$;
ALTER FUNCTION public.ingest_resolve_gateway(jsonb) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.ingest_resolve_gateway(jsonb) FROM PUBLIC,solar_ingest,solar_runtime;

CREATE FUNCTION public.ingest_quarantine(p_message_id text,p_body_hash text,p_reason text,p_raw_body text,p_receipt_context jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE quarantine_id uuid;
BEGIN
 INSERT INTO public.ingestion_quarantine(id,message_id,body_hash,reason,raw_body,receipt_context,created_at)
  VALUES(gen_random_uuid(),p_message_id,p_body_hash,p_reason,p_raw_body,p_receipt_context,clock_timestamp())
  ON CONFLICT(message_id,body_hash,reason) DO UPDATE SET message_id=EXCLUDED.message_id RETURNING id INTO quarantine_id;
 RETURN quarantine_id;
END $$;
ALTER FUNCTION public.ingest_quarantine(text,text,text,text,jsonb) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.ingest_quarantine(text,text,text,text,jsonb) FROM PUBLIC,solar_runtime,solar_auth;
GRANT EXECUTE ON FUNCTION public.ingest_quarantine(text,text,text,text,jsonb) TO solar_ingest;

CREATE FUNCTION public.ingest_accept_event(p_context jsonb,p_payload jsonb,p_payload_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_variable
DECLARE gateway public.gateway_identities; binding public.device_bindings; existing public.telemetry_samples;
 event_id uuid; point_id uuid; meter_id uuid; measured timestamptz; received timestamptz; version integer;
 project_timezone text; project_id uuid; reason text; body_hash text; quarantine_id uuid; stored_id uuid;
BEGIN

 body_hash:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 BEGIN gateway:=public.ingest_resolve_gateway(p_context);
 EXCEPTION WHEN insufficient_privilege OR data_exception THEN reason:='untrusted_gateway'; END;
 IF reason IS NULL THEN
  BEGIN
   IF jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>65536 OR p_payload->>'schemaVersion'<>'2.0'
    OR p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$' OR p_payload ?| ARRAY['organizationId','organization_id','tenantId','source','gatewayId'] THEN
    reason:='invalid_payload';
   ELSE
    event_id:=(p_payload->>'eventId')::uuid; point_id:=(p_payload->>'measurementPointId')::uuid;
    meter_id:=(p_payload->>'deviceId')::uuid; measured:=(p_payload->>'measuredAt')::timestamptz;
    version:=(p_payload->>'configurationVersion')::integer; received:=(p_context->>'receivedAt')::timestamptz;
    IF event_id IS NULL OR point_id IS NULL OR meter_id IS NULL OR measured IS NULL OR version IS NULL
     OR measured>received+interval '5 minutes' OR measured<received-interval '30 days'
     OR measured>clock_timestamp()+interval '5 minutes' OR measured<clock_timestamp()-interval '30 days'
     OR p_payload->>'quality' IS NULL OR p_payload->>'quality' NOT IN ('measured','missing','invalid')
     OR NOT (p_payload ?& ARRAY['activePower','importEnergy','exportEnergy'])
     OR jsonb_typeof(p_payload->'activePower') NOT IN ('number','null')
     OR jsonb_typeof(p_payload->'importEnergy') NOT IN ('number','null')
     OR jsonb_typeof(p_payload->'exportEnergy') NOT IN ('number','null')
     OR abs((p_payload->>'activePower')::numeric)>1000000000
     OR (p_payload->>'importEnergy')::numeric>10000000000000 OR (p_payload->>'exportEnergy')::numeric>10000000000000
     OR (p_payload->>'importEnergy')::numeric<0 OR (p_payload->>'exportEnergy')::numeric<0
     OR jsonb_typeof(coalesce(p_payload->'phases','[]'::jsonb))<>'array' THEN reason:='invalid_payload'; END IF;
   END IF;
  EXCEPTION WHEN data_exception THEN reason:='invalid_payload'; END;
 END IF;
 IF reason IS NULL THEN
  IF NOT EXISTS(SELECT FROM public.gateway_meters gm JOIN public.devices d ON d.organization_id=gm.organization_id AND d.id=gm.meter_device_id
   WHERE gm.organization_id=gateway.organization_id AND gm.gateway_identity_id=gateway.id AND gm.meter_device_id=meter_id AND d.kind='meter') THEN reason:='unauthorized_meter'; END IF;
 END IF;
 IF reason IS NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('solar-event:'||event_id::text,0));
  -- Serialize processors without a project row lock, which would conflict with management FK checks.
  SELECT mp.project_id INTO project_id FROM public.measurement_points mp WHERE mp.organization_id=gateway.organization_id AND mp.id=point_id;
  IF project_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('solar-telemetry:'||project_id::text,0)); END IF;
  -- The point lock matches management's order, serializing replacements and ingestion.
  PERFORM 1 FROM public.measurement_points WHERE organization_id=gateway.organization_id AND id=point_id FOR UPDATE;
  SELECT b.* INTO binding FROM public.device_bindings b WHERE b.organization_id=gateway.organization_id AND b.device_id=meter_id
   AND b.measurement_point_id=point_id AND b.configuration_version=version AND b.valid_from<=measured AND (b.valid_to IS NULL OR measured<b.valid_to) FOR UPDATE;
  IF binding.id IS NULL THEN reason:='binding_not_valid';
  ELSE

   SELECT timezone INTO project_timezone FROM public.projects WHERE id=binding.project_id;
   SELECT s.* INTO existing FROM public.telemetry_samples s WHERE s.event_id=event_id;
   IF existing.event_id IS NOT NULL THEN
    IF existing.organization_id<>gateway.organization_id OR existing.payload_json IS DISTINCT FROM p_payload THEN reason:='event_id_conflict'; ELSE stored_id:=existing.event_id; END IF;
   ELSE
    SELECT s.* INTO existing FROM public.telemetry_samples s WHERE s.organization_id=gateway.organization_id AND s.binding_id=binding.id AND s.measured_at=measured;
    IF existing.event_id IS NOT NULL THEN
     IF (existing.payload_json-'eventId') IS DISTINCT FROM (p_payload-'eventId') THEN reason:='timestamp_conflict'; ELSE stored_id:=existing.event_id; END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 IF reason IS NOT NULL THEN
  quarantine_id:=public.ingest_quarantine(coalesce(event_id::text,body_hash),body_hash,reason,left(p_payload::text,16000),p_context);
  IF gateway.id IS NOT NULL THEN UPDATE public.ingestion_quarantine SET organization_id=gateway.organization_id,gateway_identity_id=gateway.id,event_id=event_id WHERE id=quarantine_id; END IF;
  RETURN jsonb_build_object('status','quarantined','reason',reason,'eventId',coalesce(event_id::text,p_payload->>'eventId'),'quarantineId',quarantine_id);
 END IF;
 IF current_setting('app.ingest_gateway_id',true) IS DISTINCT FROM gateway.id::text THEN PERFORM set_config('app.ingest_project_ids','[]',true); END IF;
 PERFORM set_config('app.ingest_project_id',binding.project_id::text,true),set_config('app.ingest_gateway_id',gateway.id::text,true);
 PERFORM set_config('app.ingest_project_ids',(coalesce(nullif(current_setting('app.ingest_project_ids',true),''),'[]')::jsonb || jsonb_build_array(binding.project_id::text))::text,true);
 IF stored_id IS NOT NULL THEN
  RETURN jsonb_build_object('status','duplicate','eventId',event_id,'storedEventId',stored_id,'organizationId',gateway.organization_id,'projectId',binding.project_id,'measurementPointId',point_id,'bindingId',binding.id,'timezone',project_timezone);
 END IF;
 INSERT INTO public.telemetry_samples(event_id,schema_version,organization_id,binding_id,device_id,measurement_point_id,configuration_version,measured_at,received_at,active_power,import_energy,export_energy,quality,source,gateway_identity_id,payload_hash,payload_json,phases)
  VALUES(event_id,'2.0',gateway.organization_id,binding.id,meter_id,point_id,version,measured,received,(p_payload->>'activePower')::numeric,(p_payload->>'importEnergy')::numeric,(p_payload->>'exportEnergy')::numeric,(p_payload->>'quality')::public."TelemetryQuality",gateway.source,gateway.id,body_hash,p_payload,coalesce(p_payload->'phases','[]'::jsonb));
 INSERT INTO public.telemetry_latest(organization_id,project_id,measurement_point_id,event_id,measured_at,received_at)
  VALUES(gateway.organization_id,binding.project_id,point_id,event_id,measured,received)
  ON CONFLICT(organization_id,measurement_point_id) DO UPDATE SET event_id=EXCLUDED.event_id,measured_at=EXCLUDED.measured_at,received_at=EXCLUDED.received_at
   WHERE EXCLUDED.measured_at>public.telemetry_latest.measured_at;
 RETURN jsonb_build_object('status','accepted','eventId',event_id,'storedEventId',event_id,'organizationId',gateway.organization_id,'projectId',binding.project_id,'measurementPointId',point_id,'bindingId',binding.id,'timezone',project_timezone);
END $$;
ALTER FUNCTION public.ingest_accept_event(jsonb,jsonb,text) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.ingest_accept_event(jsonb,jsonb,text) FROM PUBLIC,solar_runtime,solar_auth;
GRANT EXECUTE ON FUNCTION public.ingest_accept_event(jsonb,jsonb,text) TO solar_ingest;
COMMIT;

BEGIN;
CREATE FUNCTION public.ingest_load_project_context(p_project_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE gateway public.gateway_identities; project public.projects; result jsonb; sample_count integer;
BEGIN
 SELECT g.* INTO gateway FROM public.gateway_identities g WHERE g.id=nullif(current_setting('app.ingest_gateway_id',true),'')::uuid AND g.status='active';
 SELECT p.* INTO project FROM public.projects p WHERE p.id=p_project_id AND p.organization_id=gateway.organization_id;
 IF gateway.id IS NULL OR project.id IS NULL OR NOT (coalesce(nullif(current_setting('app.ingest_project_ids',true),''),'[]')::jsonb ? p_project_id::text)
  OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from OR p_to-p_from>interval '33 days'
  OR p_from<clock_timestamp()-interval '33 days' OR p_to>clock_timestamp()+interval '2 days' THEN RAISE EXCEPTION 'Contexto de procesamiento no autorizado.' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO sample_count FROM public.telemetry_samples s JOIN public.device_bindings b ON b.organization_id=s.organization_id AND b.id=s.binding_id
  WHERE s.organization_id=project.organization_id AND b.project_id=p_project_id AND s.measured_at>=p_from AND s.measured_at<=p_to;
 IF sample_count>200000 THEN RAISE EXCEPTION 'Reduzca la ventana de recomputación; máximo 200000 muestras por transacción.' USING ERRCODE='54000'; END IF;
 WITH project_points AS (
   SELECT p.id FROM public.measurement_points p WHERE p.organization_id=project.organization_id AND p.project_id=p_project_id
 ), selected_samples AS MATERIALIZED (
   SELECT s.* FROM public.telemetry_samples s JOIN project_points p ON p.id=s.measurement_point_id
    WHERE s.organization_id=project.organization_id AND s.measured_at>=p_from AND s.measured_at<=p_to
   UNION
   SELECT s.* FROM project_points p CROSS JOIN LATERAL (
    SELECT t.* FROM public.telemetry_samples t WHERE t.organization_id=project.organization_id AND t.measurement_point_id=p.id
     AND t.measured_at<p_from AND t.measured_at>=clock_timestamp()-interval '31 days' ORDER BY t.measured_at DESC,t.event_id DESC LIMIT 1
   ) s
   UNION
   SELECT s.* FROM project_points p CROSS JOIN LATERAL (
    SELECT t.* FROM public.telemetry_samples t WHERE t.organization_id=project.organization_id AND t.measurement_point_id=p.id
     AND t.measured_at>p_to AND t.measured_at>=clock_timestamp()-interval '31 days' AND t.measured_at<=clock_timestamp()+interval '5 minutes' ORDER BY t.measured_at,t.event_id LIMIT 1
   ) s
 )
 SELECT jsonb_build_object('projectId',project.id,'timezone',project.timezone,
  'points',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'signConvention',p.sign_convention)) FROM public.measurement_points p WHERE p.organization_id=project.organization_id AND p.project_id=p_project_id),'[]'),
  'bindings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'measurementPointId',b.measurement_point_id,'deviceId',b.device_id,'configurationVersion',b.configuration_version,'validFrom',b.valid_from,'validTo',b.valid_to,'configuration',b.configuration)) FROM public.device_bindings b WHERE b.organization_id=project.organization_id AND b.project_id=p_project_id AND ((b.valid_from<=p_to AND (b.valid_to IS NULL OR b.valid_to>=p_from)) OR b.id IN (SELECT s.binding_id FROM selected_samples s))),'[]'),
  'topologyVersions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'validFrom',v.valid_from,'validTo',v.valid_to,'configuration',v.configuration) ORDER BY v.version) FROM public.topology_versions v WHERE v.organization_id=project.organization_id AND v.project_id=p_project_id AND v.valid_from<=p_to AND (v.valid_to IS NULL OR v.valid_to>=p_from)),'[]'),
  'samples',coalesce((SELECT jsonb_agg(jsonb_build_object('eventId',s.event_id,'bindingId',s.binding_id,'deviceId',s.device_id,'measurementPointId',s.measurement_point_id,'configurationVersion',s.configuration_version,'measuredAt',s.measured_at,'receivedAt',s.received_at,'activePower',s.active_power,'importEnergy',s.import_energy,'exportEnergy',s.export_energy,'quality',s.quality,'source',s.source,'phases',s.phases) ORDER BY s.measured_at,s.event_id)
    FROM selected_samples s),'[]')) INTO result;
 RETURN result;
END $$;
ALTER FUNCTION public.ingest_load_project_context(uuid,timestamptz,timestamptz) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.ingest_load_project_context(uuid,timestamptz,timestamptz) FROM PUBLIC,solar_runtime,solar_auth;
GRANT EXECUTE ON FUNCTION public.ingest_load_project_context(uuid,timestamptz,timestamptz) TO solar_ingest;

CREATE FUNCTION public.ingest_save_daily_aggregates(p_project_id uuid,p_rows jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE gateway public.gateway_identities; row_data jsonb; point_id uuid; local_day date;
BEGIN
 SELECT g.* INTO gateway FROM public.gateway_identities g WHERE g.id=nullif(current_setting('app.ingest_gateway_id',true),'')::uuid AND g.status='active';
 IF gateway.id IS NULL OR NOT (coalesce(nullif(current_setting('app.ingest_project_ids',true),''),'[]')::jsonb ? p_project_id::text) OR jsonb_typeof(p_rows)<>'array'
  OR jsonb_array_length(p_rows)>1000 OR octet_length(p_rows::text)>4194304 THEN RAISE EXCEPTION 'Agregados fuera del contexto autorizado.' USING ERRCODE='42501'; END IF;
 FOR row_data IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  point_id:=(row_data->>'measurementPointId')::uuid; local_day:=(row_data->>'localDate')::date;
  IF NOT EXISTS(SELECT FROM public.measurement_points p WHERE p.organization_id=gateway.organization_id AND p.project_id=p_project_id AND p.id=point_id)
   OR local_day<CURRENT_DATE-33 OR local_day>CURRENT_DATE+2 THEN RAISE EXCEPTION 'Punto o día no autorizado.' USING ERRCODE='42501'; END IF;
  INSERT INTO public.telemetry_daily_aggregates(organization_id,project_id,measurement_point_id,local_date,import_energy_kwh,export_energy_kwh,integrated_positive_kwh,integrated_negative_kwh,sample_count,gap_count,reset_count,quality,detail_json,updated_at)
   VALUES(gateway.organization_id,p_project_id,point_id,local_day,(row_data->>'importEnergyKwh')::numeric,(row_data->>'exportEnergyKwh')::numeric,(row_data->>'integratedPositiveKwh')::numeric,(row_data->>'integratedNegativeKwh')::numeric,(row_data->>'sampleCount')::integer,(row_data->>'gapCount')::integer,(row_data->>'resetCount')::integer,(row_data->>'quality')::public."AggregateQuality",row_data->'detailJson',clock_timestamp())
   ON CONFLICT(organization_id,measurement_point_id,local_date) DO UPDATE SET import_energy_kwh=EXCLUDED.import_energy_kwh,export_energy_kwh=EXCLUDED.export_energy_kwh,integrated_positive_kwh=EXCLUDED.integrated_positive_kwh,integrated_negative_kwh=EXCLUDED.integrated_negative_kwh,sample_count=EXCLUDED.sample_count,gap_count=EXCLUDED.gap_count,reset_count=EXCLUDED.reset_count,quality=EXCLUDED.quality,detail_json=EXCLUDED.detail_json,updated_at=EXCLUDED.updated_at;
 END LOOP;
END $$;
ALTER FUNCTION public.ingest_save_daily_aggregates(uuid,jsonb) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.ingest_save_daily_aggregates(uuid,jsonb) FROM PUBLIC,solar_runtime,solar_auth;
GRANT EXECUTE ON FUNCTION public.ingest_save_daily_aggregates(uuid,jsonb) TO solar_ingest;

CREATE FUNCTION public.ingest_record_loss_reports(p_context jsonb,p_reports jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE gateway public.gateway_identities; report jsonb; count_saved integer:=0; existing public.gateway_loss_reports;
 v_report_id uuid; v_from timestamptz; v_to timestamptz; v_dropped integer; v_reason text; failure text; quarantine_id uuid; body_hash text;
BEGIN
 BEGIN gateway:=public.ingest_resolve_gateway(p_context);
 EXCEPTION WHEN insufficient_privilege OR data_exception THEN
  body_hash:=encode(sha256(convert_to(p_reports::text,'UTF8')),'hex');
  PERFORM public.ingest_quarantine(body_hash,body_hash,'loss_untrusted_gateway',left(p_reports::text,16000),p_context);
  RETURN 0;
 END;
 IF jsonb_typeof(p_reports)<>'array' OR jsonb_array_length(p_reports)>100 THEN
  body_hash:=encode(sha256(convert_to(p_reports::text,'UTF8')),'hex');
  PERFORM public.ingest_quarantine(body_hash,body_hash,'invalid_loss_report',left(p_reports::text,16000),p_context); RETURN 0;
 END IF;
 FOR report IN SELECT value FROM jsonb_array_elements(p_reports) LOOP
  failure:=NULL; v_report_id:=NULL; body_hash:=encode(sha256(convert_to(report::text,'UTF8')),'hex');
  BEGIN
   v_report_id:=(report->>'reportId')::uuid; v_from:=(report->>'from')::timestamptz; v_to:=(report->>'to')::timestamptz; v_dropped:=(report->>'dropped')::integer; v_reason:=report->>'reason';
   IF v_report_id IS NULL OR v_from IS NULL OR v_to IS NULL OR v_to<v_from OR v_dropped IS NULL OR v_dropped<=0 OR v_reason IS DISTINCT FROM 'buffer_capacity'
    OR v_to>(p_context->>'receivedAt')::timestamptz+interval '5 minutes' THEN failure:='invalid_loss_report'; END IF;
  EXCEPTION WHEN data_exception THEN failure:='invalid_loss_report'; END;
  IF failure IS NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('solar-loss:'||v_report_id::text,0));
   SELECT r.* INTO existing FROM public.gateway_loss_reports r WHERE r.report_id=v_report_id;
   IF existing.report_id IS NOT NULL AND ROW(existing.organization_id,existing.gateway_identity_id,existing.lost_from,existing.lost_to,existing.dropped,existing.reason)
    IS DISTINCT FROM ROW(gateway.organization_id,gateway.id,v_from,v_to,v_dropped,v_reason) THEN failure:='loss_report_conflict'; END IF;
  END IF;
  IF failure IS NOT NULL THEN
   quarantine_id:=public.ingest_quarantine(coalesce(v_report_id::text,body_hash),body_hash,failure,left(report::text,16000),p_context);
   UPDATE public.ingestion_quarantine SET organization_id=gateway.organization_id,gateway_identity_id=gateway.id WHERE id=quarantine_id;
  ELSE
   INSERT INTO public.gateway_loss_reports(report_id,organization_id,gateway_identity_id,lost_from,lost_to,dropped,reason,recorded_at)
    VALUES(v_report_id,gateway.organization_id,gateway.id,v_from,v_to,v_dropped,v_reason,clock_timestamp()) ON CONFLICT(report_id) DO NOTHING;
   IF FOUND THEN count_saved:=count_saved+1; END IF;
  END IF;
 END LOOP;
 RETURN count_saved;
END $$;
ALTER FUNCTION public.ingest_record_loss_reports(jsonb,jsonb) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.ingest_record_loss_reports(jsonb,jsonb) FROM PUBLIC,solar_runtime,solar_auth;
GRANT EXECUTE ON FUNCTION public.ingest_record_loss_reports(jsonb,jsonb) TO solar_ingest;
COMMIT;





BEGIN;
GRANT UPDATE ON public.measurement_points,public.device_bindings TO solar_security_guard;
COMMIT;
