# Progreso de Monitoreo Solar

Fecha: **8 de octubre de 2026**. Hitos **0 y 1 completados en el alcance local**. La implementación se detiene aquí por instrucción del usuario. El hito 2 no se ha iniciado.

## Alcance y decisiones

Se leyeron el prompt TXT y la guía DOCX de Downloads como referencias del encargo. La carpeta contenía únicamente `.git`, sin commits, aplicación, dependencias, README ni `AGENTS.md` aplicable. No hubo código previo que reemplazar ni cambios ajenos que descartar.

Se creó el monolito modular Next.js con TypeScript estricto, React, Tailwind, npm y lockfile. La documentación oficial y npm se contrastaron para seleccionar versiones estables compatibles. [Arquitectura](architecture.md), [ocho hitos y aceptación](roadmap.md), [despliegue Hostinger](deployment-hostinger.md) y [versiones/avisos](dependencies.md) registran decisiones y pendientes.

Funcionan `/dashboard`, `/projects`, `/projects/[id]`, `/alerts`, `/settings` y `/api/health`. La interfaz está en español, tiene navegación de escritorio y móvil, búsqueda, filtros GET y selección de organización ficticia. El nombre provisional se centraliza en `src/lib/brand.ts`.

La demo sirve exclusivamente fixtures mediante un adaptador: **dos organizaciones y tres proyectos por organización**, sin datos reales de personas o clientes. El reloj fijo es `2026-10-08T15:00:00.000Z`, 10:00 de Bogotá. Se comunican muestras simuladas, red calculada, energía parcial, lecturas históricas y ausencia de datos. No hay autenticación ni aislamiento multiempresa acreditado; el selector no demuestra seguridad.

Prisma prepara el esquema PostgreSQL y el cliente diferido. No se ejecutaron consultas, migraciones ni escrituras remotas. Ninguna ruta demo utiliza el cliente de base de datos. El build inicial pasó incluso antes de crear `.env.local`, sin credenciales y sin consultas de negocio para pregenerar páginas.

## Verificación ejecutada

Runtime comprobado: Node **24.19.0**, npm **10.9.2**. Next **16.4.0**, React **19.3.0**, TypeScript **5.9.3**, Tailwind **4.3.3** y Prisma **7.10.0**. Más versiones en [dependencies.md](dependencies.md) y `package-lock.json`.

| Comando o comprobación | Resultado real |
| --- | --- |
| `npm ci` sobre el lockfile final | Código 0. Aviso de limpieza EPERM de un paquete WASM opcional y aviso de soporte ESLint documentados. |
| `npm run db:validate` | Código 0; esquema válido. No verifica una conexión. |
| `npm run typecheck` | Código 0; generación Prisma y TypeScript estricto. |
| `npm run lint` | Código 0, sin errores ni warnings del código. Repetido tras la corrección final de interfaz. |
| `npm test` | Código 0: **5 pruebas, 5 aprobadas**. |
| `npm run build` | Código 0; generación Prisma y build optimizado, verificado antes y después de las correcciones. |
| `npm start -- --port 3100 --hostname 127.0.0.1` | Arranque de producción local correcto. 3000 estaba ocupado; no se detuvo el proceso ajeno. |
| `/api/health` | HTTP 200, únicamente `{"status":"ok"}`. |
| `npm run test:smoke` con SMOKE_BASE_URL local | Código 0: salud, rutas, enlace a detalle, búsqueda sin coincidencias y proyecto inexistente. |
| Chrome headless / Playwright del runtime disponible | PASS: dashboard → listado → búsqueda Aurora → un resultado → detalle; cambio de empresa; filtro de alertas resueltas; vacío; error y recuperación; proyecto desactualizado. `pageErrors: []`. |
| Escritorio 1440×1050 y móvil 390×844 | 13 capturas revisadas. Dashboard, detalle, proyectos, alertas y configuración sin desbordamiento documental móvil; tablas y gráfico tienen scroll interno. |
| Detector de interfaz | Una ejecución: `[]`, sin hallazgos. |
| Configuración demo | Pruebas rechazan flags incompletos, APP_ENV ausente y APP_ENV=production; permiten Next optimizado con APP_ENV=development. |
| Secretos y Git | `.env.local`, `.next`, `node_modules`, cliente generado y QA ignorados. `.env.example` contiene solo ejemplos. |

Las cinco pruebas comprueban activación segura de demo, fixtures y búsquedas acotadas a ejemplos, balance de potencia/energía, integración al cambiar de signo y ante huecos, y contrato de telemetría v1 (unidades, calidad, fechas, versión y rechazo de tenant inyectado). **No son pruebas de aislamiento de una base real.**

## Revisión de interfaz

La revisión independiente final concluyó **PASS**, sin defectos materiales abiertos. Se corrigieron los problemas detectados en una tanda y se confirmó el resultado con nuevas capturas y el recorrido automatizado.

| Acción | Estado final | Evidencia |
| --- | --- | --- |
| Restablecer desde error | Resuelto | La navegación vuelve al dashboard normal. |
| Eliminar overflow documental móvil | Resuelto | Cinco rutas con ancho de documento igual a 390 px. |
| Evitar tabla de proyectos comprimida | Resuelto | Nombres legibles, scroll interno e indicación visible. |
| Hacer legibles los ejes móviles | Resuelto | Tipografía ampliada y gráfico desplazable. |
| Separar acciones y nota de Configuración | Resuelto | Padding y gaps consistentes. |
| Mostrar navegación móvil completa | Resuelto | Cuatro destinos visibles. |
| Revisión interactiva independiente de accesibilidad y carga | Parcial, sin bloqueo material | Fuente y contrastes revisados; sin auditoría interactiva independiente de foco, hover, zoom o varios navegadores. |
| Defectos materiales pendientes | Ninguno | Confirmación final completada. |

El estado de carga usa `loading.tsx`, skeleton accesible y movimiento reducido. Vacío, error/recuperación y desactualización se comprobaron en navegador. Los contrastes de texto revisados superan 4,5:1. No se presenta como certificación de accesibilidad ni como matriz completa de navegadores.

## Cómo revisar la entrega

La demo se dejó arrancada en [http://127.0.0.1:3100/dashboard](http://127.0.0.1:3100/dashboard). Para volver a iniciarla, desde la raíz con Node/npm en PATH:

```powershell
# Primera preparación en otro equipo; conservar un .env.local existente.
npm ci
Copy-Item .env.example .env.local
npm run build
npm start -- --port 3100 --hostname 127.0.0.1
```

En otra terminal:

```powershell
$env:SMOKE_BASE_URL = 'http://127.0.0.1:3100'
npm run test:smoke
```

Para desarrollo está disponible `npm run dev` (o `npm run dev -- --port 3101` si 3000 sigue ocupado). Se preparó ese comando; la evidencia de arranque y recorrido corresponde a `npm start` con el build optimizado.

## Pendientes externos y límites

| Elemento | Estado |
| --- | --- |
| Hostinger: plan, recursos, Node y logs | Pendiente de acceso a la cuenta. |
| GitHub, rama, dominio y destino staging inequívoco | Pendientes; no se desplegó ni cambió DNS. |
| PostgreSQL staging y lectura/escritura aislada con TLS | Pendiente de base y credenciales autorizadas. |
| Cognito, sesiones y autenticación | No implementados; hito 2. |
| Aislamiento de empresas en PostgreSQL | No implementado ni verificado; hito 2. |
| Dispositivos e infraestructura AWS | No conectados ni aprovisionados; fuera del alcance. |

Auditoría npm: cero avisos conocidos en dependencias de ejecución (`--omit=dev`); cinco avisos transitivos altos de lint por `braces`, sin parche estable disponible. El soporte de ESLint y los overrides del CLI Prisma están registrados en [dependencies.md](dependencies.md). Reevaluar antes de preparar producción; no se anuncia seguridad de producto terminada.

El arranque local optimizado no acredita despliegue Hostinger, persistencia, identidad, aislamiento ni conexión a equipos reales.

## Próximo hito tras la pausa

El próximo encargo será **hito 2**: Cognito y sesiones seguras; membresías con roles por organización; permisos por proyecto; RLS y contexto transaccional en PostgreSQL; pruebas reales de acceso cruzado con el rol de ejecución y credenciales de migración separadas. Necesita configuración autorizada de Cognito y PostgreSQL de staging. No incorporar datos de clientes antes de verificar esas garantías.

**Pausa al terminar hitos 0 y 1.** No se continúa con los siguientes hasta que el usuario lo indique.
