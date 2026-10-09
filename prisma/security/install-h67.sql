-- Run once AFTER migrations 202610090003_h67_operations AND
-- 202610090004_h67_snapshot_ingestion, with a database administrator.
-- Baseline H23/H45 files remain immutable. No external delivery is performed by SQL.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='solar_worker') THEN
  CREATE ROLE solar_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
END $$;
ALTER ROLE solar_worker NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE solar_worker SET timezone='UTC';
REVOKE solar_security_guard,solar_migrator FROM solar_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM solar_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM solar_worker;
REVOKE CREATE ON SCHEMA public FROM solar_worker;
GRANT USAGE ON SCHEMA public TO solar_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON alert_rules,alerts,alert_events,incidents,incident_events,
 maintenance_windows,notification_outbox,report_jobs,download_leases,request_rate_limits TO solar_security_guard;
GRANT UPDATE ON projects TO solar_security_guard;
GRANT USAGE,SELECT ON SEQUENCE telemetry_samples_ingestion_sequence_seq TO solar_security_guard;
GRANT SELECT ON alert_rules,alerts,alert_events,incidents,incident_events,maintenance_windows,
 notification_outbox,report_jobs,download_leases TO solar_runtime;
GRANT INSERT,UPDATE ON alert_rules,incidents,maintenance_windows TO solar_runtime;
GRANT INSERT ON incident_events,report_jobs,download_leases TO solar_runtime;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['alert_rules','alerts','alert_events','incidents','incident_events','maintenance_windows',
  'notification_outbox','report_jobs','download_leases','request_rate_limits'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['alert_rules','alerts','alert_events','incidents','incident_events','maintenance_windows','notification_outbox'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO solar_runtime USING(public.app_can_project(organization_id,project_id))',t||'_read',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['alert_rules','incidents','maintenance_windows'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO solar_runtime WITH CHECK(public.app_is_admin(organization_id))',t||'_insert',t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO solar_runtime USING(public.app_is_admin(organization_id)) WITH CHECK(public.app_is_admin(organization_id))',t||'_update',t);
 END LOOP;
END $$;
CREATE POLICY incident_events_insert ON incident_events FOR INSERT TO solar_runtime WITH CHECK(public.app_is_admin(organization_id) AND actor_id=public.app_user_id());
CREATE POLICY report_jobs_read ON report_jobs FOR SELECT TO solar_runtime USING(public.app_can_project(organization_id,project_id) AND (requested_by=public.app_user_id() OR public.app_is_admin(organization_id)));
CREATE POLICY report_jobs_request ON report_jobs FOR INSERT TO solar_runtime WITH CHECK(public.app_can_project(organization_id,project_id) AND requested_by=public.app_user_id());
CREATE POLICY download_leases_read ON download_leases FOR SELECT TO solar_runtime USING(user_id=public.app_user_id() AND public.app_can_project(organization_id,project_id));
CREATE POLICY download_leases_issue ON download_leases FOR INSERT TO solar_runtime WITH CHECK(user_id=public.app_user_id() AND public.app_can_project(organization_id,project_id));

CREATE FUNCTION public.operations_validate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE runtime boolean:=session_user='solar_runtime'; job public.report_jobs;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
  RAISE EXCEPTION 'La identidad de operaciones es inmutable.' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='alert_rules' THEN
  IF TG_OP='UPDATE' AND (NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at OR (runtime AND NEW.last_evaluated_at IS DISTINCT FROM OLD.last_evaluated_at)) THEN
   RAISE EXCEPTION 'Tipo, creación y reloj de evaluación son inmutables.' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='incidents' THEN
  IF NEW.assignee_user_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id) AND NOT EXISTS(
   SELECT FROM public.memberships m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.assignee_user_id AND m.status='active'
    AND (m.role IN ('owner','administrator') OR (m.role='technician' AND EXISTS(SELECT FROM public.site_access s WHERE s.organization_id=m.organization_id AND s.project_id=NEW.project_id AND s.user_id=m.user_id AND s.role=m.role)))) THEN
   RAISE EXCEPTION 'Responsable no autorizado en el proyecto.' USING ERRCODE='23514';
  END IF;
  IF runtime AND TG_OP='INSERT' AND (NEW.created_by_id IS DISTINCT FROM public.app_user_id() OR NEW.alert_id IS NOT NULL OR NEW.alert_episode_id IS NOT NULL) THEN
   RAISE EXCEPTION 'Origen de incidencia inválido.' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.alert_id,NEW.alert_episode_id,NEW.created_by_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.alert_id,OLD.alert_episode_id,OLD.created_by_id,OLD.created_at) THEN
   RAISE EXCEPTION 'Origen de incidencia inmutable.' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='maintenance_windows' THEN
  IF runtime AND TG_OP='INSERT' AND NEW.created_by_id IS DISTINCT FROM public.app_user_id() THEN RAISE EXCEPTION 'Creador inválido.' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.starts_at,NEW.ends_at,NEW.reason,NEW.created_by_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.starts_at,OLD.ends_at,OLD.reason,OLD.created_by_id,OLD.created_at) OR OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL) THEN
   RAISE EXCEPTION 'El mantenimiento solo puede cancelarse una vez.' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='report_jobs' THEN
  IF TG_OP='INSERT' THEN
   IF NOT EXISTS(SELECT FROM public.projects p WHERE p.organization_id=NEW.organization_id AND p.id=NEW.project_id AND p.timezone=NEW.timezone)
    OR NEW.period_from IS DISTINCT FROM (NEW.start_date::timestamp AT TIME ZONE NEW.timezone)
    OR NEW.period_to IS DISTINCT FROM ((NEW.end_date+1)::timestamp AT TIME ZONE NEW.timezone)
    OR NEW.status<>'queued' OR NEW.attempts<>0 OR NEW.lease_token_hash IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.worker_id IS NOT NULL
    OR NEW.artifact_key IS NOT NULL OR NEW.sha256 IS NOT NULL OR NEW.byte_length IS NOT NULL OR NEW.snapshot_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.snapshot_sequence<>0
    OR (runtime AND NEW.next_attempt_at>clock_timestamp()+interval '5 seconds') THEN
    RAISE EXCEPTION 'Solicitud de informe inválida.' USING ERRCODE='23514';
   END IF;
   -- Share the ingestion project lock: every earlier sample is committed before
   -- capturing the sequence; a later insertion always receives a larger value.
   PERFORM pg_advisory_xact_lock(hashtextextended('solar-telemetry:'||NEW.project_id::text,0));
   NEW.created_at:=clock_timestamp();
   SELECT coalesce(max(s.ingestion_sequence),0) INTO NEW.snapshot_sequence FROM public.telemetry_samples s
    JOIN public.measurement_points p ON p.organization_id=s.organization_id AND p.id=s.measurement_point_id
    WHERE p.organization_id=NEW.organization_id AND p.project_id=NEW.project_id;
  ELSE
   IF ROW(NEW.requested_by,NEW.idempotency_key,NEW.timezone,NEW.start_date,NEW.end_date,NEW.period_from,NEW.period_to,NEW.created_at,NEW.snapshot_sequence)
     IS DISTINCT FROM ROW(OLD.requested_by,OLD.idempotency_key,OLD.timezone,OLD.start_date,OLD.end_date,OLD.period_from,OLD.period_to,OLD.created_at,OLD.snapshot_sequence)
     OR OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'Solicitud final o identidad de informe inmutable.' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='download_leases' THEN
  SELECT r.* INTO job FROM public.report_jobs r WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id AND r.id=NEW.report_job_id;
  IF TG_OP='INSERT' AND (job.id IS NULL OR job.status<>'completed' OR (runtime AND job.requested_by<>public.app_user_id() AND NOT public.app_is_admin(NEW.organization_id))
   OR NEW.expires_at<=clock_timestamp() OR NEW.expires_at>clock_timestamp()+interval '5 minutes' OR NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Permiso de descarga inválido.' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.report_job_id,NEW.user_id,NEW.token_hash,NEW.expires_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.report_job_id,OLD.user_id,OLD.token_hash,OLD.expires_at,OLD.created_at) THEN
   RAISE EXCEPTION 'Permiso de descarga inmutable.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION public.operations_validate() OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.operations_validate() FROM PUBLIC;
CREATE TRIGGER operations_rule_validate BEFORE INSERT OR UPDATE ON alert_rules FOR EACH ROW EXECUTE FUNCTION public.operations_validate();
CREATE TRIGGER operations_incident_validate BEFORE INSERT OR UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION public.operations_validate();
CREATE TRIGGER operations_maintenance_validate BEFORE INSERT OR UPDATE ON maintenance_windows FOR EACH ROW EXECUTE FUNCTION public.operations_validate();
CREATE TRIGGER operations_report_validate BEFORE INSERT OR UPDATE ON report_jobs FOR EACH ROW EXECUTE FUNCTION public.operations_validate();
CREATE TRIGGER operations_download_validate BEFORE INSERT OR UPDATE ON download_leases FOR EACH ROW EXECUTE FUNCTION public.operations_validate();

CREATE FUNCTION public.auth_take_rate_limit(p_scope text,p_key_hash text,p_limit integer,p_window_seconds integer)
RETURNS TABLE(allowed boolean,retry_after integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE start_at timestamptz; until_at timestamptz; used integer;
BEGIN
 IF p_scope IS NULL OR p_scope NOT IN ('api_read','api_write','auth_login','auth_callback','auth_logout','api_global') OR p_key_hash IS NULL OR p_key_hash !~ '^[a-f0-9]{64}$'
  OR p_limit IS NULL OR p_limit<1 OR p_limit>10000 OR p_window_seconds IS NULL OR p_window_seconds<1 OR p_window_seconds>3600 THEN RAISE EXCEPTION 'Límite inválido.' USING ERRCODE='22023'; END IF;
 start_at:=to_timestamp(floor(extract(epoch FROM clock_timestamp())/p_window_seconds)*p_window_seconds); until_at:=start_at+make_interval(secs=>p_window_seconds);
 DELETE FROM public.request_rate_limits WHERE ctid IN (SELECT ctid FROM public.request_rate_limits WHERE expires_at<clock_timestamp()-interval '2 hours' LIMIT 100);
 INSERT INTO public.request_rate_limits(scope,key_hash,window_start,count,expires_at) VALUES(p_scope,p_key_hash,start_at,1,until_at)
  ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=least(public.request_rate_limits.count+1,p_limit+1) RETURNING count INTO used;
 RETURN QUERY SELECT used<=p_limit,greatest(1,ceil(extract(epoch FROM until_at-clock_timestamp()))::integer);
END $$;
ALTER FUNCTION public.auth_take_rate_limit(text,text,integer,integer) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.auth_take_rate_limit(text,text,integer,integer) FROM PUBLIC,solar_runtime,solar_ingest,solar_worker;
GRANT EXECUTE ON FUNCTION public.auth_take_rate_limit(text,text,integer,integer) TO solar_auth;

CREATE FUNCTION public.worker_claim_alert_project() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE project public.projects; result jsonb; evaluated timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
 SELECT p.* INTO project FROM public.projects p
  WHERE EXISTS(SELECT FROM public.alert_rules r WHERE r.organization_id=p.organization_id AND r.project_id=p.id
   AND (r.enabled OR EXISTS(SELECT FROM public.alerts a WHERE a.rule_id=r.id AND a.status IN ('active','pending')))
   AND (r.last_evaluated_at IS NULL OR r.last_evaluated_at<evaluated-interval '30 seconds' OR r.updated_at>r.last_evaluated_at))
  ORDER BY (SELECT min(coalesce(r.last_evaluated_at,'-infinity'::timestamptz)) FROM public.alert_rules r WHERE r.project_id=p.id),p.id
  LIMIT 1 FOR UPDATE OF p SKIP LOCKED;
 IF project.id IS NULL THEN RETURN NULL; END IF;
 PERFORM set_config('app.worker_project_id',project.id::text,true),set_config('app.worker_evaluated_at',evaluated::text,true);
 SELECT jsonb_build_object('evaluatedAt',evaluated,'project',jsonb_build_object('id',project.id,'organizationId',project.organization_id,'name',project.name,'timezone',project.timezone,'commissionedAt',project.commissioned_at),
  'rules',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'organizationId',r.organization_id,'projectId',r.project_id,'kind',r.kind,'name',r.name,'enabled',r.enabled,'persistenceSeconds',r.persistence_seconds,'recoverySeconds',r.recovery_seconds,'configuration',r.configuration,'createdAt',r.created_at,'updatedAt',r.updated_at,'lastEvaluatedAt',r.last_evaluated_at)) FROM public.alert_rules r WHERE r.organization_id=project.organization_id AND r.project_id=project.id),'[]'),
  'points',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'signConvention',p.sign_convention)) FROM public.measurement_points p WHERE p.organization_id=project.organization_id AND p.project_id=project.id),'[]'),
  'bindings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'measurementPointId',b.measurement_point_id,'deviceId',b.device_id,'configurationVersion',b.configuration_version,'validFrom',b.valid_from,'validTo',b.valid_to,'configuration',b.configuration)) FROM public.device_bindings b WHERE b.organization_id=project.organization_id AND b.project_id=project.id AND b.valid_to IS NULL),'[]'),
  'topologyVersions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'validFrom',v.valid_from,'validTo',v.valid_to,'configuration',v.configuration)) FROM public.topology_versions v WHERE v.organization_id=project.organization_id AND v.project_id=project.id AND v.valid_to IS NULL),'[]'),
  'latestSamples',coalesce((SELECT jsonb_agg(jsonb_build_object('eventId',s.event_id,'bindingId',s.binding_id,'measurementPointId',s.measurement_point_id,'deviceId',s.device_id,'configurationVersion',s.configuration_version,'measuredAt',s.measured_at,'receivedAt',s.received_at,'activePower',s.active_power,'importEnergy',s.import_energy,'exportEnergy',s.export_energy,'quality',s.quality,'source',s.source,'alarms',s.alarms)) FROM public.telemetry_latest l JOIN public.telemetry_samples s ON s.organization_id=l.organization_id AND s.event_id=l.event_id WHERE l.organization_id=project.organization_id AND l.project_id=project.id),'[]'),
  'states',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'ruleId',a.rule_id,'dedupKey',a.dedup_key,'status',a.status,'episodeId',a.episode_id,'candidateSince',a.candidate_since,'recoverySince',a.recovery_since,'activatedAt',a.activated_at,'resolvedAt',a.resolved_at,'lastEvaluatedAt',a.last_evaluated_at,'title',a.title,'message',a.message,'severity',a.severity,'detail',a.detail)) FROM public.alerts a WHERE a.organization_id=project.organization_id AND a.project_id=project.id),'[]'),
  'maintenanceWindows',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'from',m.starts_at,'to',m.ends_at,'cancelledAt',m.cancelled_at,'reason',m.reason)) FROM public.maintenance_windows m WHERE m.organization_id=project.organization_id AND m.project_id=project.id AND m.cancelled_at IS NULL AND m.ends_at>=evaluated),'[]')) INTO result;
 IF octet_length(result::text)>8388608 THEN RAISE EXCEPTION 'Contexto de alertas demasiado grande.' USING ERRCODE='54000'; END IF;
 RETURN result;
END $$;
ALTER FUNCTION public.worker_claim_alert_project() OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_claim_alert_project() FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_claim_alert_project() TO solar_worker;

CREATE FUNCTION public.worker_save_alert_evaluation(p_project_id uuid,p_evaluated_at timestamptz,p_results jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE project public.projects; plan jsonb; previous public.alerts; v_alert_id uuid; v_incident_id uuid; inserted_id uuid; v_event_kind public."AlertEventKind"; active_count integer:=0; resolved_count integer:=0;
BEGIN
 SELECT p.* INTO project FROM public.projects p WHERE p.id=p_project_id;
 IF project.id IS NULL OR p_project_id::text IS DISTINCT FROM current_setting('app.worker_project_id',true)
  OR p_evaluated_at IS DISTINCT FROM nullif(current_setting('app.worker_evaluated_at',true),'')::timestamptz
  OR jsonb_typeof(p_results) IS DISTINCT FROM 'array' OR jsonb_array_length(p_results)>4096 OR octet_length(p_results::text)>8388608 THEN
  RAISE EXCEPTION 'Evaluación fuera del contexto reclamado.' USING ERRCODE='42501';
 END IF;
 FOR plan IN SELECT value FROM jsonb_array_elements(p_results) LOOP
  IF NOT EXISTS(SELECT FROM public.alert_rules r WHERE r.organization_id=project.organization_id AND r.project_id=project.id AND r.id=(plan->>'ruleId')::uuid)
   OR plan->>'dedupKey' IS NULL OR length(plan->>'dedupKey')>256 OR length(plan->>'title')>240 OR length(plan->>'message')>4000
   OR (plan->>'lastEvaluatedAt')::timestamptz IS DISTINCT FROM p_evaluated_at THEN RAISE EXCEPTION 'Transición inválida.' USING ERRCODE='23514'; END IF;
  SELECT a.* INTO previous FROM public.alerts a WHERE a.organization_id=project.organization_id AND a.rule_id=(plan->>'ruleId')::uuid AND a.dedup_key=plan->>'dedupKey' FOR UPDATE;
  IF previous.id IS NOT NULL AND previous.last_evaluated_at>p_evaluated_at THEN RAISE EXCEPTION 'Evaluación fuera de orden.' USING ERRCODE='23514'; END IF;
  v_event_kind:=(plan->>'event')::public."AlertEventKind";
  IF (v_event_kind='activated' AND plan->>'status'<>'active') OR (v_event_kind='resolved' AND plan->>'status'<>'resolved')
   OR (v_event_kind='resolved' AND (previous.id IS NULL OR previous.status<>'active')) THEN RAISE EXCEPTION 'Evento incompatible con el estado.' USING ERRCODE='23514'; END IF;
  INSERT INTO public.alerts(id,organization_id,project_id,rule_id,dedup_key,status,episode_id,candidate_since,recovery_since,activated_at,resolved_at,last_evaluated_at,title,message,severity,detail)
   VALUES(coalesce(previous.id,gen_random_uuid()),project.organization_id,project.id,(plan->>'ruleId')::uuid,plan->>'dedupKey',(plan->>'status')::public."AlertStatus",(plan->>'episodeId')::uuid,(plan->>'candidateSince')::timestamptz,(plan->>'recoverySince')::timestamptz,(plan->>'activatedAt')::timestamptz,(plan->>'resolvedAt')::timestamptz,p_evaluated_at,plan->>'title',plan->>'message',(plan->>'severity')::public."AlertSeverity",coalesce(plan->'detail','{}'))
   ON CONFLICT(organization_id,rule_id,dedup_key) DO UPDATE SET status=EXCLUDED.status,episode_id=EXCLUDED.episode_id,candidate_since=EXCLUDED.candidate_since,recovery_since=EXCLUDED.recovery_since,activated_at=EXCLUDED.activated_at,resolved_at=EXCLUDED.resolved_at,last_evaluated_at=EXCLUDED.last_evaluated_at,title=EXCLUDED.title,message=EXCLUDED.message,severity=EXCLUDED.severity,detail=EXCLUDED.detail RETURNING id INTO v_alert_id;
  IF v_event_kind IS NOT NULL THEN
   inserted_id:=NULL;
   INSERT INTO public.alert_events(id,organization_id,project_id,alert_id,episode_id,kind,detail,created_at)
    VALUES(gen_random_uuid(),project.organization_id,project.id,v_alert_id,(plan->>'episodeId')::uuid,v_event_kind,coalesce(plan->'detail','{}')||jsonb_build_object('title',plan->>'title','message',plan->>'message','severity',plan->>'severity'),p_evaluated_at)
    ON CONFLICT(alert_id,episode_id,kind) DO NOTHING RETURNING id INTO inserted_id;
   IF inserted_id IS NOT NULL THEN
    INSERT INTO public.notification_outbox(id,organization_id,project_id,alert_id,episode_id,event_kind,event_key,payload,status,attempts,next_attempt_at,created_at)
     VALUES(gen_random_uuid(),project.organization_id,project.id,v_alert_id,(plan->>'episodeId')::uuid,v_event_kind,v_alert_id::text||':'||(plan->>'episodeId')||':'||v_event_kind::text,jsonb_build_object('alertId',v_alert_id,'episodeId',plan->>'episodeId','title',plan->>'title','message',plan->>'message','severity',plan->>'severity'),'pending',0,p_evaluated_at,p_evaluated_at)
     ON CONFLICT(alert_id,episode_id,event_kind) DO NOTHING;
    IF v_event_kind='activated' THEN
     active_count:=active_count+1; v_incident_id:=NULL;
     INSERT INTO public.incidents(id,organization_id,project_id,alert_id,alert_episode_id,title,description,status,created_at,updated_at)
      VALUES(gen_random_uuid(),project.organization_id,project.id,v_alert_id,(plan->>'episodeId')::uuid,plan->>'title',plan->>'message','open',p_evaluated_at,p_evaluated_at)
      ON CONFLICT(alert_id,alert_episode_id) DO NOTHING RETURNING id INTO v_incident_id;
     IF v_incident_id IS NOT NULL THEN INSERT INTO public.incident_events(id,organization_id,project_id,incident_id,kind,detail,created_at) VALUES(gen_random_uuid(),project.organization_id,project.id,v_incident_id,'created',jsonb_build_object('source','alert','alertId',v_alert_id,'episodeId',plan->>'episodeId'),p_evaluated_at); END IF;
    ELSE resolved_count:=resolved_count+1; END IF;
   END IF;
  END IF;
 END LOOP;
 UPDATE public.alert_rules SET last_evaluated_at=p_evaluated_at WHERE organization_id=project.organization_id AND project_id=project.id;
 PERFORM set_config('app.worker_project_id','',true),set_config('app.worker_evaluated_at','',true);
 RETURN jsonb_build_object('activated',active_count,'resolved',resolved_count);
END $$;
ALTER FUNCTION public.worker_save_alert_evaluation(uuid,timestamptz,jsonb) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_save_alert_evaluation(uuid,timestamptz,jsonb) FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_save_alert_evaluation(uuid,timestamptz,jsonb) TO solar_worker;

CREATE FUNCTION public.worker_claim_notification(p_worker_id text,p_lease_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE row_data public.notification_outbox;
BEGIN
 IF p_worker_id IS NULL OR length(p_worker_id)>128 OR p_lease_hash IS NULL OR p_lease_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Worker inválido.' USING ERRCODE='22023'; END IF;
 SELECT n.* INTO row_data FROM public.notification_outbox n WHERE n.status='pending' AND n.attempts<5 AND n.next_attempt_at<=clock_timestamp() AND (n.locked_until IS NULL OR n.locked_until<clock_timestamp()) ORDER BY n.next_attempt_at,n.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF row_data.id IS NULL THEN RETURN NULL; END IF;
 UPDATE public.notification_outbox SET attempts=attempts+1,locked_until=clock_timestamp()+interval '60 seconds',lease_token_hash=p_lease_hash,worker_id=p_worker_id WHERE id=row_data.id RETURNING * INTO row_data;
 RETURN jsonb_build_object('id',row_data.id,'organizationId',row_data.organization_id,'projectId',row_data.project_id,'eventKey',row_data.event_key,'payload',row_data.payload,'attempts',row_data.attempts,'createdAt',row_data.created_at);
END $$;
ALTER FUNCTION public.worker_claim_notification(text,text) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_claim_notification(text,text) FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_claim_notification(text,text) TO solar_worker;

CREATE FUNCTION public.worker_complete_notification(p_id uuid,p_lease_hash text,p_success boolean,p_error_code text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE row_data public.notification_outbox;
BEGIN
 SELECT n.* INTO row_data FROM public.notification_outbox n WHERE n.id=p_id AND n.status='pending' AND n.lease_token_hash=p_lease_hash AND n.locked_until>=clock_timestamp() FOR UPDATE;
 IF row_data.id IS NULL THEN RAISE EXCEPTION 'Notificación fuera de lease.' USING ERRCODE='42501'; END IF;
 IF p_success IS NULL OR (NOT p_success AND (p_error_code IS NULL OR p_error_code !~ '^[A-Z0-9_]{1,80}$')) THEN RAISE EXCEPTION 'Resultado inválido.' USING ERRCODE='22023'; END IF;
 UPDATE public.notification_outbox SET status=CASE WHEN p_success THEN 'delivered'::public."NotificationStatus" WHEN attempts>=5 THEN 'failed'::public."NotificationStatus" ELSE 'pending'::public."NotificationStatus" END,
  delivered_at=CASE WHEN p_success THEN clock_timestamp() ELSE NULL END,last_error=CASE WHEN p_success THEN NULL ELSE p_error_code END,
  next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,5*(2^attempts)::integer)),locked_until=NULL,lease_token_hash=NULL,worker_id=NULL WHERE id=p_id;
END $$;
ALTER FUNCTION public.worker_complete_notification(uuid,text,boolean,text) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_complete_notification(uuid,text,boolean,text) FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_complete_notification(uuid,text,boolean,text) TO solar_worker;
COMMIT;

BEGIN;
CREATE FUNCTION public.worker_report_metadata(p_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('id',r.id,'organizationId',r.organization_id,'projectId',r.project_id,'projectName',p.name,'requestedBy',r.requested_by,
  'idempotencyKey',r.idempotency_key,'timezone',r.timezone,'startDate',r.start_date,'endDate',r.end_date,'from',r.period_from,'to',r.period_to,
  'status',r.status,'attempts',r.attempts,'nextAttemptAt',r.next_attempt_at,'leaseUntil',r.lease_until,'artifactKey',r.artifact_key,'sha256',r.sha256,
  'byteLength',r.byte_length,'snapshotJson',r.snapshot_json,'errorCode',r.error_code,'createdAt',r.created_at,'updatedAt',r.updated_at,'completedAt',r.completed_at)
 FROM public.report_jobs r JOIN public.projects p ON p.organization_id=r.organization_id AND p.id=r.project_id WHERE r.id=p_id
$$;
ALTER FUNCTION public.worker_report_metadata(uuid) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_report_metadata(uuid) FROM PUBLIC,solar_worker,solar_runtime,solar_auth,solar_ingest;

CREATE FUNCTION public.worker_claim_report_job(p_worker_id text,p_lease_hash text,p_lease_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE job public.report_jobs;
BEGIN
 IF p_worker_id IS NULL OR length(p_worker_id)>128 OR p_lease_hash IS NULL OR p_lease_hash !~ '^[a-f0-9]{64}$'
  OR p_lease_until IS NULL OR p_lease_until<=clock_timestamp() OR p_lease_until>clock_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'Lease inválido.' USING ERRCODE='22023'; END IF;
 UPDATE public.report_jobs SET status='failed',error_code='LEASE_EXHAUSTED',lease_token_hash=NULL,lease_until=NULL,worker_id=NULL,updated_at=clock_timestamp()
  WHERE id IN(SELECT r.id FROM public.report_jobs r WHERE r.status='processing' AND r.lease_until<clock_timestamp() AND r.attempts>=3 LIMIT 100 FOR UPDATE SKIP LOCKED);
 SELECT r.* INTO job FROM public.report_jobs r WHERE r.attempts<3 AND ((r.status='queued' AND r.next_attempt_at<=clock_timestamp()) OR (r.status='processing' AND r.lease_until<clock_timestamp()))
  ORDER BY r.next_attempt_at,r.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF job.id IS NULL THEN RETURN NULL; END IF;
 UPDATE public.report_jobs SET status='processing',attempts=attempts+1,lease_token_hash=p_lease_hash,lease_until=p_lease_until,worker_id=p_worker_id,error_code=NULL,updated_at=clock_timestamp() WHERE id=job.id;
 RETURN public.worker_report_metadata(job.id);
END $$;
ALTER FUNCTION public.worker_claim_report_job(text,text,timestamptz) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_claim_report_job(text,text,timestamptz) FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_claim_report_job(text,text,timestamptz) TO solar_worker;

CREATE FUNCTION public.worker_renew_report_job(p_id uuid,p_lease_hash text,p_lease_until timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_lease_until IS NULL OR p_lease_until<=clock_timestamp() OR p_lease_until>clock_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'Lease inválido.' USING ERRCODE='22023'; END IF;
 UPDATE public.report_jobs SET lease_until=p_lease_until,updated_at=clock_timestamp() WHERE id=p_id AND status='processing' AND lease_token_hash=p_lease_hash AND lease_until>=clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'Informe fuera de lease.' USING ERRCODE='42501'; END IF;
END $$;
ALTER FUNCTION public.worker_renew_report_job(uuid,text,timestamptz) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_renew_report_job(uuid,text,timestamptz) FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_renew_report_job(uuid,text,timestamptz) TO solar_worker;

CREATE FUNCTION public.worker_report_context(p_id uuid,p_lease_hash text,p_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE job public.report_jobs; result jsonb; p_from timestamptz; p_to timestamptz; sample_count integer;
BEGIN
 SELECT r.* INTO job FROM public.report_jobs r WHERE r.id=p_id AND r.status='processing' AND r.lease_token_hash=p_lease_hash AND r.lease_until>=clock_timestamp() FOR SHARE;
 IF job.id IS NULL OR p_date IS NULL OR p_date<job.start_date OR p_date>job.end_date THEN RAISE EXCEPTION 'Día de informe fuera de lease.' USING ERRCODE='42501'; END IF;
 p_from:=p_date::timestamp AT TIME ZONE job.timezone; p_to:=(p_date+1)::timestamp AT TIME ZONE job.timezone;
 SELECT count(*) INTO sample_count FROM public.telemetry_samples s JOIN public.measurement_points p ON p.organization_id=s.organization_id AND p.id=s.measurement_point_id
  WHERE p.organization_id=job.organization_id AND p.project_id=job.project_id AND s.measured_at>=p_from AND s.measured_at<=p_to AND s.received_at<=job.created_at AND s.ingested_at<=job.created_at AND s.ingestion_sequence<=job.snapshot_sequence;
 IF sample_count>200000 THEN RAISE EXCEPTION 'Máximo 200000 observaciones por día de informe.' USING ERRCODE='54000'; END IF;
 WITH project_points AS (SELECT p.id FROM public.measurement_points p WHERE p.organization_id=job.organization_id AND p.project_id=job.project_id), selected_samples AS MATERIALIZED (
  SELECT s.* FROM public.telemetry_samples s JOIN project_points p ON p.id=s.measurement_point_id WHERE s.organization_id=job.organization_id AND s.measured_at>=p_from AND s.measured_at<=p_to AND s.received_at<=job.created_at AND s.ingested_at<=job.created_at AND s.ingestion_sequence<=job.snapshot_sequence
  UNION SELECT s.* FROM project_points p CROSS JOIN LATERAL(SELECT t.* FROM public.telemetry_samples t WHERE t.organization_id=job.organization_id AND t.measurement_point_id=p.id AND t.measured_at<p_from AND t.received_at<=job.created_at AND t.ingested_at<=job.created_at AND t.ingestion_sequence<=job.snapshot_sequence ORDER BY t.measured_at DESC,t.event_id DESC LIMIT 1) s
  UNION SELECT s.* FROM project_points p CROSS JOIN LATERAL(SELECT t.* FROM public.telemetry_samples t WHERE t.organization_id=job.organization_id AND t.measurement_point_id=p.id AND t.measured_at>p_to AND t.received_at<=job.created_at AND t.ingested_at<=job.created_at AND t.ingestion_sequence<=job.snapshot_sequence ORDER BY t.measured_at,t.event_id LIMIT 1) s
 )
 SELECT jsonb_build_object('projectId',job.project_id,'timezone',job.timezone,
  'points',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'signConvention',p.sign_convention)) FROM public.measurement_points p WHERE p.organization_id=job.organization_id AND p.project_id=job.project_id),'[]'),
  'bindings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'measurementPointId',b.measurement_point_id,'deviceId',b.device_id,'configurationVersion',b.configuration_version,'validFrom',b.valid_from,'validTo',b.valid_to,'configuration',b.configuration)) FROM public.device_bindings b WHERE b.organization_id=job.organization_id AND b.project_id=job.project_id AND ((b.valid_from<=p_to AND (b.valid_to IS NULL OR b.valid_to>=p_from)) OR b.id IN(SELECT s.binding_id FROM selected_samples s))),'[]'),
  'topologyVersions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'validFrom',v.valid_from,'validTo',v.valid_to,'configuration',v.configuration) ORDER BY v.version) FROM public.topology_versions v WHERE v.organization_id=job.organization_id AND v.project_id=job.project_id AND v.valid_from<=p_to AND (v.valid_to IS NULL OR v.valid_to>=p_from)),'[]'),
  'samples',coalesce((SELECT jsonb_agg(jsonb_build_object('eventId',s.event_id,'bindingId',s.binding_id,'deviceId',s.device_id,'measurementPointId',s.measurement_point_id,'configurationVersion',s.configuration_version,'measuredAt',s.measured_at,'receivedAt',s.received_at,'activePower',s.active_power,'importEnergy',s.import_energy,'exportEnergy',s.export_energy,'quality',s.quality,'source',s.source,'phases',s.phases,'alarms',s.alarms) ORDER BY s.measured_at,s.event_id) FROM selected_samples s),'[]')) INTO result;
 IF octet_length(result::text)>67108864 THEN RAISE EXCEPTION 'Contexto de informe demasiado grande.' USING ERRCODE='54000'; END IF;
 RETURN result;
END $$;
ALTER FUNCTION public.worker_report_context(uuid,text,date) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_report_context(uuid,text,date) FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_report_context(uuid,text,date) TO solar_worker;

CREATE FUNCTION public.worker_complete_report_job(p_id uuid,p_lease_hash text,p_artifact jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE job public.report_jobs;
BEGIN
 SELECT r.* INTO job FROM public.report_jobs r WHERE r.id=p_id AND r.status='processing' AND r.lease_token_hash=p_lease_hash AND r.lease_until>=clock_timestamp() FOR UPDATE;
 IF job.id IS NULL THEN RAISE EXCEPTION 'Informe fuera de lease.' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_artifact) IS DISTINCT FROM 'object' OR (p_artifact->>'artifactKey') IS DISTINCT FROM 'reports/'||job.organization_id::text||'/'||p_id::text||'/'||(p_artifact->>'sha256')||'.pdf'
  OR p_artifact->>'sha256' IS NULL OR p_artifact->>'sha256' !~ '^[a-f0-9]{64}$' OR (p_artifact->>'byteLength')::integer NOT BETWEEN 1 AND 52428800
  OR jsonb_typeof(p_artifact->'snapshotJson') IS DISTINCT FROM 'object' OR octet_length(p_artifact::text)>8388608 THEN RAISE EXCEPTION 'Artefacto inválido.' USING ERRCODE='22023'; END IF;
 UPDATE public.report_jobs SET status='completed',artifact_key=p_artifact->>'artifactKey',sha256=p_artifact->>'sha256',byte_length=(p_artifact->>'byteLength')::integer,snapshot_json=p_artifact->'snapshotJson',
  completed_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token_hash=NULL,lease_until=NULL,worker_id=NULL,error_code=NULL
  WHERE id=p_id AND status='processing' AND lease_token_hash=p_lease_hash AND lease_until>=clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'Informe fuera de lease.' USING ERRCODE='42501'; END IF;
END $$;
ALTER FUNCTION public.worker_complete_report_job(uuid,text,jsonb) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_complete_report_job(uuid,text,jsonb) FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_complete_report_job(uuid,text,jsonb) TO solar_worker;

CREATE FUNCTION public.worker_fail_report_job(p_id uuid,p_lease_hash text,p_error_code text,p_retry_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_error_code IS NULL OR p_error_code !~ '^[A-Z0-9_]{1,80}$' OR p_retry_at IS NULL OR p_retry_at<clock_timestamp() OR p_retry_at>clock_timestamp()+interval '1 day' THEN RAISE EXCEPTION 'Reintento inválido.' USING ERRCODE='22023'; END IF;
 UPDATE public.report_jobs SET status=CASE WHEN attempts>=3 THEN 'failed'::public."ReportJobStatus" ELSE 'queued'::public."ReportJobStatus" END,error_code=p_error_code,next_attempt_at=p_retry_at,
  updated_at=clock_timestamp(),lease_token_hash=NULL,lease_until=NULL,worker_id=NULL WHERE id=p_id AND status='processing' AND lease_token_hash=p_lease_hash AND lease_until>=clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'Informe fuera de lease.' USING ERRCODE='42501'; END IF;
END $$;
ALTER FUNCTION public.worker_fail_report_job(uuid,text,text,timestamptz) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.worker_fail_report_job(uuid,text,text,timestamptz) FROM PUBLIC,solar_runtime,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.worker_fail_report_job(uuid,text,text,timestamptz) TO solar_worker;

CREATE FUNCTION public.app_consume_download_lease(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE lease public.download_leases;
BEGIN
 SELECT d.* INTO lease FROM public.download_leases d JOIN public.report_jobs r ON r.organization_id=d.organization_id AND r.project_id=d.project_id AND r.id=d.report_job_id
  WHERE d.token_hash=p_token_hash AND d.user_id=public.app_user_id() AND d.expires_at>clock_timestamp() AND d.consumed_at IS NULL AND d.revoked_at IS NULL
   AND r.status='completed' AND public.app_can_project(d.organization_id,d.project_id) AND (r.requested_by=public.app_user_id() OR public.app_is_admin(d.organization_id)) FOR UPDATE OF d;
 IF lease.id IS NULL THEN RAISE EXCEPTION 'Descarga expirada o no autorizada.' USING ERRCODE='42501'; END IF;
 UPDATE public.download_leases SET consumed_at=clock_timestamp() WHERE id=lease.id;
 RETURN public.worker_report_metadata(lease.report_job_id);
END $$;
ALTER FUNCTION public.app_consume_download_lease(text) OWNER TO solar_security_guard;
REVOKE ALL ON FUNCTION public.app_consume_download_lease(text) FROM PUBLIC,solar_worker,solar_auth,solar_ingest;
GRANT EXECUTE ON FUNCTION public.app_consume_download_lease(text) TO solar_runtime;

DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='solar_backup') THEN
  CREATE ROLE solar_backup LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
END $$;
ALTER ROLE solar_backup NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE solar_backup SET timezone='UTC';
REVOKE solar_security_guard,solar_migrator FROM solar_backup;
REVOKE CREATE ON SCHEMA public FROM solar_backup;
GRANT USAGE ON SCHEMA public TO solar_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM solar_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM solar_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO solar_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO solar_backup;
COMMIT;

-- Additive optional device alarms: NULL means no report; [] is explicit no alarms.
BEGIN;
CREATE OR REPLACE FUNCTION public.ingest_accept_event(p_context jsonb,p_payload jsonb,p_payload_hash text) RETURNS jsonb
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
     OR jsonb_typeof(coalesce(p_payload->'phases','[]'::jsonb))<>'array' OR (p_payload ? 'alarms' AND (jsonb_typeof(p_payload->'alarms')<>'array' OR jsonb_array_length(p_payload->'alarms')>32)) THEN reason:='invalid_payload'; END IF;
   END IF;
   IF p_payload ? 'alarms' AND reason IS NULL THEN
    IF EXISTS(SELECT FROM jsonb_array_elements(p_payload->'alarms') a WHERE jsonb_typeof(a)<>'object' OR a->>'code' IS NULL OR a->>'code' !~ '^[A-Za-z0-9_.:-]{1,80}$' OR a->>'severity' IS NULL OR a->>'severity' NOT IN ('warning','critical') OR jsonb_typeof(a->'active') IS DISTINCT FROM 'boolean') OR (SELECT count(*)<>count(DISTINCT a->>'code') FROM jsonb_array_elements(p_payload->'alarms') a) THEN reason:='invalid_payload'; END IF;
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
 INSERT INTO public.telemetry_samples(event_id,schema_version,organization_id,binding_id,device_id,measurement_point_id,configuration_version,measured_at,received_at,active_power,import_energy,export_energy,quality,source,gateway_identity_id,payload_hash,payload_json,phases,alarms)
  VALUES(event_id,'2.0',gateway.organization_id,binding.id,meter_id,point_id,version,measured,received,(p_payload->>'activePower')::numeric,(p_payload->>'importEnergy')::numeric,(p_payload->>'exportEnergy')::numeric,(p_payload->>'quality')::public."TelemetryQuality",gateway.source,gateway.id,body_hash,p_payload,coalesce(p_payload->'phases','[]'::jsonb),p_payload->'alarms');
 INSERT INTO public.telemetry_latest(organization_id,project_id,measurement_point_id,event_id,measured_at,received_at)
  VALUES(gateway.organization_id,binding.project_id,point_id,event_id,measured,received)
  ON CONFLICT(organization_id,measurement_point_id) DO UPDATE SET event_id=EXCLUDED.event_id,measured_at=EXCLUDED.measured_at,received_at=EXCLUDED.received_at
   WHERE EXCLUDED.measured_at>public.telemetry_latest.measured_at;
 RETURN jsonb_build_object('status','accepted','eventId',event_id,'storedEventId',event_id,'organizationId',gateway.organization_id,'projectId',binding.project_id,'measurementPointId',point_id,'bindingId',binding.id,'timezone',project_timezone);
END $$;
CREATE OR REPLACE FUNCTION public.ingest_load_project_context(p_project_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
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
  'samples',coalesce((SELECT jsonb_agg(jsonb_build_object('eventId',s.event_id,'bindingId',s.binding_id,'deviceId',s.device_id,'measurementPointId',s.measurement_point_id,'configurationVersion',s.configuration_version,'measuredAt',s.measured_at,'receivedAt',s.received_at,'activePower',s.active_power,'importEnergy',s.import_energy,'exportEnergy',s.export_energy,'quality',s.quality,'source',s.source,'phases',s.phases,'alarms',s.alarms) ORDER BY s.measured_at,s.event_id)
    FROM selected_samples s),'[]')) INTO result;
 RETURN result;
END $$;
COMMIT;
