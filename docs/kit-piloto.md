# Kit piloto y gateway — Hito 5

Estado: software y pruebas locales implementados. No se ha comprado, conectado ni calibrado un medidor, ni se ha conectado el gateway a AWS. La precisión física, la orientación de los TC, el cableado, la continuidad eléctrica y la recuperación de un corte real siguen pendientes de aceptación en campo.

## Referencia compatible

El único mapa implementado es **Eastron SDM630MCT, protocolo Modbus v1.7**. Un equipo cuyo nombre solo diga SDM630, SDM630MCT V2, SDM630MCT-ML o una variante MID no se considera compatible por semejanza del nombre: hay que contrastar su protocolo exacto antes de habilitarlo. El [protocolo oficial SDM630MCT v1.7](https://www.eastroneurope.com/images/uploads/products/protocol/SDM630MCT_MODBUS_Protocol_V1.7.pdf) describe valores IEEE754 float32 de dos registros y lectura FC04. La selección es una referencia de integración; no se ha autorizado una compra.

Para el piloto de una instalación conectada a red sin batería se prevén:

- Un punto de generación y otro de intercambio con red, cada uno con medidor compatible, TC y protecciones adecuados a la instalación y a la placa del modelo exacto.
- Una pasarela **Modbus TCP a Modbus RTU RS485** que conserve el Unit ID; una pasarela de puerto serie transparente sin esta conversión no basta.
- Un equipo Linux con Node.js 24, almacenamiento persistente y una cuenta de servicio dedicada; red cableada local y acceso saliente MQTT/TLS al endpoint de IoT.
- Un certificado X.509 exclusivo del gateway, su clave privada y una CA válida; reloj sincronizado con NTP.

La elección final de TC, alimentación, protecciones, topología RS485, puesta a tierra y conexionado corresponde al diseño eléctrico y la puesta en servicio. El software no modifica ajustes ni controla equipos eléctricos.

## Mapa aplicado

Los números de dirección del código son offsets **base cero**, no las referencias 30001 del manual. Solo se emite FC04; nunca FC06/FC16 ni escrituras de configuración.

| Señal | Referencia del manual | Offset | Unidad recibida | Salida |
|---|---:|---:|---|---|
| Tensión A/B/C | 30001/30003/30005 | 0/2/4 | V | V |
| Corriente A/B/C | 30007/30009/30011 | 6/8/10 | A | A |
| Potencia activa A/B/C | 30013/30015/30017 | 12/14/16 | W | kW, divide entre 1000 |
| Potencia activa total | 30053 | 52 | W | kW, divide entre 1000 |
| Energía importada acumulada | 30073 | 72 | kWh | kWh |
| Energía exportada acumulada | 30075 | 74 | kWh | kWh |

Cada adquisición hace tres lecturas: `(0,18)`, `(52,2)` y `(72,4)`, evitando huecos de registros reservados. El orden normal es registro más significativo primero; `wordOrder: "low-first"` solo se utiliza si se ha verificado que el equipo está configurado así. Unit ID debe estar entre 1 y 247; no se usa broadcast. Los ensayos locales cubren fragmentación TCP, MBAP, identificador de transacción, función, tamaño, excepción, timeout, float no finito, signos y unidades.

El medidor aplica su propia relación de TC. El gateway **no multiplica por otra relación de TC**. El binding del piloto usa `configuration.multiplier: 1`; cualquier corrección posterior debe registrarse mediante una nueva versión temporal y verificarse para evitar doble escalado.

La convención del punto de red es potencia positiva al importar y negativa al exportar. `powerSign` es obligatorio: `1` conserva la lectura y `-1` invierte potencia total/por fase y permuta contadores importación/exportación. Debe confirmarse con una condición conocida de importación y otra de exportación; no se deduce por el nombre del dispositivo. La generación utiliza su orientación verificada. Cambios de orientación o relación requieren un nuevo binding temporal; no reescriben historia.

## Configuración privada

Autorizar primero el gateway en la organización y asociarle los medidores/puntos/versiones permitidos. El servidor genera un UUID que se utiliza como `GatewayIdentity.id`, `gatewayId`, `clientId`, ThingName de AWS y `gateway_id` del paquete. El certificado se vincula a ese Thing; su thumbprint de 64 caracteres hexadecimales se registra como principal. El UUID de inventario del dispositivo gateway es otro identificador.

Ejemplo de estructura, con identificadores y rutas que deben sustituirse por los autorizados:

```json
{
  "gatewayId": "dc379717-7120-4db8-aa1a-2f929cb8ccde",
  "clientId": "dc379717-7120-4db8-aa1a-2f929cb8ccde",
  "endpoint": "REEMPLAZAR-ats.iot.us-east-1.amazonaws.com",
  "topic": "solar/v2/gateways/dc379717-7120-4db8-aa1a-2f929cb8ccde/telemetry",
  "certificatePath": "/etc/solar-gateway/device.pem.crt",
  "privateKeyPath": "/etc/solar-gateway/private.pem.key",
  "caPath": "/etc/solar-gateway/root-ca.pem",
  "bufferPath": "/var/lib/solar-gateway/outbox.sqlite",
  "pollIntervalMs": 10000,
  "maxBufferSamples": 50000,
  "maxBufferBytes": 67108864,
  "meters": [
    {
      "model": "SDM630MCT-v1.7",
      "deviceId": "34597510-36b1-422e-a006-36f83143fb6e",
      "measurementPointId": "538c819f-7a6b-4ef5-84cc-837778cab689",
      "configurationVersion": 1,
      "host": "192.168.20.10",
      "port": 502,
      "unitId": 1,
      "wordOrder": "high-first",
      "powerSign": 1
    }
  ]
}
```

La configuración admite entre 1 y 8 medidores y puntos únicos. `endpoint` acepta un hostname de AWS IoT, sin URL ni puerto; `clientId` y tópico deben coincidir con el UUID autorizado. La conexión usa TLS con verificación del servidor, mínimo TLS 1.2, certificado cliente, QoS1 y `retain: false`. No existe una opción para desactivar TLS. En Linux la clave privada requiere permisos 0600; el directorio de almacenamiento debe pertenecer a la cuenta de servicio con permisos 0700, también para proteger archivos WAL/SHM. No guardar estos archivos ni el JSON privado en Git.

Ejecutar con **Node.js 24**:

```bash
npm ci
npm run gateway -- /etc/solar-gateway/gateway.json
```

Se verificó localmente con Node 24.19.0. `node:sqlite` tiene estabilidad 1.2 (release candidate) en la [documentación de Node 24](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html); se acepta para el piloto para evitar una dependencia nativa externa. Una advertencia experimental del runtime no significa que la cola haya fallado. El gateway exige Node24; el frontend no necesita importar SQLite. Mantener la versión fijada y repetir los ensayos de reinicio al actualizarla.

## Almacenamiento y tiempo

SQLite conserva cada evento y un único paquete en vuelo con los mismos IDs y contenido tras un reinicio. Solo elimina sus observaciones al recibir el PUBACK MQTT. Si la publicación falla, reenvía exactamente ese paquete. La deduplicación del servidor usa el evento, por lo que una redelivery no suma energía dos veces. El publicador mantiene como máximo una operación QoS1 pendiente en memoria; los demás eventos permanecen en SQLite.

El buffer limita simultáneamente cantidad de muestras y bytes de sus JSON. Por defecto son 50.000 y 64 MiB; la autonomía aproximada en segundos es `maxBufferSamples × pollIntervalMs / (1000 × cantidadMedidores)`, antes de considerar el límite de bytes. SQLite, índices, paquete en vuelo y WAL consumen espacio adicional: el límite JSON no es una reserva exacta del tamaño físico. Hay límites de páginas y checkpoints; se debe dejar margen de disco y verificarlo en el equipo real.

Al llenarse, elimina las observaciones más antiguas que no estén en vuelo y conserva un reporte durable con rango de tiempo y cantidad descartada. Una pérdida de una observación puede tener inicio igual a fin. Los reportes enviados quedan inmutables; las pérdidas posteriores usan otro reporte. No se reemplazan valores ausentes por cero ni se inventa energía durante la desconexión. Las publicaciones mezclan tres observaciones recientes por cada antigua cuando hay ambas clases, drenando primero el backfill más antiguo; el lote tiene como máximo 40 muestras y 64 KiB.

`measured_at` corresponde al final de la adquisición de cada medidor y se conserva al reenviar. Las tres lecturas de un medidor y los distintos medidores son secuenciales, **no una captura eléctrica simultánea**. Una falla produce `missing` o `invalid` y valores nulos. El consumo instantáneo calculado puede quedar pendiente si los puntos no tienen timestamps exactamente alineados. El balance de energía utiliza únicamente intervalos comunes y marca `estimated` cuando debe prorratear contadores; presenta su cobertura. El piloto no afirma consumo medido ni sincronía física que no se ha verificado.

PUBACK confirma aceptación por el broker, no una transacción PostgreSQL. La regla AWS tiene archivo de errores, SQS tiene reintentos/DLQ y el procesador tiene cuarentena durable; aun así se requiere comprobar las rutas reales en AWS. Véase [ingesta AWS](aws-ingestion.md).

## Aceptación pendiente en campo

1. Confirmar modelo/protocolo, régimen de fases, Unit ID, baud/paridad RS485, orden de palabras, relación de TC y convención de signos del punto.
2. Comparar tensiones, corrientes, potencia por fase/total y deltas de contadores con pantalla y equipo de referencia bajo importación/exportación conocidas; registrar tolerancia y evidencia, sin declarar precisión por pasar fixtures.
3. Cortar enlace MQTT y alimentación, reiniciar, comprobar IDs persistidos, recuperación del buffer, orden reciente/backfill y reporte de pérdida al alcanzar capacidad.
4. Probar certificado de otro Thing, tópico ajeno, gateway revocado y binding vencido; comprobar rechazo/cuarentena sin cruce de organización.
5. Comprobar reloj, cobertura de energía, escalado único y comportamiento con lectura ausente, contador reiniciado y sustitución de medidor.

Hasta completar esos puntos, el hito ofrece un piloto implementado y ensayado localmente, con validación física y AWS pendientes.
