# Preparación de Amazon Cognito

La aplicación ya integra OIDC en servidor. [La plantilla Cognito](../infra/cognito.json) prepara la infraestructura pendiente para conectar ese login: **no se ha desplegado** y no contiene usuarios, contraseñas, secretos ni un alojamiento web. La guía original termina en el hito 7; este cierre prepara su aceptación externa, sin inventar un nuevo hito.

## Recursos y decisiones

Crear dos stacks independientes, uno para staging y otro para producción, con prefijos/orígenes distintos. La plantilla está dirigida a la partición comercial `aws`; no se ha preparado ni verificado GovCloud/China. Preferir cuentas AWS separadas para ambos entornos. No reutilizar User Pool, cliente, secretos o base entre ellos.

| Recurso | Configuración preparada |
| --- | --- |
| User Pool | Correo como identificador, sin distinción de mayúsculas; correo obligatorio y verificado; actualizaciones de correo verificadas antes del cambio; recuperación por correo |
| Contraseña / MFA | Mínimo 12 caracteres con mayúscula, minúscula, número y símbolo; contraseña temporal de un día; MFA TOTP `ON` por defecto, configurable a `OPTIONAL` u `OFF`; sin SMS |
| App client web | Sólo authorization code; scopes `openid email profile`; PKCE S256 generado por la aplicación; secreto de cliente por defecto, configurable; existencia de usuarios oculta; tokens ID/access de 60 minutos |
| Dominio | Prefijo `<DeploymentPrefix>-<Environment>`, managed login v2 |
| Branding | Estilo predeterminado explícito asociado al cliente; necesario al crear el cliente mediante código |
| Protección | User Pool con eliminación protegida; los cuatro recursos con `Retain` al eliminar o reemplazar; outputs sin secretos |

Managed login v2 requiere el plan **Essentials** o superior. El recurso de branding evita un cliente sin páginas de login. Revisar disponibilidad regional y costo del plan antes de ejecutar el change set. [Dominio y managed login](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolDomain.html), [branding CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-managedloginbranding.html).

El registro de una identidad verificada está habilitado en Cognito; los permisos sobre empresas/proyectos se conceden exclusivamente desde PostgreSQL y las invitaciones de la aplicación. Tener una cuenta Cognito no asigna proyectos existentes. La aplicación puede crear una empresa propia con un usuario verificado según el flujo actual. No se crean grupos Cognito ni Identity Pools, y el proceso web no necesita permisos administrativos de Cognito.

Con `MfaMode=ON`, managed login guía el registro del autenticador TOTP. `OPTIONAL` no inscribe automáticamente a usuarios sin un factor configurado; la aplicación actual no ofrece un panel propio de inscripción MFA. Para el piloto se recomienda conservar `ON` y ensayar la recuperación de una cuenta que pierda el autenticador. [TOTP](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa-totp.html), [métodos en managed login](https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flows-selection-managedlogin.html).

## Datos que se necesitan de la cuenta

1. Cuenta y región AWS comerciales; perfil CLI del operador con permisos de despliegue acotados. Verificar la cuenta mediante `aws sts get-caller-identity` antes de operar.
2. Origen HTTPS definitivo de staging y, después, de producción; DNS/certificado/alojamiento deben resolver ese origen. `AppBaseUrl` no admite rutas, query, fragmento, credenciales o barra final. Cognito usa un dominio propio de prefijo y HTTPS, sin requerir un certificado personalizado.
3. Prefijo de dominio disponible y exclusivo por cuenta/región. Su disponibilidad sólo se conoce al consultar/desplegar en AWS.
4. Para producción, identidad SES verificada y dirección remitente cubierta por ella; revisar compatibilidad de región, autorización de envío, sandbox y entrega real. Staging puede comenzar con correo predeterminado de Cognito, sujeto a sus límites. [Correo Cognito y SES](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html).
5. PostgreSQL del entorno con las cuatro migraciones y la instalación administrativa de seguridad aplicadas; conexiones separadas `solar_runtime` y `solar_auth`. [Instalación SQL](../prisma/security/README.md).

El operador/rol de CloudFormation requiere los permisos de creación, lectura y actualización de los cuatro tipos Cognito de la plantilla. Si se usa SES `DEVELOPER` y no existe el rol vinculado al servicio, Cognito requiere `iam:CreateServiceLinkedRole`; limitarlo al servicio Cognito de correo según IAM. Esos permisos pertenecen al despliegue, nunca al proceso web. No se incluye una política administrativa genérica con `cognito-idp:*` ni claves de acceso en la aplicación. [Rol de servicio para correo](https://docs.aws.amazon.com/cognito/latest/developerguide/using-service-linked-roles.html).

## Preparar y revisar el stack

Copiar [staging.parameters.example.json](../infra/cognito/staging.parameters.example.json) a `.work/cognito/staging.parameters.json`, crear el directorio si hace falta y sustituir los valores ficticios. Usar [production.parameters.example.json](../infra/cognito/production.parameters.example.json) para el segundo entorno después de aceptar staging. Ambos ejemplos son públicos; no introducir secretos en archivos de parámetros. Los dominios `.invalid`, ARN con cuenta `000000000000` y prefijo `replace-...` son marcadores que deben cambiarse.

Los comandos siguientes se ejecutarán cuando exista la cuenta/perfil; **no se han ejecutado aquí**. En PowerShell, desde la raíz del repositorio:

```powershell
$solarProfile = 'PERFIL_STAGING'
$solarRegion = 'REGION_ELEGIDA'
$solarStack = 'solar-staging-identity'
$solarChangeSet = 'identity-reviewed-v1'

aws sts get-caller-identity --profile $solarProfile --region $solarRegion
aws cloudformation validate-template --template-body file://infra/cognito.json --profile $solarProfile --region $solarRegion
aws cloudformation create-change-set --stack-name $solarStack --change-set-name $solarChangeSet --change-set-type CREATE --template-body file://infra/cognito.json --parameters file://.work/cognito/staging.parameters.json --profile $solarProfile --region $solarRegion
aws cloudformation wait change-set-create-complete --stack-name $solarStack --change-set-name $solarChangeSet --profile $solarProfile --region $solarRegion
aws cloudformation describe-change-set --stack-name $solarStack --change-set-name $solarChangeSet --profile $solarProfile --region $solarRegion
```

Revisar cuenta, región, parámetros, cuatro recursos y ausencia de reemplazos inesperados. `validate-template` comprueba la plantilla en el servicio, pero no acredita disponibilidad del dominio, correo, cuotas, costos ni éxito del login. La revisión del change set debe quedar guardada con la versión del repositorio. Si hay un stack existente, preparar `UPDATE` y conservar explícitamente los parámetros actuales; no repetir `CREATE`.

Después de aprobar ese change set concreto, ejecutarlo y consultar sus outputs:

```powershell
aws cloudformation execute-change-set --stack-name $solarStack --change-set-name $solarChangeSet --profile $solarProfile --region $solarRegion
aws cloudformation wait stack-create-complete --stack-name $solarStack --profile $solarProfile --region $solarRegion
aws cloudformation update-termination-protection --enable-termination-protection --stack-name $solarStack --profile $solarProfile --region $solarRegion
aws cloudformation describe-stacks --stack-name $solarStack --query 'Stacks[0].Outputs' --profile $solarProfile --region $solarRegion
```

Para una actualización usar el waiter `stack-update-complete`. La protección de terminación del stack es un ajuste del stack y no forma parte de la plantilla. `Retain` conserva recursos facturables al retirar un stack; inventariarlos antes de cualquier baja. Cambiar el esquema de atributos, identificador de usuario o secreto del cliente puede exigir reemplazo o migración; revisar el change set y preservar el pool anterior.

## Conectar el servidor

| Output | Variable privada del entorno web |
| --- | --- |
| `AppBaseUrl` | `APP_BASE_URL` |
| `CognitoIssuer` | `COGNITO_ISSUER` |
| `CognitoClientId` | `COGNITO_CLIENT_ID` |
| `CognitoDomain` | `COGNITO_DOMAIN` |
| `ClientSecretRequired=true` | Recuperar el secreto generado y guardar como `COGNITO_CLIENT_SECRET`; no se publica en outputs |

Con cliente confidencial, recuperar el secreto en la consola del cliente o mediante `DescribeUserPoolClient` desde un proceso autorizado que lo envíe directamente al gestor de secretos. No imprimirlo, guardarlo en logs ni copiarlo al chat; no ejecutar un `describe-user-pool-client` sin filtrar en una terminal compartida. Si se eligió `GenerateClientSecret=false`, omitir `COGNITO_CLIENT_SECRET`. El servidor admite ambos modos: utiliza `client_secret_basic` cuando hay secreto y PKCE S256 en ambos casos. [Token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html), [PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html).

Completar además `APP_ENV=staging`, `DATA_ADAPTER=postgres`, `DEMO_MODE=false`, `DATABASE_URL`, `AUTH_DATABASE_URL` y un `AUTH_SECRET` aleatorio exclusivo del entorno de al menos 32 bytes. Generar ese secreto dentro del gestor de secretos, no a partir de texto humano. El cliente Cognito y `AUTH_SECRET` son secretos distintos. La sesión de la aplicación vence como máximo con el ID token de una hora configurado por esta plantilla; no se almacenan ni renuevan refresh tokens.

Registrar exactamente `<AppBaseUrl>/auth/callback` y `<AppBaseUrl>/login`; ya se derivan en la plantilla. Para un ensayo de Cognito desde este equipo, habilitar `EnableLocalhostCallbacks=true` **sólo en el stack staging**, elegir `LocalTestPort` y arrancar una instancia separada con `APP_ENV=development`, `APP_BASE_URL=http://localhost:<puerto>` y ese mismo pool staging. Usar `localhost`, no intercambiarlo con `127.0.0.1`, porque la coincidencia es exacta. La excepción no sustituye la aceptación por HTTPS; eliminarla del stack al terminar el ensayo. AWS permite HTTP de loopback únicamente para pruebas. [Callbacks del cliente](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpoolclient.html).

## Aceptación externa pendiente

Registrar fecha, cuenta/región, versión del stack/app y resultado sin guardar contraseñas, códigos OAuth, JWT, cookies, QR TOTP ni secretos:

1. Desde `/login`, completar registro, correo verificado, contraseña y TOTP en managed login; volver al callback exacto y a `/organizations`. Comprobar que sin verificar el correo no se crea una sesión utilizable.
2. Crear una empresa con su titular; invitar a un técnico/cliente de pruebas y comprobar que sólo ve los proyectos asignados. Una cuenta verificada ajena no debe ver esos proyectos. Los permisos provienen de PostgreSQL, no de grupos Cognito.
3. Verificar cookies HttpOnly, SameSite=Lax y Secure, expiración a una hora, reinicio del proceso sin perder la sesión vigente y denegación de una sesión revocada.
4. Reutilizar un callback ya consumido o alterar `state`/`nonce` debe fallar; probar cancelación del usuario, código vencido y errores de descubrimiento/JWKS sin mostrar secretos.
5. Cerrar sesión con el botón de la aplicación: se revoca la sesión local, se pasa por `/logout` de Cognito y se vuelve a `<AppBaseUrl>/login`. Reabrir una ruta privada debe exigir autenticación. [Logout Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html).
6. Ensayar recuperación de contraseña por correo y asistencia administrativa ante pérdida de TOTP. Verificar entrega, límites de envío y configuración SES real antes de incorporar clientes.
7. Retirar una membresía/asignación y confirmar que pierde acceso inmediato a datos/PDF; revisar logs del proxy para que no registren query OAuth, cookies o tokens de invitación.

Evidencia local nueva: **siete pruebas** en [cognito-infra.test.ts](../tests/cognito-infra.test.ts) verifican ramas staging/producción, URI, MFA, retención, compatibilidad de outputs y canje confidencial Basic con PKCE y JWT firmado mediante proveedor HTTPS inyectado. Ejecutar `node --conditions=react-server --import tsx --test tests/cognito-infra.test.ts` o `npm test`. No había AWS CLI ni cfn-lint configurados en este equipo: no se afirma validación del servicio ni un login Cognito real. La aceptación de los siete pasos anteriores continúa pendiente de la cuenta, PostgreSQL remoto y alojamiento.
