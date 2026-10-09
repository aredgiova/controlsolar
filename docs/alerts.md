# Alertas, incidencias y monitor independiente — hito 6

El monitor evalúa políticas explícitas sobre proyectos puestos en marcha y telemetría persistida. Las alertas describen una observación que requiere revisión; no diagnostican una avería, rendimiento esperado por irradiancia ni estado de un equipo que no haya reportado ese dato. Los datos de prueba continúan identificados como simulados.

## Reglas y alcance

Las reglas se crean por proyecto; no se habilitan automáticamente. Solo owner/administrator puede crear o editar reglas, programar mantenimiento, asignar responsables y gestionar incidencias. Técnicos y clientes consultan únicamente los proyectos que tienen asignados. Las rutas usan sesión, empresa validada y RLS; no aceptan empresa, actor ni permisos dentro del cuerpo.

| Tipo | Política explícita | Condición |
| --- | --- | --- |
| `communication` | `staleAfterSeconds` | Falta lectura vigente de un punto requerido, o adquisición/recepción supera el umbral. Una lectura `missing` también indica falta de lectura del punto. |
| `invalid_data` | `maxMeasurementAgeSeconds` | El origen marca explícitamente como `invalid` una lectura reciente. Ausencia y antigüedad no se convierten en dato inválido. |
| `generation` | `startLocalTime`, `endLocalTime`, `weekdays`, `minimumPowerKw`, `maxMeasurementAgeSeconds` | Generación medida reciente bajo el mínimo durante la ventana local configurada. Fuera de ventana se recupera según la política. |
| `device_alarm` | `minimumSeverity`, `maxMeasurementAgeSeconds` | Un reporte explícito del equipo contiene un código activo con severidad suficiente. |

Todas las reglas tienen nombre, `enabled`, `persistenceSeconds` (300 por defecto) y `recoverySeconds` (120 por defecto). Los periodos admiten 0 para políticas de actuación inmediata. Un proyecto admite hasta 32 reglas. Cambiar la configuración provoca reevaluación; si cambia durante una ventana pendiente, la persistencia empieza de nuevo con la política actual.

La política de generación siempre requiere horario y mínimo elegidos por el administrador. Los días usan 0=domingo a 6=sábado y la zona IANA del proyecto. Las ventanas pueden cruzar medianoche; su tramo después de medianoche corresponde al día de inicio. No se calcula una expectativa solar sin irradiancia ni se trata ausencia como potencia cero. Un cero medido sí puede incumplir un mínimo configurado. Una topología incompleta o un proyecto sin puesta en marcha no produce un diagnóstico de comunicación/generación.

La comunicación distingue adquisición y recepción: reenviar hoy un dato antiguo no acredita una lectura actual. Al instalar un medidor o crear una regla se concede el umbral inicial para recibir su primera lectura; esa espera no acredita una recuperación. El balance y los puntos elegidos siguen la topología/asignación vigente.

## Persistencia, recuperación e historial

Una condición anómala comienza como `pending`. Se activa únicamente si permanece observable durante toda la persistencia configurada. Cada episodio tiene un UUID estable, y cada transición activada/resuelta tiene una restricción única por alerta/episodio/tipo. Evaluaciones repetidas no duplican eventos, incidencias ni notificaciones.

La recuperación también exige continuidad durante su ventana. Evidencia desconocida —datos ausentes, obsoletos, configuración incompleta o mantenimiento— cancela la ventana pendiente/de recuperación. Una alerta activa se conserva hasta tener evidencia suficiente de recuperación o desactivar explícitamente su regla. Datos fuera de orden no hacen retroceder el estado reciente, y una evaluación más antigua no sobrescribe una nueva.

La activación abre una incidencia por episodio en la misma transacción. La incidencia conserva título, explicación y vínculo con el episodio original. Recuperar la alerta no cierra el trabajo operativo. Un administrador puede asignarla a otro administrador o a un técnico activo asignado al proyecto, añadir observaciones y pasarla a `in_progress`. El cierre exige una resolución y registra quién/cuándo lo hizo. Una incidencia cerrada mantiene su resolución; se pueden añadir observaciones posteriores sin reescribir su cierre.

`AlertEvent` e `IncidentEvent` forman historiales append-only. Los cambios manuales también escriben `AuditEvent` con el actor real; los eventos automáticos se identifican como sistema, sin atribuirlos a un usuario ficticio. La historia de la incidencia y la alerta permanece aunque se cambie un responsable o aparezca un episodio posterior.

## Mantenimiento programado

Cada ventana define proyecto, inicio, fin y motivo, con máximo 90 días de duración. Una ventana vigente y no cancelada suspende activaciones nuevas y rompe ventanas de persistencia/recuperación. Conserva las alertas e incidencias ya abiertas y su historial. Cancelarla exige permiso de administración y queda auditado. No borra eventos ni oculta retrospectivamente una alerta emitida.

## Alarmas de equipo y contrato 2.0

La extensión aditiva opcional de telemetría es:

```json
"alarms": [{"code": "CODIGO_REPORTADO_POR_EL_EQUIPO", "severity": "warning", "active": true}]
```

Se permiten hasta 32 códigos únicos, con severidad `warning`/`critical`. La omisión del campo —persistida como `null`— significa que no hubo reporte/soporte; **no resuelve** una alarma existente. Un reporte explícito `[]` significa un snapshot sin alarmas activas. Un código `active:false` también permite recuperar ese código, respetando la ventana configurada.

El driver SDM630MCT actual no inventa registros Modbus de alarmas ni añade ese campo sin soporte documentado. La política de alarmas de equipo permanece sin evidencia mientras el origen no las reporte. El escenario `device_alarm` del simulador usa el código `SIMULATED_DEMO`, con fuente `simulator`, para probar activación y recuperación locales.

## Outbox y notificaciones locales

Alerta, historial, incidencia y fila de outbox se confirman en una misma transacción. La publicación in-app cambia esa fila a `delivered`; las consultas del usuario muestran solo notificaciones publicadas de sus proyectos autorizados. No exponen tokens de lease ni datos internos del worker.

La reclamación de la outbox usa un lease de 60 segundos y bloqueo de fila. Un fallo conserva la notificación pendiente con un código fijo, incrementa intentos y aplica espera exponencial; tras cinco intentos queda `failed`. El estado se conserva entre reinicios. Un evento/episodio solo tiene una fila, de modo que el reintento no crea otro aviso.

No se envían correo, WhatsApp, SMS ni webhooks. El punto de publicación se puede adaptar posteriormente, pero la implementación habilitada es únicamente in-app. La prueba de reintentos inyecta un fallo local y comprueba la posterior publicación durable, sin contactar servicios externos.

## Ejecución independiente

El proceso de monitor no depende de una página abierta ni de una sesión de navegador. Usa `WORKER_DATABASE_URL` con el rol separado `solar_worker`, UTC, sin propiedad de tablas, privilegios directos, superusuario ni bypass de RLS. Fuera de desarrollo local se exige TLS verificado. Las funciones SQL estrechas reclaman un proyecto, devuelven su snapshot y aceptan transiciones únicamente dentro de ese contexto/reloj evaluado.

```powershell
# Una evaluación y drenaje local de outbox.
npm run monitor -- --once

# Proceso continuo; requiere supervisión/reinicio del proceso en el despliegue.
npm run monitor -- --interval-ms 30000 --max-projects 100 --max-notifications 100
```

Cada ciclo devuelve únicamente conteos y fecha. Los proyectos se reevaluan aproximadamente cada 30 segundos, o antes tras una edición de política. Varios procesos usan reclamación/bloqueos para no trabajar simultáneamente sobre el mismo proyecto o aviso. Los límites por ciclo son explícitos; no se presenta este ensayo como certificación de capacidad productiva.

API de servidor: `runMonitoringCycle({maxProjects,maxNotifications})` devuelve `{projects,activated,resolved,notificationsDelivered,notificationsFailed}`. Las transacciones de evaluación y publicación son cortas e independientes. Si una transacción falla, no queda una alerta sin su incidencia/outbox ni una publicación parcialmente confirmada.

## Servicios y rutas de gestión

Las listas devuelven `{items,total,page,pageSize}` y admiten paginación acotada/filtro de proyecto. Los historiales están acotados a 200 eventos por consulta. Todos los endpoints están bajo `/api/v1/organizations/{organizationId}`:

| Recurso | Operaciones |
| --- | --- |
| `/alert-rules` | GET, POST; PATCH `/{ruleId}`. Proyecto/tipo no se cambian al editar. |
| `/alerts` | GET, filtros estado/tipo; GET `/{alertId}` con historial. |
| `/incidents` | GET, POST; GET/PATCH `/{incidentId}`; POST `/{incidentId}/observations`. |
| `/maintenance-windows` | GET, POST; PATCH `/{windowId}` con `{cancelled:true}`. |
| `/notifications` | GET de avisos in-app publicados y autorizados. |

El endpoint de alertas no permite al cliente fabricar transiciones. El endpoint de incidencias exige resolución para `status:"closed"`. La recuperación automática y el cierre operativo son acciones independientes.

## Evidencia local y límites

Las pruebas puras cubren esquemas estrictos, ventanas locales/nocturnas, persistencia/recuperación, supresión de repetidos, evidencia desconocida, datos atrasados, mantenimiento y reportes de alarmas presentes/omitidos. La integración PostgreSQL comprueba el flujo anomalía→incidencia→asignación→observación→recuperación→cierre auditado, clientes/técnicos asignados, empresa ajena, reintento de outbox, mantenimiento, alarmas explícitas y ejecución real del CLI independiente.

El ensayo de carga del hito 7 está en [qa/h67-benchmark.json](qa/h67-benchmark.json). Se reproduce con `npm run benchmark -- --env-file archivo-local-test.json`. Usa dos instaladoras y cinco proyectos ficticios, 600 observaciones nuevas y 10 retransmisiones; valida continuidad energética, estado reciente, aislamiento y vaciado de un buffer local de reconexión. Sus p50/p95/p99 y throughput son mediciones locales con pocos paquetes, sin hardware/red de campo ni SQS/AWS real. No permite inferir costes ni un límite de instalaciones en producción.
