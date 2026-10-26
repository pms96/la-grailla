import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_CATALOG, TEMPLATES, TEMPLATE_LABELS, TEMPLATE_PRESETS, parseTheme } from '@/lib/brand/theme';
import { toTemplateEvent, type EventInput } from '@/app/(public)/_home/event-view';
import { EventEntries } from '@/app/(public)/_home/galeria/event-entries';
import { EventosGaleria } from '@/app/(public)/_home/galeria/eventos-galeria';
import { GaleriaHero, GaleriaTitle, HomeGaleria, type HomeGaleriaProps } from '@/app/(public)/_home/galeria/home-galeria';
import { BLOB_PUBLIC_HOST, attr, expectOptimized, withBlobHost } from '../helpers/blob-host';

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);

const event = (over: Partial<EventInput> = {}): EventInput => ({
  id: 'e1',
  slug: 'noche-de-verano',
  name: 'Noche de Verano',
  imageUrl: 'https://example.com/cartel.jpg',
  date: '2026-11-14T20:00:00Z',
  venue: 'Sala Rodrigo',
  city: 'Valencia',
  maxCapacity: 500,
  currentCount: 100,
  ticketTypes: [{ price: 15 }],
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const h1 = (html: string) => html.match(/<h1[\s\S]*?<\/h1>/)![0];

describe('plantilla «galería» — catálogo', () => {
  it('está en el catálogo con su etiqueta y una sugerencia de ajustes válida', () => {
    expect(TEMPLATES).toContain('galeria');
    expect(TEMPLATE_LABELS.galeria.label).toBe('Galería');
    const preset = TEMPLATE_PRESETS.galeria!;
    expect(preset.mode).toBe('light');
    expect(FONT_CATALOG[preset.fonts.display].roles).toContain('display');
    expect(FONT_CATALOG[preset.fonts.body].roles).toContain('body');
  });

  it('Instrument Serif es solo para titulares y no choca con ninguna otra variable CSS', () => {
    expect(FONT_CATALOG['instrument-serif'].roles).toEqual(['display']);
    const vars = Object.values(FONT_CATALOG).map((f) => f.cssVar);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('un tema guardado con la plantilla y los ajustes sugeridos es válido; como cuerpo, la serifa se rechaza', () => {
    const preset = TEMPLATE_PRESETS.galeria!;
    const base = { v: 1, template: 'galeria', mode: preset.mode, radius: preset.radius, colors: { primary: '#1d4ed8', accent: '#f59e0b' }, brand: { name: 'Sala Rodrigo' } };
    expect(parseTheme({ ...base, fonts: preset.fonts })?.template).toBe('galeria');
    expect(parseTheme({ ...base, fonts: { display: 'inter', body: 'instrument-serif' } })).toBeNull();
  });
});

describe('GaleriaTitle', () => {
  it('con cursiva real destaca la última palabra; sin ella, o con una sola palabra, no toca nada', () => {
    expect(render(<GaleriaTitle text="Noche de Verano" italic />)).toBe('Noche de <em>Verano</em>');
    expect(render(<GaleriaTitle text="Noche de Verano" italic={false} />)).toBe('Noche de Verano');
    expect(render(<GaleriaTitle text="Verano" italic />)).toBe('Verano');
  });
});

describe('GaleriaHero', () => {
  const hero = { badge: '', title: 'Sala Rodrigo', subtitle: 'Música en directo', primaryCta: { href: '/eventos', label: 'Ver eventos', icon: 'ticket' as const } };

  it('con evento: nombre completo en el único h1, datos del evento, foto con texto alternativo y botón de compra', () => {
    const html = render(<GaleriaHero brandName="Sala Rodrigo" hero={hero} featured={toTemplateEvent(event())} italic />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(h1(html))).toBe('Noche de Verano');
    expect(h1(html)).toContain('<em>Verano</em>');
    expect(html).toContain('sábado, 14 de noviembre');
    expect(html).toContain('Sala Rodrigo, Valencia');
    expect(html).toContain('desde 15.00€');
    expect(html).toContain('href="/eventos/noche-de-verano/comprar"');
    expect(html).toContain('data-hero');
    expect(html).toContain('alt="Cartel de Noche de Verano"');
  });

  it('sin foto el marco enseña el día en grande y se oculta a lectores de pantalla', () => {
    const html = render(<GaleriaHero brandName="Sala Rodrigo" hero={hero} featured={toTemplateEvent(event({ imageUrl: null, date: '2026-11-14T20:00:00Z' }))} />);
    expect(html).toContain('gl-frame--blank');
    expect(html).toMatch(/gl-frame--blank" aria-hidden="true"><span class="gl-numeral">14<\/span>/);
    expect(html).not.toContain('<img');
  });

  it('sin evento: titular de la marca, su texto y el botón de la página; sin marco de foto', () => {
    const html = render(<GaleriaHero brandName="Sala Rodrigo" hero={hero} featured={null} />);
    expect(text(h1(html))).toBe('Sala Rodrigo');
    expect(html).toContain('Música en directo');
    expect(html).toContain('href="/eventos"');
    expect(html).not.toContain('gl-frame');
  });
});

describe('EventEntries', () => {
  const rows = [
    toTemplateEvent(event()),
    toTemplateEvent(event({ id: 'e2', slug: 'otra', name: 'Otra Noche', imageUrl: null, maxCapacity: 100, currentCount: 100 })),
    toTemplateEvent(event({ id: 'e3', slug: 'tercera', name: 'Tercera' })),
  ];

  it('numera por orden del calendario y enlaza cada entrada a su ficha', () => {
    const html = render(<EventEntries events={rows} />);
    expect(html).toContain('N.º 01');
    expect(html).toContain('N.º 02');
    expect(html).toContain('N.º 03');
    expect(html.indexOf('Noche de Verano')).toBeLessThan(html.indexOf('Otra Noche'));
    expect(html.match(/class="gl-entry /g)).toHaveLength(3);
    expect(html).toContain('href="/eventos/otra"');
    expect(html).toContain('Sin plazas online');
  });

  it('la foto cambia de lado en las entradas pares', () => {
    const html = render(<EventEntries events={rows} />);
    const entries = html.split('<li>').slice(1);
    // El contenedor de la foto es el único con `md:col-span-4`: en las impares va a la derecha (col. 9) y en las pares a la izquierda (col. 2).
    const photoCol = (entry: string) => entry.match(/md:col-span-4 (md:col-start-\d+)"/)?.[1];
    expect(photoCol(entries[0])).toBe('md:col-start-9');
    expect(photoCol(entries[1])).toBe('md:col-start-2');
    expect(photoCol(entries[2])).toBe('md:col-start-9');
  });

  it('las fotos son perezosas y decorativas (el nombre ya está en el texto); sin foto, el día en grande', () => {
    const html = render(<EventEntries events={rows} />);
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html.match(/loading="lazy"/g)).toHaveLength(2);
    expect(html).toContain('alt=""');
    expect(html).toContain('gl-frame--blank');
  });
});

describe('HomeGaleria y EventosGaleria — cada sección solo con su módulo', () => {
  const base: HomeGaleriaProps = {
    brandName: 'Sala Rodrigo',
    hero: { badge: '', title: 'Sala Rodrigo', subtitle: '', primaryCta: null },
    events: [toTemplateEvent(event())],
    loadError: false,
    hasEntradas: true,
    hasTienda: true,
    hasSponsors: true,
    contactEnabled: false,
    copy: { shopTitle: 'Merch', shopSubtitle: '', aboutTitle: '', aboutText: 'Una sala con historia.', sponsorsTitle: '', sponsorsSubtitle: '' },
  };

  it('con todo: programa, tienda, texto propio y patrocinio', () => {
    const html = render(<HomeGaleria {...base} />);
    expect(html).toContain('>Programa<');
    expect(html).toContain('href="/tienda"');
    expect(html).toContain('Merch');
    expect(html).toContain('Una sala con historia.');
    expect(html).toContain('href="/sponsors"');
  });

  it('sin Entradas, Tienda ni Sponsors no hay ni programa ni enlaces a esos módulos', () => {
    const html = render(<HomeGaleria {...base} hasEntradas={false} hasTienda={false} hasSponsors={false} events={[]} />);
    expect(html).not.toContain('>Programa<');
    expect(html).not.toContain('href="/tienda"');
    expect(html).not.toContain('href="/sponsors"');
    expect(html).not.toContain('/eventos/');
    expect(html).toContain('Una sala con historia.');
  });

  it('error de carga y lista vacía se distinguen', () => {
    expect(render(<HomeGaleria {...base} events={[]} loadError />)).toContain('No hemos podido cargar los eventos');
    const vacio = render(<HomeGaleria {...base} events={[]} />);
    expect(vacio).toContain('Aún no hay eventos publicados');
    expect(vacio).not.toContain('No hemos podido cargar');
  });

  it('/eventos: titular, programa, y los estados de error y vacío', () => {
    const ok = render(<EventosGaleria brandName="Sala Rodrigo" events={[toTemplateEvent(event())]} loadError={false} italicAccent />);
    expect(text(h1(ok))).toBe('Programa completo');
    expect(ok).toContain('N.º 01');
    expect(render(<EventosGaleria brandName="Sala Rodrigo" events={[]} loadError />)).toContain('No hemos podido cargar la programación');
    expect(render(<EventosGaleria brandName="Sala Rodrigo" events={[]} loadError={false} />)).toContain('Todavía no hay fechas publicadas');
  });
});

describe('imágenes de Blob con la optimización activa (BLOB_PUBLIC_HOST)', () => {
  const blob = `https://${BLOB_PUBLIC_HOST}/t1/events/e1/cartel.jpg`;
  const hero = { badge: '', title: 'Sala Rodrigo', subtitle: 'Música en directo', primaryCta: null };

  it('el cartel del héroe pide variantes de /_next/image, mantiene la prioridad y el texto alternativo', () => {
    const html = withBlobHost(() => render(<GaleriaHero brandName="Sala Rodrigo" hero={hero} featured={toTemplateEvent(event({ imageUrl: blob }))} />));
    expectOptimized(html, blob);
    expect(attr(html, 'sizes')).toBe('(min-width:1400px) 640px, (min-width:768px) 50vw, 100vw');
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('alt="Cartel de Noche de Verano"');
  });

  it('las entradas optimizan solo las fotos del store y siguen siendo perezosas', () => {
    const rows = [toTemplateEvent(event({ imageUrl: blob })), toTemplateEvent(event({ id: 'e2', slug: 'otra', name: 'Otra' }))];
    const html = withBlobHost(() => render(<EventEntries events={rows} />));
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html.match(/srcSet=/g)).toHaveLength(1);
    expect(html).toContain('src="https://example.com/cartel.jpg"');
    expect(html.match(/loading="lazy"/g)).toHaveLength(2);
  });

  it('sin la variable el src es el original', () => {
    const html = withBlobHost(() => render(<GaleriaHero brandName="Sala Rodrigo" hero={hero} featured={toTemplateEvent(event({ imageUrl: blob }))} />), null);
    expect(html).toContain(`src="${blob}"`);
    expect(html).not.toContain('srcSet');
  });
});
