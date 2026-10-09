# Progreso de Monitoreo Solar

Fecha: **9 de octubre de 2026**. **Hito 4 implementado y probado localmente; hito 5 implementado en su alcance local y preparado para aceptación externa.** Se detiene antes del hito 6. No se ha conectado un medidor físico ni desplegado AWS, Cognito o staging.

El usuario autorizó los hitos 4/5 y respondió: «Todavía no; implementa y prueba todo lo posible localmente». Los documentos iniciales se trataron como referencias. La evidencia anterior permanece en [hitos 0/1](progress-h01.md) y [hitos 2/3](progress-h23.md).

## Entrega

- Contrato v2 estricto, simulador determinista independiente y procesador común con Lambda. Organización, proyecto y recepción se resuelven desde transporte/registro confiable. [Contrato y cálculos](telemetry.md).
- Autorización administrativa de identidades y medidores, UUID individual, revocación permanente auditada, muestras, último estado monotónico, agregados diarios, cuarentena y pérdidas persistidos. Rol `solar_ingest` separado sin acceso directo a tablas; 22 tablas tienen FORCE RLS. [Seguridad](../prisma/security/README.md).
- Duplicados sin sumar energía, conflictos en cuarentena, atrasos ligados a la configuración vigente al medir, sustituciones históricas, deltas, reinicios y huecos. La integración de potencia y el prorrateo temporal se identifican como estimados; el balance requiere topología y cobertura compatibles.
- Consulta diaria en zona del proyecto, antigüedad, potencia, energía parcial, cobertura, origen y calidad. La procedencia del día consultado se distingue de la última lectura; la simulación es explícita y las ausencias conservan `null`.
- Gateway Node 24 de solo lectura FC04, perfil exacto SDM630MCT v1.7, fases/signos/contadores y Modbus TCP vía conversión TCP/RTU. SQLite WAL conserva paquetes e IDs al reiniciar, limita capacidad, informa pérdidas y reparte envíos recientes/atrasados 3:1. [Kit provisional](kit-piloto.md).
- Adaptadores IoT Core/SQS/Lambda con envelope confiable, cuarentena durable y fallos parciales. CloudFormation prepara colas cifradas, DLQ, Lambda, políticas, secreto externo, archivo privado de errores y observabilidad. [AWS y recuperación](aws-ingestion.md).

## Evidencia local

| Comprobación | Resultado |
| --- | --- |
| Actualización y base nueva | Ambas migraciones, instalación administrativa, 22 tablas FORCE RLS. Prisma diff sin diferencias en base nueva y actualización; baseline H23 inmutable y registros previos conservados. |
| Roles/aislamiento | Credenciales runtime/auth/ingest efectivas y separadas; ingesta sin tablas ni helpers internos, rechazo de identidades/equipos ajenos; muestras/agregados limitados por proyecto. |
| Atomicidad | Un fallo revierte muestras, último estado y agregados juntos. Cuarentena y pérdidas durables/idempotentes. |
| HTTP optimizado | Gestión H23, autorización del gateway, consulta por cliente asignado, IDs ajenos, fecha imposible, ingesta común, duplicados/desorden, balance conocido, conflicto y revocación pasan. |
| Recorrido H5 | TCP FC04 ficticio → driver → SQLite con pérdida puntual → reinicio del mismo paquete → envelope ficticio → consumidor real → PostgreSQL. Duplicados, cuarentena, pérdida y revocación pasan. Certificado/envelope locales; no acredita TLS/AWS físico. |
| Suite ordinaria | 45 aprobadas, cero fallos; seis integraciones omitidas por falta de conexiones explícitas. |
| Integración PostgreSQL | 23 aprobadas, cero fallos/omitidas en la ejecución conjunta con roles efectivos. |
| Reinicio de aplicación | Sesión, activos, último estado, procedencia y energía de la misma fixture siguen disponibles tras recompilar y reiniciar. |
| Interfaz | 12 capturas escritorio 1440×1050 / móvil 390×844, autorización por formulario, consulta por fecha, vacío y cliente asignado; sin errores de página ni desbordamiento documental. Revisión independiente aprobada y corrección de unidades tras valores ausentes confirmada. |
| Demo | Smoke HTTP y recorrido Chrome de navegación/búsqueda/cambio de empresa/alertas/vacío/error-recuperación/desactualización/móvil aprobados; fixtures H1 preservadas. |
| Simulador CLI | Dos procesos independientes producen JSONL idéntico: 22 observaciones aceptadas y 22 duplicadas al repetir; probado con PostgreSQL real. |
| Consumidor Lambda | Bundle actualizado, ZIP de 2.046.410 bytes, CRC/layout e importación en frío Node24 comprobados. Plantilla pasa verificaciones locales de referencias, ciclos, políticas, reintentos y secretos; no se ejecutó validación de AWS. |
| Capacidad funcional | Día de dos medidores: 17.282 muestras a 10 s y 34.562 a 5 s. Intervalos compactados y lotes menores de 3,5 MiB para el límite SQL de 4 MiB. Consulta/recomputación por día con vecinos, sin cargar un mes por paquete. No equivale a carga de producción medida. |
| Herramientas | Tipos, lint sin warnings y build optimizado correctos. `npm audit --omit=dev`: cero avisos conocidos. Avisos de herramientas en [dependencies.md](dependencies.md). |

Los skips de la suite ordinaria sin conexiones no acreditan aislamiento. La ejecución de esbuild necesitó permiso local adicional para leer directorios padre; la revisión automática lo aprobó y solo generó archivos dentro del proyecto.

## Pendientes externos y límites

| Elemento | Estado |
| --- | --- |
| Kit físico | Falta confirmar modelo/firmware, TC, instalación/fases, signos, precisión y comparación con instrumento bajo condiciones documentadas. La referencia no autoriza una compra. |
| Sincronización | Se conserva la hora real de cada lectura. Consumo instantáneo ausente si los puntos no están alineados; energía prorrateada estimada. |
| AWS | Falta validar CloudFormation/IAM en destino, provisionar certificados, desplegar y probar TLS, secreto/red, reintentos/DLQ, fallo de regla/error action y revocación efectiva en IoT Core. La revocación del registro local sí está probada. |
| Cognito/staging | Pendientes proveedor real, correo/MFA, TLS/pooling, alojamiento y repetición de autorización. |
| Escala/retención | No se acreditaron 100 sitios, costos, particionado, retención de producción ni restauración operativa; corresponden al hito 7 antes de escalar. |

QoS1 confirma aceptación del broker. No se garantiza entrega exactamente una vez de extremo a extremo; un fallo del error action también requiere observación y recuperación comprobadas. No hay control remoto, alertas operativas ni informes del hito 6.

## Reproducción

Usar Node 24 y [README](../README.md). La base local debe estar arrancada con migraciones y seguridad instaladas. `.work/pg-local/test-env.json` guarda conexiones privadas `admin`, `migration`, `runtime`, `auth` e `ingest`, excluidas de Git. La demo conserva sus flags originales en `.env.local`.

```powershell
$env:TEST_ENV_FILE = '.work/pg-local/test-env.json'
npm run test:integration
npm test
npm run typecheck
npm run lint
npm run build
npm run build:ingestion
```

`test:http` requiere la aplicación persistente y conexiones explícitas; `test:telemetry:http` usa su fixture e `INGEST_DATABASE_URL`. Tras reiniciar, `TEST_VERIFY_PERSISTENCE=true` verifica los mismos registros con ambos scripts. Las sesiones de QA se siembran únicamente desde scripts locales; la aplicación no ofrece un bypass de identidad.

Para paquetes sin base: `npm run simulate -- --config archivo.json --output archivo-nuevo.jsonl`. No se contrataron servicios, compraron equipos, enviaron mensajes externos ni crearon recursos AWS.

Al entregar se detuvieron la aplicación de QA persistente y PostgreSQL, conservando sus datos. La demostración queda disponible en [127.0.0.1:3100](http://127.0.0.1:3100/dashboard). Las sesiones ficticias locales no constituyen cuentas de usuario del producto.
