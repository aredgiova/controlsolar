# Despliegue independiente de monitor, informes y gateway

Preparación local para cerrar la configuración de los hitos 6/7. Los servicios no están instalados ni activados. El servidor Next.js atiende solicitudes web; el monitor y los informes necesitan procesos supervisados que sobrevivan al cierre del navegador y se reinicien al fallar. La modalidad Aplicación Node.js de Hostinger no acredita por sí sola la disponibilidad de esos procesos adicionales: confirmar sus límites o elegir un alojamiento separado para workers. No se supone que la cuenta sea un VPS.

## Artefactos sin dependencias de desarrollo en ejecución

En una máquina de build con Node.js 24 y el lockfile del release:

```bash
npm ci
npm run build:workers
```

Se generan `.work/workers/monitor.mjs`, `report-worker.mjs`, `gateway.mjs`, `prepare-device.mjs` y `manifest.json`. Esbuild incluye las dependencias de ejecución; el host de los workers sólo necesita Node 24 y los archivos del bundle, sin `tsx`, npm ni `node_modules`. El gateway utiliza además SQLite integrado en Node 24; la herramienta de preparación no necesita SQLite ni red. El marcador `server-only` se resuelve exclusivamente en estos bundles de servidor. No se usa el módulo opcional `pg-native`: la conexión utiliza el cliente JavaScript `pg`. La compilación no conecta la base ni AWS, no incorpora valores del entorno y no incluye `.env`, `.work` u otros archivos privados como entradas.

El manifiesto registra SHA256/tamaño de cada ejecutable, versión de Node y SHA256 del lockfile. Conservarlo junto al artefacto exacto del release y el inventario de migraciones; comprobar los hashes después de transferirlo. Repetir el build con el mismo código y lockfile genera los mismos ejecutables. El bundle debe volver a generarse después de cambiar configuración validada, SQL invocado o código de los módulos.

Los comandos de desarrollo `npm run monitor`, `npm run reports` y `npm run gateway` utilizan `tsx`; requieren la instalación completa de dependencias de desarrollo. No son los comandos de las unidades de producción.

## Configuración privada por proceso

Cada proceso recibe su propio archivo de entorno, fuera del directorio del artefacto y de Git. Usar credenciales SQL de `solar_worker`, distintas de web/auth/ingesta/migración/backup. Ambos workers usan actualmente el mismo rol SQL, por lo que su rotación de contraseña debe coordinarse entre ambos procesos; no darles credenciales de administración. Los entornos staging y producción usan destinos separados.

Monitor, `/etc/solar/monitor.env`:

```dotenv
APP_ENV=staging
WORKER_DATABASE_URL=postgresql://solar_worker:REEMPLAZAR@db.example.invalid:5432/solar_staging?sslmode=verify-full
```

Informes, `/etc/solar/reports.env`:

```dotenv
APP_ENV=staging
WORKER_DATABASE_URL=postgresql://solar_worker:REEMPLAZAR@db.example.invalid:5432/solar_staging?sslmode=verify-full
REPORT_STORAGE=s3
REPORT_S3_BUCKET=REEMPLAZAR
REPORT_S3_ACCOUNT_ID=000000000000
AWS_REGION=us-east-1
```

Sustituir todos los ejemplos por valores reales privados; no iniciar con los marcadores anteriores. Añadir la CA de PostgreSQL cuando la requiera el proveedor y comprobar certificado/hostname en destino. El monitor no necesita S3, Cognito, AUTH_SECRET ni conexiones web/auth. El worker de informes necesita credenciales AWS para `s3:PutObject` y `s3:GetObject` exclusivamente en `reports/*` del bucket de ese entorno. El servidor web usa una identidad distinta con `s3:GetObject`. La plantilla [reports.json](../infra/reports.json) recibe ARNs de roles existentes; no crea esos roles ni garantiza cómo el host obtiene credenciales.

Preferir credenciales temporales del rol de ejecución cuando el alojamiento las soporte. Si el host es externo a AWS, configurar y verificar un mecanismo de credenciales privado admitido por el SDK; no copiar perfiles personales ni claves al bundle. No conceder acceso AWS al monitor. Cuando se utilicen archivos privados de credenciales o CA, deben ser legibles únicamente por la cuenta correspondiente; la unidad bloquea acceso a directorios home. No colocar `.env` junto a los bundles: el entrypoint de informes admite dotenv para desarrollo, y producción debe recibir sólo su entorno explícito.

Para el ensayo local con `APP_ENV=development`, usar el rol de worker de la base de pruebas y `REPORT_STORAGE=local`. Ejecutar desde la raíz del workspace para compartir `.work/private-reports` con el servidor web. Las unidades propuestas son para staging/producción con S3, no para ese almacenamiento local.

El artefacto `gateway.mjs` se copia al equipo de campo, junto a su manifiesto verificable; no recibe conexiones PostgreSQL, secretos de sesión, credenciales IAM ni variables del servidor web. Su configuración privada JSON, certificado X.509 individual, clave y CA se preparan mediante el [procedimiento del kit](kit-piloto.md). Ejecutar allí con `node /opt/solar-gateway/gateway.mjs /etc/solar-gateway/gateway.json`. Conservar SQLite/buffer en un directorio persistente escribible únicamente por su cuenta de servicio. El modelo de equipo/OS debe confirmarse antes de preparar e instalar su supervisor; las unidades de este documento corresponden sólo a los dos workers de backend.

La herramienta adicional `prepare-device.mjs` permite preparar el paquete y verificar localmente certificado/clave/CA en el propio equipo, sin copiar la clave a administración y sin instalar dependencias de desarrollo. Ejecutar desde un directorio privado de trabajo `node /opt/solar-gateway/prepare-device.mjs --config /etc/solar-gateway/device-setup.json --output primer-kit --preflight`; genera una carpeta nueva bajo `.work/device-setup`, sin invocar AWS ni abrir conexiones. Seguir [device-connection-setup.md](device-connection-setup.md) para el esquema de entrada y las revisiones pendientes del registry/servicios reales.

## Unidades Linux preparadas

Las plantillas [solar-monitor.service](../infra/operations/solar-monitor.service) y [solar-reports.service](../infra/operations/solar-reports.service) usan cuentas distintas sin privilegios, archivos de entorno separados, reinicio ante fallo y límite de reintentos de arranque. Sus rutas son convenciones que deben adaptarse y revisarse en el host elegido:

| Elemento | Preparación del operador |
| --- | --- |
| Node | Node 24 en `/usr/bin/node`; la unidad comprueba la versión mayor. |
| Artefactos | Sólo bundles y manifiesto en `/opt/solar/workers`, propiedad de administrador, sin escritura por los usuarios de servicio. |
| Cuentas | `solar-monitor` y `solar-reports`, sin login interactivo ni grupos privilegiados. |
| Secretos | Archivos `/etc/solar/monitor.env` y `/etc/solar/reports.env`, propiedad root, modo 0600; systemd los carga antes de cambiar usuario. |
| Red | Salida a PostgreSQL con TLS; informes además a S3/servicio de credenciales por HTTPS. Confirmar DNS y límites de conexiones. |
| Permisos | Migraciones e instalación SQL aplicadas; 32 tablas FORCE RLS y funciones de worker disponibles. |

En el host autorizado, validar primero las unidades con `systemd-analyze verify`, ajustar rutas/CA/permisos y realizar `--once` con datos de staging. Sólo después instalar/habilitar los servicios. Las plantillas no cambian el sistema al estar presentes en el repositorio. No colocar secretos de migración, ingesta o backup en sus archivos de entorno.

Comandos del artefacto, con el entorno privado ya configurado:

```bash
node /opt/solar/workers/monitor.mjs --once
node /opt/solar/workers/report-worker.mjs --once
```

El ensayo `--once` puede evaluar alertas/notificaciones pendientes o generar un informe: ejecutarlo únicamente en el destino de staging autorizado. Revisar después el journal por nombre de componente/estado, antigüedad de ciclos, informes fallidos y backlog. Los logs no deben contener URL SQL, tokens ni cuerpos PDF. Configurar alerta operativa si el servicio queda fallido o deja de completar ciclos; las unidades no envían avisos externos por sí mismas.

## Reinicio, parada y retorno de versión

SIGTERM permite terminar el trabajo activo y cerrar el pool. El monitor puede esperar su intervalo de 30 segundos; el worker de informes termina su job antes de detenerse. Las unidades esperan hasta 120 segundos antes de terminar el proceso. Un trabajo excepcionalmente largo puede superar esa espera: PostgreSQL revierte una transacción interrumpida, y las reservas de informes vencen para permitir recuperación idempotente. La existencia de un objeto S3 no reemplaza la confirmación del job. Comprobar recuperación tras parada en el host real.

Para actualizar: detener ambos workers, verificar manifiesto y compatibilidad de esquema del artefacto nuevo, aplicar migraciones mediante el proceso offline cuando corresponda, ejecutar el preflight y el ensayo de staging y reiniciar. Mantener el artefacto anterior verificable para retorno compatible de aplicación, sin descenso destructivo de esquema. El procedimiento completo de backup/restore y las limitaciones del ensayo local están en [operations-h67.md](operations-h67.md).
