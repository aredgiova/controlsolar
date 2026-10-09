# Monitoreo Solar

Plataforma para administrar y monitorear instalaciones solares. Los hitos **0 a 7 están implementados en su alcance local**: demostración, identidad/permisos, activos temporales, telemetría, gateway, alertas, incidencias, portal, informes privados, respaldo cifrado y ensayo de carga. **La aceptación externa sigue pendiente**: Cognito/staging/producción reales, AWS, kit físico y piloto con clientes autorizados. El cierre de preparación añade plantilla Cognito, incorporación offline de dispositivos, bundles de procesos y preflight de configuración. Seguir [el orden para conectar servicios reales](docs/connection-readiness.md).

## Demostración local

Con Node 24 LTS y npm:

```powershell
npm ci
# Solo en la primera preparación; conservar .env.local si ya existe.
Copy-Item .env.example .env.local
npm run dev
```

Abrir [localhost:3000](http://localhost:3000). La demostración contiene dos empresas ficticias y tres instalaciones por empresa, con fecha fija del 8 de octubre de 2026. Es de consulta, no guarda cambios y no acredita identidad. Se prohíbe con `APP_ENV=production`.

## Demostración en Vercel

La preparación para Vercel usa Node 24.x, `npm ci` y `npm run build:vercel`. En el proyecto de demo configurar `APP_ENV=staging`, `DATA_ADAPTER=demo` y `DEMO_MODE=true` para los scopes Preview y Production de Vercel; no necesita PostgreSQL, Cognito ni secretos. El scope Production de Vercel es independiente de `APP_ENV`: la demo conserva `staging` aunque tenga una URL estable.

Seguir [la guía de despliegue en Vercel](docs/deployment-vercel.md) para importar `aredgiova/controlsolar` en el alcance Vercel `aredlopez-8250s-projects`, vinculado al usuario GitHub `aredgiova`, revisar qué archivos se publican y verificar el despliegue con `DEMO_BASE_URL` y `npm run test:vercel:demo`. La configuración local preparada no implica que ya exista un despliegue remoto. Usar un proyecto separado al incorporar servicios y datos reales.

## Gestión persistente

Preparar PostgreSQL aislado siguiendo [la instalación de roles y RLS](prisma/security/README.md), y un User Pool / cliente de Cognito según [la configuración de identidad](docs/authentication.md). Configurar únicamente variables privadas del servidor:

| Variable | Uso |
| --- | --- |
| `APP_ENV` | `development`, `staging` o `production`; falta equivale a producción. |
| `DATA_ADAPTER`, `DEMO_MODE` | `postgres`, `false` para gestión; `demo`, `true` para ejemplos. |
| `DATABASE_URL` | Credenciales de `solar_runtime`, nunca propietario ni BYPASSRLS. |
| `AUTH_DATABASE_URL` | Credenciales distintas de `solar_auth`, solo funciones de identidad. |
| `APP_BASE_URL` | Origen de la aplicación, HTTPS en producción. |
| `COGNITO_ISSUER`, `COGNITO_CLIENT_ID` | User Pool y cliente autorizados. |
| `COGNITO_CLIENT_SECRET` | Opcional, si el cliente tiene secreto. |
| `COGNITO_DOMAIN` | Dominio HTTPS de inicio/cierre de sesión de Cognito. |
| `AUTH_SECRET` | Secreto aleatorio privado de al menos 32 bytes. |

`DATABASE_MIGRATION_URL` se proporciona **solo al proceso de migración**, con `solar_migrator`; no debe estar en el proceso web. `npm run db:migrate` ejecuta las migraciones pendientes. La instalación inicial de seguridad requiere el paso administrativo separado. El build no migra ni consulta registros privados. No usar `NEXT_PUBLIC_*` para secretos ni registrar URLs de conexión.

Al iniciar sesión se puede crear la organización y después registrar clientes, proyectos y dispositivos. El titular y los administradores gestionan la empresa; técnicos y propietarios de instalaciones consultan solo proyectos asignados. El equipo se incorpora por invitaciones de siete días y uso único. Los enlaces se comparten manualmente, sin envío automático de correo.

Las vinculaciones y topologías conservan versiones y vigencias. La puesta en marcha requiere una topología y medidores vigentes. El detalle permite consultar potencia, energía diaria, procedencia y cobertura, sin sustituir ausencias por cero. Los datos del simulador se identifican expresamente.

## Telemetría y primer gateway

1. Registrar un equipo gateway y sus medidores; vincular los medidores a los puntos del proyecto y configurar la topología.
2. En **Dispositivos → Acceso a las mediciones**, autorizar la identidad y sus medidores. La aplicación genera un UUID, utilizado como ID del gateway, cliente MQTT y Thing Name. La identidad no cambia de origen ni de medidores: se revoca y se crea otra para un cambio de autorización.
3. Para pruebas, elegir **Simulador local** (solo desarrollo/staging) y usar el contrato/configuración de [telemetry.md](docs/telemetry.md). `npm run simulate -- --config <archivo-local.json> --ingest` utiliza el mismo procesador que Lambda y requiere `INGEST_DATABASE_URL` con el rol separado `solar_ingest`. Con `--output <archivo-nuevo.jsonl>` genera paquetes sin insertarlos.
4. Para el kit, seguir [kit-piloto.md](docs/kit-piloto.md) y `npm run gateway -- <archivo-local.json>`. El gateway requiere **Node.js 24** y certificados individuales; no se ejecuta dentro de Next.js.
5. `npm run build:ingestion` genera el consumidor para la plantilla de [AWS](docs/aws-ingestion.md). El despliegue necesita una cuenta y recursos explícitos. El secreto SQL pertenece a Secrets Manager; el proceso web no necesita credenciales de ingesta.

El contrato v2 excluye autoridad de organización/proyecto y tiempo de recepción del payload. Duplicados, conflictos, atrasos, huecos, reinicios y sustituciones se procesan en transacciones. La revocación del registro bloquea nuevas lecturas en la plataforma; para AWS debe desactivarse además el certificado en IoT Core. La referencia de hardware es provisional hasta comprobar el equipo y su firmware.

## Verificación

```powershell
npm run db:validate
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

`npm test` ejecuta las pruebas de contratos/dominio/OIDC; omite las integraciones si faltan conexiones explícitas. Para comprobar las garantías con una base desechable ya migrada y con RLS:

```powershell
# Archivo privado, excluido de Git: {"admin":"...","runtime":"...","auth":"...","ingest":"...","worker":"...","backup":"..."}
$env:TEST_ENV_FILE = '.work/pg-local/test-env.json'
npm run test:integration
```

También admite `TEST_ADMIN_DATABASE_URL`, `TEST_RUNTIME_DATABASE_URL`, `TEST_AUTH_DATABASE_URL` y `TEST_INGEST_DATABASE_URL` sin archivo. Las pruebas crean datos ficticios; nunca dirigirlas a una base con clientes. `npm run test:http` requiere `TEST_BASE_URL` y `TEST_ADMIN_DATABASE_URL` en loopback, una base terminada en `_test` y la aplicación ejecutándose con las conexiones de prueba. Genera sesiones exclusivamente desde el script de pruebas; la aplicación no ofrece rutas de acceso ficticio. Después, `npm run test:telemetry:http` usa esa fixture y `INGEST_DATABASE_URL` para comprobar autorización del gateway, ingesta real en PostgreSQL, duplicados, energía, consultas autorizadas y revocación. La suite completa de gateway y buffer requiere Node 24.

Después de ejecutar el HTTP test, reiniciar la aplicación, asignar `$env:TEST_VERIFY_PERSISTENCE='true'` y repetir `npm run test:http` comprueba los mismos registros guardados. La fixture privada se conserva en `.work/http-fixture.json`, con sesiones de prueba que vencen en dos horas. Eliminar esa variable para crear una nueva tanda de pruebas.

Para la demo: `SMOKE_BASE_URL=http://localhost:3000 npm run test:smoke` (en PowerShell asignar la variable con `$env:SMOKE_BASE_URL`). `/api/health` solo comprueba vida del proceso.

Consultar [evidencia y pendientes](docs/progress.md), [API](docs/api-management.md), [modelo H67](docs/h67-schema.md), [arquitectura](docs/architecture.md), [dependencias](docs/dependencies.md), [operación y recuperación](docs/operations-h67.md) y [piloto](docs/pilot-h7.md).

## Alertas, portal e informes

En **Alertas**, un administrador configura reglas por proyecto, persistencia/recuperación y mantenimiento; asigna incidencias, registra observaciones y cierra con una resolución. Los propietarios y técnicos consultan sólo proyectos asignados. **Mi portal** reúne sus instalaciones y el detalle permite pedir un PDF de hasta 31 días. La recuperación de una alerta no cierra automáticamente su incidencia. Los avisos son internos al portal; no se envía correo, SMS ni mensajes externos.

Los procesos de monitor y reportes requieren `WORKER_DATABASE_URL` con el rol restringido solar_worker, fuera del servidor Next. Para PDF local, configurar `APP_ENV=development` y `REPORT_STORAGE=local` en el servidor y worker; los archivos quedan en `.work/private-reports`. En staging/producción se exige S3 privado configurado. No entregar credenciales worker/backup/migración al proceso web.

```powershell
npm run monitor -- --once
npm run reports -- --once
# Omitir --once para mantener los workers activos en un proceso supervisado.
```

Ver [alertas](docs/alerts.md) y [reportes](docs/reports.md). `npm run test:h67:http` amplía la fixture HTTP con incidencias, mantenimiento, reportes y descargas. `npm run benchmark -- --env-file .work/pg-local/test-env.json` crea cinco instalaciones ficticias en una base local de pruebas. `npm run backup` y `npm run restore:rehearsal` usan credenciales offline y una clave privada; seguir [el procedimiento](docs/operations-h67.md).
