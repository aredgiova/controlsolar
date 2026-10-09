# Preparación para conectar dispositivos

La conexión física y AWS IoT continúan pendientes. El software ya dispone de gateway de solo lectura, SQLite durable, ingesta, registry y revocación. Esta preparación agrega un generador **offline** de configuración y política por equipo. No inicia red, no invoca AWS CLI, no crea certificados y no incorpora dispositivos a la base de datos.

## Preparar los campos sin inventar un equipo

Con Node.js 24 y las dependencias instaladas:

```powershell
npm run prepare:device -- --template --output piloto-input
```

El archivo editable queda en `.work/device-setup/piloto-input/input.template.json`. Los campos desconocidos están vacíos y **no pasan la validación**. El perfil `SDM630MCT-v1.7` indica el único mapa actualmente implementado; no afirma que ese sea el medidor adquirido. Si el kit usa otro modelo o firmware, hay que implementar y probar su mapa antes de conectarlo. No sustituir el nombre para forzar la aceptación.

La configuración final reúne:

| Grupo | Datos que debe aportar el responsable |
|---|---|
| `aws` | Cuenta de 12 dígitos, región comercial AWS, endpoint de datos `iot:Data-ATS`, perfil CLI opcional e ID AWS del certificado si ya se conoce. |
| `registry` | UUID de empresa, proyecto, equipo gateway, identidad autorizada y medidores; huella X.509; asignaciones vigentes de los medidores seleccionados. |
| `gateway` | Rutas absolutas en el host del gateway, dirección TCP del convertidor RS485/Ethernet, puerto, unitId, orden de palabras y orientación. Intervalo y capacidad de buffer explícitos. |

Esta utilidad admite la partición comercial `aws` y endpoints `amazonaws.com`. No genera configuración para China, GovCloud, dominios IoT personalizados ni conexión MQTT por WebSocket. El campo `projectId` del paquete es documentación del alcance esperado, nunca una autorización para escribir en ese proyecto.

El snapshot se transcribe desde el registro de la aplicación y la configuración vigente de proyecto/puntos. Se comparan UUID, allowlist, dispositivo/punto/versión, vigencia sin fecha de fin, unicidad de medidores/puntos y direcciones Modbus. **No se consulta el registry en vivo**: antes de ejecutar los comandos, el titular/administrador debe volver a comprobar empresa, proyecto, estado y asignaciones. El servidor continúa siendo la autoridad al recibir cada lectura.

## Certificado, huella e identidad MQTT

El orden de preparación evita confundir el equipo físico con su identidad de transporte:

1. Registrar empresa/proyecto, equipo gateway, medidores, puntos, asignaciones y topología. Guardar los UUID devueltos por la aplicación.
2. Crear la clave y el CSR en el propio gateway o en el mecanismo seguro del fabricante. La utilidad no genera claves ni las copia al equipo de administración.
3. Obtener el certificado mediante CSR y dejarlo **INACTIVE** mientras se completa el registro. El plan incluye una referencia revisable a `aws iot create-certificate-from-csr --no-set-as-active`; no usa `create-keys-and-certificate`. Ejecutarlo repetidamente crea certificados distintos y puede sobrescribir el archivo de salida; comprobar que no exista. Si AWS CLI se utiliza desde administración, trasladar solamente el CSR público y el certificado emitido, adaptando las rutas de esa referencia; la clave permanece en el gateway. [AWS CLI: certificado desde CSR](https://docs.aws.amazon.com/cli/latest/reference/iot/create-certificate-from-csr.html).
4. Calcular SHA256 sobre el certificado **DER**, no sobre el texto PEM. En Node.js, el cálculo es `createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex")`. `Get-FileHash` sobre un PEM calcula otra cosa. Se aceptan mayúsculas hexadecimales y se normalizan a minúsculas; no incluir `:` ni espacios.
5. Enrolar la identidad `aws_iot` en la aplicación con esa huella y la allowlist de medidores. La aplicación devuelve un UUID nuevo: `GatewayIdentity.id = clientId = ThingName = gateway_id`. El `gatewayDeviceId` identifica el equipo del inventario y es otro UUID. No reservar un UUID inventado para anticipar esta respuesta.
6. Completar la plantilla con esa identidad real y el snapshot vigente; entonces generar el paquete final.

AWS usa dos referencias diferentes: `certificateId`/`certificateArn` para administrar el certificado y la **huella X.509** que `principal()` entrega para MQTT con certificado. La utilidad no deduce una de la otra ni presupone que sean iguales. El ID administrativo se toma de la respuesta AWS; la huella se calcula del certificado local y se compara con la recepción real durante la aceptación. [AWS: función principal()](https://docs.aws.amazon.com/iot/latest/developerguide/iot-sql-functions.html#iot-function-principal), [AWS: referencias del certificado creado](https://docs.aws.amazon.com/cli/latest/reference/iot/create-certificate-from-csr.html).

Las identidades AWS nuevas guardan la huella en minúsculas; el envelope de ingesta también la normaliza. Si existiera una identidad previa guardada en mayúsculas, revisar y sustituir mediante revocación/enrolamiento; este cambio no modifica registros históricos automáticamente. Los identificadores del simulador conservan su texto original.

## Generar el paquete revisable

Después de completar los campos reales:

```powershell
npm run prepare:device -- --config .work/device-setup/piloto-input/input.template.json --output piloto-revisado
```

Se crea un directorio nuevo `.work/device-setup/piloto-revisado`:

| Archivo | Uso |
|---|---|
| `gateway.json` | Configuración aceptada por el runtime del gateway. Rutas pertenecientes al host destino. |
| `iot-policy.json` | Solo `iot:Connect` al clientId exacto y `iot:Publish` al tópico exacto de este UUID, ambos exigiendo Thing asociado. Sin comodines ni permisos de suscripción. |
| `commands.review.json` | Comandos separados por servicio/argumentos y etapas; condiciones que comprobar antes de cada operación. Ningún comando se ejecuta. |
| `registry-snapshot.json` | Identificadores y asignaciones aportados para la comparación local. No es evidencia de consulta autenticada. |
| `manifest.json` | Estado `prepared_offline`, hashes SHA256 de los archivos, preflight y pendientes explícitos. Los hashes detectan cambios respecto del manifest; no sustituyen una firma ni una revisión. |
| `README.md` | Secuencia de revisión, operación y revocación del paquete. |

No se incluyen claves privadas, certificados ni contraseñas. La carpeta se crea con permisos restrictivos donde el sistema los admite. Se rechazan salidas fuera de `.work/device-setup`, nombres con rutas, carpetas existentes y enlaces/junctions en `.work` o `device-setup`; no se sobreescribe un paquete anterior. En Windows, revisar además las ACL del directorio con las herramientas de administración del sistema. `.work` permanece excluido de Git y de los artefactos de la aplicación.

Si `certificateId` es `null`, el plan conserva un marcador explícito y el manifest lo declara pendiente. Sustituirlo con el ID real antes de ejecutar cualquier comando que administre el certificado. Los comandos se almacenan como arrays de argumentos: no concatenarlos en una cadena de shell ni ejecutar el archivo JSON como un script.

## Revisión AWS y preflight local

El plan primero compara la cuenta, región y endpoint; después propone crear Thing/política, asociar el certificado de forma `EXCLUSIVE_THING`, adjuntar la política y finalmente activar. Si ya existen recursos, inspeccionarlos en lugar de repetir altas a ciegas. Revisar **todas** las políticas adjuntas al certificado: una política adicional podría ampliar los permisos de esta política exacta. AWS distingue la asociación del certificado al Thing de la política que autoriza sus operaciones. [AWS: asociación de Thing y política](https://docs.aws.amazon.com/iot/latest/developerguide/attach-to-cert.html), [AWS: variables y asociación del Thing](https://docs.aws.amazon.com/iot/latest/developerguide/thing-policy-variables.html).

`describe-endpoint` utiliza `iot:Data-ATS`; su primera llamada puede crear el endpoint de la cuenta. La utilidad solo escribe esa instrucción para revisión. Instalar un trust bundle de CA obtenido de la fuente oficial y revisar su integridad/procedencia; nunca desactivar la validación TLS. [AWS: endpoint ATS](https://docs.aws.amazon.com/cli/latest/reference/iot/describe-endpoint.html), [AWS: autenticación del servidor y CA](https://docs.aws.amazon.com/iot/latest/developerguide/server-authentication.html).

Construir con `npm run build:workers` en el equipo de preparación y verificar los hashes de `.work/workers/manifest.json`. Copiar solamente `gateway.mjs` y `prepare-device.mjs` al destino privado. Ambos están empaquetados y requieren Node24; no necesitan `tsx` ni `node_modules` en el gateway. La configuración y los archivos de credenciales se administran aparte. Ver [despliegue de procesos y gateway](worker-deployment.md).

Ejecutar el preflight **en el gateway**, con sus rutas reales y sin trasladar la clave a otro host. Trabajar desde un directorio privado y escribible, pues la salida queda bajo su `.work/device-setup`:

```powershell
node /opt/solar-gateway/prepare-device.mjs --config /etc/solar-gateway/device-setup.json --output piloto-preflight --preflight
```

Lee archivos regulares acotados de certificado/clave/CA y verifica: certificado cliente dentro de vigencia, SHA256 DER igual al registry aportado, par certificado/clave y CA locales válidas. No imprime ni guarda la clave; el buffer leído se limpia después de usarlo. En POSIX exige que la clave no tenga permisos para grupo/otros; en Windows declara pendiente la revisión de ACL.

El preflight no prueba el emisor de confianza del certificado cliente contra AWS, estado/ID del certificado en la cuenta, correspondencia real del endpoint, hostname/cadena TLS remota, asociaciones/políticas AWS ni vigencia real del registry. `networkVerified` y `registryVerified` permanecen en `false` aun cuando los archivos coincidan. Conservar estas comprobaciones como pendientes de la aceptación externa.

El gateway operativo requiere Node.js 24 por SQLite. Antes de iniciarlo, confirmar físicamente modelo/mapa, firmware, unitId, velocidad/paridad RS485 configurada en el convertidor, fases, CT, sentido de importación/exportación y reloj/NTP. El driver solo lee FC04; esta preparación no autoriza escrituras Modbus. Arranque del artefacto preparado:

```powershell
node /opt/solar-gateway/gateway.mjs /etc/solar-gateway/gateway.json
```

No iniciarlo con el template vacío ni con la configuración de otro host. La ingesta AWS necesita además los recursos de [aws-ingestion.md](aws-ingestion.md), PostgreSQL y su rol `solar_ingest` correctamente instalados. El login Cognito de usuarios y el certificado IoT del gateway son credenciales con propósitos distintos.

## Revocación y aceptación

Revocar primero la identidad en la aplicación (`PATCH /api/v1/organizations/:org/gateways/:id`, `{ "status": "revoked" }`, sesión de titular/administrador y Origin correcto): la plataforma rechazará nuevas lecturas, conservando el histórico. Después ejecutar la etapa AWS revisada: certificado `INACTIVE`, desconexión del clientId en el endpoint de datos, retiro de política y asociación. La desactivación puede tardar minutos en cerrar conexiones existentes; no asumir corte inmediato. [AWS: estado del certificado](https://docs.aws.amazon.com/cli/latest/reference/iot/update-certificate.html), [AWS: desconectar un cliente](https://docs.aws.amazon.com/cli/latest/reference/iot-data/delete-connection.html).

La revocación de la aplicación es permanente. Para cambiar de certificado, conservar evidencia, revocar la identidad anterior y enrolar una nueva con su UUID/Thing/tópico propios. No borrar histórico ni reusar un principal revocado como si fuera un alta nueva.

Antes del piloto real demostrar: lectura correcta y orientación; mTLS real; coincidencia de `principal()`; Connect/Publish propios permitidos y otros UUID/tópicos rechazados; recepción IoT→SQS→Lambda→PostgreSQL; pérdida y recuperación de enlace; retransmisión sin duplicar energía; rechazo después de revocación. Las pruebas locales de `tests/device-setup.test.ts` cubren la preparación, hashes, no sobreescritura, salidas con enlaces, validación de certificados anónimos de prueba y ausencia de contenidos privados en errores. No acreditan ninguna de esas conexiones externas.
