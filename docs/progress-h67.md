# Progreso de Monitoreo Solar

Fecha: **9 de octubre de 2026**. **Hito 6 implementado y verificado localmente; hito 7 implementado y probado en su alcance local, con aceptación del piloto real pendiente.** Se detiene al cerrar este encargo. No se han conectado equipos físicos, aprovisionado AWS/Cognito ni recibido datos de clientes reales.

El usuario autorizó «sigamos con el hito 6 y 7». Se mantiene su indicación de implementar y probar todo lo posible localmente porque aún no dispone de hardware, cuenta AWS ni servicios de staging. Los documentos originales se usan como referencias y permanecen sin cambios. Evidencia anterior: [0/1](progress-h01.md), [2/3](progress-h23.md) y [4/5](progress-h45.md).

## Entrega local H6

- Cuatro clases de regla: comunicación, dato inválido, generación esperada con horario/umbral explícitos y alarma reportada por el equipo. Persistencia/recuperación, supresión de repetidos, mantenimiento y episodios; faltar un paquete no diagnostica una falla eléctrica.
- Monitor independiente. Estado, transición, incidencia y aviso pendiente se confirman juntos. Outbox con leases, reintentos y entrega interna al portal; no se envían mensajes externos.
- Incidencias con responsable autorizado, estados, observaciones, resolución obligatoria al cerrar e historial/auditoría. Una recuperación de telemetría conserva la incidencia hasta cierre manual.
- Portal por proyecto y PDF privado de hasta 31 días inclusivos. Conserva periodo/zona, fuente, unidades, calidad y cobertura; utiliza el dominio energético de las consultas. Snapshot estable incluso ante SQS tardío, mediante secuencia de ingesta y reloj de base.
- Worker de informes con reservas/reintentos/idempotencia. Descarga con sesión, permisos actuales y token de cinco minutos vinculado al usuario y de un solo uso. Archivos locales privados sólo en desarrollo; adaptador/plantilla S3 privada preparados.

Ver [alertas](alerts.md), [informes](reports.md), [API](api-management.md) y [esquema H67](h67-schema.md).

## Entrega local H7

- Credenciales separadas web/auth/ingesta/worker/migración/backup; 32 tablas FORCE RLS. Rol solar_worker sin tablas directas. La excepción BYPASSRLS de solar_backup es offline, sólo lectura y rechazada por los procesos de aplicación.
- Límites atómicos compartidos en PostgreSQL, respuesta 429/Retry-After, límite de 32 KiB de JSON, cabeceras de seguridad y exclusión de secretos/archivos privados del trazado Next.
- Backup custom consistente, cifrado AES-256-GCM, manifiesto HMAC, inventario/huellas y archivos privados. Restauración no destructiva a base vacía loopback separada; verificados datos, PDF, RLS, asignación y permisos de funciones de los roles restringidos.
- Plantillas separadas staging/producción, servicio/timer de backup preparados, procedimiento de incidentes y reversión compatible de aplicación sin descenso destructivo de esquema. Las unidades no están instaladas ni activadas en este equipo.
- Ensayo del procesador/PostgreSQL con dos instaladoras ficticias, cinco proyectos/diez medidores, flujo normal y ráfaga de reconexión. Mide latencias, atraso simulado, backlog, continuidad y tiempo de provisión mediante servicios; no sustituye tiempo humano de alta.

Ver [operación y recuperación](operations-h67.md) y [piloto/capacidad](pilot-h7.md).

## Evidencia final

| Comprobación | Resultado |
| --- | --- |
| Suite ordinaria Node 24 | 63 pruebas puras aprobadas; nueve integraciones omitidas sin conexiones explícitas. |
| Integración PostgreSQL Node 24 | 33 aprobadas, cero fallos/omitidas. Archivos serializados por la cola compartida de workers; incluye roles efectivos, aislamiento, atomicidad/dedup/outbox, snapshot, revocación y límites concurrentes. |
| Migraciones | Baselines H23/H45 intactas; cuatro migraciones + tres scripts de seguridad en instalación nueva. Actualización conservó datos; Prisma diff sin diferencias en ambas. |
| Recorrido HTTP | Gestión/telemetría anteriores y H67: regla/mantenimiento, asignación/observación/cierre, informes, idempotencia, PDF, tokens, replay, IDOR y revocación correctos. Sesiones de QA sólo desde scripts offline. |
| Límites HTTP | Cuerpo excesivo 413, escritura 429 con Retry-After, presupuesto de lectura separado y cabeceras comprobadas. [Evidencia](qa/h67-http-security.json). |
| Respaldo/restauración | 33 tablas recuperadas, 32 FORCE RLS y dos PDF; contenidos coinciden, cliente sólo un proyecto, rol sin scope ve cero, auth/ingest/worker sin tablas y con funciones correspondientes. Misma instancia local, base diferente. [Evidencia](qa/h67-restore.json). |
| Carga local | 600 observaciones únicas aceptadas + 10 duplicadas, cero cuarentenas; continuidad/aislamiento en cinco proyectos, backlog de reconexión 500→0. Normal p95=12,627 ms por paquete; ráfaga p95=181,526 ms. Percentiles de ráfaga sobre cinco paquetes: muestra pequeña. [Métricas](qa/h67-benchmark.json). |
| Interfaz | 14 capturas 1440×1050 / 390×844, sin errores de página/desbordamiento documental. Crear/asignar/observar/cerrar, crear regla, cliente asignado y descarga PDF en Chrome correctos. Revisión independiente: disposition ship, dos hallazgos resueltos (desplazamiento accesible y navegación activa). [Evidencia](qa/h67-ui.json). |
| PDF | Documento real de 31 días / tres páginas renderizado e inspeccionado; tablas, fuente simulada, unidades, zona y trazabilidad legibles. Descarga HTTP y navegador comprobadas. |
| Demo | Smoke HTTP y recorrido Chrome de navegación, búsqueda, dos empresas, filtros, vacío, error/recuperación, desactualización y móvil pasan; fixtures preservadas. |
| Herramientas | Lint sin warnings, tipos, Prisma validate y build optimizado correctos. Auditoría de ejecución: cero avisos. Avisos de tooling/pg en [dependencias](dependencies.md). |
| Lambda | Bundle H67 recompilado localmente para Node 24, comprobado sin desplegar. Las pruebas conservan envelope confiable, reintentos, cuarentena y fallos parciales. |

Las omisiones de la suite ordinaria no acreditan aislamiento; la ejecución explícita de integración sí se realizó. El respaldo/restauración y los percentiles locales no acreditan RPO/RTO, disponibilidad ni capacidad de producción. El piloto de la guía requiere clientes reales y sigue abierto.

## Pendientes de aceptación externa

| Elemento | Falta comprobar |
| --- | --- |
| Hardware | Modelo/firmware real, fases, TC, signos, precisión y comparación con instrumento; continuidad de campo y alarmas realmente soportadas por el equipo. |
| AWS | CloudFormation/IAM en destino, TLS, certificados, red, secreto, SQS/DLQ/error-action, S3 privado y restauración de versiones, observabilidad y revocación efectiva IoT. |
| Identidad/alojamiento | Cognito, correo/MFA, staging/producción separados, TLS/pooling/proxy/WAF, cookies y pruebas cruzadas en el destino. |
| Recuperación operativa | Activar scheduler, respaldo fuera del equipo, política/retención/PITR y restore en cluster aislado del proveedor con roles/secretos nuevos. Ensayar reversión con el artefacto exacto de release antes de producción. |
| Piloto | Una o dos instaladoras, tres a cinco proyectos y clientes autorizados; alta humana, intervenciones, utilidad de alertas, disposición a pagar y costo observado por sitio. |
| Escala | Carga sostenida/100 sitios no acreditada; retención/particionado y presupuesto se decidirán con datos reales. |

No se contrataron servicios, compraron equipos, enviaron mensajes externos ni crearon recursos AWS. No hay control remoto ni nuevas funciones posteriores al hito 7.

## Reproducción y estado del entorno

Usar Node 24 y [README](../README.md). `.work/pg-local/test-env.json` conserva exclusivamente conexiones privadas de prueba: admin/migration/runtime/auth/ingest/worker/backup; `.work/pg-local/backup-key.txt` contiene la clave local, ignorada por Git. Los archivos temporales, PDFs, capturas y respaldos quedan en `.work`, fuera de public. Las cuatro migraciones y la instalación de seguridad se describen en [su README](../prisma/security/README.md).

```powershell
$env:TEST_ENV_FILE = '.work/pg-local/test-env.json'
npm run test:integration
npm test
npm run typecheck
npm run lint
npm run db:validate
npm run build
npm run build:ingestion
```

Las pruebas HTTP necesitan el servidor persistente y conexiones explícitas; test:h67:http usa su fixture y el worker. El benchmark crea nuevos registros ficticios en una base de pruebas, jamás clientes. Para backup/restore seguir las variables y guardas del [procedimiento](operations-h67.md); no dirigir pruebas a producción.

Al entregar se detienen el servidor persistente de QA y PostgreSQL, conservando datos y archivos. La demostración permanece en [127.0.0.1:3100](http://127.0.0.1:3100/dashboard), con los flags originales de `.env.local`. Los usuarios de QA son ficticios, con sesiones temporales, y no representan cuentas Cognito del producto.
