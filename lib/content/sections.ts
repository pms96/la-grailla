import { parseBlobUrl } from '@/lib/blob-url';

/* Secciones de contenido de la portada que edita el propio cliente: servicios, proyectos, equipo y preguntas frecuentes. Son del NÚCLEO
 * (no dependen de ningún módulo de negocio) y no necesitan modelo ni migración: cada sección es un JSON en la configuración, como los
 * tipos de patrocinio. Este archivo es puro (sin Prisma ni React): lo importan el editor del panel, la API de configuración y la web.
 *
 * Una sección sin elementos NO se muestra. Todo el texto es del cliente: aquí solo hay nombres neutros por defecto. */

export const SECTION_KINDS = ['servicios', 'proyectos', 'equipo', 'faq'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const SECTION_CONFIG_KEYS: Readonly<Record<SectionKind, string>> = {
  servicios: 'home_section_servicios',
  proyectos: 'home_section_proyectos',
  equipo: 'home_section_equipo',
  faq: 'home_section_faq',
};

/** Límites: acotan lo que cabe en una portada razonable y lo que la API acepta (el JSON viaja en una sola clave de configuración). */
export const SECTION_LIMITS = {
  items: 24,
  title: 120,
  intro: 400,
  itemTitle: 120,
  text: 1200,
  meta: 80,
  href: 300,
  image: 500,
  raw: 60_000,
} as const;

export type SectionItem = {
  title: string;
  text: string;
  /** Dato corto junto al título: «Desde 300 €», «Cliente · 2025», el cargo de una persona. */
  meta: string;
  /** Imagen subida desde el panel (siempre de Blob); vacío = sin imagen. */
  imageUrl: string;
  /** Enlace opcional (https, ruta del propio sitio, ancla o correo); vacío = sin enlace. */
  href: string;
};

export type ContentSection = { title: string; intro: string; items: SectionItem[] };

export type SectionDef = {
  label: string;
  /** Título que se muestra si el cliente no escribe uno. */
  defaultTitle: string;
  /** Ancla de la sección en la portada y en el menú. */
  anchor: string;
  /** Qué campos tiene cada elemento (el editor y la web solo usan los que apliquen). */
  fields: { image: boolean; href: boolean; meta: boolean; text: boolean };
  /** Etiquetas del editor. */
  labels: { title: string; text: string; meta: string; add: string; empty: string };
};

export const SECTION_DEFS: Readonly<Record<SectionKind, SectionDef>> = {
  servicios: {
    label: 'Servicios',
    defaultTitle: 'Servicios',
    anchor: 'servicios',
    fields: { image: false, href: true, meta: true, text: true },
    labels: { title: 'Servicio', text: 'Descripción', meta: 'Detalle (precio, plazo…)', add: 'Añadir servicio', empty: 'Aún no has añadido ningún servicio.' },
  },
  proyectos: {
    label: 'Proyectos',
    defaultTitle: 'Proyectos',
    anchor: 'proyectos',
    fields: { image: true, href: true, meta: true, text: true },
    labels: { title: 'Proyecto', text: 'Descripción', meta: 'Cliente, año…', add: 'Añadir proyecto', empty: 'Aún no has añadido ningún proyecto.' },
  },
  equipo: {
    label: 'Equipo',
    defaultTitle: 'Equipo',
    anchor: 'equipo',
    fields: { image: true, href: false, meta: true, text: true },
    labels: { title: 'Nombre', text: 'Presentación', meta: 'Cargo', add: 'Añadir persona', empty: 'Aún no has añadido a nadie.' },
  },
  faq: {
    label: 'Preguntas frecuentes',
    defaultTitle: 'Preguntas frecuentes',
    anchor: 'preguntas-frecuentes',
    fields: { image: false, href: false, meta: false, text: true },
    labels: { title: 'Pregunta', text: 'Respuesta', meta: '', add: 'Añadir pregunta', empty: 'Aún no has añadido ninguna pregunta.' },
  },
};

export function emptySection(): ContentSection {
  return { title: '', intro: '', items: [] };
}

export function emptyItem(): SectionItem {
  return { title: '', text: '', meta: '', imageUrl: '', href: '' };
}

const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Como `clip`, pero sin recortar: una dirección cortada a medias apuntaría a otro sitio, así que si no cabe entera se descarta. */
const whole = (v: unknown, max: number): string => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.length <= max ? t : '';
};

/** Enlace permitido: https, una ruta del propio sitio (`/contacto`), un ancla (`#contacto`) o un correo. Cualquier otra cosa (`javascript:`,
 *  `data:`, `http:`, `//otro-sitio`) se descarta: el enlace lo escribe el cliente, pero lo ve todo el mundo. */
export function safeHref(raw: unknown): string {
  const v = whole(raw, SECTION_LIMITS.href);
  if (!v) return '';
  if (v.startsWith('#')) return /^#[\w-]{1,80}$/.test(v) ? v : '';
  if (v.startsWith('/')) return v.startsWith('//') || v.includes('\\') || /[\s\u0000-\u001f]/.test(v) ? '' : v;
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(v)) return v;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && !url.username && !url.password ? v : '';
  } catch {
    return '';
  }
}

/** Imagen permitida: solo las subidas desde el panel (Blob del propio sitio); la CSP tampoco deja cargar otras. */
export function safeImageUrl(raw: unknown): string {
  const v = whole(raw, SECTION_LIMITS.image);
  return v && parseBlobUrl(v) ? v : '';
}

function normalizeItem(raw: unknown, kind: SectionKind): SectionItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const f = SECTION_DEFS[kind].fields;
  const title = clip(r.title, SECTION_LIMITS.itemTitle);
  if (!title) return null; // un elemento sin título no se puede mostrar
  return {
    title,
    text: f.text ? clip(r.text, SECTION_LIMITS.text) : '',
    meta: f.meta ? clip(r.meta, SECTION_LIMITS.meta) : '',
    imageUrl: f.image ? safeImageUrl(r.imageUrl) : '',
    href: f.href ? safeHref(r.href) : '',
  };
}

/** Lee lo guardado con tolerancia: un JSON roto, de otra forma o con datos fuera de límite nunca rompe la portada (se descarta lo que sobra). */
export function parseSection(raw: string | null | undefined, kind: SectionKind): ContentSection {
  if (!raw || raw.length > SECTION_LIMITS.raw) return emptySection();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptySection();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptySection();
  const d = data as Record<string, unknown>;
  const items = (Array.isArray(d.items) ? d.items : [])
    .slice(0, SECTION_LIMITS.items)
    .map((i) => normalizeItem(i, kind))
    .filter((i): i is SectionItem => i !== null);
  return { title: clip(d.title, SECTION_LIMITS.title), intro: clip(d.intro, SECTION_LIMITS.intro), items };
}

/** ¿Hay algo que mostrar? Sin elementos, la sección no existe en la web (aunque tenga título). */
export function hasContent(section: ContentSection | null | undefined): section is ContentSection {
  return !!section && section.items.length > 0;
}

/** Lo que se guarda: vacío si la sección no tiene nada (así «borrar todo» deja la clave vacía y la web la oculta). */
export function serializeSection(section: ContentSection, kind: SectionKind): string {
  const clean = parseSection(JSON.stringify(section), kind);
  if (clean.items.length === 0 && !clean.title && !clean.intro) return '';
  return JSON.stringify(clean);
}

/** Las imágenes que usa una sección guardada (para saber cuáles dejan de usarse al editarla o quitarla). */
export function sectionImageUrls(raw: string | null | undefined, kind: SectionKind): string[] {
  return parseSection(raw, kind)
    .items.map((item) => item.imageUrl)
    .filter((url) => url !== '');
}

/** Motivo por el que el valor guardado no es válido (para rechazarlo en la API y avisar en el editor), o null si lo es. Vacío vale: la oculta.
 *  Es MÁS estricta que `parseSection`: la web tolera datos raros, pero el panel no debe guardarlos en silencio recortados. */
export function invalidSectionValue(raw: string, kind?: SectionKind): string | null {
  const v = raw.trim();
  if (v === '') return null;
  if (v.length > SECTION_LIMITS.raw) return 'es demasiado largo';
  let data: unknown;
  try {
    data = JSON.parse(v);
  } catch {
    return 'no es un JSON válido';
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'tiene un formato no válido';
  const d = data as Record<string, unknown>;
  const text = (x: unknown, max: number) => x === undefined || (typeof x === 'string' && x.length <= max);
  if (!text(d.title, SECTION_LIMITS.title)) return `el título admite como máximo ${SECTION_LIMITS.title} caracteres`;
  if (!text(d.intro, SECTION_LIMITS.intro)) return `la introducción admite como máximo ${SECTION_LIMITS.intro} caracteres`;
  if (!Array.isArray(d.items)) return 'faltan los elementos';
  if (d.items.length > SECTION_LIMITS.items) return `admite como máximo ${SECTION_LIMITS.items} elementos`;
  for (const [n, item] of d.items.entries()) {
    const at = `elemento ${n + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return `${at}: formato no válido`;
    const i = item as Record<string, unknown>;
    if (typeof i.title !== 'string' || i.title.trim() === '') return `${at}: falta el título`;
    if (!text(i.title, SECTION_LIMITS.itemTitle)) return `${at}: el título admite como máximo ${SECTION_LIMITS.itemTitle} caracteres`;
    if (!text(i.text, SECTION_LIMITS.text)) return `${at}: el texto admite como máximo ${SECTION_LIMITS.text} caracteres`;
    if (!text(i.meta, SECTION_LIMITS.meta)) return `${at}: el detalle admite como máximo ${SECTION_LIMITS.meta} caracteres`;
    // Con el tipo conocido solo se exigen los campos que ese tipo usa; sin él (la API valida por clave), todos.
    if (typeof i.href === 'string' && i.href.trim() !== '' && (kind === undefined || SECTION_DEFS[kind].fields.href) && safeHref(i.href) === '') {
      return `${at}: el enlace debe empezar por https://, / o #, o ser un correo (mailto:), y tener como máximo ${SECTION_LIMITS.href} caracteres`;
    }
    if (typeof i.imageUrl === 'string' && i.imageUrl.trim() !== '' && (kind === undefined || SECTION_DEFS[kind].fields.image) && safeImageUrl(i.imageUrl) === '') {
      return `${at}: la imagen debe subirse desde el panel`;
    }
  }
  return null;
}

/** Tipo de sección que corresponde a una clave de configuración, o null si la clave no es de una sección. */
export function sectionKindOfKey(key: string): SectionKind | null {
  return SECTION_KINDS.find((k) => SECTION_CONFIG_KEYS[k] === key) ?? null;
}
