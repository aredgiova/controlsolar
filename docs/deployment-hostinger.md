# Preparación del despliegue en Hostinger

Estado al 8 de octubre de 2026: procedimiento preparado; acceso a la cuenta, plan, repositorio remoto, destino de staging y despliegue remoto **pendientes de verificación**. Consultar documentación pública no confirma qué tiene contratado la cuenta del usuario. Esta entrega no cambia DNS, no elimina sitios y no contrata servicios.

## Modalidad y compatibilidad

El destino es **Aplicación web Node.js** con Next.js como frontend y backend. No corresponde a un sitio exportado estáticamente ni requiere asumir un VPS. Hostinger documenta soporte de aplicaciones Node.js en Business Web Hosting y planes Cloud; incluye Next.js con backend y selección de Node 18.x, 20.x, 22.x y 24.x. Permite conectar GitHub o subir archivos. [Guía oficial de Hostinger](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/).

La línea preferida es Node 24 LTS, sujeta a confirmar el parche disponible y la compatibilidad del lockfile; Node 22 LTS es alternativa. Node 18 y 20 aparecen EOL en la fuente oficial de Node y no se eligen para producción aunque sigan listados por el alojamiento. [Releases de Node.js](https://nodejs.org/en/about/previous-releases).

La app necesita un servidor Next.js. Se mantienen `next build` y `next start`; no se usa `output: "export"`. El build no ejecuta consultas de negocio ni migraciones remotas. Next.js documenta estos comandos y exige ejecutar lint por separado. [Instalación de Next.js](https://nextjs.org/docs/app/getting-started/installation).

## Datos que deben comprobarse en la cuenta

| Comprobación | Evidencia necesaria | Estado actual |
| --- | --- | --- |
| Modalidad | Sección Aplicación web Node.js y plan exacto. | Pendiente |
| Recursos | CPU, memoria, almacenamiento, procesos, cantidad de aplicaciones y límites de build. | Pendiente |
| Runtime | Node LTS y parche ofrecido; npm compatible con el lockfile. | Pendiente |
| Fuente | Repositorio GitHub autorizado, rama de staging y raíz del proyecto. | Pendiente |
| Build y arranque | Campos de configuración aceptados, comando de instalación, build, arranque y puerto asignado. | Pendiente |
| Variables | Variables separadas de build y runtime, guardadas sin publicarse en logs. | Pendiente |
| Dominio | URL de staging inequívoca y HTTPS válido; dominio comercial puede esperar. | Pendiente |
| Operación | Logs de instalación, build y runtime; reinicio y retorno a la versión anterior. | Pendiente |
| PostgreSQL | Salida de red al proveedor externo, TLS, certificados, pooling y límite de conexiones. | Pendiente |

No publicar una demo abierta en un dominio existente de clientes. El primer despliegue de prueba debe apuntar a un destino de staging autorizado e independiente.

## Preparación reproducible local

Con Node/npm en `PATH`, ejecutar desde la raíz:

```powershell
npm ci
npm run lint
npm run typecheck
npm run build
npm start
```

Estos son los comandos de verificación previstos. Sus resultados efectivos, runtime usado y posibles particularidades del entorno están en [progress.md](progress.md). El script `start` debe permitir el puerto asignado por la plataforma. No fijar un puerto de desarrollo en la configuración remota sin comprobar el mecanismo de Hostinger.

La demostración local requiere configuración explícita:

```dotenv
APP_ENV=development
DATA_ADAPTER=demo
DEMO_MODE=true
```

Una compilación y un arranque con `NODE_ENV=production` son una prueba técnica local de Next.js. No son un despliegue en producción de clientes. Para una demostración remota de staging se utilizará `APP_ENV=staging` y `DEMO_MODE=true`; para producción de clientes la demostración está prohibida. La gestión persistente implementada en hitos 2/3 requiere `DATA_ADAPTER=postgres`, `DEMO_MODE=false`, RLS y la configuración de Cognito.

## Staging del producto persistente (cierre de preparación H0–7)

Seguir primero [connection-readiness.md](connection-readiness.md): preparar PostgreSQL/RLS, stack Cognito y archivos privados/S3; confirmar además dónde se ejecutarán monitor y reportes. Una aplicación Node.js web no acredita procesos permanentes adicionales. Los [bundles y supervisores](worker-deployment.md) permiten colocarlos en un destino independiente sin cambiar el monolito web.

El entorno web real usa la [plantilla staging](../infra/environments/staging.env.example): APP_ENV=staging, DATA_ADAPTER=postgres, DEMO_MODE=false, roles solar_runtime/solar_auth distintos, APP_BASE_URL HTTPS exacta, outputs Cognito y almacenamiento S3 privado. No necesita credenciales de ingesta, worker, migración o respaldo. Las credenciales AWS del web sirven para leer PDF privados; el login OIDC no necesita acceso administrativo AWS.

Antes de arrancar, comprobar esa configuración con `npm run preflight -- --service web --env-file <archivo-privado> --check-database --check-provider` desde la máquina de preparación, con acceso autorizado al destino. Ejecutar migraciones/instalación de seguridad como operación separada, fuera de build. Publicar el build revisado, conservar el artefacto previo, comprobar health y completar el recorrido real de Cognito, permisos por empresa/proyecto e informes. Discovery y health no sustituyen ese recorrido.

Proporcionar al host sólo variables web, revisar TLS/pooling/red, mecanismo de credenciales S3 y eliminación de tokens de logs. No transferir .work, volcados, certificados del kit ni archivos .env reales dentro del sitio. Separar staging/producción y retirar cualquier demo del destino persistente antes de incorporar clientes.

## Secuencia de demostración H0/1 cuando exista acceso

1. Confirmar con el titular el destino de staging y los recursos disponibles. Registrar plan, Node y URL sin guardar secretos.
2. Confirmar que el repositorio y la rama incluyen el lockfile y excluyen `.env` reales. Registrar el commit desplegado.
3. Crear o seleccionar exclusivamente la aplicación Node.js de staging autorizada. Elegir el framework Next.js, la raíz y una versión LTS compatible.
4. Revisar los comandos detectados por Hostinger. Instalar reproduciblemente con `npm ci`, compilar con `npm run build` y arrancar con `npm start` si la interfaz admite esos campos. Validar el puerto y las variables mediante la configuración real del panel.
5. Guardar `APP_ENV=staging`, `DATA_ADAPTER=demo` y `DEMO_MODE=true` en el servicio, nunca credenciales en `NEXT_PUBLIC_*`. La demo no necesita secretos de AWS ni consultas a PostgreSQL.
6. Revisar logs de build y runtime sin imprimir variables completas. Verificar HTTPS, `/api/health`, navegación dashboard → proyectos → detalle, filtros y estados en escritorio y móvil.
7. Registrar URL, commit, Node, comandos, resultados y límites observados. Si falla, conservar logs depurados y comprobar el retorno sin tocar otros sitios.

## PostgreSQL externo e identidad

`DATABASE_URL` usa `solar_runtime`; `AUTH_DATABASE_URL` usa `solar_auth`. Las URL ilustrativas no acreditan conexión. El build no consulta datos de negocio. `DATABASE_MIGRATION_URL` se suministra únicamente al CLI, fuera del servidor web. Para la primera base nueva: provisionar migrador/base, ejecutar `npm run db:migrate` y después la instalación administrativa única de roles/RLS; completar [prisma/security/README.md](../prisma/security/README.md). No ejecutar la baseline para reemplazar una base poblada.

Cuando exista una base de staging inequívoca, realizar una lectura/escritura con datos de prueba aislados, confirmar TLS, limpiar únicamente esos datos y registrar evidencia. La validación de esquema y la generación del cliente no sustituyen esa prueba. Los hitos 0 y 1 no ejecutan `db push`, migraciones o escrituras en una base remota.

Las migraciones futuras serán un paso explícito de release con respaldo y revisión, fuera de `build`. No instalar PostgreSQL en Hostinger ni cambiar a MySQL para suplir una falta de acceso. Evaluar pooling, certificados y capacidad con el proveedor elegido antes del piloto. Configurar callback y salida de Cognito según [authentication.md](authentication.md). Ajustar el proxy para no registrar códigos OAuth, cookies ni tokens de invitación. Repetir allí las pruebas de aislamiento y autenticación antes de incorporar clientes; la evidencia local no valida el entorno remoto.

## Pendientes de acceso

- Cuenta y plan Hostinger con aplicación Node.js disponible, recursos y URL de staging autorizada.
- Repositorio GitHub y rama remota que se usarán para despliegue.
- Base PostgreSQL de staging, conexión segura y credenciales separadas cuando corresponda verificar persistencia.
- Configuración Cognito de staging para el hito 2: región, User Pool, cliente, dominios y URLs de retorno/cierre de sesión.

No hacen falta credenciales de dispositivos, IoT Core, SQS, Lambda o S3 para cerrar la demostración local.
