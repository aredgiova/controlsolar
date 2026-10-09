# Progreso de Monitoreo Solar

Fecha: **9 de octubre de 2026**. Los hitos **0–7 están implementados en su alcance local** y se completó la preparación para conectar dispositivos y crear el login AWS/Cognito. La guía original no contiene un hito 8. **La aceptación externa de identidad, kit y piloto sigue pendiente**: no se crearon recursos AWS ni se conectaron equipos físicos o clientes reales.

El encargo actual fue revisar qué faltaba y dejar preparada la configuración para iniciar esas conexiones. Los documentos originales permanecen sin cambios; sus instrucciones se usan como referencias, subordinadas al alcance autorizado por el usuario. Evidencia anterior: [0/1](progress-h01.md), [2/3](progress-h23.md), [4/5](progress-h45.md) y [6/7](progress-h67.md).

## Cierre de preparación

- **Cognito:** plantilla CloudFormation con pool/cliente/dominio managed login v2/branding; correo verificado, MFA TOTP, código OAuth/PKCE, cliente con secreto opcional. Parámetros separados staging/producción, localhost sólo staging y SES requerido para producción. Outputs sin secretos. [Configuración](cognito-setup.md).
- **Dispositivos:** herramienta offline para plantilla, snapshot de identidad/asignaciones, gateway.json, política MQTT exacta, comandos AWS revisables y hashes. Comprobación local opcional de certificado/clave/CA. Ningún comando AWS se ejecuta; plantilla vacía no se considera equipo listo. Diferenciados certificadoId administrativo y SHA256 X.509; mayúsculas normalizadas al enrolar/recibir. [Conexión](device-connection-setup.md).
- **Procesos:** bundles Node24 de monitor, report-worker, gateway y prepare-device, sin tsx/node_modules en ejecución. Manifest con hashes/tamaño/lockfile. Unidades Linux preparadas para los dos workers, usuarios/entornos separados y reinicio. No instaladas ni habilitadas. [Despliegue](worker-deployment.md).
- **Configuración:** ejemplos completos por proceso y entorno. Preflight offline con salida depurada; flags explícitos para conexión SQL de lectura y discovery OIDC. Rechaza marcadores, secretos de otros procesos y destinos incompatibles. Un diagnóstico positivo sólo acredita su alcance indicado.
- **PostgreSQL:** validación común de rol/destino/TLS en web, auth, worker e ingesta; Lambda siempre exige verify-full. Rechaza parámetros duplicados y overrides de host/usuario/opciones. Sin TLS sólo development loopback. Los permisos efectivos y FORCE RLS siguen comprobándose en cada contexto de ejecución.
- **Respaldo:** se valida URL antes de conectar y se eliminan todas las variables PG* heredadas, incluido PGHOSTADDR, antes de ejecutar libpq. Fuera de loopback se exige verify-full. Restauración local repetida sin modificar fuente; no se probó TLS remoto.
- **Documentación:** orden único de preparación/activación en [connection-readiness.md](connection-readiness.md), ruta persistente final de Hostinger y comando de reportes corregidos. Demostración original conservada.

## Verificación final

| Comprobación | Resultado |
| --- | --- |
| Suite ordinaria Node 24.19 | **85 aprobadas**, cero fallos; nueve integraciones omitidas sin conexiones explícitas. Incluye 22 pruebas nuevas respecto del cierre H67. |
| Integración explícita PostgreSQL 18.4 | **33 aprobadas**, cero fallos/omitidas: aislamiento, permisos, operaciones, telemetría, alertas, informes, snapshot, revocación y límites. |
| Total de pruebas aprobadas | **118** entre suite ordinaria e integración explícita. Las omisiones no se cuentan como aprobadas. |
| Cognito local | Siete pruebas nuevas de estructura/ramas/MFA/retención/configuración y canje confidencial Basic con PKCE/JWT firmado mediante proveedor inyectado. No es login en AWS. |
| Configuración/preflight | Cinco pruebas nuevas de transporte/credenciales y alcance; CLI real comprobó web/auth/monitor/reportes en SQL de lectura, y rechazó ejemplos incompletos staging/producción. [Evidencia](qa/connection-readiness.json). |
| Incorporación IoT | Ocho pruebas nuevas: vínculo de IDs/bindings/endpoint, política exacta, separación de thumbprint/certificadoId, salida privada/inmutable, certificados locales y errores sin contenido privado. |
| Respaldo | Cuatro pruebas de cifrado/manifiesto/TLS/destino (dos nuevas); restore real: 33 tablas, 32 FORCE RLS y dos PDF, fuente intacta y roles preservados. [Evidencia nueva](qa/connection-readiness-restore.json); evidencia H67 original conservada. |
| HTTP del build final | Gestión, sesiones/CSRF/CRUD/invitaciones/puesta en marcha/reemplazo; telemetría/enrolamiento/energía/replay/revocación; reglas/incidencias/portal/PDF/token/revocación: correctos. Fixtures locales nuevas; anterior conservada privadamente. |
| Herramientas | Lint, tipos, Prisma validate y build Next optimizado correctos. Código/configuración compila sin necesitar conexiones de negocio ni migrar la base. |
| Artefactos | Lambda ZIP/import/hash Node24, cuatro bundles/hash, monitor/reportes --once con rol restringido local, gateway sin configuración rechazado y prepare-device genera plantilla offline. Trazado web excluye rutas privadas. [Evidencia](qa/connection-readiness-artifacts.json). |

Las pruebas HTTP usan sesiones ficticias sembradas offline en una base local de pruebas; no hay bypass de identidad en el producto. La fixture de cookies usa origen HTTPS con APP_ENV=development porque la base local no usa TLS; staging/producción sin verify-full se rechazan en pruebas separadas. El aviso de consultas concurrentes de pg/Prisma ya registrado en [dependencias](dependencies.md) sigue siendo una limitación de la versión, no un fallo de las pruebas.

## Activación externa pendiente

Seguir [el procedimiento de conexiones](connection-readiness.md), en este orden:

1. Definir cuenta/región AWS, URL HTTPS y alojamiento staging; confirmar destino de workers.
2. Preparar PostgreSQL administrado, roles, migraciones, TLS y red.
3. Validar/revisar/ejecutar stack Cognito, guardar outputs/secretos y aceptar registro/correo/TOTP/login/logout/asignaciones reales.
4. Preparar identidades AWS web/reportes, S3 privado y supervisión de workers; desplegar aplicación con variables privadas y aceptar aislamiento en destino.
5. Preparar secreto/red y desplegar IoT/SQS/Lambda mediante change set revisado; incorporar certificado/Thing/gateway/medidores reales.
6. Comparar lecturas con referencia, ensayar reconexión/revocación/recuperación y realizar piloto H7 con instaladoras autorizadas; medir costos y utilidad observados.

Los modelos y el firmware reales, precisión/CT/signos, permisos AWS, DNS/TLS remoto, SES, VPC, respaldo fuera del equipo/PITR y piloto no están acreditados. AWS CLI/cfn-lint no estaban disponibles: la plantilla Cognito tiene validación estructural local; `validate-template` y change set del servicio siguen pendientes. No se contrataron servicios, compraron equipos ni enviaron mensajes a terceros. No se agregaron control remoto, cobro u otras funciones posteriores al piloto.

## Reproducción y entorno conservado

Usar Node24 y dependencias completas para preparar/verificar:

```powershell
npm run lint
npm run typecheck
npm run db:validate
npm test
$env:TEST_ENV_FILE = '.work/pg-local/test-env.json'
npm run test:integration
npm run build
npm run build:ingestion
npm run build:workers
npm run prepare:device -- --template --output mi-kit-input
npm run preflight -- --service web --env-file archivo-privado.env
```

La última orden devuelve código 1 hasta completar un entorno real o una fixture local explícita; no acredita AWS. No repetir el nombre de salida de prepare:device: se rechaza sobrescritura. Consultar sus guías para los flags de lectura y certificado.

Conexiones locales, claves, sesiones de QA, PDFs, paquetes y respaldos permanecen exclusivamente bajo .work, ignorado por Git y fuera de public. No se publica ese directorio como parte del sitio. Al entregar se detienen QA persistente y PostgreSQL conservando datos; queda la [demostración ficticia en 127.0.0.1:3100](http://127.0.0.1:3100/dashboard), reiniciada con el build final y los flags originales de .env.local.
