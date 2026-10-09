# Operación, recuperación y seguridad — hitos 6/7

Implementación local del 9 de octubre de 2026. Los comandos de backup/restore se ejecutan fuera del servidor web. Las plantillas no crean recursos, no activan tareas del sistema y no prueban infraestructura externa.

## Entornos y secretos

Usar bases, User Pools, secretos, buckets, colas y certificados diferentes para staging y producción; plantillas en [staging](../infra/environments/staging.env.example) y [producción](../infra/environments/production.env.example). Etiquetar recursos con environment, application y centro de costo. Probar migraciones y permisos efectivos primero en staging. La aplicación no permite demo en producción; el almacenamiento de reportes local requiere development explícito.

| Proceso | Credencial SQL | Autoridad |
| --- | --- | --- |
| Web | solar_runtime + solar_auth | RLS por organización/proyecto; funciones de sesión/límites separadas |
| Ingesta | solar_ingest | Funciones acotadas de registro y telemetría |
| Monitor/reportes | solar_worker | Funciones acotadas, sin SELECT directo de tablas |
| Migraciones | solar_migrator | Estructura; no entregar a procesos web/workers |
| Backup offline | solar_backup | BYPASSRLS necesario para respaldar todos los tenants; sólo lectura, sin membresías privilegiadas |
| Instalación/restore | Administrador offline | Sólo operación controlada; nunca credencial de aplicación |

Los flags y ejemplos no acreditan el aprovisionamiento de estos servicios. No incluir `.work`, `.env*`, volcados, claves ni certificados en despliegues. Next excluye esos archivos de su trazado. Mantener secretos en el administrador del entorno y rotarlos mediante un despliegue controlado. Validar TLS y certificados de PostgreSQL en el destino; los ejemplos locales usan exclusivamente loopback.

## Límites y sesiones

El API comparte contadores atómicos PostgreSQL: 1200 solicitudes/minuto globales antes de autenticación; 600 lecturas y 120 escrituras/minuto por usuario verificado. Login tiene 60/minuto y callback 120/minuto globales. Responde 429 con Retry-After; las claves son HMAC, no IP ni identidad en texto. No se confía en X-Forwarded-For aportado por el cliente. La capa de alojamiento debe añadir límites por IP, conexiones, duración del cuerpo y protección ante volumen antes de Node; todavía no existe un WAF/proxy configurado. El cierre de sesión conserva la revocación aun si el proveedor no responde.

JSON de gestión máximo 32 KiB incluso sin Content-Length; la telemetría conserva su límite de 64 KiB y no comparte una ruta pública de ingreso HTTP. No hay endpoint de subida arbitraria de archivos. Los PDF se generan en servidor, tienen máximo 10 MiB, almacenamiento privado, hash de integridad, autorización vigente por proyecto y descarga temporal de un solo uso. Un URL o UUID por sí solo no autoriza la descarga.

Se envían nosniff, no-referrer, DENY, Permissions-Policy y CSP para impedir embebido, bases externas y objetos. Producción envía HSTS. La CSP no restringe scripts inline de Next; no se declara una política completa de scripts. Las rutas autenticadas responden no-store. Las garantías de sesión, origen, expiración, retiro de membresía y autorización de objeto se comprueban en pruebas locales con credenciales efectivas.

## Respaldo cifrado

Requisitos: pg_dump compatible con la versión del servidor, credencial offline solar_backup y BACKUP_ENCRYPTION_KEY en base64 de 32 bytes aleatorios. Conservar esa clave separada de los respaldos, en un gestor de secretos. Perderla impide restaurar; quien la obtenga puede descifrar los archivos. BACKUP_ROOT debe ser privado, fuera de public. No hay borrado automático ni retención destructiva en estos scripts.

El cliente offline admite sslmode, sslrootcert, sslcert y sslkey en la URL y los transmite a libpq mediante variables privadas. La URL se valida antes de abrir cualquier conexión; fuera de loopback exige verify-full y la CA correcta. Se rechazan parámetros desconocidos/duplicados y se eliminan **todas** las variables PG* heredadas, incluido PGHOSTADDR, antes de reconstruir el destino explícito de libpq. En loopback sin sslmode se fija disable explícitamente para que Node y libpq no hereden modos diferentes. No se probó negociación TLS con un proveedor externo. La nueva regresión y restauración están en [connection-readiness-restore.json](qa/connection-readiness-restore.json).

```powershell
# Variables privadas del proceso: BACKUP_DATABASE_URL, BACKUP_ENCRYPTION_KEY.
# PG_DUMP_BIN permite indicar la ruta absoluta al ejecutable.
$env:BACKUP_ROOT = 'D:/solar-backups'
# Para reportes locales, incluir la raíz efectiva (.work/private-reports por defecto).
$env:BACKUP_REPORT_ROOT = 'D:/solar-private-reports'
npm run backup
```

`backup.mjs` valida el rol, mantiene un snapshot consistente de PostgreSQL, ejecuta pg_dump custom con propietarios/ACL y cifra el flujo con AES-256-GCM. Firma el manifiesto con HMAC e incluye hashes/tamaños, inventario de tablas y huellas de contenido calculadas sobre ese mismo snapshot. No crea un volcado sin cifrar. Los archivos privados locales se cifran individualmente. Si falla, no publica manifiesto completo; conservar el directorio fallido para diagnóstico o retirarlo manualmente tras verificar su ruta.

Los reportes son objetos inmutables: al respaldar archivos después del snapshot se pueden incluir objetos adicionales, pero no se deben borrar archivos mientras corre el backup. Detener temporalmente el worker de reportes para una captura estricta conjunta. En S3, usar versionado y una política de respaldo/replicación aparte: el dump SQL no copia objetos S3. La plantilla de reportes prepara versionado, pero la recuperación real del bucket y sus claves sigue pendiente de AWS.

Las unidades [service](../infra/operations/solar-backup.service) y [timer](../infra/operations/solar-backup.timer) preparan ejecución cada seis horas en Linux. Antes de habilitarlas, el operador debe instalar Node/pg_dump, directorios, usuario sin privilegios y archivo privado /etc/solar/backup.env con modo 0600, y copiar los respaldos cifrados a un destino independiente. No se han instalado unidades ni programado tareas en este equipo. Supervisar cada ejecución y alertar ante falta de manifiesto o antigüedad mayor a la política acordada. Definir retención y ensayar recuperación antes de eliminar generaciones antiguas. Un disco local único no es recuperación ante pérdida del equipo.

## Restauración comprobable

`npm run restore:rehearsal` acepta exclusivamente una base vacía en loopback cuyo nombre termina en `_restore_test`. Configurar RESTORE_DATABASE_URL, RESTORE_BACKUP_DIRECTORY, BACKUP_ENCRYPTION_KEY, PG_RESTORE_BIN y opcional RESTORE_REPORT_ROOT (vacío). El comando jamás limpia o sobrescribe una base, ni permite usar la fuente del respaldo. El administrador crea previamente una base nueva y los roles esperados. Los roles son objetos globales del cluster y no forman parte de pg_dump.

Se autentica el manifiesto, se verifica y descifra completamente el archivo antes de ejecutar SQL; pg_restore usa una transacción y exit-on-error. Sólo se restauran archivos de un origen confiable: un volcado contiene código SQL ejecutable. Se comparan contenidos de todas las tablas y flags RLS/FORCE RLS con la captura firmada. El archivo temporal SQL se elimina por su ruta exacta en finally. No hay borrado recursivo. Ver evidencia local en [h67-restore.json](qa/h67-restore.json).

El ensayo usa una base separada dentro del mismo cluster local; acredita restauración lógica y permisos de aplicación, no recuperación de un proveedor completo. En producción deben ensayarse cluster aislado, roles y secretos nuevos, TLS, objetos S3, WAL/PITR, acceso restringido y conciliación de mensajes pendientes. Antes de abrir tráfico: comprobar solar_runtime sin scope ve cero proyectos; cliente sólo asignados; solar_auth/ingest/worker sin acceso directo; ninguna cuenta de aplicación es owner, superuser o BYPASSRLS.

## Migraciones y reversión de aplicación

Las migraciones previas se conservan. H67 añade tablas/columnas; no elimina datos ni cambia el protocolo v2. Guardar artefacto de aplicación, lockfile, hashes de migraciones, versión de Node y configuración pública junto a cada release. Aplicar migraciones incrementales con la credencial offline y comprobar diff/roles antes de arrancar. El instalador de seguridad administrativo se ejecuta según su README; no repetir baselines de forma indiscriminada.

Para revertir H67 a la aplicación H45: detener primero monitor y reportes; conservar base/migraciones y sus nuevas tablas; desplegar el artefacto H45 previamente probado contra una copia del esquema expandido; probar login, consulta de proyectos y telemetría antes de reabrir. Los campos nuevos tienen valores por defecto y el contrato v2 anterior sigue aceptado. No ejecutar una migración destructiva de descenso. Esta compatibilidad es una condición de release: repetir el ensayo con el artefacto exacto en staging, todavía no disponible como release externo. Si no pasa, mantener el artefacto actual y corregir hacia adelante. Un backup no sustituye una reversión compatible de aplicación.

## Respuesta a incidentes

1. Registrar hora UTC, proyecto, síntoma y responsable; distinguir ausencia de recepción, dato inválido, condición configurada y alarma explícita. No diagnosticar una falla eléctrica por falta de paquetes.
2. Consultar antigüedad, origen, configuración vigente, cola y DLQ. Conservar evidencias sin tokens, contraseñas ni datos innecesarios. Usar mantenimiento sólo para una intervención planificada; no ocultar un incidente real.
3. Si hay credencial comprometida, revocar gateway/sesión/membresía y rotar el secreto del servicio afectado. En AWS desactivar además el certificado IoT; la revocación local no hace ese cambio externo.
4. Si falla un worker, detener sus réplicas, corregir causa y reiniciarlo. Los leases caducan; reintentos conservan idempotencia. Supervisar jobs fallidos y avisos pendientes, no aumentar intentos indefinidamente. El portal conserva las incidencias hasta cierre manual con resolución.
5. Ante pérdida de base, cerrar tráfico y ensayar el respaldo más reciente en un destino aislado. Verificar integridad, RLS, asignaciones, archivos y continuidad antes de cambiar conexiones. Registrar duración y posible pérdida temporal; no prometer RPO/RTO de producción con mediciones locales.
6. Añadir observación, resolución, causa comprobada y seguimiento. Validar recuperación con datos nuevos y cerrar la incidencia. Conservar auditoría.
