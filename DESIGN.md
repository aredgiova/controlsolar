---
name: Monitoreo Solar
description: Panel operativo sobrio para revisar instalaciones solares y detectar atención pendiente.
colors:
  accent: "#17634f"
  accent-hover: "#104c3d"
  accent-active: "#0a3e31"
  sidebar: "#142e27"
  nav-hover: "#29463b"
  nav-active: "#315444"
  background: "#f4f6f5"
  surface: "#fff"
  text: "#192f2a"
  muted: "#5e6e68"
  border: "#dce4df"
  control-border: "#b7c7bd"
  surface-hover: "#eaf0ec"
  warning: "#785407"
  focus: "#a76b00"
  status-positive-bg: "#e9f3ed"
  status-positive-text: "#20613e"
  status-warning-bg: "#fbf0d5"
  status-warning-text: "#795209"
  status-critical-bg: "#f8e9e5"
  status-critical-text: "#9c3f31"
  status-info-bg: "#edf1f4"
  status-info-text: "#425e70"
  chart-generation: "#16845b"
  chart-consumption: "#4367a0"
  chart-grid: "#b57821"
typography:
  display:
    fontFamily: "\"Segoe UI\", Arial, Helvetica, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.025em"
  headline:
    fontFamily: "\"Segoe UI\", Arial, Helvetica, sans-serif"
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-.025em"
  title:
    fontFamily: "\"Segoe UI\", Arial, Helvetica, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: "\"Segoe UI\", Arial, Helvetica, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "\"Segoe UI\", Arial, Helvetica, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.55
rounded:
  badge: "5px"
  control: "6px"
  notice: "8px"
  panel: "12px"
spacing:
  compact: "8px"
  small: "12px"
  medium: "16px"
  mobile-panel: "18px"
  section: "20px"
  panel: "24px"
  page: "36px"
  wide-page: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-active:
    backgroundColor: "{colors.accent-active}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  nav-link:
    textColor: "#c9d9d0"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  nav-link-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.surface}"
  status-positive:
    backgroundColor: "{colors.status-positive-bg}"
    textColor: "{colors.status-positive-text}"
    rounded: "{rounded.badge}"
    padding: "3px 8px"
  status-warning:
    backgroundColor: "{colors.status-warning-bg}"
    textColor: "{colors.status-warning-text}"
    rounded: "{rounded.badge}"
    padding: "3px 8px"
  status-critical:
    backgroundColor: "{colors.status-critical-bg}"
    textColor: "{colors.status-critical-text}"
    rounded: "{rounded.badge}"
    padding: "3px 8px"
  status-info:
    backgroundColor: "{colors.status-info-bg}"
    textColor: "{colors.status-info-text}"
    rounded: "{rounded.badge}"
    padding: "3px 8px"
---

# Design System: Monitoreo Solar

## Overview

**Creative North Star: "Centro de operación solar"**

Un panel sobrio en español para revisar instalaciones y decidir dónde intervenir. La identidad procede del verde bosque de la navegación, superficies claras y una jerarquía tipográfica contenida. La marca provisional es «Monitoreo Solar»; no se introduce una identidad comercial adicional.

La densidad favorece la lectura de estados, fechas y unidades. Las situaciones que requieren atención preceden a los gráficos en el resumen. El contexto de demostración permanece visible: sus registros son ficticios. En modo persistente, el origen y la cobertura acompañan las lecturas de cada proyecto; una etiqueta de gateway identifica su procedencia y no acredita por sí sola una conexión física verificada.

**Key Characteristics:**

- Verde bosque en navegación y acciones; fondo gris claro y paneles blancos.
- Superficies planas delimitadas por bordes finos.
- Estados expresados con texto, punto y color semántico.
- Tablas y gráficos legibles mediante desplazamiento interno en móvil.
- Procedencia, calidad y cobertura legibles; datos simulados identificados y unidades explícitas.

Esta documentación describe el sistema construido en `src/app/globals.css` y los componentes compartidos. Los tokens del frontmatter son la referencia normativa; los ejemplos completos, las transiciones y los breakpoints están en `.impeccable/design.json`. El alcance de producto se mantiene en `PRODUCT.md`.

## Colors

La paleta combina bosque profundo, verde operativo y neutros de matiz verdoso. Las señales ámbar, rojo y azul tienen una función informativa concreta.

### Primary

- **Verde operativo — `accent`:** botones principales, enlaces de acción y detalles de interacción.
- **Verde profundo — `accent-hover` y `accent-active`:** respuesta de los botones al puntero y a la pulsación.
- **Bosque de navegación — `sidebar`:** marco estable de la aplicación.
- **Bosque de estado — `nav-hover` y `nav-active`:** distingue la opción recorrida y la sección actual sin alterar la geometría.

### Neutral

- **Gris de trabajo — `background`:** fondo general entre superficies.
- **Blanco de panel — `surface`:** paneles, controles y barra superior.
- **Tinta verde — `text`:** títulos, nombres y valores.
- **Gris secundario — `muted`:** contexto, ayudas, fechas y unidades.
- **Borde suave — `border`:** contenedores y divisores.
- **Borde de control — `control-border`:** campos y botón secundario.
- **Superficie de interacción — `surface-hover`:** respuesta del botón secundario.

### Estados y series

- **Positivo — `status-positive-*`:** en línea y resuelta.
- **Ámbar — `status-warning-*`:** datos desactualizados, advertencia y alerta abierta. `warning` también identifica el contador de atención.
- **Crítico — `status-critical-*`:** sin conexión y prioridad alta.
- **Informativo — `status-info-*`:** información sin urgencia y ausencia de datos recibidos.
- **Foco ámbar — `focus`:** contorno visible al navegar con teclado, separado del estado del dato.
- **Generación, consumo y red — `chart-generation`, `chart-consumption`, `chart-grid`:** asignación estable para las tres series del gráfico y sus leyendas.

**The Lectura operativa Rule.** El acento identifica navegación, enlaces y acciones. Los colores semánticos comunican estado y los colores de serie identifican magnitudes; no intercambiar esas funciones.

## Typography

**Display Font:** Segoe UI, con Arial, Helvetica y sans-serif como alternativas.  
**Body Font:** la misma familia. No existe una familia independiente para etiquetas ni números.

La tipografía conserva el aspecto de una herramienta de trabajo: pesos medios, titulares contenidos y etiquetas en caja natural. Los valores y las celdas numéricas usan cifras tabulares para facilitar comparación.

### Hierarchy

- **Display:** valores de métricas; el rol no se utiliza como titular promocional. En móvil se reduce a (26px).
- **Headline:** título de página. En móvil se reduce a (25px).
- **Title:** encabezado de sección. Los encabezados dentro de paneles pasan a (16px) en móvil.
- **Body:** lectura general. Las descripciones de página admiten hasta (70ch); algunos textos de ayuda y estados vacíos usan hasta (65ch).
- **Label:** etiquetas y contexto. Los datos de tabla y controles usan (13px); encabezados de tabla y badges usan (11px). Los h3 usan (15px) con peso (650).

La escala principal está definida en el frontmatter. Evitar mayúsculas sostenidas en navegación, botones y estados.

**The Unidad explícita Rule.** Mostrar potencia en kW y energía en kWh. La capacidad nominal de instalación conserva kWp; una lectura ausente se presenta como «No disponible», sin unidad adjunta, y no como cero.

## Layout

En escritorio, la aplicación usa una barra lateral fija de (236px) y una zona flexible con ancho mínimo de cero. El contenido principal se centra dentro de un máximo de (1500px), con margen interior habitual de (36px). La barra superior mide (66px) de alto. Cabeceras de panel y filtros mantienen espacios interiores de (20px 24px); las secciones se separan habitualmente por (24px).

El resumen usa tres métricas; los detalles pueden usar cuatro. Los paneles de detalle y configuración se distribuyen en columnas de proporción (1.7fr / 1fr), con la segunda columna de al menos (260px). Esas composiciones se adaptan sin cambiar la secuencia de lectura.

- **A partir de (1500px):** el contenido principal usa margen interior de (42px 48px).
- **Hasta (1100px):** la barra lateral pasa a (212px), el margen de página a (28px) y detalle/configuración se apilan. Las cuatro métricas se distribuyen en dos columnas.
- **Hasta (760px):** la barra lateral pasa a cabecera en flujo normal, seguida por una cuadrícula de navegación de cuatro columnas; los destinos adicionales ocupan otra fila. Los iconos quedan encima del texto, con enlaces de al menos (52px) de alto. Se ocultan la barra superior y el pie de la navegación; permanecen el selector de empresa, el aviso del entorno y el pie del espacio de trabajo. El contenido usa (26px 18px), los paneles reducen su espacio interior a (18px) y las métricas se apilan en filas.
- **Hasta (360px):** el texto de pestañas se reduce a (10px).

La tabla de proyectos conserva un ancho mínimo de (960px) y su primera columna de (230px); el desplazamiento horizontal pertenece al contenedor de tabla. El gráfico tiene su propio contenedor desplazable y mantiene el SVG de al menos (620px) en móvil. Las etiquetas SVG aumentan a (18px) en ese contexto. Las ayudas para deslizar aparecen en móvil. No debe aparecer desbordamiento horizontal en toda la página para poder consultar estos contenidos.

## Elevation & Depth

No se usan sombras. El fondo gris, los paneles blancos, los bordes de (1px) y los divisores construyen la separación. Los estados utilizan superficies teñidas de baja intensidad. La navegación usa tonos progresivos dentro del bosque para distinguir la sección actual.

**The Planos claros Rule.** Los paneles permanecen planos, sin sombras. La separación depende del fondo, el borde y el espacio.

## Shapes

Los contenedores mayores tienen esquinas suaves; los controles son más contenidos y las etiquetas de estado más compactas. Los radios están en el frontmatter: panel, control, notice y badge. Los indicadores de estado son puntos circulares de (5px); el indicador del entorno usa (6px). La leyenda del gráfico utiliza cuadrados de (9px) con radio de (2px).

Los bordes son finos y constantes. Tablas y divisores usan líneas completas; no convierten las filas en tarjetas individuales. Los paneles recortan su contenido a la forma del contenedor y los elementos extensos se desplazan dentro de él.

## Components

### Buttons

Acciones compactas con peso (600), texto de (13px), separación entre icono y texto de (8px) y alto mínimo de (42px). Los botones principales usan el acento; los secundarios usan superficie blanca y borde de control. Las formas y espacios constan en el frontmatter.

El color transiciona durante (160ms) con `ease-out`. El botón principal dispone de hover y pulsación; el secundario cambia a superficie de interacción en hover. El estado deshabilitado reduce la opacidad a (.55) y usa cursor de indisponibilidad. Todos los controles interactivos reciben contorno de foco de (3px), con desplazamiento de (4px).

### Chips

Los badges combinan punto y etiqueta en español. El tamaño de (11px), peso (600), espacio entre elementos de (6px) y relleno compacto permiten leerlos dentro de tablas. No se usan como botones. Mantener las correspondencias exactas: en línea/resuelta, datos desactualizados/advertencia/abierta, sin conexión/prioridad alta e informativa/sin datos recibidos.

El distintivo de demostración y el contador de atención conservan el tono ámbar, para diferenciar el contexto de los datos de las métricas.

### Cards / Containers

Los paneles usan superficie blanca, borde fino y radio de panel. La cabecera separa título y descripción de acciones mediante un divisor. Las métricas se agrupan dentro de una única superficie con divisores internos, en lugar de repetir sombra o tarjetas separadas. Los valores principales tienen cifras tabulares y la unidad reduce tamaño y contraste.

### Inputs / Fields

Los campos tienen etiqueta visible encima, borde de control, fondo blanco, radio de control y alto mínimo de (42px). El texto de entrada es de (13px) y el espacio interior de (10px 12px). El buscador ocupa el espacio flexible de la barra de filtros y toda una fila en móvil.

El selector de empresa pertenece al fondo oscuro de navegación y conserva etiqueta visible. El foco usa el contorno común. Los formularios de gestión conservan etiquetas, indicación de obligatoriedad y ayudas asociadas; durante el envío, el botón muestra «Guardando…» y se deshabilita. El resultado se comunica con texto verde y `role="status"`, o rojo y `role="alert"` ante un error. No existe una variante propia de borde de error por campo.

### Navigation

Cuatro destinos base: Resumen, Proyectos, Alertas y Configuración. Clientes, Dispositivos y Equipo y accesos se añaden para administración y en demostración. En escritorio cada enlace combina icono de trazo y texto en una fila, con alto mínimo de (46px). El estado actual usa fondo más claro, texto blanco, peso (600) y `aria-current="page"`. El hover cambia fondo y texto durante (160ms) con `ease-out`.

En móvil los destinos disponibles permanecen visibles en una cuadrícula de cuatro columnas, con icono sobre etiqueta. Conservar el orden y el tamaño de interacción; no ocultar destinos detrás de un menú adicional.

### Tabla de proyectos

Una tabla semántica con nombre de proyecto como encabezado de fila, ubicación/cliente como texto secundario, capacidad, estado, generación, última lectura y enlace explícito «Ver detalle». El origen de la telemetría aparece como una segunda línea secundaria cuando existen lecturas; la fecha se presenta en la zona horaria del proyecto. La ausencia de recepción usa «Sin datos recibidos», y la generación ausente conserva «No disponible» sin kW. Los encabezados son discretos; las filas usan (18px 24px) y una línea divisoria suave. El hover de fila aclara el fondo. Las cifras usan alineación tabular.

El nombre y la acción enlazan al mismo detalle. Conservar etiquetas de columna, caption accesible y un contenedor enfocable con nombre de región; el desplazamiento móvil no cambia el orden de columnas.

### Gráfico de potencia

Tres series con color estable, leyenda textual, líneas de (2.5px) y puntos visibles. El eje identifica la zona horaria de la consulta y kW; la demostración conserva «Hora de Colombia». Red positiva significa importación; red negativa significa exportación. Los datos ausentes interrumpen las líneas y los puntos aislados siguen siendo visibles.

El gráfico incluye título y descripción SVG, una nota de procedencia y cálculo, y una tabla desplegable con los valores. La nota usa el origen del día consultado, que puede diferir del origen de la última lectura. Si no hay lecturas, se muestra un mensaje explícito. Evitar animaciones de entrada que alteren la interpretación de los valores.

### Procedencia, calidad y cobertura

La recepción se presenta en un panel con origen textual, estado disponible y una lista de última medición, última recepción y zona horaria. «Simulador local» y los orígenes mixtos llevan un aviso ámbar que identifica los valores ficticios. La falta de recepción no se representa como una conexión reciente; las lecturas desactualizadas conservan una explicación visible.

Las métricas de potencia describen su calidad y momento de medición debajo del valor. Las de energía describen calidad y horas con cobertura; una nota común informa el corte, las muestras, los huecos, los reinicios y las lecturas inválidas. «Medida», «Calculada», «Estimada» y «Sin datos» son texto operativo, sin añadir una nueva escala cromática. Los acumulados parciales se identifican como tales. La estrategia específica de consulta y acceso está en los briefs de superficie.

### Estados de carga y vacío

Los vacíos conservan título, explicación y retorno contextual cuando corresponde. La carga usa bloques neutros con pulso de opacidad de (.5 a 1), en ciclos alternos de (1.5s) con `ease-in-out`. La preferencia de movimiento reducido elimina animaciones y transiciones. El enlace «Saltar al contenido» se revela al recibir foco.

## Do's and Don'ts

### Do:

- **Do** mantener la navegación lateral en escritorio y los destinos autorizados visibles en la cuadrícula móvil.
- **Do** mostrar primero los estados que requieren atención y conservar el aviso de datos simulados.
- **Do** acompañar cada estado de una etiqueta legible y cada magnitud disponible de su unidad; mostrar procedencia, calidad y cobertura junto a las lecturas.
- **Do** conservar el desplazamiento dentro de tablas y gráficos, con indicación textual en móvil.
- **Do** reutilizar la tipografía, los bordes y los radios existentes antes de añadir variantes.

### Don't:

- **Don't** añadir sombras a los paneles ni convertir el acento en decoración dominante.
- **Don't** comprimir las columnas o las etiquetas del gráfico hasta hacerlas ilegibles en móvil.
- **Don't** representar lecturas ausentes como cero ni unir una línea a través de datos ausentes.
- **Don't** presentar los datos ficticios como telemetría real ni convertir una etiqueta de origen en una afirmación de validación física o externa.
- **Don't** depender únicamente del color para distinguir estados o series.

