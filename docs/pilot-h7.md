# Piloto y capacidad — hito 7

La implementación y el ensayo son locales. No hay clientes reales, equipos físicos, cuenta AWS, facturación ni evidencia de disposición a pagar. No se declara aceptado el piloto externo.

## Evidencia de carga local

[benchmark.ts](../scripts/benchmark.ts) crea dos instaladoras ficticias, cinco proyectos y diez medidores en una base loopback terminada en `_test`. Usa servicios y procesador reales con credenciales separadas, timestamps y contadores conocidos, dos paquetes concurrentes como máximo. No se importa en la aplicación. Reproducir con Node24:

```powershell
npm run benchmark -- --env-file .work/pg-local/test-env.json
```

[h67-benchmark.json](qa/h67-benchmark.json) conserva versión, tamaño del ensayo, tiempos, percentiles, throughput, aceptación, duplicados, cuarentena, backlog modelado, continuidad y aislamiento. Son 600 observaciones únicas y 10 repetidas; se verifica que la energía y el último estado de los cinco proyectos sean coherentes. La ráfaga representa un buffer en memoria y no mide SQS real. Los percentiles de la ráfaga tienen sólo cinco paquetes; no permiten prometer capacidad de producción ni 100 sitios. El retardo de timestamps es parte del escenario simulado; no acredita sincronización de relojes ni latencia de campo.

Medir en staging y luego en piloto: measured_at→received_at→ingested_at, p50/p95/p99 por etapa, errores/cuarentena/duplicados, edad y profundidad de SQS/DLQ, trabajos de reportes y avisos pendientes, uso de base y tiempo de recomputación. Reportar cobertura y pérdidas por punto y periodo. Separar lecturas antiguas recuperadas de lecturas actuales; un backfill exitoso no hace reciente una medida histórica.

## Alta y seguimiento de 3–5 proyectos reales

1. Confirmar autorización de una o dos instaladoras y sus propietarios, alcance, contacto responsable y consentimiento para acceso a datos. Elegir tres a cinco instalaciones compatibles con el kit validado.
2. Registrar zona horaria, ubicación, topología, fases, medidores, signos y puntos físicos. Verificar hardware/firmware e instrumento de referencia según [kit](kit-piloto.md). Medir el tiempo humano desde inicio de alta hasta primera lectura válida; no confundirlo con duración de un script.
3. Crear usuarios reales mediante Cognito, asignaciones por proyecto y gateways individuales; comprobar aislamiento con credenciales de producción antes de datos de clientes. Invitar por el canal expresamente autorizado por el operador.
4. Ajustar persistencia y recuperación, horario y umbral de generación con el responsable técnico. Ejecutar un mantenimiento planificado, una desconexión/reconexión, un reporte de periodo y una incidencia asignada/cerrada.
5. Ensayar recuperación aislada completa, incluyendo archivos y roles. Registrar duración observada y diferencias de datos antes de habilitar el piloto.
6. Durante el periodo acordado, registrar intervenciones y tiempo, avisos útiles/inútiles/duplicados, percepción de los propietarios y disposición a pagar. Revisar alertas que pasan desapercibidas. Al terminar, decidir continuidad y alcance a partir de evidencia.

| Medida de piloto | Fuente | Estado actual |
| --- | --- | --- |
| Alta hasta lectura válida | Cronómetro y ficha por instalación | Pendiente de personas/equipos reales |
| Intervenciones y tiempo | Incidencias e historial de soporte | Sólo recorrido ficticio probado |
| Utilidad de alertas | Evaluación del instalador por episodio | Pendiente de piloto |
| Disponibilidad de datos | Cobertura/lag/pérdidas por punto | Escenario local conocido probado |
| Costo por sitio y mes | Export de facturación etiquetada + reparto documentado | Sin cuenta ni costos observados |
| Disposición a pagar | Entrevista autorizada y registro de respuesta | Sin clientes entrevistados |
| Recuperación | Backup restaurado y controles de acceso | Local, base separada en mismo cluster; proveedor pendiente |

## Costo y decisiones de escala

No hay un importe observado o cotizado. En AWS registrar por entorno y periodo: IoT mensajes/tamaño, SQS solicitudes y retención/DLQ, Lambda invocaciones/duración, base CPU/RAM/IO/almacenamiento/WAL, S3 objetos/versiones/descargas, logs, red y alojamiento. Repartir costos comunes mediante una regla explícita y dividir por sitios activos del mismo periodo; conservar moneda, impuestos, créditos y días cubiertos. No dividir una prueba local gratuita entre cinco y llamarlo costo de producción.

Usar el volumen real: sitios × puntos × muestras/día, tamaño medido por muestra, índices, agregados y copias. Fijar retención de crudos, agregados, logs, PDFs y respaldos con necesidad de soporte, presupuesto y requisitos del cliente. Evaluar particionado cuando volumen y consultas lo justifiquen; no se agregó una política destructiva sin datos de operación. Repetir carga sostenida y una reconexión representativa en staging, con márgenes acordados y observación del retraso acumulado, antes de ampliar el piloto.

La infraestructura prepara métricas de ingesta; los límites y el procedimiento de incidentes/restore se describen en [operación](operations-h67.md). Consultar las tarifas y la factura vigentes cuando exista el destino; esta entrega no inventa precios ni acredita gasto real.
