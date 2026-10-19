import { z } from 'zod';

/* Tema de marca de un cliente (SiteTheme). Módulo PURO (sin servidor, sin next/*): lo usan el layout, la pantalla de Apariencia y los tests.
 *
 * Qué es y qué NO es:
 *   - Un cliente personaliza su web con muy pocas decisiones (dos colores de marca, dos tonos de superficie, una pareja de tipografías de un
 *     catálogo cerrado, la forma de las esquinas y una plantilla). El resto de tokens (primer plano, bordes, tarjetas, gráficos…) se DERIVA aquí,
 *     con contraste legible garantizado: no se puede guardar un tema ilegible.
 *   - Nunca se inyecta texto libre en CSS. `buildThemeCss` solo emite tripletes HSL calculados por este módulo y nombres de variables de una
 *     lista cerrada, y se comprueba con una expresión regular antes de salir.
 *   - Se valida al guardar Y al leer: lo que haya en la BD (aunque lo escribiera otra vía, p. ej. el PUT genérico de configuración) pasa por
 *     `parseTheme`, que devuelve null si no es un tema válido. */

export const THEME_VERSION = 1 as const;

// ── Catálogo cerrado ────────────────────────────────────────────────────────────────────────────────────────────────
export const TEMPLATES = ['feria', 'editorial', 'marquesina', 'galeria', 'tipo', 'estudio', 'cine', 'drop'] as const;
export type TemplateKey = (typeof TEMPLATES)[number];
export const TEMPLATE_LABELS: Record<TemplateKey, { label: string; description: string }> = {
  feria: { label: 'Feria', description: 'Festiva: degradados, pegatinas de borde grueso y botones redondeados.' },
  editorial: { label: 'Editorial', description: 'Sobria: tipografía grande, mucho aire y sin adornos.' },
  marquesina: {
    label: 'Marquesina',
    description: 'Cartel de teatro: el nombre del evento a pantalla completa, cinta en movimiento y programación en filas con el cartel flotando al pasar el ratón.',
  },
  galeria: {
    label: 'Galería',
    description: 'Clara y con mucho aire: tipografía con serifa enorme, programa numerado y fotos que se revelan al bajar. Para cultura, gastronomía y clubs privados.',
  },
  tipo: {
    label: 'Tipo',
    description: 'Sin fotos: titular pesado y enorme, bloques de color y formas geométricas propias de cada evento. Para quien solo tiene tipografía y color.',
  },
  estudio: {
    label: 'Estudio',
    description: 'Para empresas de servicios, estudios y agencias: un titular que explica qué hacéis, el índice de proyectos con la imagen siguiendo al cursor, servicios, equipo y preguntas frecuentes.',
  },
  cine: {
    label: 'Cine',
    description: 'Oscura y cinematográfica: vídeo a pantalla completa en la cabecera, cartelera en un riel horizontal y el cartel que crece de la tarjeta a la ficha del evento. Para conciertos y promotoras con vídeo.',
  },
  drop: {
    label: 'Drop',
    description: 'Para comercio y marca: bloques de color, producto grande con etiqueta de precio, riel de novedades y una ficha propia por producto, con el producto siguiendo al cursor y un «Añadido» al comprar.',
  },
};

export const FONT_KEYS = ['fredoka', 'space-grotesk', 'inter', 'dm-sans', 'poppins', 'montserrat', 'playfair-display', 'bebas-neue', 'instrument-serif', 'bricolage-grotesque'] as const;
export type FontKey = (typeof FONT_KEYS)[number];
/** `cssVar`: la variable que define `next/font` para esa familia (ver lib/brand/fonts.ts). Los valores NO vienen del cliente. */
export const FONT_CATALOG: Record<FontKey, { label: string; cssVar: string; roles: readonly ('display' | 'body')[] }> = {
  fredoka: { label: 'Fredoka (redondeada)', cssVar: '--f-fredoka', roles: ['display', 'body'] },
  'space-grotesk': { label: 'Space Grotesk (geométrica)', cssVar: '--f-space-grotesk', roles: ['display', 'body'] },
  inter: { label: 'Inter (neutra)', cssVar: '--f-inter', roles: ['display', 'body'] },
  'dm-sans': { label: 'DM Sans (humanista)', cssVar: '--f-dm-sans', roles: ['display', 'body'] },
  poppins: { label: 'Poppins (geométrica amplia)', cssVar: '--f-poppins', roles: ['display', 'body'] },
  montserrat: { label: 'Montserrat (urbana)', cssVar: '--f-montserrat', roles: ['display', 'body'] },
  'playfair-display': { label: 'Playfair Display (serif elegante)', cssVar: '--f-playfair-display', roles: ['display'] },
  'bebas-neue': { label: 'Bebas Neue (cartel)', cssVar: '--f-bebas-neue', roles: ['display'] },
  'instrument-serif': { label: 'Instrument Serif (serif de galería)', cssVar: '--f-instrument-serif', roles: ['display'] },
  'bricolage-grotesque': { label: 'Bricolage Grotesque (con carácter)', cssVar: '--f-bricolage-grotesque', roles: ['display', 'body'] },
};
export const DEFAULT_FONTS = { display: 'fredoka', body: 'space-grotesk' } as const satisfies { display: FontKey; body: FontKey };

export const RADII = ['recto', 'suave', 'redondo'] as const;
export type RadiusKey = (typeof RADII)[number];
export const RADIUS_VALUE: Record<RadiusKey, string> = { recto: '0.375rem', suave: '0.75rem', redondo: '1rem' };

export const MODES = ['dark', 'light', 'system'] as const;
export type ModeKey = (typeof MODES)[number];

/** Ajustes con los que cada plantilla luce mejor. Son una SUGERENCIA (la pantalla de Apariencia los ofrece con un botón), no se imponen. */
export const TEMPLATE_PRESETS: Partial<Record<TemplateKey, { mode: ModeKey; radius: RadiusKey; fonts: { display: FontKey; body: FontKey }; note: string }>> = {
  marquesina: {
    mode: 'dark',
    radius: 'recto',
    fonts: { display: 'bebas-neue', body: 'space-grotesk' },
    note: 'modo oscuro, esquinas rectas y Bebas Neue para el titular',
  },
  galeria: {
    mode: 'light',
    radius: 'recto',
    fonts: { display: 'instrument-serif', body: 'dm-sans' },
    note: 'modo claro, esquinas rectas y Instrument Serif para el titular',
  },
  tipo: {
    mode: 'light',
    radius: 'recto',
    fonts: { display: 'montserrat', body: 'inter' },
    note: 'modo claro, esquinas rectas y Montserrat para el titular',
  },
  estudio: {
    mode: 'light',
    radius: 'recto',
    fonts: { display: 'bricolage-grotesque', body: 'inter' },
    note: 'modo claro, esquinas rectas y Bricolage Grotesque para el titular',
  },
  cine: {
    mode: 'dark',
    radius: 'recto',
    fonts: { display: 'playfair-display', body: 'inter' },
    note: 'modo oscuro, esquinas rectas y Playfair Display para el titular',
  },
  drop: {
    mode: 'light',
    radius: 'suave',
    fonts: { display: 'poppins', body: 'inter' },
    note: 'modo claro, esquinas suaves y Poppins para el titular',
  },
};

// ── Esquema ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #RRGGBB');
// Una imagen de marca es un fichero propio de la instalación (/brand/…) o un fichero de Vercel Blob (https, sin query ni credenciales).
// La comprobación de que pertenece al prefijo del cliente se hace al guardar (servidor): aquí solo la forma.
const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';
/** Ficheros fijos de la instalación de La Grailla (iconos y imagen social de siempre): solo los puede usar el cliente legacy. */
export const LEGACY_FIXED_ASSETS = ['/icon-32.png', '/icon-512.png', '/apple-icon.png', '/og-image.png'] as const;
export function isBrandAssetUrl(raw: string): boolean {
  if ((LEGACY_FIXED_ASSETS as readonly string[]).includes(raw)) return true;
  if (/^\/brand\/(?!\.)[\w.-]+$/.test(raw)) return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname.endsWith(BLOB_HOST_SUFFIX) &&
    url.hostname.length > BLOB_HOST_SUFFIX.length &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    !url.port
  );
}
const assetUrl = z.string().max(500).refine(isBrandAssetUrl, 'URL de imagen no válida');

/** Vídeo de cabecera (plantilla «cine»): solo de Blob y solo MP4 o WebM, que son los que reproduce cualquier navegador sin plugins. */
export function isBrandVideoUrl(raw: string): boolean {
  if (!isBrandAssetUrl(raw) || raw.startsWith('/')) return false;
  try {
    return /\.(mp4|webm)$/i.test(decodeURIComponent(new URL(raw).pathname));
  } catch {
    return false;
  }
}
const videoUrl = z.string().max(500).refine(isBrandVideoUrl, 'El vídeo debe ser un MP4 o WebM subido desde el panel');

const text = (max: number) => z.string().trim().max(max);

export const themeSchema = z.object({
  v: z.literal(THEME_VERSION),
  template: z.enum(TEMPLATES).default('feria'),
  mode: z.enum(MODES).default('dark'),
  radius: z.enum(RADII).default('suave'),
  colors: z.object({
    primary: hex,
    accent: hex,
    /** Fondo de página en modo oscuro / claro. Vacío = derivado del color principal. */
    surfaceDark: hex.optional(),
    surfaceLight: hex.optional(),
  }),
  fonts: z
    .object({ display: z.enum(FONT_KEYS), body: z.enum(FONT_KEYS) })
    .refine((f) => FONT_CATALOG[f.display].roles.includes('display') && FONT_CATALOG[f.body].roles.includes('body'), 'Tipografía no válida para ese uso')
    .default(DEFAULT_FONTS),
  assets: z
    .object({
      /** Logo para superficies OSCURAS (versión clara/blanca) y para superficies CLARAS (versión oscura). */
      logoOnDark: assetUrl.optional(),
      logoOnLight: assetUrl.optional(),
      favicon: assetUrl.optional(),
      ogImage: assetUrl.optional(),
      /** Vídeo y póster de la cabecera de la plantilla «cine». El póster es lo que se ve mientras carga o si el visitante pide menos movimiento. */
      heroVideo: videoUrl.optional(),
      heroPoster: assetUrl.optional(),
    })
    .default({}),
  brand: z.object({
    name: text(60).min(1),
    tagline: text(160).default(''),
    description: text(300).default(''),
    /** Razón social para el pie y los textos legales; vacío = el nombre. */
    legalName: text(100).default(''),
    /** Pegatina de la cabecera de la plantilla «feria» (p. ej. «GOOD VIBES»); vacío = sin pegatina. */
    sticker: text(24).default(''),
  }),
});

export type SiteTheme = z.infer<typeof themeSchema>;
/** Lo que llega del formulario: igual que `SiteTheme` pero con los valores por defecto aún sin aplicar. */
export type SiteThemeInput = z.input<typeof themeSchema>;

/** Valida un valor desconocido (JSON de la BD o cuerpo de una petición). null si no es un tema válido. */
export function parseTheme(raw: unknown): SiteTheme | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const r = themeSchema.safeParse(value);
  return r.success ? r.data : null;
}

// ── Color ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Hsl = { h: number; s: number; l: number };

export function hexToHsl(hexColor: string): Hsl {
  const n = parseInt(hexColor.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function hslToHex(c: Hsl): string {
  return `#${hslToRgb(c)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Razón de contraste WCAG entre dos colores HSL (1 a 21). */
export function contrastRatio(a: Hsl, b: Hsl): number {
  const la = luminance(hslToRgb(a));
  const lb = luminance(hslToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (h: number) => ((h % 360) + 360) % 360;
const r1 = (v: number) => Math.round(v * 10) / 10;
const fmt = ({ h, s, l }: Hsl) => `${r1(wrap(h))} ${r1(clamp(s, 0, 100))}% ${r1(clamp(l, 0, 100))}%`;

const WHITE: Hsl = { h: 0, s: 0, l: 100 };
/** Texto sobre un color de marca: el de mayor contraste entre blanco y una tinta oscura del mismo tono. */
function readableOn(bg: Hsl): Hsl {
  // l=2: con un negro más claro, los tonos medios (L≈50) se quedarían por debajo de 4.5 con ambas opciones.
  const ink: Hsl = { h: bg.h, s: 20, l: 2 };
  return contrastRatio(bg, WHITE) >= contrastRatio(bg, ink) ? WHITE : ink;
}

// ── Tokens derivados ────────────────────────────────────────────────────────────────────────────────────────────────
/** Los únicos tokens que un tema puede fijar: los de globals.css. Lista cerrada. */
export const TOKEN_KEYS = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
  'accent', 'accent-foreground', 'destructive', 'destructive-foreground', 'border', 'input', 'ring',
  'lima', 'neon-pink', 'warm-yellow', 'lavender', 'hero-glow',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
] as const;
export type TokenKey = (typeof TOKEN_KEYS)[number];
export type TokenSet = Record<TokenKey, string>;

function deriveLight(primary: Hsl, accent: Hsl, surface?: Hsl): TokenSet {
  const h = primary.h;
  const bg: Hsl = surface ?? { h: 0, s: 0, l: 100 };
  const fg: Hsl = { h, s: 20, l: 6 };
  const sec: Hsl = surface ? { h: surface.h, s: Math.min(surface.s, 12), l: clamp(surface.l - 6, 0, 100) } : { h, s: 5, l: 94 };
  const border: Hsl = surface ? { h: surface.h, s: Math.min(surface.s, 10), l: clamp(surface.l - 10, 0, 100) } : { h, s: 6, l: 90 };
  return {
    background: fmt(bg), foreground: fmt(fg),
    card: fmt(bg), 'card-foreground': fmt(fg),
    popover: fmt(bg), 'popover-foreground': fmt(fg),
    primary: fmt(primary), 'primary-foreground': fmt(readableOn(primary)),
    secondary: fmt(sec), 'secondary-foreground': fmt(fg),
    muted: fmt(sec), 'muted-foreground': fmt({ h, s: 4, l: 40 }),
    accent: fmt(accent), 'accent-foreground': fmt(readableOn(accent)),
    destructive: '0 84% 60%', 'destructive-foreground': '0 0% 98%',
    border: fmt(border), input: fmt(border), ring: fmt(primary),
    lima: fmt(accent), 'neon-pink': fmt({ h: h + 105, s: 100, l: 70 }), 'warm-yellow': fmt({ h: accent.h - 30, s: 90, l: 53 }), lavender: fmt({ h: h + 35, s: 45, l: 78 }),
    'hero-glow': fmt(primary),
    'chart-1': fmt(primary), 'chart-2': fmt(accent), 'chart-3': fmt({ h: h + 105, s: 100, l: 70 }), 'chart-4': fmt({ h: accent.h - 30, s: 90, l: 53 }), 'chart-5': fmt({ h: h + 35, s: 45, l: 78 }),
  };
}

function deriveDark(primary: Hsl, accent: Hsl, surface?: Hsl): TokenSet {
  const h = primary.h;
  // En oscuro el color de marca sube un punto de luminosidad para seguir destacando sobre el fondo.
  const p: Hsl = { h, s: clamp(primary.s + 5, 0, 100), l: clamp(primary.l + 7, 0, 66) };
  const bg: Hsl = surface ?? { h, s: 30, l: 6 };
  const card: Hsl = { h: bg.h, s: bg.s * 0.85, l: bg.l + 3 };
  const fg: Hsl = { h: 60, s: 10, l: 96 };
  const sec: Hsl = { h: bg.h, s: bg.s * 0.7, l: bg.l + 10 };
  const mut: Hsl = { h: bg.h, s: bg.s * 0.5, l: bg.l + 9 };
  const border: Hsl = { h: bg.h, s: bg.s * 0.5, l: bg.l + 12 };
  return {
    background: fmt(bg), foreground: fmt(fg),
    card: fmt(card), 'card-foreground': fmt(fg),
    popover: fmt(card), 'popover-foreground': fmt(fg),
    primary: fmt(p), 'primary-foreground': fmt(readableOn(p)),
    secondary: fmt(sec), 'secondary-foreground': fmt(fg),
    muted: fmt(mut), 'muted-foreground': fmt({ h: bg.h, s: 5, l: 64 }),
    accent: fmt(accent), 'accent-foreground': fmt(readableOn(accent)),
    destructive: '0 63% 31%', 'destructive-foreground': '0 0% 98%',
    border: fmt(border), input: fmt(border), ring: fmt(p),
    lima: fmt(accent), 'neon-pink': fmt({ h: h + 105, s: 100, l: 70 }), 'warm-yellow': fmt({ h: accent.h - 30, s: 90, l: 53 }), lavender: fmt({ h: h + 35, s: 45, l: 78 }),
    'hero-glow': fmt({ h, s: clamp(primary.s + 5, 0, 100), l: 35 }),
    'chart-1': fmt(p), 'chart-2': fmt(accent), 'chart-3': fmt({ h: h + 105, s: 100, l: 72 }), 'chart-4': fmt({ h: accent.h - 30, s: 90, l: 58 }), 'chart-5': fmt({ h: h + 35, s: 50, l: 72 }),
  };
}

export type DerivedTokens = { light: TokenSet; dark: TokenSet };

export function deriveTokens(theme: Pick<SiteTheme, 'colors'>): DerivedTokens {
  const primary = hexToHsl(theme.colors.primary);
  const accent = hexToHsl(theme.colors.accent);
  return {
    light: deriveLight(primary, accent, theme.colors.surfaceLight ? hexToHsl(theme.colors.surfaceLight) : undefined),
    dark: deriveDark(primary, accent, theme.colors.surfaceDark ? hexToHsl(theme.colors.surfaceDark) : undefined),
  };
}

export function hexToRgb(hexColor: string): [number, number, number] {
  const n = parseInt(hexColor.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mezcla un color con blanco (`amount` 0..1 = proporción de blanco): fondos suaves para emails. */
export function tintHex(hexColor: string, amount: number): string {
  const [r, g, b] = hexToRgb(hexColor).map((v) => Math.round(v + (255 - v) * amount));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Colores de marca como #RRGGBB, para lo que no es CSS: emails, PDFs, Excel y pases de wallet. */
export function brandHexColors(theme: Pick<SiteTheme, 'colors'>): { primary: string; accent: string; ink: string; surfaceDark: string } {
  const primary = hexToHsl(theme.colors.primary);
  return {
    primary: theme.colors.primary.toLowerCase(),
    accent: theme.colors.accent.toLowerCase(),
    ink: hslToHex({ h: primary.h, s: 20, l: 6 }),
    surfaceDark: (theme.colors.surfaceDark ?? hslToHex({ h: primary.h, s: 30, l: 6 })).toLowerCase(),
  };
}

/** Un par de colores que un tema NO puede dejar ilegible: texto sobre cada color de marca. Devuelve los fallos (vacío = tema legible). */
export function themeContrastIssues(theme: Pick<SiteTheme, 'colors'>): string[] {
  const { light, dark } = deriveTokens(theme);
  const issues: string[] = [];
  const parse = (v: string): Hsl => {
    const [h, s, l] = v.split(' ');
    return { h: parseFloat(h), s: parseFloat(s), l: parseFloat(l) };
  };
  for (const [mode, set] of [['claro', light], ['oscuro', dark]] as const) {
    for (const [bg, fg, what] of [
      ['background', 'foreground', 'el texto sobre el fondo'],
      ['primary', 'primary-foreground', 'el texto sobre el color principal'],
      ['accent', 'accent-foreground', 'el texto sobre el color de acento'],
    ] as const) {
      if (contrastRatio(parse(set[bg]), parse(set[fg])) < 4.5) issues.push(`En modo ${mode}, ${what} no tiene contraste suficiente.`);
    }
  }
  return issues;
}

/**
 * Avisos que NO bloquean: el color principal o el de acento usados como TEXTO o icono sobre el fondo (enlaces, iconos) con menos de 3:1.
 * Un acento claro funciona de relleno (botón) pero se lee mal como texto; se avisa para que lo elija con conocimiento.
 */
export function themeContrastWarnings(theme: Pick<SiteTheme, 'colors'>): string[] {
  const { light, dark } = deriveTokens(theme);
  const parse = (v: string): Hsl => {
    const [h, s, l] = v.split(' ');
    return { h: parseFloat(h), s: parseFloat(s), l: parseFloat(l) };
  };
  const out: string[] = [];
  for (const [mode, set] of [['claro', light], ['oscuro', dark]] as const) {
    for (const [token, what] of [['primary', 'principal'], ['accent', 'de acento']] as const) {
      if (contrastRatio(parse(set[token]), parse(set.background)) < 3) out.push(`En modo ${mode}, el color ${what} se lee mal como texto o icono sobre el fondo.`);
    }
  }
  return out;
}

// ── CSS ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SAFE_TRIPLET = /^\d{1,3}(\.\d)? \d{1,3}(\.\d)?% \d{1,3}(\.\d)?%$/;
const SAFE_CSS = /^[\w\s:;.,%#(){}+\-[\]=]*$/;

function block(selector: string, tokens: TokenSet): string {
  const decls = TOKEN_KEYS.map((k) => {
    if (!SAFE_TRIPLET.test(tokens[k])) throw new Error(`Valor de token no válido: ${k}`);
    return `--${k}:${tokens[k]};`;
  });
  return `${selector}{${decls.join('')}}`;
}

/**
 * CSS que se inyecta en el <head>: sobrescribe los tokens de globals.css, el radio y las tipografías. Sin estilos de marca propios (tema
 * ausente) no se emite nada, y La Grailla se ve exactamente como siempre. Se emite SIN capa para ganar a las reglas de `@layer base`.
 */
export function buildThemeCss(theme: SiteTheme): string {
  const { light, dark } = deriveTokens(theme);
  const radius = RADIUS_VALUE[theme.radius];
  const rootExtra = `--radius:${radius};--radius-sm:calc(${radius} - 4px);--radius-lg:calc(${radius} + 4px);`;
  const root = block(':root', light).replace(/}$/, `${rootExtra}}`);
  const parts = [root, block('.dark', dark)];
  const display = FONT_CATALOG[theme.fonts.display].cssVar;
  const body = FONT_CATALOG[theme.fonts.body].cssVar;
  // La especificidad (0,1,1) de `body[data-brand-fonts]` gana a la clase de variable que genera next/font en <body>.
  parts.push(`body[data-brand-fonts]{--font-display:var(${display});--font-sans:var(${body});}`);
  const css = parts.join('\n');
  if (!SAFE_CSS.test(css)) throw new Error('CSS de tema no válido');
  return css;
}

/** Atributo que activa las tipografías del tema (ver `buildThemeCss`). */
export const BRAND_FONTS_ATTR = 'data-brand-fonts';
