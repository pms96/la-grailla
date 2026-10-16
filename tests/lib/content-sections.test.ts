import { describe, expect, it } from 'vitest';
import {
  SECTION_CONFIG_KEYS,
  SECTION_KINDS,
  SECTION_LIMITS,
  hasContent,
  invalidSectionValue,
  parseSection,
  safeHref,
  safeImageUrl,
  sectionKindOfKey,
  serializeSection,
} from '@/lib/content/sections';
import { CONFIG_DEFAULT_KEYS } from '@/lib/config';
import { configKeyOwners, invalidConfigValue, isConfigKeyAllowed } from '@/lib/config-ownership';

const BLOB = 'https://abc123.public.blob.vercel-storage.com/t1/sections/foto.jpg';
const item = (over: Record<string, unknown> = {}) => ({ title: 'Diseño web', text: 'Sitios a medida.', meta: 'Desde 300 €', imageUrl: '', href: '', ...over });
const json = (over: Record<string, unknown> = {}) => JSON.stringify({ title: '', intro: '', items: [item()], ...over });

describe('enlaces de las secciones', () => {
  it('admite https, rutas del propio sitio, anclas y correos', () => {
    expect(safeHref('https://ejemplo.es/contacto')).toBe('https://ejemplo.es/contacto');
    expect(safeHref('/contacto')).toBe('/contacto');
    expect(safeHref('#contacto')).toBe('#contacto');
    expect(safeHref('mailto:hola@ejemplo.es')).toBe('mailto:hola@ejemplo.es');
  });

  it('descarta lo que podría ejecutar código o llevar a otro sitio sin avisar', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'http://ejemplo.es', '//otro.sitio/x', '/\\otro.sitio', 'https://user:pass@ejemplo.es', 'ejemplo.es', '#con espacio', 'mailto:no-es-correo']) {
      expect(safeHref(bad), bad).toBe('');
    }
  });

  it('descarta un enlace demasiado largo', () => {
    expect(safeHref(`https://ejemplo.es/${'a'.repeat(SECTION_LIMITS.href)}`)).toBe('');
  });
});

describe('imágenes de las secciones', () => {
  it('solo se admiten las subidas desde el panel (Blob)', () => {
    expect(safeImageUrl(BLOB)).toBe(BLOB);
    expect(safeImageUrl('https://otro-sitio.com/foto.jpg')).toBe('');
    expect(safeImageUrl('http://abc123.public.blob.vercel-storage.com/x.jpg')).toBe('');
    expect(safeImageUrl('data:image/png;base64,AAAA')).toBe('');
    expect(safeImageUrl(`${BLOB}?x=1`)).toBe('');
  });
});

describe('parseSection: lo guardado se lee con tolerancia', () => {
  it('un valor vacío, roto o de otra forma da una sección vacía (nunca rompe la portada)', () => {
    for (const raw of [undefined, null, '', 'no es json', '[]', '"texto"', '123', 'null', JSON.stringify({ items: 'x' })]) {
      const s = parseSection(raw as string | null | undefined, 'servicios');
      expect(hasContent(s), String(raw)).toBe(false);
    }
  });

  it('recorta los textos, descarta los elementos sin título y respeta el máximo', () => {
    const many = Array.from({ length: SECTION_LIMITS.items + 10 }, (_, i) => item({ title: `Servicio ${i}` }));
    const s = parseSection(JSON.stringify({ title: '  Qué hacemos  ', intro: '', items: [item({ title: '   ' }), item({ title: 'x'.repeat(500) }), ...many] }), 'servicios');
    expect(s.title).toBe('Qué hacemos');
    // Solo se leen los primeros 24; uno de ellos no tiene título y se descarta.
    expect(s.items).toHaveLength(SECTION_LIMITS.items - 1);
    expect(s.items[0]!.title).toHaveLength(SECTION_LIMITS.itemTitle);
  });

  it('cada sección solo conserva los campos que usa', () => {
    const full = item({ imageUrl: BLOB, href: 'https://ejemplo.es' });
    const raw = JSON.stringify({ items: [full] });
    expect(parseSection(raw, 'faq').items[0]).toMatchObject({ meta: '', imageUrl: '', href: '' });
    expect(parseSection(raw, 'equipo').items[0]).toMatchObject({ meta: 'Desde 300 €', imageUrl: BLOB, href: '' });
    expect(parseSection(raw, 'servicios').items[0]).toMatchObject({ imageUrl: '', href: 'https://ejemplo.es' });
    expect(parseSection(raw, 'proyectos').items[0]).toMatchObject({ imageUrl: BLOB, href: 'https://ejemplo.es' });
  });

  it('un enlace o una imagen no válidos se quitan del elemento, no lo tiran entero', () => {
    const s = parseSection(JSON.stringify({ items: [item({ href: 'javascript:alert(1)', imageUrl: 'https://otro.com/a.jpg' })] }), 'proyectos');
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ title: 'Diseño web', href: '', imageUrl: '' });
  });
});

describe('serializeSection', () => {
  it('una sección sin título, introducción ni elementos se guarda vacía (la web la oculta)', () => {
    expect(serializeSection({ title: '', intro: '', items: [] }, 'faq')).toBe('');
    expect(serializeSection({ title: '', intro: '', items: [{ title: '  ', text: 'x', meta: '', imageUrl: '', href: '' }] }, 'faq')).toBe('');
  });

  it('ida y vuelta: lo que se guarda se lee igual', () => {
    const section = { title: 'Qué hacemos', intro: 'Tres cosas.', items: [{ title: 'Diseño web', text: 'Sitios a medida.', meta: 'Desde 300 €', imageUrl: '', href: 'https://ejemplo.es' }] };
    const back = parseSection(serializeSection(section, 'servicios'), 'servicios');
    expect(back.title).toBe('Qué hacemos');
    expect(back.items).toHaveLength(1);
    expect(back.items[0]!.href).toBe('https://ejemplo.es');
  });

  it('con solo título y sin elementos se guarda, pero no hay nada que mostrar', () => {
    const raw = serializeSection({ title: 'Servicios', intro: '', items: [] }, 'servicios');
    expect(raw).not.toBe('');
    expect(hasContent(parseSection(raw, 'servicios'))).toBe(false);
  });
});

describe('invalidSectionValue: la API rechaza lo que el panel no debe guardar', () => {
  it('vacío y un valor correcto valen', () => {
    expect(invalidSectionValue('')).toBeNull();
    expect(invalidSectionValue(json())).toBeNull();
    expect(invalidSectionValue(json({ items: [item({ href: 'https://ejemplo.es', imageUrl: BLOB })] }), 'proyectos')).toBeNull();
  });

  it('JSON roto, forma equivocada o demasiado grande', () => {
    expect(invalidSectionValue('{no')).not.toBeNull();
    expect(invalidSectionValue('[]')).not.toBeNull();
    expect(invalidSectionValue(JSON.stringify({ title: 'x' }))).not.toBeNull(); // faltan los elementos
    expect(invalidSectionValue('x'.repeat(SECTION_LIMITS.raw + 1))).not.toBeNull();
  });

  it('demasiados elementos y textos fuera de límite', () => {
    expect(invalidSectionValue(json({ items: Array.from({ length: SECTION_LIMITS.items + 1 }, () => item()) }))).toMatch(/máximo/);
    expect(invalidSectionValue(json({ items: [item({ text: 'x'.repeat(SECTION_LIMITS.text + 1) })] }))).toMatch(/texto/);
    expect(invalidSectionValue(json({ title: 'x'.repeat(SECTION_LIMITS.title + 1) }))).toMatch(/título/);
  });

  it('un elemento sin título se rechaza, con su número', () => {
    expect(invalidSectionValue(json({ items: [item(), item({ title: ' ' })] }))).toMatch(/elemento 2: falta el título/);
  });

  it('un enlace peligroso o una imagen ajena se rechazan, no se recortan en silencio', () => {
    expect(invalidSectionValue(json({ items: [item({ href: 'javascript:alert(1)' })] }), 'servicios')).toMatch(/enlace/);
    expect(invalidSectionValue(json({ items: [item({ imageUrl: 'https://otro.com/a.jpg' })] }), 'equipo')).toMatch(/imagen/);
  });

  it('no exige los campos que la sección no usa (el equipo no tiene enlace)', () => {
    expect(invalidSectionValue(json({ items: [item({ href: 'javascript:alert(1)' })] }), 'equipo')).toBeNull();
  });
});

describe('claves de configuración de las secciones', () => {
  it('son del núcleo: siempre disponibles, y ninguna sección depende de un módulo de negocio', () => {
    for (const kind of SECTION_KINDS) {
      const key = SECTION_CONFIG_KEYS[kind];
      expect(configKeyOwners(key)).toEqual(['nucleo']);
      expect(isConfigKeyAllowed(key, ['nucleo'])).toBe(true);
      expect(CONFIG_DEFAULT_KEYS).toContain(key);
      expect(sectionKindOfKey(key)).toBe(kind);
    }
  });

  it('un rol sin el núcleo no las puede tocar', () => {
    expect(isConfigKeyAllowed(SECTION_CONFIG_KEYS.faq, ['nucleo', 'tienda'], ['tienda'])).toBe(false);
    expect(isConfigKeyAllowed(SECTION_CONFIG_KEYS.faq, ['nucleo', 'tienda'], ['nucleo'])).toBe(true);
  });

  it('la API de configuración valida su contenido por clave', () => {
    expect(invalidConfigValue(SECTION_CONFIG_KEYS.servicios, json())).toBeNull();
    expect(invalidConfigValue(SECTION_CONFIG_KEYS.servicios, '{no')).not.toBeNull();
    expect(invalidConfigValue(SECTION_CONFIG_KEYS.equipo, json({ items: [item({ imageUrl: 'https://otro.com/a.jpg' })] }))).toMatch(/imagen/);
    expect(invalidConfigValue(SECTION_CONFIG_KEYS.faq, '')).toBeNull();
  });
});
