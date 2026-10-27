import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_CATALOG, TEMPLATES, TEMPLATE_LABELS, TEMPLATE_PRESETS, parseTheme } from '@/lib/brand/theme';
import { toTemplateEvent, type EventInput } from '@/app/(public)/_home/event-view';
import { EstudioHero, HomeEstudio, sentenceSize, type HomeEstudioProps } from '@/app/(public)/_home/estudio/home-estudio';
import { EventosEstudio } from '@/app/(public)/_home/estudio/eventos-estudio';
import { EventList } from '@/app/(public)/_home/estudio/event-list';
import { ProjectIndex } from '@/app/(public)/_home/estudio/project-index';
import { ContentSections } from '@/app/(public)/_home/sections/content-sections';
import { PageBanner } from '@/app/(public)/_templates/page-banner';
import { parseSection, type ContentSection, type SectionKind } from '@/lib/content/sections';
import { attr, expectOptimized, withBlobHost } from '../helpers/blob-host';

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const BLOB = 'https://abc123.public.blob.vercel-storage.com/t1/sections/foto.jpg';
const section = (kind: SectionKind, items: Record<string, unknown>[]): ContentSection => parseSection(JSON.stringify({ title: '', intro: '', items }), kind);

const event = (over: Partial<EventInput> = {}): EventInput => ({
  id: 'e1',
  slug: 'jornada-abierta',
  name: 'Jornada abierta',
  imageUrl: null,
  date: '2026-11-14T18:00:00Z',
  venue: 'Estudio',
  city: 'Valencia',
  maxCapacity: 100,
  ticketTypes: [{ price: 10, maxQuantity: 100, soldCount: 10 }],
  ...over,
});

const projects = section('proyectos', [
  { title: 'Web de una cooperativa', text: 'Rediseño completo.', meta: 'Cooperativa · 2025', imageUrl: BLOB, href: 'https://ejemplo.es/cooperativa' },
  { title: 'Cerámica Rovira', meta: 'Tienda · 2024', href: '/contacto' },
  { title: 'Festival de cine', text: 'Entradas y acreditaciones.' },
]);

describe('plantilla «estudio» — catálogo', () => {
  it('está en el catálogo, con etiqueta y sugerencia de ajustes válida', () => {
    expect(TEMPLATES).toContain('estudio');
    expect(TEMPLATE_LABELS.estudio.label).toBe('Estudio');
    const preset = TEMPLATE_PRESETS.estudio!;
    expect(FONT_CATALOG[preset.fonts.display].roles).toContain('display');
    expect(FONT_CATALOG[preset.fonts.body].roles).toContain('body');
    expect(FONT_CATALOG['bricolage-grotesque'].cssVar).toBe('--f-bricolage-grotesque');
  });

  it('un tema guardado con la plantilla y los ajustes sugeridos es válido', () => {
    const preset = TEMPLATE_PRESETS.estudio!;
    const theme = parseTheme({ v: 1, template: 'estudio', mode: preset.mode, radius: preset.radius, colors: { primary: '#1d4ed8', accent: '#f59e0b' }, fonts: preset.fonts, brand: { name: 'Estudio Rovira' } });
    expect(theme?.template).toBe('estudio');
  });

  it('los temas guardados antes (otras plantillas) siguen siendo válidos', () => {
    expect(parseTheme({ v: 1, template: 'tipo', colors: { primary: '#1d4ed8', accent: '#f59e0b' }, brand: { name: 'X' } })?.template).toBe('tipo');
  });
});

describe('sentenceSize', () => {
  it('el titular es una frase: manda su longitud total', () => {
    expect(sentenceSize('Diseñamos webs que se entienden')).toBe('l');
    expect(sentenceSize('Somos un estudio de diseño y desarrollo que acompaña a pequeñas empresas')).toBe('m');
    expect(sentenceSize('x'.repeat(140))).toBe('s');
  });
});

describe('EstudioHero', () => {
  const hero = { badge: '', title: 'Diseñamos webs que se entienden', subtitle: 'Estudio pequeño en Valencia.', primaryCta: { href: '#contacto', label: 'Cuéntanos tu proyecto', icon: 'mail' as const } };

  it('el titular es el único h1 y sale completo; la frase y el botón los pone el cliente', () => {
    const html = render(<EstudioHero brandName="Estudio Rovira" hero={hero} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])).toBe('Diseñamos webs que se entienden');
    expect(html).toContain('Estudio pequeño en Valencia.');
    expect(html).toContain('href="#contacto"');
    expect(html).toContain('Cuéntanos tu proyecto');
    expect(html).toContain('Estudio Rovira'); // sobre-título: el nombre, porque el titular es otra frase
  });

  it('sin frase de apoyo ni botón no pinta ningún enlace; con el nombre como titular no repite el sobre-título', () => {
    const html = render(<EstudioHero brandName="Estudio Rovira" hero={{ badge: '', title: '', subtitle: '', primaryCta: null }} />);
    expect(html).not.toContain('<a ');
    expect(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])).toBe('Estudio Rovira');
    expect(html).not.toContain('es-label');
  });

  it('un titular largo usa un tamaño menor', () => {
    expect(render(<EstudioHero brandName="X" hero={{ ...hero, title: 'x '.repeat(70) }} />)).toContain('data-size="s"');
  });
});

describe('ProjectIndex', () => {
  it('una fila por proyecto; con enlace es un enlace y sin él es solo texto', () => {
    const html = render(<ProjectIndex items={projects.items} />);
    expect(html.match(/class="es-row"/g)).toHaveLength(3);
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain('href="https://ejemplo.es/cooperativa"');
    expect(html).toContain('href="/contacto"');
    expect(html).toContain('Festival de cine');
    expect(html).toContain('Entradas y acreditaciones.');
    expect(html).toContain('Cooperativa · 2025');
  });

  it('un enlace externo se abre en otra pestaña y lo dice a lectores de pantalla; uno interno, no', () => {
    const html = render(<ProjectIndex items={projects.items} />);
    expect(html).toMatch(/<a href="https:\/\/ejemplo\.es\/cooperativa" class="es-row" target="_blank" rel="noopener noreferrer"/);
    expect(html.match(/\(se abre en otra pestaña\)/g)).toHaveLength(1);
  });

  it('la imagen flotante empieza vacía y oculta: ninguna se descarga hasta pasar por su fila; la miniatura táctil es perezosa', () => {
    const html = render(<ProjectIndex items={projects.items} />);
    expect(html).toMatch(/class="es-preview hidden md:block" data-on="false" aria-hidden="true"/);
    expect(html).toMatch(/<div class="es-preview-card"><\/div>/);
    expect(html.match(/<img /g)).toHaveLength(1); // solo el proyecto con imagen lleva miniatura
    expect(html).toContain('loading="lazy"');
  });

  it('el texto del cliente se escapa', () => {
    const html = render(<ProjectIndex items={section('proyectos', [{ title: '<script>alert(1)</script>' }]).items} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('ContentSections con «estudio»', () => {
  const all = { proyectos: projects, servicios: section('servicios', [{ title: 'Diseño web', text: 'A medida.' }]), equipo: section('equipo', [{ title: 'Ana López', meta: 'Dirección' }]), faq: section('faq', [{ title: '¿Cuánto tarda?', text: 'Seis semanas.' }]) };

  it('los proyectos son el índice (no una rejilla de tarjetas)', () => {
    const html = render(<ContentSections template="estudio" sections={all} kinds={['proyectos']} />);
    expect(html).toContain('es-list');
    expect(html).toContain('es-row-title');
    expect(html).not.toContain('aspect-[4/3]');
  });

  it('`kinds` decide qué secciones salen y en qué orden', () => {
    const html = render(<ContentSections template="estudio" sections={all} kinds={['proyectos', 'servicios']} />);
    expect(html.indexOf('id="proyectos"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="proyectos"')).toBeLessThan(html.indexOf('id="servicios"'));
    expect(html).not.toContain('id="equipo"');
  });

  it('sin `kinds` sigue funcionando por tramos, como antes', () => {
    expect(render(<ContentSections template="estudio" sections={all} slot="after-about" />)).toContain('id="equipo"');
  });
});

describe('HomeEstudio', () => {
  const base: HomeEstudioProps = {
    brandName: 'Estudio Rovira',
    hero: { badge: '', title: 'Diseñamos webs que se entienden', subtitle: '', primaryCta: null },
    events: [toTemplateEvent(event())],
    loadError: false,
    hasEntradas: false,
    hasTienda: false,
    hasSponsors: false,
    contactEnabled: false,
    sections: { proyectos: projects, servicios: section('servicios', [{ title: 'Diseño web' }]), equipo: section('equipo', [{ title: 'Ana López' }]), faq: section('faq', [{ title: '¿Cuánto tarda?', text: 'Seis semanas.' }]) },
    copy: { shopTitle: '', shopSubtitle: '', aboutTitle: '', aboutText: 'Un estudio pequeño.', sponsorsTitle: '', sponsorsSubtitle: '' },
  };
  const ids = (html: string) => [...html.matchAll(/<section[^>]*id="([^"]+)"/g)].map((m) => m[1]);

  it('un cliente de servicios (solo núcleo): proyectos, servicios, sobre nosotros, equipo y preguntas, en ese orden y sin módulos de negocio', () => {
    const html = render(<HomeEstudio {...base} />);
    expect(ids(html)).toEqual(['proyectos', 'servicios', 'sobre-nosotros', 'equipo', 'preguntas-frecuentes']);
    expect(html).not.toContain('Agenda');
    expect(html).not.toContain('/tienda');
    expect(html).not.toContain('/sponsors');
    expect(html).not.toContain('/eventos/');
  });

  it('con Entradas, Tienda y Sponsors aparecen como bloques secundarios', () => {
    const html = render(<HomeEstudio {...base} hasEntradas hasTienda hasSponsors />);
    expect(ids(html)).toContain('agenda');
    expect(html).toContain('href="/eventos/jornada-abierta"');
    expect(html).toContain('href="/tienda"');
    expect(html).toContain('href="/sponsors"');
  });

  it('sin secciones ni texto propio solo queda el titular', () => {
    const html = render(<HomeEstudio {...base} sections={undefined} copy={{ ...base.copy, aboutText: '' }} />);
    expect(ids(html)).toEqual([]);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('error de carga y lista vacía de la agenda se distinguen', () => {
    expect(render(<HomeEstudio {...base} hasEntradas events={[]} loadError />)).toContain('No hemos podido cargar los eventos');
    const vacio = render(<HomeEstudio {...base} hasEntradas events={[]} />);
    expect(vacio).toContain('Aún no hay eventos publicados');
    expect(vacio).not.toContain('No hemos podido cargar');
  });
});

describe('EventList y EventosEstudio', () => {
  it('una fila por evento con su enlace, lugar, precio y estado', () => {
    const events = [toTemplateEvent(event()), toTemplateEvent(event({ id: 'e2', slug: 'otra', name: 'Otra jornada', ticketTypes: [{ price: 10, maxQuantity: 100, soldCount: 100 }] }))];
    const html = render(<EventList events={events} />);
    expect(html.match(/class="es-row"/g)).toHaveLength(2);
    expect(html).toContain('href="/eventos/otra"');
    expect(html).toContain('desde 10.00€');
    expect(html).toContain('Sin plazas online');
  });

  it('/eventos: cabecera y estados de error y vacío', () => {
    expect(render(<EventosEstudio brandName="Estudio" events={[]} loadError />)).toContain('No hemos podido cargar la agenda');
    const vacio = render(<EventosEstudio brandName="Estudio" events={[]} loadError={false} />);
    expect(vacio).toContain('Todavía no hay fechas publicadas');
    expect(render(<EventosEstudio brandName="Estudio" events={[toTemplateEvent(event())]} loadError={false} />)).toContain('Jornada abierta');
  });
});

describe('PageBanner con «estudio»', () => {
  const facts = [{ label: 'Fecha', value: 'Sábado, 14 de noviembre' }, { label: 'Lugar', value: 'Estudio, Valencia' }];

  it('un solo h1 con el título, datos en lista de definiciones y la imagen del cartel', () => {
    const html = render(<PageBanner template="estudio" brandName="Estudio" title="Jornada abierta" facts={facts} imageUrl="https://example.com/c.jpg" />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])).toBe('Jornada abierta');
    expect(html).toContain('<dl');
    expect(html).toContain('Sábado, 14 de noviembre');
    expect(html).toContain('alt="Cartel de Jornada abierta"');
  });

  it('en versión baja (legales) no lleva imagen y el titular es más pequeño', () => {
    const html = render(<PageBanner template="estudio" brandName="Estudio" title="Aviso legal" imageUrl="https://example.com/c.jpg" compact />);
    expect(html).not.toContain('<img');
    expect(html).toContain('data-size="s"');
  });
});

describe('ProjectIndex con la optimización de imágenes activa (BLOB_PUBLIC_HOST)', () => {
  it('la miniatura de 56 px pide la variante de 96 px y conserva loading y clases', () => {
    const html = withBlobHost(() => render(<ProjectIndex items={projects.items} />));
    expectOptimized(html, BLOB);
    expect(attr(html, 'sizes')).toBe('96px');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('class="h-14 w-14 object-cover md:hidden"');
  });

  it('sin la variable el src es el original', () => {
    expect(withBlobHost(() => render(<ProjectIndex items={projects.items} />), null)).toContain(`src="${BLOB}"`);
  });
});
