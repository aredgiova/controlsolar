# Ingesta AWS IoT → SQS → Lambda — Hito 5

Estado: código, bundle y plantilla revisables en local. No se ha desplegado la plantilla ni se han creado certificados, colas, funciones o secretos AWS. Las pruebas locales no sustituyen la validación de CloudFormation/IAM, TLS y conectividad en la cuenta destino.

## Frontera de confianza

```mermaid
flowchart LR
  M[Medidor FC04] --> G[Gateway / SQLite]
  G -->|TLS X.509 / QoS1| I[AWS IoT]
  I -->|Envelope del broker| Q[SQS estándar]
  I -->|Error de acción| E[S3 privado]
  Q --> L[Lambda Node24]
  L -->|solar_ingest / funciones SQL| P[(PostgreSQL)]
  L -->|Error permanente| C[Cuarentena durable]
  Q -->|5 recepciones fallidas| D[DLQ]
```

El paquete wire `2.0` contiene `gateway_id`, `packet_id`, `sent_at`, observaciones y reportes de pérdida. Cada observación lleva dispositivo, punto, versión, timestamp de adquisición, valores/unidades y calidad. No incluye organización, proyecto, recepción ni autoridad. El servidor resuelve esos datos desde el certificado/cliente/tópico registrados y los bindings temporales.

La regla construye este envelope fuera del contenido que publica el dispositivo:

```sql
SELECT 'aws_iot' AS source,
       principal() AS principal,
       clientid() AS client_id,
       topic() AS topic,
       timestamp() AS received_at_ms,
       encode(*, 'base64') AS payload_base64
FROM 'solar/v2/gateways/+/telemetry'
```

No utiliza `SELECT *`: un campo `principal`, `source` o `received_at` que venga en el JSON del dispositivo permanece dentro de `payload_base64` y no sobrescribe la identidad del broker. Para X.509, `principal()` devuelve el thumbprint del certificado; por eso el registry AWS exige 64 caracteres hexadecimales. [Funciones oficiales de AWS IoT](https://docs.aws.amazon.com/iot/latest/developerguide/iot-sql-functions.html), [payload binario/base64](https://docs.aws.amazon.com/iot/latest/developerguide/binary-payloads.html).

`GatewayIdentity.id = clientId = ThingName = gateway_id`, un UUID generado al autorizar el gateway. El tópico exacto es `solar/v2/gateways/UUID/telemetry`. La política permite únicamente Connect y Publish para ese Thing y exige `iot:Connection.Thing.IsAttached = true`; no concede suscripción ni tópicos de otros clientes. [Variables oficiales de políticas por Thing](https://docs.aws.amazon.com/iot/latest/developerguide/thing-policy-variables.html).

La cola principal deniega SendMessage a cualquier principal distinto del rol de la regla, incluso si una política IAM adicional lo permitiera. Esto es parte de la confianza en los metadatos del envelope; no autorizar productores externos que escriban JSON directamente a esa cola.

## Recursos de la plantilla

`infra/ingestion.json` declara recursos en una misma región:

| Recurso | Configuración del piloto |
|---|---|
| SQS principal | Estándar, SSE-SQS, 128 KiB, retención 4 días, visibilidad 210 s |
| DLQ | SSE-SQS, retención 14 días, recibe tras 5 recepciones fallidas, preservada al borrar stack |
| Lambda | `nodejs24.x`, 256 MiB, timeout 30 s, concurrencia reservada 2 |
| Event source | Lotes de 10, ventana 1 s, concurrencia máxima 2, `ReportBatchItemFailures` |
| S3 errores de regla | Privado, AES256, versionado, retención 30 días, preservado al borrar stack |
| Logs/alertas | Logs 30 días, métricas de reintentos, alarma por DLQ y antigüedad de cola; sin destinos de notificación configurados |

AWS IoT no admite una acción SQS FIFO. El envelope JSON ya incluye payload base64, así que `UseBase64` de la acción SQS es `false`. [Acción SQS oficial](https://docs.aws.amazon.com/iot/latest/developerguide/sqs-rule-action.html).

La visibilidad supera `6 × timeout + ventana` (181 s), y los fallos parciales evitan reenviar registros ya procesados en el mismo lote. Las colas estándar y QoS1 admiten duplicados y desorden: la integridad depende de IDs estables, deduplicación y timestamps de adquisición, no del orden de recepción. [Configuración SQS/Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html), [fallos parciales](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html), [runtime Node24](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html).

IAM separa el rol de regla y el de Lambda. La regla solo puede enviar a la cola concreta y escribir bajo `rule-errors/`; su trust policy limita cuenta y ARN de regla. Lambda solo puede consumir esa cola, leer el secreto indicado y escribir sus logs. Si el secreto usa una CMK, `kms:Decrypt` se restringe a esa clave, vía Secrets Manager y con su contexto de cifrado. Las operaciones EC2 para interfaces VPC requieren `Resource: "*"` y se restringen a la región; una denegación con `lambda:SourceFunctionArn` impide que el código de la función las use directamente. No se conceden roles propietarios de base de datos. [Acceso oficial de reglas IoT](https://docs.aws.amazon.com/iot/latest/developerguide/iot-create-role.html), [permisos VPC de Lambda](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html).

## PostgreSQL y secretos

Lambda lee un secreto de Secrets Manager con esta estructura, usando un valor real privado:

```json
{ "INGEST_DATABASE_URL": "postgresql://solar_ingest:REEMPLAZAR@db.example.internal:5432/solar?sslmode=verify-full" }
```

La función exige usuario `solar_ingest` y TLS `verify-full`. El rol se instala mediante la migración de seguridad, tiene EXECUTE solo en las funciones de ingesta y no tiene SELECT/INSERT directos ni propiedad de tablas. El store también verifica permisos efectivos, RLS forzado y contexto UTC antes de operar. Las credenciales no se envían al frontend ni se imprimen en logs.

El secreto se refresca como máximo cada cinco minutos; si su URL cambia, el store cambia de pool y cierra el anterior después de sus conexiones usadas. Para una CA privada debe incorporarse un trust bundle revisado al artefacto y configurar Node/PG según esa CA; no desactivar la verificación. La instalación local usa variables de prueba privadas y no pretende verificar el TLS de una base AWS inexistente.

## Reintentos y cuarentena

El handler valida fuente SQS/ARN de cola, envelope estricto, thumbprint, UUID, tópico, timestamp del broker, base64 canónico, UTF-8, tamaño y esquema. El payload decodificado está limitado a 64 KiB, hasta 100 observaciones y 100 reportes según el protocolo; el gateway emite lotes de hasta 40.

- Un error permanente de envelope se confirma solo después de `quarantineRaw`, una escritura SQL durable e idempotente por mensaje/hash/motivo. Conserva hash del cuerpo completo y una copia acotada; la truncación queda indicada.
- El procesador aplica autorización de gateway/dispositivo/binding, validación semántica, deduplicación, histórico y reportes de pérdida. Su cuarentena semántica también debe completar antes del retorno.
- Un error transitorio o una cuarentena que no pudo persistir devuelve únicamente ese messageId en `batchItemFailures`; conserva reintentos SQS. La falta de tiempo disponible reserva los registros sin iniciar.
- La inicialización fallida (secreto/red/DB) devuelve todos los IDs como fallidos y registra solo un estado y cantidades, sin payload ni credenciales.

El archivo S3 de errores cubre fallos de la acción IoT después del PUBACK. No es una confirmación de entrega al gateway: si también falla el error action, AWS puede descartar el mensaje. Por eso la aceptación externa debe incluir fallo inducido de regla/error action, alarmas IoT y un procedimiento de recuperación. El piloto no garantiza entrega exactamente una vez de extremo a extremo. [Error action oficial](https://docs.aws.amazon.com/iot/latest/developerguide/rule-error-handling.html).

Para recuperar una DLQ o el archivo de regla: identificar la causa, preservar el envelope original, comprobar su hash/contexto y ensayar replay controlado con la deduplicación. La denegación de productores de la cola principal bloquea un redrive manual indiscriminado: se requiere un cambio de política temporal, acotado y revisado para el operador/proceso de recuperación. No cambiar `received_at_ms` ni sustituir identidad por campos del payload. La expiración de SQS/S3 impone un plazo operativo de recuperación; no son retención histórica permanente.

## Preparación de un despliegue posterior

Antes de desplegar hacen falta una cuenta/región AWS, permisos de despliegue revisados, PostgreSQL con migraciones aplicadas, el secreto, subnets/security groups existentes y una ruta desde Lambda a PostgreSQL y Secrets Manager (endpoint VPC o NAT). La plantilla no crea base, VPC, NAT ni certificados. Si PostgreSQL está fuera de esa red debe resolverse su conectividad privada y CA antes del piloto; abrirlo públicamente no forma parte de esta implementación.

Construir el artefacto local:

```bash
npm ci
npm run build:ingestion
```

Genera `.work/ingestion/handler.mjs`, `ingestion.zip` y `manifest.json` con SHA256. El ZIP contiene `handler.mjs`, y el handler CloudFormation es `handler.handler`. Se empaquetan dependencias; `server-only` se resuelve a un guard vacío exclusivamente en este bundle de servidor. El build no utiliza AWS ni sube archivos.

La revisión posterior debe: validar la plantilla con AWS/CloudFormation y IAM, inspeccionar el artefacto/hash, subirlo a un objeto privado e inmutable de la misma región, revisar un change set con `CAPABILITY_NAMED_IAM`, autorizar su ejecución, y luego crear/asociar Thing/certificado/política sin exponer la clave privada. Este trabajo no ha ejecutado esos pasos.

La prueba externa debe demostrar certificado/hostname TLS, permisos negativos entre Things, recepción real de `principal()`, fallos parciales y DLQ, cuarentena tras error permanente, rotación de secreto, pérdida/recuperación de enlace, revocación en registry y límites de almacenamiento. Las alertas necesitan un destinatario operativo acordado; la plantilla no envía mensajes a nadie.

## Evidencia local

`tests/gateway.test.ts` prueba el driver con TCP loopback, unidades/signos, configuración y persistencia SQLite tras reinicio, capacidad, reportes y mezcla reciente/backfill. `tests/ingestion.test.ts` prueba la frontera del envelope, inyección, errores transitorios/permanentes, ACK tras cuarentena durable, truncación UTF-8 y límite de lotes/tiempo. `tests/ingestion-infra.test.ts` comprueba referencias y controles de la plantilla; es una validación estructural local y no un despliegue AWS.

`tests/gateway.integration.test.ts` recorrió TCP FC04 → SQLite con pérdida por capacidad → cierre/reapertura → envelope → handler → procesador/SQL reales. Verificó persistencia, dos eventos aceptados, replay idempotente, pérdida puntual con inicio igual a fin, cuarentena durable y revocación. Requiere Node24 y `TEST_RUNTIME_DATABASE_URL`, `TEST_ADMIN_DATABASE_URL`, `TEST_INGEST_DATABASE_URL` privados. Un envelope/certificado local fabricado sirve para ensayar el procesador; no prueba autenticación X.509 real ni AWS IoT.
