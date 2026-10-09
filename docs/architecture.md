# Arquitectura de Monitoreo Solar

Decisión inicial: 8 de octubre de 2026; actualizada el 9 de octubre con los hitos 6 y 7 autorizados por el usuario. Se implementan alertas, incidencias, reportes privados, recuperación y ensayo de carga local. La aceptación física, servicios externos y piloto real siguen pendientes.

## Producto y límites

Monitoreo Solar es el nombre provisional de una plataforma B2B2C para empresas instaladoras. Cada organización administrará clientes, proyectos, técnicos, gateways y medidores. Una persona podrá pertenecer a varias organizaciones con distintos permisos; el propietario solo podrá consultar proyectos asignados. El nombre se centraliza en la configuración de interfaz.

La fuente principal prevista son medidores independientes. Las integraciones autorizadas con inversores serán complementarias. La primera versión es de lectura: no envía órdenes a equipos y no promete control ni compatibilidad universal.

El modo de demostración usa exclusivamente fixtures ficticias, identificadas en pantalla como **«Demostración con datos simulados»**: dos organizaciones con tres proyectos cada una. Su selector no constituye autenticación. El modo persistente exige sesión verificada y membresías; cada consulta aplica RLS en PostgreSQL. Se verificó con datos ficticios y una base local; Cognito real y staging siguen pendientes. Ningún equipo ni cliente real está conectado.

Quedan fuera cobros, automatizaciones eléctricas, control de inversores, aplicación nativa, marca blanca y conectores de fabricantes. Técnicos y propietarios consultan mediciones, alertas, seguimiento e informes de instalaciones asignadas. La evolución se registra en [roadmap.md](roadmap.md).

## Decisiones de implementación

Se utiliza un monolito modular en la raíz con Next.js App Router, React, TypeScript estricto, Tailwind CSS y runtime Node.js. npm y `package-lock.json` fijan la instalación. El gateway Node.js 24 y el consumidor Lambda se ejecutan por separado; comparten contrato y procesamiento. No se agrega Express.

Los Route Handlers atienden HTTP, validan entradas y traducen resultados. Las reglas y la composición de datos pertenecen a módulos reutilizables. Los Server Components usan los mismos módulos; la interfaz no contiene credenciales ni decide permisos futuros.

| Carpeta | Responsabilidad |
| --- | --- |
| `src/app` | Rutas, layouts, estados de navegación y Route Handlers delgados. |
| `src/modules` | Servicios y reglas de organizaciones, clientes, proyectos, dispositivos, telemetría y alertas según el alcance. |
| `src/components` | Navegación, tablas, gráficos y estados de interfaz compartidos. |
| `src/lib` | Configuración validada y acceso a infraestructura. |
| `src/contracts` | Tipos y contratos versionados de entidades y telemetría. |
| `src/adapters/demo` | Fixtures deterministas y adaptador explícito de demostración. |
| `prisma` | Esquema PostgreSQL, migración inicial y instalación separada de roles/RLS. |
| `src/gateway` | Lectura Modbus TCP, buffer SQLite durable y publicación MQTT con TLS. |
| `src/ingestion` | Adaptación SQS/Lambda al procesador común de telemetría. |
| `infra` | CloudFormation del pipeline AWS, pendiente de despliegue real. |
| `docs` | Decisiones, hoja de ruta, despliegue y evidencia de progreso. |

El adaptador de demostración solo conoce fixtures. El servicio persistente usa la identidad resuelta de una sesión de servidor y `withTenant` para establecer el contexto transaccional y leer registros autorizados. Sin configuración no se cae a la demo. Las pantallas persistentes distinguen el simulador del gateway AWS, datos ausentes, calidad y cobertura del día consultado.

## Entornos y configuración

Se distingue el modo de ejecución de Next.js (`NODE_ENV`) del destino de negocio (`APP_ENV`). `npm run build` y `npm start` usan optimizaciones de producción de Next.js; una prueba local puede conservar `APP_ENV=development` y `DEMO_MODE=true`. Eso no convierte la demostración en producción de clientes.

La demo exige conjuntamente `APP_ENV=development` o `staging`, `DATA_ADAPTER=demo` y `DEMO_MODE=true`. Si falta `APP_ENV`, se considera `production`; por defecto el adaptador es `postgres` y la demo está desactivada. La configuración rechaza demo con `APP_ENV=production`; tampoco hay caída silenciosa a fixtures. El modo persistente requiere las conexiones y la configuración de identidad documentadas en [authentication.md](authentication.md).

Desarrollo, staging y producción de clientes usan variables y destinos independientes. `.env.example` contiene valores ilustrativos sin secretos; los `.env` reales se excluyen de Git. Ninguna credencial puede publicarse mediante `NEXT_PUBLIC_*`. El endpoint `/api/health` comunica únicamente la salud mínima del proceso; no acredita conectividad con PostgreSQL, Cognito o dispositivos.

## Persistencia e identidad

El destino remoto sigue siendo PostgreSQL administrado externo con Prisma. Neon es una opción por evaluar, no un servicio contratado. No se instala PostgreSQL en Hostinger ni se sustituye por MySQL. Se comprobó localmente PostgreSQL 18.4, una migración desde cero y el aislamiento con roles efectivos. Esquema, vínculos temporales y restricciones se describen en [h23-schema.md](h23-schema.md).

La compilación no debe abrir conexiones de negocio ni consultar la base para pregenerar páginas privadas. Generar Prisma Client o validar el esquema no requiere ejecutar migraciones remotas. No se incluye `prisma db push` ni una migración destructiva en `build`; las migraciones serán un paso explícito de release.

Cognito es el proveedor implementado mediante OIDC/PKCE; su configuración real aún debe probarse. La aplicación resuelve membresías, roles y acceso al proyecto en PostgreSQL. `solar_runtime` y `solar_auth` no son propietarios ni tienen BYPASSRLS; las credenciales de migración permanecen fuera del proceso web. Las funciones privilegiadas pertenecen a un rol NOLOGIN aislado, con EXECUTE explícito y search_path fijo. `withTenant` configura usuario/organización con SET LOCAL dentro de la transacción. El contexto confía en la identidad validada en servidor; las credenciales SQL nunca se distribuyen a usuarios. Las exportaciones aplican las mismas políticas y auditoría. Archivos, trabajos y cachés compartidas todavía no existen y deben conservar esa autorización al incorporarse.

## Contratos y significado de las mediciones

Los contratos incluyen organización, membresía, cliente, proyecto, dispositivo, punto, vinculaciones y topología versionada. Las fechas son TIMESTAMPTZ/UTC y se presentan en la zona del proyecto. FK compuestas y exclusiones evitan equipos de otra organización y ventanas superpuestas; los disparadores conservan la identidad histórica. Una muestra persistida identifica evento, vínculo/equipo/punto/versión, fechas, unidades, procedencia y calidad.

El contrato de adquisición **v2** excluye organización, proyecto y hora de recepción del payload. La autoridad viene del transporte y del registro: identidad UUID del gateway, cliente MQTT, principal y medidores autorizados. `solar_ingest` solo ejecuta funciones limitadas; carece de acceso directo a tablas. El servidor resuelve la asignación por `measured_at` y versión, conserva deduplicación y cuarentena, actualiza el último estado de forma monotónica y recalcula los días afectados. El v1 se conserva para las fixtures de demostración. [Contrato y cálculos](telemetry.md).

La interfaz separa potencia en kW de energía en kWh. En la demo, generación y consumo son muestras simuladas; la red se calcula por balance (`consumo − generación`). Los acumulados parciales se integran por trapecios, separando importación y exportación cuando cambia el signo. La ingesta persistente usa deltas de contadores y, si faltan, integración acotada de potencia con calidad estimada. No se integra a través de huecos. Un valor ausente se representa como ausencia, nunca como cero. Un dato desactualizado conserva su fecha y condición visibles.

## Evolución de infraestructura

La ingesta implementada usa adaptadores AWS IoT Core, SQS y Lambda, con identidades por gateway, TLS, deduplicación, reintentos y cuarentena. Se entrega CloudFormation y un consumidor compilable; no se han aprovisionado recursos. El gateway de solo lectura usa Modbus TCP, perfil SDM630MCT v1.7 y SQLite WAL para recuperar atrasos. [Kit y límites físicos](kit-piloto.md), [despliegue AWS](aws-ingestion.md). Los informes usan archivos privados y descargas temporales autorizadas; ver [reportes](reports.md).

El monitor independiente evalúa reglas, conserva estados y escribe alerta, transición, incidencia y aviso pendiente en una transacción. Un outbox con leases y reintentos publica avisos internos al portal. El worker de reportes congela periodo y zona horaria, calcula un snapshot con el mismo dominio energético y guarda el PDF antes de completar el job. Ambos usan solar_worker con funciones acotadas sin tablas directas. Las diez tablas H67 amplían RLS a 32; solar_backup sólo se usa offline para captura consistente de todos los tenants. [Esquema](h67-schema.md), [operación](operations-h67.md).

El alojamiento objetivo es **Hostinger Aplicación web Node.js**, con frontend y backend Next.js en ejecución. No se configura exportación estática. Los recursos del plan, destino de staging, rama, dominio, logs, puerto y salida TLS hacia PostgreSQL deben comprobarse con acceso real según [deployment-hostinger.md](deployment-hostinger.md).

## Compatibilidad contrastada

La documentación oficial consultada el 8 de octubre de 2026 muestra Next.js 16.4, mínimo Node.js 20.9 y TypeScript 5.1; el lint se ejecuta por separado del build. Las versiones efectivamente instaladas y probadas se registran en [progress.md](progress.md) y el lockfile. [Instalación de Next.js](https://nextjs.org/docs/app/getting-started/installation).

React publica la línea estable 19.3. Tailwind documenta la integración de su versión actual mediante `@tailwindcss/postcss` y `@import "tailwindcss"`. [Versiones de React](https://react.dev/versions), [Tailwind con PostCSS](https://tailwindcss.com/docs/installation/using-postcss).

Node.js 24 y 22 figuran como LTS; 18 y 20 ya figuran EOL. Se prefiere una línea LTS compatible con el plan, aunque Hostinger todavía liste líneas antiguas. [Releases de Node.js](https://nodejs.org/en/about/previous-releases).

Prisma 8 figura como release candidate y se excluye de esta base estable. La línea 7 conserva soporte y su conexión directa requiere un driver adapter; sus mínimos documentados incluyen Node 22.12 o 24 y TypeScript 5.4. Deben fijarse explícitamente los paquetes de la línea 7 para evitar que `latest` instale el candidato 8. [Estado de Prisma](https://www.prisma.io/docs/orm/release-status), [Prisma 7](https://www.prisma.io/docs/orm/v7), [Requisitos de Prisma](https://docs.prisma.io/docs/orm/reference/system-requirements).

## Supuestos abiertos

- No se recibieron credenciales ni un destino de staging inequívoco en la solicitud.
- El primer proyecto real se plantea conectado a red y sin batería; el kit y su topología todavía deben validarse.
- La suscripción del piloto será manual. No condicionará la operación eléctrica de la instalación.
- La demostración es una instantánea determinista y sus alertas son ejemplos, no diagnósticos reales.
- El cierre local y el cierre remoto se documentan por separado; una consulta a documentación oficial no verifica la cuenta contratada.
