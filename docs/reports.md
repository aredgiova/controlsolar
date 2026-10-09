# Informes privados — Hito 6

Implementado y probado localmente: solicitud por periodo, generación independiente de PDF real, snapshot JSON, almacenamiento privado, descarga con sesión y autorización temporal. No se ha desplegado S3 ni se ha probado una cuenta AWS.

## Periodo y contenido

La solicitud usa `startDate` y `endDate` como fechas locales inclusivas y admite de 1 a 31 días. La fecha final no puede ser futura en la zona del proyecto. El servidor toma la zona del proyecto y la congela en el job, junto con límites UTC; el cliente no puede enviar organización, zona ni resultados dentro del JSON de solicitud. Los días con DST conservan su duración real de 23/24/25 horas.

Cada informe contiene energías de generación, importación/exportación de red y consumo, su calidad, origen, cobertura común y detalle diario. Utiliza las mismas funciones `buildDailyPointAggregates`/`composeProjectEnergy` del módulo de telemetría. Conserva topologías y bindings temporales con versión/configuración. Un contador simulado puede producir una diferencia de calidad `measured`, pero sigue rotulado como **SIMULADA**; origen y calidad son dimensiones distintas.

Los huecos, datos inválidos, cambios de binding y reinicios no se convierten en ceros. La integración de potencia y el prorrateo mantienen calidad estimada. Si falta una métrica de un día, su total del periodo queda ausente en lugar de sumar únicamente los días disponibles como si fueran completos. La cobertura expresa qué intervalo respalda cada resultado. El PDF redondea cifras y usa notación científica para extremos; el snapshot conserva los números de cálculo.

El corte de muestras es la solicitud (`ReportJob.createdAt`): SQL exige `received_at <= created_at`, `ingested_at <= created_at` y una secuencia de ingreso no superior a la capturada por el job, incluidos vecinos de frontera. La solicitud y la ingestión comparten un bloqueo por proyecto antes de capturar ese corte. Un paquete que estaba demorado en SQS queda excluido si ingresó después de la solicitud, aunque su recibo de transporte sea anterior; una generación de varios días conserva el mismo conjunto elegible. La zona congelada evita reinterpretar el periodo si después cambia el proyecto. El snapshot/PDF completado es inmutable; nuevos datos requieren otra solicitud. El nombre del proyecto se toma al reclamar el job y no determina los cálculos eléctricos.

## Generación independiente

`scripts/report-worker.ts` reclama trabajos mediante `solar_worker`, un rol separado sin lectura/escritura directa de tablas, propiedad ni BYPASSRLS. El helper compartido `src/lib/worker-db.ts` comprueba identidad efectiva, permisos, UTC y las 32 tablas protegidas con FORCE RLS. El worker solo usa funciones SQL estrechas de claim/context/renovación/completar/fallar.

La reserva dura cinco minutos y se renueva entre días y antes de almacenar. SQL reclama con bloqueo y SKIP LOCKED, limita a tres intentos y solo permite completar/fallar con el hash de una reserva activa. Un proceso antiguo no puede sobreescribir el resultado de otro. Una falla agenda reintento con espera creciente acotada; tras agotar intentos el job queda fallido. La clave de idempotencia de la solicitud es UUID y se limita a organización/solicitante; reutilizarla con otro periodo/proyecto produce conflicto.

Presupuestos del piloto: hasta 200.000 observaciones por día, contexto JSON hasta 64 MiB por día, 31 días, snapshot SQL hasta 8 MiB y PDF hasta 10 MiB en la aplicación. Se procesa un día por vez y el PDF no incluye todas las observaciones crudas. Si se superan los límites, el trabajo falla de forma explícita; no trunca resultados y los presenta como completos.

Configuración local privada:

```dotenv
APP_ENV=development
WORKER_DATABASE_URL=postgresql://solar_worker:REEMPLAZAR@127.0.0.1:5432/solar_test
REPORT_STORAGE=local
```

Ejecutar con las dependencias instaladas y migraciones/seguridad aplicadas:

```bash
npm run reports -- --once
npm run reports
```

`--once` procesa como máximo un trabajo. Sin esa opción consulta la cola cada cinco segundos cuando no hay trabajo o hubo reintento. El worker utiliza procesos y credenciales independientes del servidor web; no depende de una petición HTTP larga. Se probó con Node24. No imprime secretos, tokens ni cuerpos de informes.

## Almacenamiento

`REPORT_STORAGE=local` solo está disponible con `APP_ENV=development`. Los archivos se guardan bajo `.work/private-reports`, fuera de `public`, mediante archivo temporal, fsync y rename. Las claves se generan como `reports/orgUUID/reportUUID/sha256.pdf`; no se aceptan rutas del usuario. Se rechazan traversal, symlinks/junctions y archivos inesperados; en Linux los directorios privados requieren 0700 y los archivos se crean 0600. En Windows debe configurarse la ACL de la cuenta de servicio. La descarga verifica tamaño, firma PDF y SHA256. El almacenamiento local debe compartirse entre proceso web y worker y conservarse al reiniciar.

Producción requiere `REPORT_STORAGE=s3`, `REPORT_S3_BUCKET`, `REPORT_S3_ACCOUNT_ID` y `AWS_REGION`, además de credenciales IAM de cada proceso. El adaptador usa HTTPS del SDK, `ExpectedBucketOwner`, cifrado SSE-S3 AES256, checksum SHA256 y escritura condicional `IfNoneMatch: *`. La lectura está acotada y vuelve a verificar cifrado/tamaño/hash. No genera URLs públicas ni presignadas.

`infra/reports.json` propone un bucket privado con Block Public Access, ACLs deshabilitadas, cifrado, versionado y retención al borrar stack. El rol web existente solo recibe GetObject en `reports/*`; el worker existente recibe PutObject/GetObject para escritura e idempotencia. La política deniega transporte inseguro y escrituras sin AES256. Validar plantilla/IAM y revisar un change set antes de un despliegue posterior; ningún recurso fue creado en este trabajo. [Buenas prácticas oficiales de S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html), [cifrado SSE-S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html), [escritura condicional/checksum](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html).

Los archivos locales huérfanos después de una reserva expirada pueden quedar sin referencia; su nombre por hash impide sobrescribir otro resultado. Antes de eliminar objetos se debe contrastar referencias completadas y trabajos activos. La política de conservación/limpieza de PDFs y versiones S3 debe acordarse para producción; el piloto no borra documentos automáticamente ni publica sus rutas.

## Descarga y acceso actual

La lista expone solo metadatos seguros de los últimos 50 informes. Cada solicitante ve sus informes autorizados por proyecto; titulares/administradores de la organización pueden ver los del proyecto. No entrega claves de almacenamiento ni snapshots en esa lista.

Una descarga requiere sesión verificada y un token aleatorio de 32 bytes, almacenado solo como SHA256 y válido cinco minutos. La función SQL `app_consume_download_lease` comprueba usuario actual, organización/proyecto, membresía/asignación actuales, job completado, expiración y ausencia de consumo/revocación; consume de manera atómica. Cambiar usuario, repetir el enlace, retirar acceso al proyecto o deshabilitar la membresía bloquea la descarga. Dos usos concurrentes producen como máximo una descarga autorizada.

El servidor transmite los bytes mediante proxy y responde como attachment con no-store. El token por sí solo no concede acceso; no es una URL permanente al objeto. Si falla la integridad/lectura después de consumirlo, se puede solicitar otra autorización temporal. No se envían informes ni invitaciones a terceros.

Rutas coordinadas con el servidor:

- `GET/POST /api/v1/organizations/:org/projects/:project/reports`
- `POST /api/v1/organizations/:org/reports/:report/download-lease`
- `GET /api/v1/organizations/:org/reports/:report/download?token=...`

POST recibe `{startDate,endDate,idempotencyKey}`. El botón de descarga solicita una autorización nueva y obtiene el PDF con la sesión actual; no conserva tokens en localStorage.

## Evidencia y pendientes

Nueve pruebas unitarias cubren periodo/DST, calidad/origen, días ausentes, expiración con reloj controlado, PDF multipágina, almacenamiento privado/traversal/corrupción/junction, worker idempotente y reintentos. La integración con PostgreSQL real cubre solicitud concurrente, zona congelada, snapshot/PDF persistidos, dos descargas concurrentes, usuario incorrecto, revocación de asignación/membresía, expiración real y ausencia de SELECT directo del worker.

`scripts/test-h67-http.ts` pasó contra el servidor local compilado y PostgreSQL real: solicitud idempotente, ejecución independiente del worker, descarga PDF por proxy con headers privados y rechazo 404 de usuario incorrecto, repetición del token y acceso retirado. El mismo recorrido verifica reglas, mantenimiento e incidencias del hito 7 y restaura la asignación del cliente al terminar. Sus identidades son fixtures offline privadas de prueba, sin rutas de acceso alternativo en la aplicación.

Se renderizó e inspeccionó el PDF de prueba simulado de 31 días (tres páginas): título, tablas, leyenda, origen y trazabilidad, sin solapamientos ni recortes. El ejemplo es ficticio y no certifica una instalación real. Quedan pendientes validación de S3/IAM/credenciales/red en AWS y el procedimiento operativo de conservación/limpieza y recuperación del almacenamiento.
