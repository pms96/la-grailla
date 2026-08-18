---
name: La Grailla
description: Caseta de feria nocturna — morado royal y verde lima sobre fondo azul marino profundo, con tipografía redondeada y stickers de borde grueso.
colors:
  morado-feria: "hsl(245 65% 51%)"
  morado-feria-dark: "hsl(245 70% 58%)"
  verde-lima: "hsl(72 76% 56%)"
  rosa-neon: "hsl(330 100% 70%)"
  amarillo-calido: "hsl(46 91% 53%)"
  lavanda: "hsl(280 45% 78%)"
  azul-marino-profundo: "hsl(245 30% 6%)"
  blanco-papel: "hsl(0 0% 100%)"
  tinta-noche: "hsl(240 20% 6%)"
  niebla: "hsl(60 10% 96%)"
  borde-noche: "hsl(245 15% 18%)"
  destructivo: "hsl(0 84% 60%)"
typography:
  display:
    fontFamily: "Fredoka, var(--font-sans), sans-serif"
    fontSize: "clamp(3rem, 8vw, 6rem)"
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Fredoka, var(--font-sans), sans-serif"
    fontSize: "clamp(1.5rem, 3vw, 1.875rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Fredoka, var(--font-sans), sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Space Grotesk, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Fredoka, var(--font-sans), sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.02em"
  mono:
    fontFamily: "Space Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
  3xl: "64px"
components:
  button-primary:
    backgroundColor: "{colors.morado-feria}"
    textColor: "{colors.blanco-papel}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.morado-feria}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.tinta-noche}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "40px"
  card-default:
    backgroundColor: "{colors.blanco-papel}"
    textColor: "{colors.tinta-noche}"
    rounded: "{rounded.lg}"
    padding: "24px"
  input-default:
    backgroundColor: "{colors.blanco-papel}"
    textColor: "{colors.tinta-noche}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
    height: "40px"
  badge-sticker:
    backgroundColor: "transparent"
    textColor: "{colors.verde-lima}"
    rounded: "{rounded.full}"
    padding: "6px 16px"
---

# Design System: La Grailla

## Overview

**Creative North Star: "La Caseta de Feria Nocturna"**

La Grailla vive de noche. El fondo por defecto es un azul marino casi negro (`--background` en modo oscuro), y sobre él flotan las luces de una caseta de feria andaluza: morado royal, verde lima, destellos de rosa neón y amarillo cálido, difuminados como bombillas de verbena vistas de lejos. No es la estética plana de un festival corporativo ni el ticketing neutro de un marketplace — es la propia productora anunciando su fiesta, con la energía directa de un cartel pintado a mano y pegatinas de feria pegadas sobre la pared.

La tipografía hace el mismo trabajo: Fredoka (redondeada, con peso y personalidad) para todo lo que grita — titulares, cifras de aforo, CTAs — y Space Grotesk (geométrica, neutra) para todo lo que se lee con calma — descripciones, listados, texto de soporte. Space Mono aparece solo donde hace falta precisión técnica: códigos de entrada, IDs de ticket.

El sistema es funcional primero: los formularios, inputs y tablas de admin se mantienen sobrios y legibles incluso cuando el resto de la página está lleno de gradientes y stickers. El carácter festivo vive en los titulares, los CTAs y los acentos decorativos — no en los controles con los que el staff trabaja cada noche.

**Key Characteristics:**
- Dark-first: el modo oscuro es el estado por defecto (`defaultTheme="dark"`), no un tema secundario.
- Morado royal + verde lima como pareja de marca; rosa neón, amarillo cálido y lavanda como acentos de apoyo, nunca protagonistas.
- Fredoka para todo lo que debe sentirse festivo; Space Grotesk para todo lo que debe leerse rápido.
- Dos vocabularios de profundidad a propósito: sombra ambiental suave para superficies normales, sombra dura tipo pegatina para insignias de marca.
- Radios generosos y consistentes (8–12px) en casi todo; `rounded-full` reservado para CTAs hero y stickers.

## Colors

La paleta combina un fondo nocturno saturado con dos colores de marca de alto contraste y un puñado de acentos de neón usados con moderación.

### Primary
- **Morado Feria** (`hsl(245 65% 51%)` claro / `hsl(245 70% 58%)` oscuro, ≈ `#3D2FD5`): color de marca principal. CTA primario, enlaces, foco de inputs, anillo de `--ring`. Es más vibrante en modo oscuro para mantener contraste sobre el fondo casi negro.

### Secondary
- **Verde Lima** (`hsl(72 76% 56%)`, ≈ `#C5E63A`): segundo color de marca, mismo peso visual que el morado. Se usa como acento de subrayado (la barra bajo "Grailla" en el hero), en stickers/badges, y en gráficos (`--chart-2`).

### Tertiary
- **Rosa Neón** (`hsl(330 100% 70%)`): acento decorativo — glows de fondo, blobs difuminados, tercer color de gráficos. Casi nunca aparece como relleno sólido.
- **Amarillo Cálido** (`hsl(46 91% 53%)`): segundo acento decorativo, mismo rol que el rosa neón — aparece en gráficos y como toque puntual de calidez.
- **Lavanda** (`hsl(280 45% 78%)`): acento más suave, quinto color de gráficos; poco presente fuera de visualizaciones de datos.

### Neutral
- **Azul Marino Profundo** (`hsl(245 30% 6%)`): fondo por defecto en modo oscuro (el estado canónico del producto).
- **Tinta Noche** (`hsl(240 20% 6%)`): texto principal y fondo en modo claro.
- **Blanco Papel** (`hsl(0 0% 100%)`): fondo en modo claro, texto sobre superficies morado/oscuras.
- **Niebla** (`hsl(60 10% 96%)`): texto principal sobre fondo oscuro.
- **Borde Noche** (`hsl(245 15% 18%)`): bordes y separadores en modo oscuro.
- **Destructivo** (`hsl(0 84% 60%)` claro / `hsl(0 63% 31%)` oscuro): errores, acciones destructivas, estado de aforo al 100%.

### Named Rules
**La Regla del Neón Discreto.** Rosa neón, amarillo cálido y lavanda solo aparecen como glow difuminado (`blur-3xl`, opacidad 6–15%), en bordes con opacidad reducida (`border-lima/60`), o en gráficos — nunca como relleno sólido de un componente interactivo. Su rareza es lo que los hace sentir "luces de feria" y no ruido de marca.

**La Regla del Doble Morado-Lima.** Cualquier composición de marca (hero, sticker, CTA destacado) usa morado y lima juntos, no uno sin el otro — son la pareja de marca, no dos accents intercambiables.

## Typography

**Display Font:** Fredoka (con `var(--font-sans)`, sans-serif como fallback)
**Body Font:** Space Grotesk (con `system-ui`, sans-serif como fallback)
**Label/Mono Font:** Space Mono, para códigos QR, IDs de ticket y datos técnicos

**Character:** Fredoka aporta la voz de feria — redondeada, con peso, casi de rotulista — reservada a titulares, cifras destacadas y CTAs. Space Grotesk es la voz de trabajo: geométrica y neutra, para todo lo que se lee en párrafo o en tabla. La pareja evita que el sistema se sienta ni todo-fiesta ni todo-oficina.

### Hierarchy
- **Display** (700, `clamp(3rem, 8vw, 6rem)`, line-height 0.9): el H1 del hero público ("La Grailla"). Aparece una vez por página, nunca en componentes repetidos.
- **Headline** (700, `clamp(1.5rem, 3vw, 1.875rem)`, line-height 1.2): títulos de página dentro del producto (Dashboard, "Compra Confirmada", "Control de Acceso").
- **Title** (700, 1.125rem, line-height 1.3): cabeceras de card/sección y cifras destacadas en cards de stats.
- **Body** (400, 0.875rem–1rem, line-height 1.5, máx. ~65ch en párrafos largos): texto de descripción, listados, copy de soporte.
- **Label** (600, 0.875rem, tracking 0.02em): texto de stickers/badges, siempre acompañado de un icono pequeño.
- **Mono** (400/700, 0.75rem): códigos QR mostrados en texto, IDs de ticket truncados.

### Named Rules
**La Regla del Titular Único.** El tamaño Display (Fredoka a escala hero) aparece como máximo una vez por vista — es el ancla visual de la página, no un estilo reutilizable para cualquier título grande.

## Logo / Wordmark

La marca gráfica de La Grailla es un **lettering hecho a mano** (no es texto tipográfico ni usa Fredoka) — trazo grueso, redondeado, con las letras "LL" fundidas en una sola forma. Vive como imagen (`components/logo.tsx`), no como texto estilizado.

- **Variantes:** `logo-white.png` (fondo oscuro: nav, footer, hero — el uso por defecto, ya que el producto es dark-first) y `logo-black.png` (fondo claro, uso puntual).
- **Pegatina de marca** (`sticker-wordmark.png`, `sticker-vaso.png`): la misma grafía aplicada sobre textura de papel arrugado, tal y como aparece en merchandising físico (pegatinas, vasos de la caseta). Se usa como acento decorativo — p. ej. la pegatina rotada junto al hero — nunca como wordmark funcional de navegación, porque su resolución de origen es baja (~400px) y no escala bien a tamaños grandes.
- **Favicon/apple-icon:** derivado de `sticker-vaso.png`, recortado a su bounding box y compuesto sobre un fondo sólido Morado Feria (`#3D2FD5`) en vez de dejarlo en transparencia — a 180px (`apple-icon.png`) el texto "La Grailla" se lee con nitidez; a 32px (`icon-32.png`) sigue leyéndose solo como una mancha de color de marca, ya que no existe una marca "solo icono" vectorial dedicada. Si en el futuro se genera un icono cuadrado propio (glifo simple, sin texto fino), sustituir `public/icon-32.png`, `public/icon-512.png` y `public/apple-icon.png`.
- El H1 del hero mantiene el texto "La Grailla" accesible (`sr-only`) para SEO/lectores de pantalla, mientras la imagen del logo ocupa el espacio visual — la "Regla del Titular Único" se cumple igual, solo que el titular es ahora la pieza gráfica de marca en vez de tipografía Fredoka a escala hero.
- **`favicon.svg`** (el "G" morado genérico, no relacionado con la marca real) se eliminó de `public/` al quedar huérfano tras migrar a `metadata.icons`.
- **`og-image.png`** (1200×630, usado en `openGraph.images`) se regeneró con el wordmark real (`logo-white.png`), el gradiente ambiental morado/lima/rosa de `--primary`/`--lima`/`--neon-pink`, tipografía Space Grotesk y la pegatina como acento — sustituyendo la versión anterior con texto genérico sin marca y copy en inglés ("EVENT TICKETING").

## Layout

Contenedor centrado con ancho máximo `max-w-[1200px]` en la mayoría de secciones públicas, padding horizontal `px-4`. El hero público ocupa `min-h-[85vh]` para que la primera pantalla sea siempre inmersiva. Los grids de contenido (eventos, productos) responden de una columna en móvil a 3 columnas en desktop. El panel de admin usa una densidad más compacta: cards de stats en grid de 2–4 columnas, tablas de ancho completo. El ritmo vertical sigue mayormente la escala de espaciado por defecto de Tailwind (`p-4`, `p-6`, `gap-4`); existe además una escala paralela de variables CSS (`--spacing-xs` 4px a `--spacing-3xl` 64px) definida como capa de tokens para consumo futuro por herramientas, aunque los componentes actuales todavía se apoyan en las utilidades nativas de Tailwind.

## Elevation & Depth

El sistema usa dos vocabularios de profundidad a propósito, cada uno con un rol distinto.

Para superficies normales (cards, botones, inputs) la profundidad es ambiental y sutil: sombras suaves con blur generoso que crecen ligeramente en hover, nunca agresivas. Para elementos de marca (`brand-sticker`: badges tipo "FERIA DE SAN MIGUEL 2025") la profundidad es dura y sólida — borde de 2px del color del texto y una sombra desplazada sin blur (`3px 3px 0 0 currentColor`), como una pegatina física pegada sobre la superficie. Son lenguajes deliberadamente distintos: uno dice "interfaz", el otro dice "cartel de feria".

### Shadow Vocabulary
- **Ambiental sm** (`0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.08)`): estado de reposo de botones, inputs, badges estándar.
- **Ambiental md** (`0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.05)`): hover de botones y cards interactivas.
- **Ambiental lg** (`0 10px 25px -5px rgb(0 0 0 / 0.08), 0 8px 10px -6px rgb(0 0 0 / 0.04)`): hover de cards glass, elevación máxima de superficies normales.
- **Sticker** (`3px 3px 0 0 currentColor`, sin blur, borde 2px a juego): exclusivo de `brand-sticker` — insignias de marca, nunca de UI funcional.

### Named Rules
**La Regla de los Dos Lenguajes.** Si un elemento comunica identidad de marca (sticker, badge de campaña), usa sombra dura tipo pegatina. Si comunica estado de interfaz (card, botón, input), usa sombra ambiental. Nunca se mezclan en el mismo componente.

## Shapes

Radios generosos y consistentes: 8px (sm) para controles pequeños, 10px (md) para casos intermedios, 12px (lg, ligado a `--radius: 0.75rem`) como radio por defecto de botones, cards e inputs. `rounded-full` se reserva para dos usos concretos: CTAs hero destacados (el botón "Ver Eventos" de la portada) y stickers/badges de marca — nunca para cards o inputs normales. Los bordes son de 1px salvo en `brand-sticker`, que usa 2px a juego con el color de texto.

## Components

### Buttons
- **Shape:** `rounded-lg` (12px) en la mayoría de tamaños; `rounded-md` (10px) en `sm`/`xs`/`icon-sm`.
- **Primary:** fondo Morado Feria, texto Blanco Papel, sombra ambiental sm en reposo, sombra ambiental md + `bg-primary/90` en hover. Alto por defecto 40px, padding `16px 8px`.
- **Outline:** fondo transparente, borde `border-input`; en hover adopta fondo y borde de acento.
- **Secondary / Ghost / Link:** variantes de menor énfasis para acciones secundarias; `ghost` sin fondo en reposo, `link` sin fondo nunca, subrayado en hover.
- **Glass (dark/light):** variante translúcida con blur (`backdrop-blur-md`) para botones sobre imágenes o gradientes de héroe.
- **Estado activo:** `active:scale-[0.98]` en todas las variantes — micro-feedback táctil consistente.
- **Patrón de héroe (composición, no variante base):** el CTA principal de portada combina `size="lg"` con overrides puntuales — `rounded-full`, altura 48px, `shadow-lg shadow-primary/25` — para un tratamiento de píldora que no forma parte del componente base, reservado a los CTAs de mayor jerarquía.

### Chips / Stickers
- **Style:** fondo transparente, texto y borde del mismo color de acento (normalmente Verde Lima), `rounded-full`, sombra dura tipo pegatina (`3px 3px 0 0 currentColor`), icono pequeño + texto en mayúsculas conceptual (Label).
- **Uso:** anuncios de campaña/evento destacado ("FERIA DE SAN MIGUEL 2025"), nunca para estado transaccional (eso lo cubre `Badge`).

### Cards / Containers
- **Corner Style:** `rounded-lg` (12px).
- **Background:** superficie `card` (Blanco Papel claro / Tinta Noche + tinte morado en oscuro).
- **Shadow Strategy:** ambiental sm en reposo; variante `interactive` sube a md + `-translate-y-0.5` en hover.
- **Variantes glass:** `glass-dark`/`glass-light` con `backdrop-blur-xl` y borde translúcido, para tarjetas sobre el hero o fondos con gradiente.
- **Internal Padding:** 24px (`p-6`) en header/content/footer.

### Inputs / Fields
- **Style:** borde `border-input`, fondo `background`, `rounded-lg`, altura 40px por defecto (32px en `sm`, 48px en `lg`).
- **Focus:** anillo de 2px en `--ring` (Morado Feria) con offset de 2px sobre el fondo — nunca solo cambio de borde.
- **Error / Success:** variantes dedicadas con borde y anillo de color semántico (`destructive` / `emerald-500`), no solo un mensaje de texto.
- **Ghost:** fondo `muted/50` sin borde visible hasta el foco — para buscadores y campos de baja jerarquía.

### Navigation
- El nav público usa el mismo `brand-sticker` como wordmark/CTA de acento. El admin shell usa wordmark en Display (Fredoka bold) con el nombre del producto en Morado Feria, sin decoración adicional — la navegación de trabajo es deliberadamente más sobria que la pública.

## Do's and Don'ts

### Do:
- **Do** usar Fredoka solo para lo que debe sentirse festivo (titulares, CTAs, cifras destacadas) y Space Grotesk para todo lo demás.
- **Do** mantener el modo oscuro como estado canónico del producto — diseñar primero para `azul-marino-profundo`, adaptar después a claro.
- **Do** reservar la sombra dura tipo pegatina (`3px 3px 0 0 currentColor`) exclusivamente a elementos de marca (stickers, badges de campaña).
- **Do** usar los acentos de neón (rosa, amarillo, lavanda) como glow difuminado o en gráficos, nunca como relleno sólido de un control interactivo.
- **Do** mantener inputs, tablas y controles de admin sobrios y legibles incluso cuando el resto de la vista use gradientes y stickers — el carácter festivo vive en titulares y CTAs, no en las herramientas de trabajo diario.

### Don't:
- **Don't** mezclar el vocabulario de sombra ambiental con el de sombra tipo pegatina en el mismo componente.
- **Don't** usar `rounded-full` en cards o inputs normales — está reservado a CTAs hero y stickers/badges.
- **Don't** usar Fredoka para párrafos, tablas o cualquier texto que se lea de corrido — es una fuente de titular, no de cuerpo.
- **Don't** aplicar los acentos de neón como color de fondo sólido en un botón o card — pierden su papel de "luz de feria a lo lejos" y se convierten en ruido de marca.
