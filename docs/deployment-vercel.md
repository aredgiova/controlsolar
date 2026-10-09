# Demostración en Vercel

La demo está publicada en **[controlsolar.vercel.app](https://controlsolar.vercel.app)** y se verificó el **9 de octubre de 2026**. Permite revisar y ajustar la interfaz con datos ficticios. No guarda cambios, no acredita identidad y no conecta equipos. No necesita PostgreSQL, Cognito, AWS ni secretos.

El repositorio autorizado es [aredgiova/controlsolar](https://github.com/aredgiova/controlsolar), con remoto SSH `git@github.com:aredgiova/controlsolar.git`. La cuenta Vercel comprobada en Authentication usa el usuario **aredlopez-8250**, con inicio de sesión GitHub vinculado a **aredgiova**. Su alcance Vercel es **aredlopez-8250s-projects**; usar allí un proyecto dedicado a esta demo. El propietario GitHub y el alcance Vercel tienen nombres diferentes.

## Despliegue verificado

| Evidencia | Resultado |
| --- | --- |
| Proyecto Vercel | `controlsolar`, alcance `aredlopez-8250s-projects` |
| Fuente conectada | `aredgiova/controlsolar`, rama `main` |
| URL estable | [controlsolar.vercel.app](https://controlsolar.vercel.app) |
| Primer despliegue comprobado | [controlsolar-qvssrof54-aredlopez-8250s-projects.vercel.app](https://controlsolar-qvssrof54-aredlopez-8250s-projects.vercel.app) |
| Commit de ese despliegue | [`6400b28`](https://github.com/aredgiova/controlsolar/commit/6400b28ac0806476e44d22fe074bc0a23566163b) |
| Verificación HTTP remota | `npm run test:vercel:demo` aprobado sobre la URL estable |
| Revisión en navegador | Dashboard y cambio a la empresa ficticia Horizonte correctos |

La prueba remota comprobó health, redirección inicial, ocho páginas del espacio de trabajo, detalle de proyecto, búsqueda sin resultados, login de demo y callback controlado. Las solicitudes GET y POST a la API de organizaciones devolvieron 401 sin sesión ni escritura. La evidencia está en [qa/vercel-demo.json](qa/vercel-demo.json). Este resultado acredita el despliegue de la demo; la aceptación de PostgreSQL, Cognito, AWS, equipos físicos y clientes reales sigue pendiente.

## Configuración preparada

| Ajuste | Valor |
| --- | --- |
| Framework Preset | Next.js |
| Root Directory | Raíz del repositorio (`./`) |
| Node.js Version | 24.x |
| Install Command | `npm ci` |
| Build Command | `npm run build:vercel` |
| Output Directory | Automático de Next.js; dejar el ajuste predeterminado |

`vercel.json` declara el framework y los comandos. `package.json` fija Node 24.x y conserva el lockfile. El build de Vercel valida la configuración de demo y después ejecuta `prisma generate && next build`. La generación de Prisma no conecta una base ni aplica migraciones. No usar `output: "export"`: esta aplicación utiliza páginas dinámicas y rutas de servidor.

`.vercelignore` limita los archivos que se suben mediante CLI. `.gitignore` protege los archivos locales al publicar en Git. No agregar `.work`, archivos `.env` privados, respaldos, certificados, claves o informes privados al repositorio ni a la carga de Vercel. El archivo público [`.env.vercel-demo.example`](../.env.vercel-demo.example) contiene únicamente la configuración ficticia.

## Variables de entorno

Agregar estas tres variables en **Settings → Environment Variables** y seleccionar tanto **Preview** como **Production** del proyecto de demo:

| Variable | Valor |
| --- | --- |
| `APP_ENV` | `staging` |
| `DATA_ADAPTER` | `demo` |
| `DEMO_MODE` | `true` |

El scope **Production** de Vercel determina qué despliegue recibe las variables; `APP_ENV` determina el comportamiento de ControlSolar. Una URL estable de la demo puede usar el scope Production de Vercel y debe conservar `APP_ENV=staging`. La aplicación sigue prohibiendo la demo con `APP_ENV=production`. No configurar `NODE_ENV` manualmente.

No agregar `DATABASE_URL`, `AUTH_DATABASE_URL`, credenciales de migración, ingesta o workers, variables Cognito, `AUTH_SECRET` ni claves AWS. Tampoco hacen falta `APP_BASE_URL`, `REPORT_STORAGE` o variables `NEXT_PUBLIC_*`. El chequeo previo al build exige las tres variables de demo y rechaza credenciales de servicios reales. Una modificación de variables solo se aplica a un despliegue nuevo.

## Publicación mediante GitHub

1. Confirmar que el código está publicado en `aredgiova/controlsolar` y que la rama que se importará contiene esta preparación. No publicar archivos locales privados.
2. En Vercel, entrar con el usuario **aredlopez-8250** y comprobar que el selector de cuenta o equipo corresponde al alcance **aredlopez-8250s-projects**. Crear/importar un proyecto dedicado a la demo desde el repositorio GitHub **aredgiova/controlsolar**. Si no aparece, revisar los permisos de la integración GitHub para ese repositorio.
3. Revisar los ajustes de la tabla y configurar las tres variables para Preview y Production **antes del primer build**. Dejar vacías las credenciales de servicios reales.
4. Desplegar y guardar la URL que Vercel devuelva. Comprobar que el build terminó correctamente y ejecutar la verificación descrita abajo.
5. Los siguientes cambios enviados a la rama de producción configurada en Vercel actualizan la URL estable. Las otras ramas y pull requests generan previews para revisar cambios antes de incorporarlos. Mantener la misma configuración ficticia en ambos scopes.

El proyecto ya está conectado a GitHub y el primer despliegue remoto está registrado arriba. Para cada actualización, comprobar que Vercel terminó el build y repetir la verificación sobre la URL resultante. La URL estable sigue el despliegue activo; el enlace del primer despliegue conserva la referencia de su commit.

La preparación local pasó lint, typecheck, pruebas (87 correctas y 9 omitidas por requerir servicios externos), `npm run build:vercel` con las tres variables de demo y la verificación HTTP sobre una instancia recién iniciada en el puerto 3100. La publicación en GitHub y el despliegue Vercel se completaron y la prueba HTTP remota también pasó.

## Verificación

Con Node 24 y dependencias completas, ejecutar en un entorno sin credenciales reales:

```powershell
npm ci
npm run lint
npm run typecheck
npm test
$env:APP_ENV = 'staging'
$env:DATA_ADAPTER = 'demo'
$env:DEMO_MODE = 'true'
npm run build:vercel
```

Para probar el build local, iniciar `npm start` en esa terminal. En otra terminal:

```powershell
$env:DEMO_BASE_URL = 'http://127.0.0.1:3000'
npm run test:vercel:demo
```

Para comprobar la demo publicada:

```powershell
$env:DEMO_BASE_URL = 'https://controlsolar.vercel.app'
npm run test:vercel:demo
```

La prueba comprueba la respuesta de la demo y sus rutas; no necesita sesión ni hace cambios de gestión. `/api/health` solo acredita que el proceso responde, no la conexión a dispositivos o servicios.

Revisar también en navegador el dashboard, el cambio de empresa, la lista y el detalle de proyectos, clientes, dispositivos, alertas y portal. Deben conservar la identificación de demostración y mostrar información ficticia. Si la protección de previews de Vercel pide acceso, iniciar sesión con la cuenta autorizada para la revisión; no desactivar la protección solo para ejecutar una prueba anónima.

## Alternativa con CLI

La integración GitHub es el recorrido recomendado para seguir ajustando la demo. Si se usa CLI, primero verificar la identidad y el alcance:

```powershell
npx vercel@latest login
npx vercel@latest whoami
```

Continuar solo tras comprobar que `whoami` muestra **aredlopez-8250** y que tiene acceso al alcance **aredlopez-8250s-projects**. Vincular explícitamente el proyecto de demo:

```powershell
npx vercel@latest link --scope aredlopez-8250s-projects
```

Revisar el proyecto seleccionado en el diálogo y en `.vercel/project.json`; no aceptar otro propietario ni un proyecto de producción real. Configurar en el dashboard las variables de Preview y Production indicadas arriba. Con la cuenta y el proyecto ya comprobados, este comando crea un preview:

```powershell
npx vercel@latest --scope aredlopez-8250s-projects
```

No omitir `--scope aredlopez-8250s-projects` ni añadir opciones que acepten automáticamente una vinculación distinta. La preparación del repositorio no inicia por sí sola un login, una vinculación ni un despliegue.

## Paso posterior a servicios reales

Mantener esta demo en su proyecto dedicado. Crear un proyecto separado para staging real y después producción, con sus variables, dominios y pruebas de aceptación. Seguir [el orden para conectar servicios reales](connection-readiness.md) y [la configuración Cognito](cognito-setup.md), incluyendo los callbacks de la URL definitiva.

El despliegue real requiere PostgreSQL accesible con TLS y roles separados; revisar el tamaño de los pools ante el escalado de funciones y la compatibilidad de cualquier pooler con las transacciones y RLS existentes. Los informes necesitan S3 privado e identidades de acceso separadas. Monitor, worker de informes, gateway e ingesta no se ejecutan automáticamente como parte del servidor web Vercel: desplegarlos en sus destinos previstos y supervisarlos según [la guía de procesos](worker-deployment.md).

Antes de habilitar PDFs reales en Vercel, adaptar o limitar las descargas: el código admite informes de hasta 10 MB, mientras que Vercel Functions limita el cuerpo de petición o respuesta a 4,5 MB. La demo no acredita esa integración ni la conexión física del kit.

## Referencias oficiales

- [Next.js en Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs): integración y ejecución de páginas dinámicas.
- [Versiones de Node.js](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions): soporte de 24.x y selección mediante `engines`.
- [Configuración de proyecto](https://vercel.com/docs/project-configuration): comandos de instalación y build.
- [Variables de entorno](https://vercel.com/docs/environment-variables): scopes Preview/Production y aplicación a despliegues nuevos.
- [`.vercelignore`](https://vercel.com/docs/deployments/vercel-ignore) y [exclusiones predeterminadas](https://vercel.com/docs/builds/build-features#ignored-files-and-folders): filtros de archivos de CLI.
- [Prisma v7 y caché de builds](https://www.prisma.io/docs/orm/v7/more/troubleshooting/nextjs): regenerar Prisma Client en cada build.
- [Límites de Vercel Functions](https://vercel.com/docs/functions/limitations): tamaño de cuerpos y duración de ejecuciones.
