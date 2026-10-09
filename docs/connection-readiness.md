# Cierre de preparación para conexiones reales

La guía original contiene **hitos 0–7**. El encargo del 9 de octubre de 2026 completa la preparación local para aceptar los hitos 2, 5 y 7 en servicios reales. No agrega un hito 8 ni afirma que se haya creado una cuenta, conectado un medidor, probado Cognito o desplegado infraestructura.

## Qué queda preparado

| Componente | Entrega revisable |
| --- | --- |
| Login AWS/Cognito | [Plantilla](../infra/cognito.json), parámetros separados, correo verificado, MFA TOTP, código + PKCE, dominio managed login y branding. [Procedimiento](cognito-setup.md). |
| Incorporación del equipo | CLI offline `npm run prepare:device`, plantilla de entrada, política MQTT acotada, plan AWS revisable y comprobación opcional de certificado/clave. [Procedimiento](device-connection-setup.md). |
| Ingesta | [IoT/SQS/Lambda](aws-ingestion.md), bundle Node 24, secreto solar_ingest y red privada explícitos. |
| Procesos permanentes | Bundles de monitor, reportes y gateway; monitor/reportes supervisados por unidades Linux preparadas. [Instalación](worker-deployment.md). |
| Configuración | [Web staging](../infra/environments/staging.env.example), [web producción](../infra/environments/production.env.example), [monitor](../infra/environments/monitor.env.example), [reportes](../infra/environments/reports.env.example) e [ingesta](../infra/environments/ingestion.env.example). |
| Verificación previa | `npm run preflight`: diagnóstico sin valores privados y sin red por defecto. Checks remotos de lectura sólo con flags explícitos. |
| Transporte PostgreSQL | Web/auth/ingesta/worker comparten validación de rol/destino/TLS; Lambda siempre exige verify-full. Sólo development loopback admite conexión sin TLS. Parámetros duplicados o capaces de cambiar host/usuario/opciones son rechazados. |

Los ejemplos quedan vacíos donde falta un dato real; **no pasan el preflight** hasta completarlos. La configuración de demostración existente se conserva. No copiar sus fixtures, conexiones SQL locales o sesiones de QA a staging.

## Orden de conexión y datos necesarios

1. **Definir staging:** cuenta/región AWS comercial, URL HTTPS inequívoca y alojamiento Node 24. Confirmar límites reales de Hostinger y dónde vivirán los dos workers permanentes. Mantener producción separada.
2. **Preparar PostgreSQL administrado:** destino accesible desde web/workers/Lambda, CA y TLS; instalar las cuatro migraciones y los tres scripts de seguridad en el orden de [su README](../prisma/security/README.md). Provisionar roles/secretos separados. Este repositorio no crea una base administrada ni su VPC.
3. **Crear Cognito:** completar parámetros públicos de staging, validar plantilla y revisar su change set según [la guía Cognito](cognito-setup.md). Después de ejecutar el cambio autorizado, guardar outputs en el entorno web. El secreto del cliente y AUTH_SECRET se guardan privadamente; no son outputs públicos. Cognito usa OIDC y no necesita claves IAM en Next.js.
4. **Preparar S3 y workers:** crear identidades AWS distintas de web/reportes con permisos mínimos, revisar [reports.json](../infra/reports.json) y desplegar su bucket privado. Configurar el mecanismo de credenciales que admita el alojamiento; Hostinger no obtiene automáticamente un rol IAM. El web lee PDF y el worker los escribe/lee. El monitor no necesita AWS. Completar bucket/propietario/región iguales en web y reportes.
5. **Revisar y desplegar aplicación:** ejecutar los checks siguientes, publicar sólo el artefacto correcto y configurar variables privadas del proceso web. [Hostinger](deployment-hostinger.md). El build no aplica migraciones. Instalar los workers en el destino que permita supervisarlos; sus unidades aún no están habilitadas.
6. **Aceptar login real:** registro/verificación de correo/TOTP, callback, organización, invitación/asignación y logout; comprobar cookies, replay, revocación e aislamiento real. No incorporar clientes antes de aceptar esta puerta.
7. **Preparar AWS IoT:** secreto solar_ingest, subnets/security groups, conectividad PostgreSQL/Secrets Manager y objeto ZIP privado inmutable. Revisar/validar el change set de [ingesta](aws-ingestion.md). Registrar cuenta/región y hashes del release.
8. **Seleccionar y registrar kit:** confirmar medidor/firmware/fases/TC/signos, gateway/OS y puntos físicos. Registrar activos, bindings/topología y puesta en marcha; generar CSR local, emitir certificado INACTIVE, obtener su SHA256, autorizarlo en la plataforma y obtener el UUID. Con estos datos, generar y revisar el paquete de incorporación. Activar únicamente tras comprobar correspondencia de Thing/certificado/política/registry. [Conexión de dispositivos](device-connection-setup.md).
9. **Ensayar con un sitio:** primera lectura trazable, comparación física, desconexión/backfill, duplicados, error-action/DLQ, revocación y PDF. Después completar el [piloto H7](pilot-h7.md), costos observados y recuperación fuera del equipo. Un PUBACK MQTT no prueba almacenamiento SQL.

## Preflight antes de arrancar

Ejecutar desde una máquina de preparación con Node 24 y dependencias completas (`npm ci`). Copiar el ejemplo del proceso a un archivo **privado** dentro de `.work` para pruebas o al gestor de secretos del host; no modificar los ejemplos públicos con contraseñas.

```powershell
# Sólo valida el archivo explícito; sin consultas a AWS ni PostgreSQL.
npm run preflight -- --service web --env-file .work/deployment/web-staging.env
npm run preflight -- --service monitor --env-file .work/deployment/monitor-staging.env
npm run preflight -- --service reports --env-file .work/deployment/reports-staging.env
npm run preflight -- --service ingestion --env-file .work/deployment/ingestion-staging.env

# Cuando exista el destino autorizado: sólo lectura, sin crear usuarios ni datos.
npm run preflight -- --service web --env-file .work/deployment/web-staging.env --check-database --check-provider
npm run preflight -- --service monitor --env-file .work/deployment/monitor-staging.env --check-database
npm run preflight -- --service reports --env-file .work/deployment/reports-staging.env --check-database
```

Sin `--env-file` revisa el entorno del proceso. Con archivo sólo revisa sus valores, salvo que también detecta una desactivación TLS heredada de Node. Sale con código 1 ante configuración incompleta/insegura; muestra nombres y diagnósticos fijos, jamás URLs SQL, secretos o excepciones de SDK. `ready=true` significa únicamente que pasó el alcance indicado, no una aceptación de producción. El chequeo de base usa transacciones de lectura, comprueba rol efectivo/UTC/32 FORCE RLS, ausencia de datos sin scope y permisos acotados. Discovery sólo comprueba los metadatos OIDC: no verifica callbacks registrados, secreto del cliente, correo, MFA ni un canje real de código. Esos puntos requieren el recorrido de Cognito.

Para Lambda, el preflight revisa ARNs/cuenta/región públicos. No lee Secrets Manager ni ejecuta el consumidor; la función valida la URL secreta y su rol solar_ingest al iniciar. Los permisos IAM/S3/IoT y la conectividad de VPC necesitan pruebas externas. `/api/health` sigue siendo una comprobación mínima de vida del proceso y no expone readiness ni detalles privados.

## Build y release

```powershell
npm run lint
npm run typecheck
npm run db:validate
npm test
npm run build
npm run build:ingestion
npm run build:workers
```

Los bundles están en `.work/ingestion` y `.work/workers` con hashes; estos directorios completos no se publican en el sitio web. Transferir sólo los artefactos específicos al servicio correspondiente, junto a su manifiesto. El gateway no recibe SQL, Cognito ni credenciales IAM. Conservar lockfile, versión de Node, cuatro migraciones y artefacto anterior; seguir [backup/reversión](operations-h67.md). No hay despliegue automático, cambio de DNS ni ejecución de planes AWS dentro de estos comandos.

Fuentes del transporte: [node-postgres SSL](https://node-postgres.com/features/ssl), [PostgreSQL verify-full](https://www.postgresql.org/docs/current/libpq-ssl.html). Credenciales de S3: [cadena de proveedores AWS SDK](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html). Las fuentes oficiales de Cognito/IoT y límites de sus verificaciones están enlazadas en sus procedimientos específicos.
