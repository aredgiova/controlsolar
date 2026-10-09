# Progreso de Monitoreo Solar

Fecha: **9 de octubre de 2026**. Hitos **2 y 3 implementados y comprobados localmente**. La validación con Cognito real y PostgreSQL/Hostinger de staging sigue pendiente. Se detiene la implementación antes del hito 4, conforme al alcance solicitado.

El encargo anterior de hitos 0/1 y su evidencia se conservan en [progress-h01.md](progress-h01.md). Los documentos TXT/DOCX originales se trataron como referencias; no se modificaron ni se ejecutaron instrucciones fuera de los hitos autorizados. Ante la consulta por servicios existentes, el usuario indicó: «Todavía no; avanza con la implementación y las pruebas locales».

## Entrega

- Cognito OIDC con Authorization Code/PKCE, state, nonce, verificación de firma/claims; login, callback, sesión opaca persistida por hash y logout con revocación. Configuración y límites en [authentication.md](authentication.md).
- Organizaciones, membresías, invitaciones con expiración/uso único y permisos por proyecto. Los titulares/administradores gestionan; técnicos y propietarios consultan solo proyectos asignados.
- PostgreSQL con roles distintos de migración, ejecución e identidad; 16 tablas con FORCE RLS, contexto por transacción, FK compuestas, restricciones temporales y auditoría. El servidor falla cerrado ante roles inseguros o una instalación incompleta. [Instalación](../prisma/security/README.md), [modelo](h23-schema.md).
- Pantallas de clientes, proyectos, dispositivos y equipo; alta/edición, asignaciones, puntos, vinculaciones/sustitución, topología versionada y puesta en marcha. Exportación CSV autorizada con protección ante fórmulas. [API de gestión](api-management.md).
- Demo preservada y explícitamente separada. Los registros persistentes muestran ausencia de datos; no hay ingesta ni control de equipos.

## Evidencia ejecutada

| Comprobación | Resultado |
| --- | --- |
| PostgreSQL 18.4 local | Instancia aislada en loopback, sin servicio Windows ni instalación del sistema. Datos/credenciales en `.work`, ignorados por Git. |
| Migración e instalación desde cero | Aplicadas como `solar_migrator` y administrador en una segunda base desechable; Prisma diff termina en 0, sin diferencias. Catálogo contrastado: 16 tablas, 129 columnas y 26 FK. |
| Pruebas SQL con credenciales efectivas | Roles sin bypass/ownership, RLS entre empresas, asignaciones, miembros deshabilitados, FK ajenas, exclusiones temporales, invitaciones y reutilización de conexión. También ejecutadas con `TZ=America/Bogota`; todos los tiempos son TIMESTAMPTZ/UTC. |
| Integración de negocio | CRUD, participantes, identificadores alterados, exportación limitada, muestras históricas de prueba preservadas tras sustituir, topología/puesta en marcha/retiro, TTL/correo/revocación/replay y carreras del último titular. |
| Integración de autenticación | PostgreSQL real, sesión opaca/hash/expiración, estado de un uso, revocación y logout de mismo origen; cookies de producción verificadas. OIDC se prueba con fixture firmado, sin Cognito real. |
| HTTP con build optimizado | 401 sin sesión, 403 origen ajeno, CRUD, permisos, CSV, invitaciones, puesta en marcha, sustitución y vista autorizada sin datos simulados. |
| Reinicio de aplicación | Sesión, proyecto, tres vinculaciones (una cerrada), topología, puesta en marcha y auditoría permanecen al volver a arrancar. |
| Chrome headless | Creación por formulario de cliente/proyecto/puntos/invitación; propietario sin formularios de administración y proyecto no asignado denegado. `pageErrors: []`. |
| Escritorio 1440×1050 / móvil 390×844 | Capturas de siete rutas en ambos tamaños y formularios expandidos; sin overflow documental. Ayudas visibles para tablas desplazables. Revisión independiente final PASS. |
| Demo preservada | Smoke HTTP y recorrido Chrome de dashboard/búsqueda/detalle, cambio de empresa, filtros de alertas, vacío, error/recuperación y desactualización pasaron tras los cambios. |
| Verificaciones estáticas | `db:validate`, `lint` (cero warnings) y `typecheck` terminaron en 0. Build optimizado correcto, sin consultar datos privados. |
| `npm test` | 18 aprobadas, cero fallos; 3 integraciones omitidas deliberadamente al no proporcionar conexiones. |
| `npm run test:integration` | 11 aprobadas, cero fallos y cero omitidas, con PostgreSQL local y roles efectivos. |
| `npm audit --omit=dev` | Cero avisos conocidos en dependencias de ejecución, comprobado tras añadir OIDC/JOSE. Los avisos de herramientas se conservan en [dependencies.md](dependencies.md). |

Las pruebas de integración se ejecutan con `npm run test:integration` y conexiones explícitas. La suite ordinaria omite esas pruebas si falta configuración; ese skip no es evidencia de aislamiento. Los scripts HTTP/browser crean únicamente identidades y datos ficticios en la base local. La aplicación no contiene un bypass de autenticación para desarrollo.

## Correcciones surgidas de las pruebas

Se resolvieron la inserción de invitaciones con Prisma, la auditoría al exportar como propietario y al cambiar el propio rol, la carrera de aceptación/revocación, la conservación de configuración histórica y el contexto UTC. La revisión de seguridad reforzó las funciones privilegiadas y la prohibición de falsificar invitaciones de titulares mediante SQL de ejecución.

La revisión de interfaz corrigió indicadores de scroll móvil, selección del cliente actual, borrado explícito de coordenadas, tratamiento de fechas inválidas, límites numéricos y destino tras aceptar una invitación. Los selectores paginados tienen búsquedas para localizar clientes/equipos; el cliente actual se conserva aunque esté fuera de los resultados. No quedan defectos materiales abiertos en la revisión realizada; no es una certificación completa de accesibilidad ni de navegadores.

## Pendientes externos

| Elemento | Estado |
| --- | --- |
| Cognito real | User Pool/cliente/dominio/callback/logout/correo/MFA y recorrido efectivo pendientes. |
| PostgreSQL staging | Proveedor, secretos, TLS, pooling y repetición de pruebas de permisos pendientes. |
| Hostinger/GitHub/dominio | Acceso, destino inequívoco, despliegue, logs y DNS no verificados ni modificados. |
| Equipos e ingesta | No conectados; el siguiente encargo sería el hito 4. |

La aceptación externa del hito 2 permanece abierta hasta validar Cognito y staging; no se anuncia preparación para clientes reales. No se contrataron servicios ni se enviaron invitaciones por correo.

## Reproducibilidad

La demo mantiene `.env.local` con sus tres flags originales. La configuración de QA persistente se suministró a procesos de prueba separados, sin sustituirla. Para repetir las integraciones, arrancar la base local de pruebas y usar el archivo privado `.work/pg-local/test-env.json` mediante `TEST_ENV_FILE`; el archivo contiene secretos y no se incluye en la entrega versionada.

En este equipo, desde la raíz del proyecto:

```powershell
$solarPgCtl = '.work/postgres-tools/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe'
& $solarPgCtl -D '.work/pg-local/data' -l '.work/pg-local/postgres.log' -o '-h 127.0.0.1 -p 55432' -w start
$env:TEST_ENV_FILE = '.work/pg-local/test-env.json'
npm run test:integration
& $solarPgCtl -D '.work/pg-local/data' -m fast -w stop
```

Al entregar se detuvo el servidor de QA persistente y PostgreSQL; los datos locales se conservaron. La demostración quedó disponible en [127.0.0.1:3100](http://127.0.0.1:3100/dashboard). Para revisar gestión con una identidad real, completar Cognito y utilizar las variables privadas del README; las sesiones sembradas para QA no constituyen una cuenta de usuario del producto.

Se usaron binarios PostgreSQL 18.4 del paquete específico Windows `@embedded-postgres/windows-x64@18.4.0-beta.17`, instalado solo bajo `.work/postgres-tools`, con scripts de instalación desactivados. El sufijo beta pertenece al empaquetado; la aplicación no depende de ese paquete ni del wrapper embedded-postgres. Para otro equipo puede utilizarse PostgreSQL independiente con la misma migración y roles.
