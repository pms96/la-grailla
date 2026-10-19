import { prisma } from '@/lib/prisma';
import { getOperatorEmail } from '@/lib/config';
import { currentTenant, isLegacyTenant } from '@/lib/tenant/context';
import { getFallbackBaseUrl } from '@/lib/url';
import { perRequest } from '@/lib/request-cache';
import { brandHexColors, parseTheme, tintHex, type ModeKey, type SiteTheme, type TemplateKey } from './theme';

/* La marca de la petición en curso: nombre, textos, colores y logos. Todo lo que antes era «La Grailla» escrito a mano (web, emails, PDFs,
 * Excel, pases de wallet) sale de aquí.
 *
 *   - Instalación única y cliente `legacy`: si no han guardado un tema, la marca es la de La Grailla, sin CSS añadido (se ve exactamente
 *     como siempre).
 *   - Cualquier otro cliente en modo plataforma: parte de una marca NEUTRA (su dominio como nombre, sin logo, paleta sobria), nunca de la de
 *     La Grailla. Hasta que configure Apariencia no hereda nada de otro cliente.
 *
 * El tema se guarda como JSON en la clave `site_theme` de AppConfig y se valida SIEMPRE al leer (parseTheme): lo que haya en la BD, lo
 * escribiera quien lo escribiera, nunca llega al CSS sin pasar por el esquema. */

export const THEME_CONFIG_KEY = 'site_theme';

export type Brand = {
  name: string;
  tagline: string;
  description: string;
  /** Razón social (pie, textos legales). Si el cliente no la fija, el nombre. */
  legalName: string;
  /** Pegatina de la cabecera (plantilla «feria»); '' = ninguna. */
  sticker: string;
  /** Cómo se nombra al organizador en textos formales (p. ej. la autorización de menores). */
  organizer: string;
  /** Dirección de contacto del cliente (admin_email); '' si no la ha configurado. */
  contactEmail: string;
  template: TemplateKey;
  mode: ModeKey;
  /** El tema guardado y válido, o null cuando se usa la apariencia integrada (La Grailla sin tema). */
  theme: SiteTheme | null;
  colors: {
    primary: string;
    accent: string;
    ink: string;
    surfaceDark: string;
    /** Color de títulos y botones en emails y documentos, y su versión suave para fondos de bloque. */
    emailAccent: string;
    emailTint: string;
  };
  /** URL relativa (/brand/…) o de Blob. null = sin logo: se muestra el nombre como marca de texto. */
  logoOnDark: string | null;
  logoOnLight: string | null;
  favicon: string | null;
  ogImage: string | null;
  /** Vídeo y póster de la cabecera de la plantilla «cine» (Blob del cliente); null = sin ellos. */
  heroVideo: string | null;
  heroPoster: string | null;
  /** Pegatina decorativa de la portada «feria» (solo La Grailla tiene una). */
  stickerImage: string | null;
};

const LA_GRAILLA_SEED = {
  name: 'La Grailla',
  tagline: 'Good Vibes & Eventos',
  description: 'La Grailla: caseta de feria, eventos, fiestas y las mejores noches. ¡Good Vibes! ¿Te vienes?',
  legalName: 'Grupo La Grailla',
  sticker: 'GOOD VIBES',
  organizer: 'la caseta "LA GRAILLA"',
  colors: { primary: '#3d2fd5', accent: '#c5e63a' },
  logoOnDark: '/brand/logo-white.png',
  logoOnLight: '/brand/logo-black.png',
  favicon: '/icon-32.png',
  ogImage: '/og-image.png',
  stickerImage: '/brand/sticker-wordmark.png',
} as const;

/** Punto de partida de un cliente que aún no ha configurado Apariencia: sobrio y claramente distinto de La Grailla. */
const NEUTRAL = {
  template: 'editorial' as TemplateKey,
  mode: 'light' as ModeKey,
  colors: { primary: '#1d4ed8', accent: '#f59e0b' },
};

/** Tema neutro de partida (para que la pantalla de Apariencia tenga algo que editar). */
export function neutralTheme(name: string): SiteTheme {
  return {
    v: 1,
    template: NEUTRAL.template,
    mode: NEUTRAL.mode,
    radius: 'suave',
    colors: { primary: NEUTRAL.colors.primary, accent: NEUTRAL.colors.accent },
    fonts: { display: 'inter', body: 'inter' },
    assets: {},
    brand: { name, tagline: '', description: '', legalName: '', sticker: '' },
  };
}

/** La apariencia original de La Grailla expresada como tema (para que su Apariencia tenga un punto de partida editable). */
export function legacySeedTheme(): SiteTheme {
  return {
    v: 1,
    template: 'feria',
    mode: 'dark',
    radius: 'suave',
    colors: { primary: LA_GRAILLA_SEED.colors.primary, accent: LA_GRAILLA_SEED.colors.accent },
    fonts: { display: 'fredoka', body: 'space-grotesk' },
    assets: { logoOnDark: LA_GRAILLA_SEED.logoOnDark, logoOnLight: LA_GRAILLA_SEED.logoOnLight, favicon: LA_GRAILLA_SEED.favicon, ogImage: LA_GRAILLA_SEED.ogImage },
    brand: { name: LA_GRAILLA_SEED.name, tagline: LA_GRAILLA_SEED.tagline, description: LA_GRAILLA_SEED.description, legalName: LA_GRAILLA_SEED.legalName, sticker: LA_GRAILLA_SEED.sticker },
  };
}

/** Lo que edita la pantalla de Apariencia: el tema guardado o, si no hay, el punto de partida de este cliente. */
export async function getEditableTheme(): Promise<{ theme: SiteTheme; saved: boolean; legacy: boolean }> {
  const legacy = isLegacyTenant();
  const saved = await readTheme();
  if (saved) return { theme: saved, saved: true, legacy };
  return { theme: legacy ? legacySeedTheme() : neutralTheme(neutralName()), saved: false, legacy };
}

/** Nombre mientras el cliente no ponga el suyo: su dominio. */
function neutralName(): string {
  const host = currentTenant()?.primaryDomain ?? '';
  return host.replace(/^www\./, '') || 'Sitio';
}

async function readTheme(): Promise<SiteTheme | null> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: THEME_CONFIG_KEY } });
    return row?.value ? parseTheme(row.value) : null;
  } catch {
    return null;
  }
}

export function resolveBrand(theme: SiteTheme | null, legacy: boolean, contactEmail: string, fallbackName: string): Brand {
  if (!theme && legacy) {
    return {
      name: LA_GRAILLA_SEED.name,
      tagline: LA_GRAILLA_SEED.tagline,
      description: LA_GRAILLA_SEED.description,
      legalName: LA_GRAILLA_SEED.legalName,
      sticker: LA_GRAILLA_SEED.sticker,
      organizer: LA_GRAILLA_SEED.organizer,
      contactEmail,
      template: 'feria',
      mode: 'dark',
      theme: null,
      // Los emails de La Grailla siempre han usado este morado y este fondo lila: se conservan tal cual.
      colors: { ...brandHexColors({ colors: LA_GRAILLA_SEED.colors }), emailAccent: '#a855f7', emailTint: '#f6f4ff' },
      logoOnDark: LA_GRAILLA_SEED.logoOnDark,
      logoOnLight: LA_GRAILLA_SEED.logoOnLight,
      favicon: LA_GRAILLA_SEED.favicon,
      ogImage: LA_GRAILLA_SEED.ogImage,
      heroVideo: null,
      heroPoster: null,
      stickerImage: LA_GRAILLA_SEED.stickerImage,
    };
  }
  const t = theme ?? neutralTheme(fallbackName);
  const seed = legacy ? LA_GRAILLA_SEED : null;
  return {
    name: t.brand.name,
    tagline: t.brand.tagline,
    description: t.brand.description || t.brand.tagline,
    legalName: t.brand.legalName || t.brand.name,
    sticker: t.brand.sticker,
    organizer: legacy ? LA_GRAILLA_SEED.organizer : `"${(t.brand.legalName || t.brand.name).toUpperCase()}"`,
    contactEmail,
    template: t.template,
    mode: t.mode,
    // Un tema guardado SIEMPRE se aplica (aunque sea el neutro, para que el cliente vea su apariencia coherente en la vista previa).
    theme: t,
    colors: { ...brandHexColors(t), emailAccent: t.colors.primary.toLowerCase(), emailTint: tintHex(t.colors.primary, 0.93) },
    logoOnDark: t.assets.logoOnDark ?? seed?.logoOnDark ?? null,
    logoOnLight: t.assets.logoOnLight ?? seed?.logoOnLight ?? null,
    favicon: t.assets.favicon ?? seed?.favicon ?? null,
    ogImage: t.assets.ogImage ?? seed?.ogImage ?? null,
    heroVideo: t.assets.heroVideo ?? null,
    heroPoster: t.assets.heroPoster ?? null,
    stickerImage: seed?.stickerImage ?? null,
  };
}

async function loadBrand(): Promise<Brand> {
  const legacy = isLegacyTenant();
  const theme = await readTheme();
  let contactEmail = '';
  try {
    contactEmail = await getOperatorEmail();
  } catch {
    contactEmail = '';
  }
  return resolveBrand(theme, legacy, contactEmail, neutralName());
}

/** La marca de esta petición (una sola lectura por petición cuando se llama desde Server Components). */
export const getBrand: () => Promise<Brand> = perRequest(loadBrand);

/** URL absoluta de un recurso de marca (los relativos /brand/… cuelgan del dominio del cliente). null si no hay recurso. */
export function absoluteBrandUrl(url: string | null, baseUrl?: string): string | null {
  if (!url) return null;
  if (/^https:\/\//i.test(url)) return url;
  const base = baseUrl ?? getFallbackBaseUrl();
  return base ? `${base}${url}` : url;
}

/** ¿Es una instalación que ya pasó por Apariencia? (para el aviso «completa tu marca» en el panel). */
export const hasSavedTheme = async (): Promise<boolean> => (await readTheme()) !== null;
