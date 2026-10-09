# Telemetría local y contrato de campo — hitos 4 y 5

La demostración continúa usando sus fixtures. La telemetría persistente se consulta únicamente en modo PostgreSQL, con sesión y alcance de empresa/proyecto. Los datos del simulador se etiquetan como **simulados**; no acreditan una medición física ni una conexión con AWS.

## Contrato 2.0

Gateway, simulador y worker usan `src/modules/telemetry/protocol.ts`. Cada paquete contiene `schema_version: "2.0"`, `gateway_id`, `packet_id`, `sent_at`, hasta 100 `samples` y hasta 100 `loss_reports`. El límite de transporte es 64 KiB por paquete. No se acepta un paquete vacío.

Cada observación contiene:

| Campo | Significado |
| --- | --- |
| `event_id` | UUID estable que se conserva al retransmitir. |
| `device_id` / `measurement_point_id` | Medidor y punto previamente registrados. |
| `configuration_version` | Versión de asignación vigente en `measured_at`. |
| `measured_at` | Fecha ISO 8601 con zona/offset de adquisición real. |
| `values.active_power` | Potencia activa en kW; `null` si falta. |
| `values.import_energy` / `export_energy` | Contadores acumulativos en kWh; `null` si faltan. |
| `units` | Literales obligatorios `kW`, `kWh`, `kWh`. |
| `quality` | `measured`, `missing` o `invalid`. |
| `phases` | Opcional: fases A/B/C sin duplicar, V, A y kW por fase. |
| `alarms` | Opcional: snapshot de hasta 32 códigos explícitos con severidad y estado. Omitido no acredita recuperación; `[]` es reporte sin alarmas activas. |

El esquema rechaza campos adicionales, valores no finitos, unidades distintas, calidades inventadas y atributos de autoridad como empresa, proyecto, fuente o recepción. `missing` exige todos los valores eléctricos nulos. Cero medido conserva su significado; ausencia no se convierte en cero. `estimated` y `calculated` solo se producen en el servidor.

La fuente viaja en un contexto separado: `{source, principalId, clientId, topic, receivedAt}`. La regla IoT/cola autorizada aporta ese contexto en AWS; el CLI aporta `source: "simulator"` en desarrollo/staging. El paquete nunca puede elegir la empresa. La identidad autorizada cumple `gateway_id = clientId = Thing Name = GatewayIdentity.id` y tópico exacto `solar/v2/gateways/{id}/telemetry`. `gatewayDeviceId` es el equipo físico del inventario y tiene otro UUID.

La allowlist del gateway contiene los UUID de sus medidores. Además, cada observación debe coincidir con el equipo, punto, versión y vigencia temporal de una asignación de la misma empresa. Un medidor alternativo, una versión incorrecta o un emisor sin autorización se envía a cuarentena. El alcance inicial usa el medidor de generación como fuente primaria; no suma una segunda lectura del inversor al mismo punto.

## Persistencia y reintentos

`processTelemetryPacket(packet, context)` devuelve conteos `accepted`, `duplicate`, `quarantined`, `lossReportsRecorded` y resultados por observación. Toda la operación usa `solar_ingest` mediante `INGEST_DATABASE_URL`, separada de runtime, identidad y migraciones. Ese rol solo ejecuta funciones SQL estrechas y no tiene permisos directos sobre tablas.

La transacción resuelve el registro, conserva observaciones, actualiza el estado más reciente y guarda los días derivados. Un fallo intermedio revierte todos esos cambios. Las lecturas más antiguas no hacen retroceder `telemetry_latest`.

- Mismo evento y contenido: duplicado sin energía adicional.
- Otro UUID con el mismo punto/asignación/instante y contenido: duplicado semántico.
- Mismo evento con contenido distinto, o mismo instante con valores diferentes: cuarentena, conservando el original.
- Eventos atrasados: hasta 30 días; reloj adelantado: hasta 5 minutos. La recepción también se valida contra el reloj del servidor.
- Pérdidas de buffer: informes estables con rango, cantidad y motivo `buffer_capacity`, persistidos sin duplicación. Una identidad inválida o un conflicto de informe queda en cuarentena durable.

La cola confirma observaciones rechazadas solo después de persistir su cuarentena. Los fallos de infraestructura se devuelven como fallos parciales de SQS para reintento. El transporte y despliegue se describen en [aws-ingestion.md](aws-ingestion.md).

## Potencia, energía y calidad

La dirección normalizada de red es positiva para importación y negativa para exportación. En generación/consumo, `import_energy` representa el contador de energía hacia delante. El driver convierte W a kW y aplica una sola vez la orientación de instalación. El medidor ya incorpora su configuración CT; no se vuelve a aplicar una relación CT en el mensaje. El multiplicador del registro se aplica una vez en el servidor; para el piloto debe permanecer en 1 salvo calibración comprobada.

Se prefieren deltas de contadores sobre la integración de potencia. Un descenso se marca como reinicio y nunca produce energía negativa. No se unen muestras de equipos, versiones de asignación o fuentes diferentes. Una muestra explícitamente ausente/inválida corta el intervalo. Un contador puede recuperar energía total a través de un hueco de comunicación; el hueco sigue registrado y el reparto de ese delta entre días se etiqueta **estimado**.

Sin contadores utilizables, se integra linealmente la potencia firmada, separando importación y exportación incluso si cruza cero. Esa energía siempre es **estimada**. Solo se integra dentro de `TELEMETRY_MAX_INTEGRATION_GAP_SECONDS` (300 por defecto, máximo 3600); un hueco mayor conserva valores ausentes. El reinicio de un contador puede usar esa misma alternativa corta si hay potencia válida.

Los días se delimitan en la zona IANA del proyecto. Se respetan días de 23/25 horas y cambios de offset; no se supone que un día siempre dura 86 400 segundos. Un intervalo recortado por medianoche o cambio de topología se distribuye proporcionalmente y pasa a estimado.

Generación, importación, exportación y consumo del balance comparten los mismos intervalos cubiertos y la topología vigente en cada instante. No se restan sumas de días con cobertura diferente. En la topología sin batería, `consumo = generación + importación − exportación`; con contadores alineados su calidad es **calculada**, y con interpolación/integración es **estimada**. Si existe un punto de consumo dedicado, se usa su medición con cobertura común. Sin cobertura compatible, el balance queda ausente.

La potencia instantánea calculada exige timestamps de generación y red exactamente iguales. El gateway conserva la hora real de cada adquisición secuencial: si difieren, ambas potencias medidas siguen disponibles y el consumo instantáneo queda ausente. No se inventa una simultaneidad ni se aplica una tolerancia oculta.

La inserción atrasada recalcula sus intervalos anterior/siguiente y todos los días cruzados. Se carga cada día afectado con los vecinos inmediatos por punto dentro del horizonte de 31 días; no se escanea un mes completo por cada lectura. El formato persistido `tuple-v1` compacta intervalos y se decodifica a los mismos tipos numéricos para consulta. Los lotes de escritura tienen un presupuesto de 3,5 MB, por debajo de 4 MiB SQL por llamada.

## Lecturas para la interfaz

`getTelemetryProjection(identity, orgId, projectId, {date})` devuelve números JSON, zona/día/corte de energía, calidad por métrica, cobertura, huecos, reinicios, conteos y hasta 288 buckets de potencia. Los buckets sin lecturas tienen `null`. `source` corresponde a la última lectura; `daySource` corresponde al día seleccionado, evitando atribuir datos históricos simulados a una lectura posterior de AWS.

`getPortfolioTelemetry(identity, orgId)` consulta únicamente estado reciente y configuración, sin cargar series históricas por proyecto. La conexión exige lecturas medidas de todos los puntos requeridos con asignaciones y topología actuales: hasta 5 minutos `online`, hasta 15 `stale`, después `offline`; sin lecturas, `missing`. Se consideran tanto adquisición como recepción. Una simulación histórica recibida ahora permanece histórica.

Hay límites explícitos de 200 000 observaciones por contexto/día y 20 000 por ejecución del simulador. Un día de dos puntos a 10 s contiene unas 17 280 observaciones; a 5 s, unas 34 560. En la prueba de instantánea diaria, cada fila compacta midió aproximadamente 1,45 MB a 10 s y 2,90 MB a 5 s. Estas son comprobaciones de límites locales, no una certificación de rendimiento, coste ni capacidad productiva. La retención, optimización de agregados incrementales y carga sostenida se validan en hitos posteriores.

## Uso del simulador

Primero crea cliente, proyecto, puntos, asignaciones, topología e identidad de gateway con fuente `simulator` y allowlist de medidores. El simulador no provisiona ni evade ese registro. Copia los identificadores autorizados a un archivo local:

```json
{
  "gatewayId": "UUID_DE_LA_IDENTIDAD_AUTORIZADA",
  "principalId": "identificador-local-registrado",
  "timezone": "America/Bogota",
  "seed": "piloto-uno",
  "from": "2026-10-09T11:00:00-05:00",
  "to": "2026-10-09T12:00:00-05:00",
  "intervalSeconds": 300,
  "capacityKwp": 6,
  "baseLoadKw": 2,
  "scenario": "baseline",
  "meters": [
    {"deviceId": "UUID_MEDIDOR_GEN", "measurementPointId": "UUID_PUNTO_GEN", "configurationVersion": 1, "kind": "generation"},
    {"deviceId": "UUID_MEDIDOR_RED", "measurementPointId": "UUID_PUNTO_RED", "configurationVersion": 1, "kind": "grid"}
  ]
}
```

Reemplaza los marcadores por UUID reales y el rango por fechas pasadas recientes dentro de las vigencias. `meters` admite `validFrom`/`validTo` opcionales para representar un reemplazo sin solapar equipos o puntos. Los escenarios disponibles son `baseline`, `duplicates`, `late`, `gap`, `missing`, `reset` y `device_alarm`. El último usa el código explícitamente simulado `SIMULATED_DEMO`; el driver físico no inventa registros de alarmas. Una semilla/configuración idéntica produce los mismos paquetes, contadores e IDs.

```powershell
# Exportación local: no escribe en la base.
npm run simulate -- --config .work/simulator.json --output .work/packets.jsonl

# Ingesta explícita por el mismo procesador y registro que usa el worker.
# APP_ENV debe ser development/staging e INGEST_DATABASE_URL debe usar solar_ingest.
npm run simulate -- --config .work/simulator.json --ingest
```

`--output` crea un archivo nuevo y no sobreescribe otro existente. Repetir `--ingest` con la misma configuración produce duplicados y conserva energía/estado. No pegues credenciales en la configuración del simulador; la conexión se entrega mediante variables del entorno.

## Evidencia local y pendientes externos

Las pruebas cubren esquema estricto, signos, contadores, integración, reinicios, huecos, duplicados, medianoche/DST, datos atrasados, topologías temporales, frescura y snapshots diarios compactos. La integración PostgreSQL comprueba lote multiproyecto, concurrencia, rollback, reemplazo histórico, conflicto, vecinos a medianoche, reinicio de conexiones y dos ejecuciones reales del CLI (primera aceptación y replay idéntico). La prueba HTTP comprueba autorización, enrolamiento, consulta, energía y revocación.

Quedan pendientes las lecturas del kit físico, verificación de orientación/CT/fases y firmware, certificados y conexión mTLS reales, despliegue IAM/IoT/SQS/Lambda y observación de reconexión/pérdidas en campo. No se presentan esas verificaciones como completadas por las pruebas locales.
