# Contrato persistente H6/H7

Las migraciones aditivas `202610090003_h67_operations` y `202610090004_h67_snapshot_ingestion` conservan las baselines H2/3 y H4/5. Se añaden diez tablas, para un total de 32 con FORCE RLS; las fechas instantáneas son TIMESTAMPTZ(3) y los días civiles son DATE.

| Prisma / tabla | Identidad y comportamiento |
| --- | --- |
| AlertRule / alert_rules | Organización/proyecto; tipo communication, invalid_data, generation o device_alarm; configuración JSON, persistencia/recuperación en segundos, enabled y reloj lastEvaluatedAt del worker. |
| Alert / alerts | Única por organización/regla/dedupKey; estado pending/active/resolved, episodeId e instantes de candidatura/recuperación/activación/cierre. |
| AlertEvent / alert_events | Append-only; único alertId/episodeId/kind activated o resolved. |
| Incident / incidents | Organización/proyecto; enlace opcional al episodio; open/in_progress/closed, responsable activo autorizado al asignar, resolución y closedAt obligatorios al cerrar. |
| IncidentEvent / incident_events | Append-only; actor real para cambios manuales, actor null para acciones del sistema. |
| MaintenanceWindow / maintenance_windows | Intervalo starts_at/ends_at (Prisma from/to), motivo y creador; solo puede cancelarse una vez. |
| NotificationOutbox / notification_outbox | Única por alerta/episodio/evento; payload in-app, pending/delivered/failed, contador, lease y reintento durable. |
| ReportJob / report_jobs | Proyecto/solicitante/idempotencyKey; periodo local inclusivo <=31 días, zona congelada y from/to UTC; queued/processing/completed/failed, lease renovable, tres intentos, metadata/checksum/snapshot privados inmutables al terminar. |
| DownloadLease / download_leases | Hash de token, usuario/proyecto/informe, vigencia <=5 minutos; consumo único bajo permisos actuales. |
| RequestRateLimit / request_rate_limits | Tabla de sistema sin tenant ni políticas de lectura; scope/hash/windowStart y contador atómico. |

Toda relación entre entidades de proyecto utiliza claves foráneas compuestas con organización/proyecto. La consulta requiere `app_can_project`, membresía activa y asignación para técnicos/clientes. Owner/admin gestionan reglas, incidencias, responsables y mantenimiento. Los informes pertenecen a su solicitante o son consultables por administración; no se publican rutas privadas en listados HTTP.

`withAlertWorker` usa `withWorkerTransaction` con `solar_worker` y ofrece claimProject/saveEvaluation/claimNotification/completeNotification. La evaluación bloquea el proyecto hasta COMMIT/ROLLBACK; guarda alerta/evento/incidencia/outbox juntos. Las notificaciones solo llegan al adaptador local/in-app. La recuperación de una alerta no cierra automáticamente la incidencia.

El worker de PDF reclama trabajos mediante worker_claim_report_job, carga cada día con worker_report_context, renueva el lease, confirma con worker_complete_report_job o registra reintento con worker_fail_report_job. La solicitud bloquea el proyecto con la misma clave de ingesta y captura snapshotSequence, el máximo ingestionSequence ya confirmado. Cada consulta filtra por ese corte y por recibo/persistencia <=createdAt, incluidos vecinos; los paquetes SQS posteriores con recibo antiguo se excluyen. Cada día admite 200000 observaciones internas y vecinos inmediatos por punto, con límite de 64 MiB. La clave privada de artefacto es `reports/{organizationId}/{jobId}/{sha256}.pdf`. app_consume_download_lease vuelve a autorizar y consume el permiso atómicamente.

La extensión `TelemetrySample.alarms` es JSON nullable: null/ausencia significa que el equipo no reportó alarmas; [] representa un reporte explícito sin alarmas. Solo se aceptan códigos, severidad warning/critical y estado active explícitos. No se infieren registros ni capacidades de hardware.

Instalación, roles offline de backup y variables de prueba: [prisma/security/README.md](../prisma/security/README.md). La prueba SQL H67 cubre roles efectivos, RLS/FK, atomicidad/idempotencia, reintentos, concurrencia del rate limit, corte as-of de informes y redención única/revocada.
