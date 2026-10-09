# Monitoreo Solar

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js, React, TypeScript estricto, Tailwind y npm según la guía suministrada. Backend en Route Handlers, PostgreSQL externo y Prisma como destino de persistencia. Hostinger Aplicación web Node.js como alojamiento previsto.

## Users

Empresas instaladoras que administran clientes, proyectos y equipos solares. Los titulares y administradores gestionan la organización; técnicos y propietarios de instalaciones consultan únicamente sus proyectos asignados.

## Product Purpose

Monitoreo energético multimarca basado principalmente en medidores independientes. El alcance autorizado llega a los hitos 0 a 7: base, identidad/permisos, activos, telemetría, gateway, alertas, seguimiento, portal e informes, recuperación y ensayo local. La aceptación física, AWS y el piloto con clientes reales requieren validación externa.

## Operating Context

El operador registra clientes e instalaciones, asigna participantes, configura puntos y medidores, conserva reemplazos y versiones de topología y registra puesta en marcha. El recorrido ficticio permite explorar potencia, energía y alertas. La aplicación se consulta desde escritorio y móvil, en español. Los tiempos usan UTC y se presentan según la zona del proyecto u organización; la demo usa America/Bogota.

## Capabilities and Constraints

Demo explícita de solo lectura con dos organizaciones ficticias y tres proyectos por organización. Modo persistente separado con Cognito OIDC, sesiones opacas, invitaciones, RLS y roles por empresa/proyecto, probado con PostgreSQL local. Ingesta v2 compartida entre simulador y gateway; muestras, último estado y agregados persistentes. Consulta diaria en zona del proyecto, procedencia y calidad visibles. Reglas de alertas con persistencia, recuperación y mantenimiento; incidencias asignadas con historial y cierre. Portal por proyecto, PDF privado y descarga temporal autorizada. Backup cifrado y restauración local; ensayo de reconexión con datos ficticios. Cognito real, staging, AWS y kit físico requieren configuración y validación externa. Los datos ausentes nunca equivalen a cero. Potencia en kW y energía en kWh. No hay control de inversores.

## Brand Commitments

Nombre provisional «Monitoreo Solar», centralizado en configuración. Panel sobrio y operativo, navegación lateral en escritorio y adaptada al móvil, tabla y filtros útiles. La marca comercial permanece pendiente.

## Evidence on Hand

Plan y prompt inicial proporcionados por el usuario. Repositorio vacío al iniciar. Pruebas de contratos, OIDC firmado y PostgreSQL real, recorrido HTTP/browser y persistencia tras reiniciar. No existen datos de clientes reales; las credenciales y registros de QA son locales y ficticios. La evidencia se conserva en docs/progress.md.

## Product Principles

- Priorizar instalaciones que requieren atención.
- Distinguir datos medidos, calculados y no disponibles, siempre identificados como simulados en la demostración.
- Verificar permisos en servidor y PostgreSQL antes de incorporar datos reales.
- Informar verificaciones locales y externas por separado.
