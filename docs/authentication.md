# Identidad, sesiones y configuración de Cognito

Implementación iniciada en el hito 2 y ampliada con los controles de los hitos 6/7. No se creó un User Pool ni se probaron credenciales reales. La [preparación de Cognito](cognito-setup.md) incluye ahora una plantilla CloudFormation, parámetros separados y el procedimiento de aceptación externa; no equivale a un despliegue.

## Configuración del proveedor

1. Preparar un stack del entorno con [infra/cognito.json](../infra/cognito.json) según [el procedimiento de Cognito](cognito-setup.md). La plantilla habilita **Authorization code grant** y los scopes `openid email profile`. El servidor admite clientes con secreto (`COGNITO_CLIENT_SECRET`) o sin él. La identidad debe incluir correo verificado; no se acepta `email_verified=false`.
2. Configurar un dominio de managed login. Registrar exactamente la callback `<APP_BASE_URL>/auth/callback` y la salida `<APP_BASE_URL>/login`. En staging/producción usar HTTPS. Para una conexión real de pruebas locales, AWS documenta la excepción HTTP de `localhost`; usar, por ejemplo, `http://localhost:3100`, y registrar ese origen completo. [Autorización de Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [cierre de sesión](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html).
3. Definir el issuer `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>`, cliente y dominio HTTPS en las variables privadas. El issuer configurado se restringe a Cognito y nunca proviene de una solicitud. `AUTH_SECRET` protege el estado temporal del inicio de sesión; generar al menos 32 bytes aleatorios y guardarlos en el gestor de secretos.
4. Preparar `AUTH_DATABASE_URL` como `solar_auth`, distinta de `DATABASE_URL` (`solar_runtime`). Los roles y funciones se instalan según [el procedimiento SQL](../prisma/security/README.md).
5. Verificar en staging el recorrido real login → callback → organización → invitación → logout, correo verificado/no verificado, expiración, intentos repetidos, cookies Secure, reinicio y revocación. Probar TLS, pooling y permisos efectivos en el proveedor de base elegido. Esta aceptación externa permanece pendiente.

La aplicación usa PKCE S256, `state` y `nonce` aleatorios; Cognito admite S256. El canje y la verificación de firmas/JWKS, issuer, audience, expiración y `token_use=id` ocurren en servidor. [PKCE de Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), [openid-client](https://github.com/panva/openid-client).

## Sesión y autorizaciones

La cookie temporal es un JWE autenticado con vigencia de diez minutos; contiene nonce, state y verificador PKCE. Su hash de estado se consume una sola vez de forma atómica en PostgreSQL. Cada callback elimina la cookie temporal, incluso si falla. Los retornos se limitan a rutas internas.

La sesión usa un token opaco aleatorio de 32 bytes. Solo se guarda SHA-256 en la base. La cookie es HttpOnly, SameSite=Lax y Secure con HTTPS/producción, con caducidad limitada al menor entre ocho horas y la expiración del ID token. No se guardan refresh tokens ni JWT en localStorage. En esta versión se vuelve a iniciar sesión al vencer; no hay renovación silenciosa.

Cada solicitud resuelve el hash contra una sesión vigente/no revocada y un usuario verificado. El logout requiere POST de mismo origen, revoca en servidor y borra cookies antes de regresar al proveedor. Si el proveedor no responde, la revocación local sigue vigente. Los permisos se vuelven a leer de PostgreSQL: no dependen de roles enviados por el navegador ni de grupos Cognito.

Las mutaciones API requieren JSON, sesión y `Origin` exacto; las respuestas privadas usan `no-store`. El cuerpo se limita a 32 KiB. Los archivos PDF privados y los trabajos de monitor/reportes ya están implementados: el worker usa funciones acotadas, y cada descarga comprueba sesión vigente, autorización por proyecto y un lease de cinco minutos y uso único. No hay caché compartida de respuestas privadas ni endpoint de subida arbitraria. Las exportaciones aplican RLS y registran auditoría. Next no registra las rutas entrantes y Referrer-Policy es `no-referrer`; el proxy/alojamiento deberá omitir códigos OAuth, cookies y tokens de invitación en sus logs. [Reportes](reports.md), [operación y límites](operations-h67.md).

Los límites atómicos de PostgreSQL restringen login a 60 solicitudes/minuto globales y callback a 120/minuto; el API aplica presupuestos globales y por usuario. El logout conserva la revocación de sesión. El proxy/WAF remoto y sus controles por IP todavía deben configurarse en el destino.

## Evidencia local y límites

Las pruebas OIDC usan un proveedor inyectado de pruebas HTTPS con JWT firmado y JWKS, sin debilitar el proveedor de ejecución. Verifican PKCE, firma, claims, nonce, state, expiración y replay. Las pruebas PostgreSQL comprueban funciones `auth_*`, límites temporales, concurrencia, resolución/revocación de sesiones y logout con cookies Secure/HttpOnly/SameSite en un origen HTTPS. Esa fixture usa APP_ENV=development porque su PostgreSQL es loopback sin TLS; las pruebas de configuración comprueban separadamente que staging/producción lo rechazan.

Los scripts HTTP siembran sesiones ficticias directamente en la base local de pruebas, con credenciales administrativas privadas. No hay ruta, contraseña maestra, flag de bypass ni endpoint de login simulado en la aplicación. Estas pruebas no prueban la configuración del servicio Cognito real, su correo, MFA o el comportamiento del proxy remoto.
