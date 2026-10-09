# Hoja de ruta de Monitoreo Solar

La hoja de ruta sigue los ocho hitos de la guía aportada el 8 de octubre de 2026. El usuario autorizó sucesivamente 0/1, 2/3, 4/5 y 6/7, y después completar la preparación para conexiones de dispositivos y AWS/Cognito. La guía no contiene un hito 8: este cierre prepara la aceptación externa pendiente de 2, 5 y 7. Se mantiene su indicación de probar todo lo posible localmente sin inventar kit ni cuenta AWS. Consultar [progress.md](progress.md) y [preparación de conexiones](connection-readiness.md) para distinguir evidencia local y validaciones pendientes.

## Hito 0 Inspección y decisiones

**Entrega:** revisar las instrucciones, el estado del repositorio y los cambios locales; definir el monolito modular, entornos y dependencias externas; contrastar los requisitos del alojamiento Node.js y registrar el procedimiento.

**Aceptación:** repositorio evaluado sin perder trabajo ajeno; decisiones en `architecture.md`, los ocho hitos en este documento, preparación de Hostinger en `deployment-hostinger.md` y situación real en `progress.md`. Las comprobaciones de la cuenta que carezcan de acceso quedan pendientes de forma explícita.

## Hito 1 Base ejecutable y demostración

**Entrega:** Next.js, React, TypeScript estricto, Tailwind, npm, lockfile y configuración validada; rutas `/dashboard`, `/projects`, `/projects/[id]`, `/alerts`, `/settings` y `/api/health`; dos organizaciones ficticias con tres proyectos cada una mediante un adaptador de demostración explícito; esquema inicial coherente para PostgreSQL y Prisma.

**Aceptación:** instalación reproducible, lint, tipos, build y arranque local con optimizaciones de producción comprobados; navegación dashboard → listado → detalle y salud mínima; revisión de escritorio y móvil; carga, vacío, error y datos desactualizados comprensibles; kW y kWh diferenciados, ausencias sin cero y gráficos coherentes. La interfaz avisa que son datos simulados. No se presenta una pantalla de login como identidad terminada. La conexión de lectura/escritura con PostgreSQL y Hostinger staging solo se acredita si hubo acceso autorizado y evidencia.

**Pausa prevista:** no comenzar el hito 2 dentro del primer encargo.

## Hito 2 Identidad membresías y aislamiento

**Entrega:** Cognito, sesiones seguras, cierre de sesión e invitaciones con expiración; usuarios, organizaciones, membresías y permisos por proyecto. Aplicar autorización en servidor y RLS en PostgreSQL con credenciales de ejecución y migración separadas. Propagar el ámbito autorizado a exportaciones, archivos, trabajos y cachés; registrar acciones sensibles.

**Aceptación:** pruebas reales con dos organizaciones y el rol efectivo de la base demuestran que no pueden leer ni modificar registros ajenos por API, identificadores alterados, acceso directo o exportaciones. El propietario consulta únicamente proyectos asignados. El modo demo no puede funcionar en producción de clientes. No se incorporan datos reales antes de verificar esta puerta.

## Hito 3 Clientes proyectos y activos persistentes

**Entrega:** altas y edición de clientes e instalaciones, técnicos y propietarios; zona horaria, ubicación, potencia nominal y topología inicial validada sin batería. Persistir dispositivos, puntos de medición, asignaciones temporales y versiones de topología. Registrar puesta en marcha y cambios, sin reinterpretar históricos tras un reemplazo.

**Aceptación:** crear un proyecto, asignar participantes y puntos, sustituir un medidor y conservar datos e historial tras reinicios y despliegues. Las restricciones impiden asignar equipos de otra organización. Un número de serie o QR por sí solo no otorga acceso: la vinculación requiere sesión y autorización.

## Hito 4 Telemetría simulada por el contrato real

**Entrega:** simulador independiente y determinista; contrato versionado, validación común con la futura ingesta real, deduplicación, resolución del ámbito desde el registro de dispositivos y procesamiento de datos atrasados. Persistir muestras, último estado y agregados. Calcular balances para una topología conocida, manejar deltas, reinicios, huecos y sustituciones; elegir la fuente principal de cada punto.

**Aceptación:** casos con resultados conocidos verifican las fórmulas y unidades; repetir un evento no duplica energía; mensajes fuera de orden no hacen retroceder el último estado; reiniciar un contador no genera energía negativa; se distinguen medido, calculado, estimado y ausente. Los tiempos se almacenan en UTC y se presentan en la zona del proyecto.

## Hito 5 Primer kit real y recuperación

**Entrega:** elegir y documentar medidor, sensores, gateway, protocolo y puntos físicos compatibles con el piloto. Provisionar identidad individual, TLS y permisos; integrar IoT Core, SQS estándar y Lambda con reintentos, lotes, cuarentena y fallos parciales. Guardar lecturas en interrupciones y recuperar atrasos con límites de envío.

**Aceptación:** las mediciones son trazables hasta el equipo y se comparan con un instrumento de referencia bajo condiciones documentadas, incluyendo fases e importación/exportación. Desconectar y reconectar no duplica datos ni bloquea los recientes; una pérdida fuera del buffer aparece como hueco; revocar credenciales impide nuevos envíos. La precisión se comunica según la evidencia.

## Hito 6 Alertas portal del propietario e informe

**Entrega:** alertas por comunicación, datos inválidos, generación esperada y alarmas de equipo con ventanas de persistencia y recuperación; mantenimiento, supresión de repetidos y envío con reintentos. Incidencias con responsable, seguimiento y cierre. Portal autorizado por proyecto e informe de período con archivos privados y descargas temporales.

**Aceptación:** una anomalía persistente crea la alerta esperada, se asigna, se resuelve y queda auditada. No se diagnostica una avería únicamente por falta de datos. El informe concuerda con período, unidades, calidad y zona horaria de la interfaz; los propietarios no acceden a archivos ni instalaciones ajenos.

## Hito 7 Seguridad recuperación capacidad y piloto

**Entrega:** separar staging y producción; revisar secretos, sesiones, permisos, archivos y límites de solicitudes; probar respaldos y restauración aislada, migraciones incrementales y retorno de versión. Medir continuidad, retraso de ingesta, backlog, errores y costo por sitio. Pilotar con una o dos instaladoras y tres a cinco proyectos compatibles.

**Aceptación:** recorrido completo con clientes reales autorizados; aislamiento probado con credenciales efectivas; respaldo restaurado; respuesta a incidentes definida; carga normal y ráfaga de recuperación medidas. Se documentan costo observado, tiempo de alta, intervenciones, utilidad de alertas y disposición a pagar. La retención y el particionado se deciden con volumen de telemetría, no solo número de usuarios.

## Evolución posterior

Cobro recurrente automático, más kits, conectores de fabricantes, informes avanzados, marca blanca y aplicación móvil nativa se priorizarán según el piloto. El control remoto necesita capacidades validadas, órdenes autorizadas con vencimiento, idempotencia y confirmación del estado observado; no pertenece a la primera versión. S3 privado y procesos externos se incorporarán cuando informes, archivos o tareas lo requieran.
