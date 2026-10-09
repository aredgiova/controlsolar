# API de gestión y consulta de mediciones

Las rutas se sirven bajo `/api/v1`, requieren la cookie de sesión y una identidad con correo verificado. Las escrituras exigen `Origin` del mismo sitio y `Content-Type: application/json`. Las respuestas tienen `Cache-Control: private, no-store`. El UUID de organización de la URL selecciona el ámbito: nunca autoriza por sí mismo. PostgreSQL vuelve a verificar membresía activa y acceso al proyecto mediante RLS con el rol de ejecución.

Los hitos 4/5 añaden estas rutas. La adquisición MQTT/SQS es un proceso separado con credenciales `solar_ingest`; no existe un endpoint público web para subir telemetría.

H6/H7 añaden las rutas siguientes. Las mutaciones de reglas, mantenimiento e incidencias requieren titular/administrador; técnicos y propietarios consultan su ámbito. Todos los usuarios con acceso vigente al proyecto pueden solicitar reportes; los listados/descargas aplican además permisos del solicitante. Los límites compartidos devuelven 429 y Retry-After; ver [operación](operations-h67.md).

| Ruta relativa | Método | Operación |
| --- | --- | --- |
| `/organizations/:org/alert-rules` | GET / POST | Reglas / crear política explícita, persistencia y recuperación. Contratos en src/contracts/alerts.ts. |
| `/organizations/:org/alert-rules/:id` | PATCH | Cambiar nombre, estado, tiempos o configuración completa conservando tipo/proyecto. |
| `/organizations/:org/alerts` | GET | Listado paginado; status pending/active/resolved, projectId, kind, search. Sin status muestra sólo alertas emitidas. |
| `/organizations/:org/alerts/:id` | GET | Condición e historial de hasta 200 transiciones. |
| `/organizations/:org/incidents` | GET / POST | Listado / crear {projectId,title,description?,assigneeUserId?,alertId?}. |
| `/organizations/:org/incidents/:id` | GET / PATCH | Historial / {assigneeUserId?,status?,resolution?}; closed exige resolución. |
| `/organizations/:org/incidents/:id/observations` | POST | Añadir {note} al historial. |
| `/organizations/:org/maintenance-windows` | GET / POST | Listado / {projectId,from,to,reason}; fechas ISO con zona. |
| `/organizations/:org/maintenance-windows/:id` | PATCH | Cancelar con {cancelled:true}. |
| `/organizations/:org/notifications` | GET | Avisos internos entregados, sin tokens ni leases de worker. |
| `/organizations/:org/projects/:id/reports` | GET / POST | Listado / {startDate,endDate,idempotencyKey}; 202 para solicitud, días locales inclusivos, máximo31. |
| `/organizations/:org/reports/:id/download-lease` | POST | Cuerpo {}; autorización temporal de cinco minutos, usuario y proyecto vigentes. |
| `/organizations/:org/reports/:id/download?token=...` | GET | PDF privado; consume autorización una vez, vuelve a verificar sesión y asignación. |

Un reporte no expone artifactKey, snapshot, hash de lease ni URL pública. La descarga responde application/pdf, attachment y no-store. Nunca enviar su token a terceros; el token no sustituye una sesión vigente. Los workers no se disparan desde GET de páginas: se ejecutan por separado.

| Ruta relativa | Método | Operación / cuerpo |
| --- | --- | --- |
| `/organizations/:org/gateways` | GET | Registro paginado de identidades; solo titular/administrador. |
| `/organizations/:org/gateways` | POST | `{name,gatewayDeviceId,source:"simulator"\|"aws_iot",principalId,meterDeviceIds}`. Equipos activos de la misma empresa. Genera ID y cliente MQTT UUID iguales. |
| `/organizations/:org/gateways/:id` | PATCH | `{status:"revoked"}`; permanente, auditada y sin borrar lecturas históricas. |
| `/organizations/:org/projects/:id/telemetry?date=YYYY-MM-DD` | GET | Última potencia y recepción; energía, serie y cobertura del día civil en la zona del proyecto. Requiere acceso al proyecto. Sin fecha usa su día actual. |

El simulador solo se autoriza fuera de producción. AWS exige el identificador hexadecimal de 64 caracteres del certificado; no recibe la clave privada. Los campos de autoridad desconocidos se rechazan. La respuesta de telemetría diferencia la procedencia de la última lectura (`source`) y del día consultado (`daySource`), además de calidad y cobertura por métrica. Las ausencias conservan `value:null`. Una fecha imposible recibe 400 y un proyecto no asignado recibe 404. Ver [contrato y cálculos](telemetry.md) y [límites AWS](aws-ingestion.md).

| Ruta relativa | Método | Operación / cuerpo |
| --- | --- | --- |
| `/organizations` | GET / POST | Membresías actuales / crear `{name,slug,timezone}` |
| `/invitations/accept` | POST | Aceptar `{token}` solo con el correo verificado destinatario |
| `/organizations/:org/customers` | GET / POST | Listado paginado / crear `{name}` |
| `/organizations/:org/customers/:id` | PATCH | Editar `{name}` |
| `/organizations/:org/projects` | GET / POST | Listado paginado / crear `{customerId,name,location,latitude?,longitude?,capacityKwp,timezone,topologyType:"grid_tied_no_battery"}` |
| `/organizations/:org/projects/export` | GET | CSV de proyectos autorizados, máximo 10.000, protección frente a fórmulas |
| `/organizations/:org/projects/:id` | GET / PATCH | Detalle, participantes, puntos, asignaciones, versiones e historial / editar campos de proyecto |
| `/organizations/:org/projects/:id/points` | POST | `{name,kind,signConvention}` |
| `/organizations/:org/projects/:id/participants` | POST | `{userId,role:"technician"|"customer"}` |
| `/organizations/:org/projects/:id/participants/:userId` | DELETE | Retirar asignación al proyecto |
| `/organizations/:org/projects/:id/bindings` | POST | Vincular/sustituir `{deviceId,measurementPointId,validFrom,configuration:{channel,multiplier}}` |
| `/organizations/:org/projects/:id/topology` | POST | Versionar `{validFrom,configuration:{type:"grid_tied_no_battery",generationPointId,gridPointId,consumptionPointId:null|UUID}}` |
| `/organizations/:org/projects/:id/commissioning` | POST | `{commissionedAt,notes}`; requiere topología y medidores vigentes |
| `/organizations/:org/projects/:id/history` | GET | Historial auditado, máximo 100 eventos |
| `/organizations/:org/devices` | GET / POST | Inventario autorizado / `{name,serialNumber,kind:"gateway"|"meter"}` |
| `/organizations/:org/devices/:id` | PATCH | Editar `{name}` |
| `/organizations/:org/devices/:id/retire` | POST | Retirar equipo sin asignaciones vigentes, cuerpo `{}` |
| `/organizations/:org/memberships` | GET | Miembros con su usuario y proyectos asignados |
| `/organizations/:org/memberships/:id` | PATCH | `{role?,status?:"active"|"disabled"}` |
| `/organizations/:org/invitations` | GET / POST | Últimas 100 / `{email,role,projectIds:[]}` |
| `/organizations/:org/invitations/:id` | DELETE | Revocar invitación pendiente |

Los listados de clientes, proyectos y dispositivos devuelven `{items,total,page,pageSize}`; admiten `search`, `page` y `pageSize` (máximo 100). Los contratos estrictos están en `src/contracts/management.ts`; rechazan campos extra, incluido `organizationId` en cuerpos. Las entradas usan camelCase. Las salidas de dispositivo usan `serial` y las de proyecto usan `topology`; los decimales se serializan como cadenas. Fechas ISO 8601 con zona horaria; vigencias almacenadas en UTC.

Todas las escrituras iniciales de gestión requieren `owner` (titular de la organización) o `administrator`. Los roles `technician` y `customer` consultan únicamente proyectos asignados. Solo el titular puede administrar titulares, y siempre debe quedar uno activo. `customer` representa al propietario del sitio; no equivale a `owner` de la organización.

Una invitación vence en siete días. La creación devuelve `token` e `invitationPath` una sola vez para entrega manual; los listados, la base y la auditoría nunca muestran el token original. La aceptación verifica correo, caducidad, revocación y uso único en una transacción. No se envía correo en este hito.

Un reemplazo cierra la asignación anterior y abre la siguiente en una transacción, incrementando `configurationVersion`. Las ventanas son `[validFrom,validTo)`. Los equipos y puntos no pueden tener asignaciones superpuestas; no se reescriben mediciones previas. Los cambios de topología también producen versiones nuevas. Ninguna ruta crea telemetría ni control remoto.
