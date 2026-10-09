# Dependencias verificadas

Selección contrastada con documentación oficial y registro npm el 8 de octubre de 2026, ampliada el 9 de octubre para los hitos 4/5 y 6/7. El lockfile fija las versiones efectivamente instaladas; usar `npm ci` para reproducirlas.

| Herramienta | Versión comprobada |
| --- | --- |
| Node.js local | 24.19.0 |
| npm local | 10.9.2 |
| Next.js / eslint-config-next | 16.4.0 |
| React / React DOM | 19.3.0 |
| TypeScript | 5.9.3 |
| Tailwind / PostCSS Tailwind | 4.3.3 |
| Prisma / cliente / adaptador PostgreSQL | 7.10.0 |
| PostgreSQL driver `pg` | 8.23.1 |
| Zod | 4.6.5 |
| openid-client | 6.8.8 |
| jose | 6.2.12 |
| ESLint | 9.39.5 |
| MQTT.js | 5.16.0 |
| AWS SDK Secrets Manager | 3.1148.0 |
| AWS SDK S3 | 3.1148.0 |
| pdf-lib | 1.17.1 |
| esbuild (compilador del consumidor) | 0.28.2 |

Node 24 LTS es la línea preferida; el manifiesto permite también Node 22 desde 22.12. Next necesita Node desde 20.9 y Prisma 7 requiere 20.19, 22.12 o 24; se eligen líneas LTS aún mantenidas. [Next.js](https://nextjs.org/docs/app/getting-started/installation), [Prisma](https://docs.prisma.io/docs/orm/reference/system-requirements), [Node.js](https://nodejs.org/en/about/previous-releases).

El gateway y sus pruebas requieren Node 24 y usan `node:sqlite` integrado para evitar extensiones nativas de terceros. Su estado de estabilidad y límites se documentan en [kit-piloto.md](kit-piloto.md); no se ha probado este agente sobre Node 22. MQTT.js y el SDK AWS se fijan por lockfile y esbuild solo participa en la compilación. `npm audit --omit=dev` volvió a terminar sin avisos tras estas incorporaciones.

H6 incorpora pdf-lib para PDF generados en servidor y AWS SDK S3 para objetos privados. La auditoría de ejecución volvió a dar cero avisos después de instalarlos. Los clientes offline pg_dump/pg_restore 18.6 de EDB se extrajeron dentro de `.work/pg-client-tools` con CRC del archivo ZIP y hashes locales; no son dependencias del servidor web ni una instalación del sistema. La prueba usa PostgreSQL local 18.4. [pdf-lib](https://pdf-lib.js.org/), [SDK S3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/), [clientes PostgreSQL](https://www.postgresql.org/docs/18/app-pgdump.html), [binarios Windows](https://www.enterprisedb.com/download-postgresql-binaries).

## Compatibilidad y avisos de herramientas

ESLint 10.12 se evaluó y ejecutó correctamente con este código, pero tres plugins transitivos de `eslint-config-next@16.4.0` todavía declaran compatibilidad únicamente hasta ESLint 9. Se conserva 9.39.5 para respetar esos rangos y evitar dependencias pares incompatibles. npm informa que esa línea está fuera de soporte: actualizar el conjunto de plugins y ESLint cuando sea compatible, antes de la preparación de producción. [Estado de versiones ESLint](https://eslint.org/version-support/).

La auditoría completa deja **cinco avisos de severidad alta** en la cadena de herramientas `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`. Son cinco paquetes afectados por un aviso transitivo sin parche estable disponible para `braces`; no son cinco fallos independientes de la aplicación. La aplicación no recibe patrones glob de usuarios. `npm audit --omit=dev` no reporta vulnerabilidades conocidas en las dependencias de ejecución en esta verificación. Esto no sustituye una revisión de seguridad del producto. [Aviso oficial](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

Se aplicaron dos overrides acotados a dependencias del CLI de Prisma: `prisma → mysql2@3.24.5` y `@prisma/config → deepmerge-ts@8.0.2`. Corrigen avisos conocidos sin cambiar Prisma ni el destino PostgreSQL. El proyecto no usa MySQL. El uso de `deepmerge` en la configuración actual contiene objetos simples y cadenas; no usa las APIs que cambiaron en la versión 8. Se comprobaron generación, validación Prisma, tipos y build con estos overrides. Revisarlos cuando Prisma incorpore las correcciones upstream. [MySQL2](https://github.com/sidorares/node-mysql2/releases), [DeepmergeTS 8](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0), [seguimiento Prisma](https://github.com/prisma/orm/issues/30052).

No se aplicó `npm audit fix --force`: la sugerencia automática retrocedía el framework de lint y el CLI a versiones mayores anteriores.

En Windows, `npm ci` terminó con código 0 y un aviso de limpieza `EPERM` en un paquete WASM opcional. Las comprobaciones posteriores se ejecutaron sobre esa instalación. No se eliminó ni modificó contenido fuera del proyecto.

En la integración de hitos 2/3, `pg@8.23.1` emite un aviso de deprecación sobre consultas concurrentes en una conexión desde el intérprete interno de PrismaPg. La versión 8 sigue admitiéndolas y las pruebas pasaron. Antes de migrar a pg 9, verificar la compatibilidad del adaptador Prisma; no se suprimió el aviso ni se modificaron librerías instaladas. PostgreSQL local 18.4 se utilizó únicamente para pruebas, fuera de las dependencias de la aplicación.
