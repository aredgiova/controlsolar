# Contrato persistente de los hitos 2 y 3

`prisma/schema.prisma` es la fuente del cliente. La migración `202610090001_h23_baseline` crea una **base nueva** de PostgreSQL; el esquema inicial de los hitos 0/1 no tenía una base aplicada ni datos persistidos. No se debe usar esta baseline para reemplazar una base poblada.

| Modelo | Alcance y función |
| --- | --- |
| User, Session, AuthFlow | Identidad Cognito verificada, sesión opaca persistida solo como SHA-256 y estado OIDC de un uso. |
| Organization, Membership | Empresa y rol activo `owner`, `administrator`, `technician` o `customer`. |
| SiteAccess | Proyecto asignado a técnico o cliente. El rol debe coincidir con su membresía activa. |
| Invitation, InvitationProject | Invitación con correo, hash, expiración, revocación y proyectos autorizados. La aceptación bloquea el token y comprueba el correo verificado guardado. |
| Customer, Project | Cliente e instalación con ubicación, coordenadas opcionales, kWp, zona IANA, puesta en marcha y topología `grid_tied_no_battery`. |
| Device | Inventario de una empresa; serie única en esa empresa, sin acceso implícito por conocer la serie. |
| MeasurementPoint | Significado físico estable de generación, consumo o red, con convención de signo explícita. |
| DeviceBinding | Asignación temporal de equipo a punto/proyecto y versión de configuración. |
| TopologyVersion | Configuración inmutable por versión y período de vigencia. |
| AuditEvent | Registro de acciones anexado por actor autorizado, sin UPDATE/DELETE para ejecución. |
| TelemetrySample | Contrato reservado para hito 4, ligado a asignación, equipo, punto y versión históricos. La aplicación no puede insertar telemetría todavía. |

Las FK de organización/proyecto son compuestas. Las exclusiones GiST impiden intervalos superpuestos por equipo, punto y versión de topología. Los intervalos son `[desde, hasta)`: una sustitución cierra el anterior y abre el siguiente en el mismo instante. Los disparadores impiden modificar la identidad y configuración históricas o cerrar una asignación dejando muestras fuera del período. Todos los tiempos son `TIMESTAMPTZ(3)`; roles y pools usan UTC. La zona del proyecto se utiliza para presentar los tiempos.

La API de servidor toma `TenantIdentity { userId }` exclusivamente de la sesión verificada. `withTenant(identity, organizationId, callback(tx))` establece `app.user_id` y `app.organization_id` con `set_config(..., true)` dentro de la misma transacción y conexión del pool. Antes de ejecutar el callback comprueba el rol efectivo, UTC, FORCE RLS de todas las tablas y la membresía activa. `readTenantContext(tx)` devuelve el rol y permisos generales; el servicio y RLS verifican además el proyecto. `withIdentity` solo sirve para las funciones de arranque auditadas; no concede permiso general de empresa.

`listOrganizations(identity)` devuelve empresas autorizadas más rol actual. `createOrganization(identity, {name,slug,timezone})` y `acceptInvitation(identity,tokenHash)` llaman funciones SQL con identidad tomada del contexto, no de parámetros de solicitud. El creador obtiene membresía `owner`. Este rol administra la empresa; el cliente propietario de una instalación usa `customer` y solo ve proyectos asignados.

Instalación y pruebas de seguridad: [prisma/security/README.md](../prisma/security/README.md). Evidencia local: PostgreSQL 18.4, migración mediante `solar_migrator`, seguridad por administrador, 16 tablas con FORCE RLS, 129 columnas y 26 FK contrastadas con el esquema; `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` termina en 0. Las pruebas SQL de aislamiento, roles, sesiones, invitaciones y sustitución están en `tests/database.integration.test.ts` y requieren conexiones locales explícitas. La validación local no acredita Cognito ni staging remoto.

