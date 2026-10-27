import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_CATALOG, TEMPLATES, TEMPLATE_LABELS, TEMPLATE_PRESETS, parseTheme } from '@/lib/brand/theme';
import { titleSize, toTemplateEvent, type EventInput } from '@/app/(public)/_home/event-view';
import { EventRows } from '@/app/(public)/_home/marquesina/event-rows';
import { HomeMarquesina, MarquesinaHero, type HomeMarquesinaProps } from '@/app/(public)/_home/marquesina/home-marquesina';
import { Marquee } from '@/components/ui/marquee';
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
  ticketTypes: [{ price: 15, maxQuantity: 500, soldCount: 100 }],
  ...over,
});

/** Texto visible de un fragmento de HTML (sin etiquetas, con los espacios colapsados). */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('plantilla «marquesina» — catálogo', () => {
  it('está en el catálogo, con etiqueta y sugerencia de ajustes válida', () => {
    expect(TEMPLATES).toContain('marquesina');
    expect(TEMPLATE_LABELS.marquesina.label).toBe('Marquesina');
    const preset = TEMPLATE_PRESETS.marquesina!;
    expect(FONT_CATALOG[preset.fonts.display].roles).toContain('display');
    expect(FONT_CATALOG[preset.fonts.body].roles).toContain('body');
  });

  it('un tema guardado con la plantilla y los ajustes sugeridos es válido', () => {
    const preset = TEMPLATE_PRESETS.marquesina!;
    const theme = parseTheme({
      v: 1,
      template: 'marquesina',
      mode: preset.mode,
      radius: preset.radius,
      colors: { primary: '#1d4ed8', accent: '#f59e0b' },
      fonts: preset.fonts,
      brand: { name: 'Sala Rodrigo' },
    });
    expect(theme?.template).toBe('marquesina');
  });
});

describe('toTemplateEvent', () => {
  it('formatea la fecha en hora de Madrid: un evento a las 00:30 no cae en el día anterior', () => {
    // 23:30 UTC del 14 = 00:30 del 15 en Madrid (horario de invierno).
    const e = toTemplateEvent(event({ date: '2026-11-14T23:30:00Z' }));
    expect(e.day).toBe('15');
    expect(e.month).toBe('nov');
    expect(e.weekday).toBe('dom');
    expect(e.longDate).toBe('domingo, 15 de noviembre');
  });

  it('junta sala y ciudad, y toma el precio del tipo de entrada más barato', () => {
    const e = toTemplateEvent(event());
    expect(e.place).toBe('Sala Rodrigo, Valencia');
    expect(e.fromPrice).toBe(15);
    expect(toTemplateEvent(event({ ticketTypes: [] })).fromPrice).toBeNull();
    expect(toTemplateEvent(event({ venue: null, city: 'Valencia' })).place).toBe('Valencia');
  });

  it('estado de venta: normal, alta demanda, sin plazas o cerrada con su texto', () => {
    expect(toTemplateEvent(event()).status).toBeNull();
    expect(toTemplateEvent(event({ ticketTypes: [{ price: 15, maxQuantity: 100, soldCount: 90 }] })).status).toBe('Alta demanda');
    expect(toTemplateEvent(event({ ticketTypes: [{ price: 15, maxQuantity: 100, soldCount: 100 }] })).status).toBe('Sin plazas online');
    expect(toTemplateEvent(event({ onlineSalesClosed: true, onlineSalesClosedLabel: 'Solo en taquilla' })).status).toBe('Solo en taquilla');
  });
});

describe('titleSize', () => {
  it('un nombre largo usa un tamaño menor para no salirse de la pantalla', () => {
    expect(titleSize('Primavera')).toBe('l');
    expect(titleSize('Noche de Verano 2026')).toBe('m');
    expect(titleSize('Festival Internacional de Música Electrónica')).toBe('s');
  });

  it('una palabra larga no se parte: manda la palabra más larga, no solo el total de letras', () => {
    // «Merchandising» son 13 letras en una sola palabra: con el tamaño «l» se saldría de su columna y la máscara la recortaría.
    expect(titleSize('Merchandising')).toBe('s');
    expect(titleSize('Programación')).toBe('m');
    expect(titleSize('Tienda')).toBe('l');
    expect(titleSize('La casa de Bernarda Alba')).toBe('m'); // 24 letras pero ninguna palabra larga
  });

  it('con una tipografía ancha (tipo) el mismo nombre necesita un tamaño menor', () => {
    expect(titleSize('Programa', true)).toBe('m');
    expect(titleSize('Programación', true)).toBe('s');
    expect(titleSize('Tienda', true)).toBe('l');
    // Nunca mayor que con una tipografía estrecha, para ninguna longitud.
    const order = { l: 0, m: 1, s: 2 } as const;
    for (const t of ['A', 'Verano', 'Noche de Verano', 'Merchandising', 'Festival Internacional de Música Electrónica', 'Superlongnombreenunapalabra']) {
      expect(order[titleSize(t, true)]).toBeGreaterThanOrEqual(order[titleSize(t)]);
    }
  });
});

describe('Marquee', () => {
  it('anuncia el texto una vez a lectores de pantalla y oculta la pista decorativa', () => {
    const html = render(<Marquee items={['Sáb 14 nov', 'Sala Rodrigo', 'Entradas']} />);
    expect(html.match(/class="sr-only"/g)).toHaveLength(1);
    expect(html).toContain('Sáb 14 nov · Sala Rodrigo · Entradas');
    expect(html).toMatch(/class="marquee-track" aria-hidden="true"/);
    // Dos grupos idénticos (el bucle desplaza -50%).
    expect(html.match(/class="marquee-group"/g)).toHaveLength(2);
  });

  it('sin textos no pinta nada', () => {
    expect(render(<Marquee items={['  ', '']} />)).toBe('');
  });
});

describe('MarquesinaHero', () => {
  const hero = { badge: '', title: 'Sala Rodrigo', subtitle: 'Música en directo', primaryCta: { href: '/eventos', label: 'Ver eventos', icon: 'ticket' as const } };

  it('con evento destacado: el nombre es el único h1 y completo, y el botón lleva a comprar', () => {
    const html = render(<MarquesinaHero brandName="Sala Rodrigo" hero={hero} featured={toTemplateEvent(event())} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])).toBe('Noche de Verano');
    expect(html).toContain('href="/eventos/noche-de-verano/comprar"');
    expect(html).toContain('sábado, 14 de noviembre');
    expect(html).toContain('desde 15.00€');
  });

  it('sin evento: titular de la marca y el botón de la página', () => {
    const html = render(<MarquesinaHero brandName="Sala Rodrigo" hero={hero} featured={null} />);
    expect(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])).toBe('Sala Rodrigo');
    expect(html).toContain('href="/eventos"');
    expect(html).not.toContain('Comprar entradas');
  });

  it('sin evento ni botón posible no pinta ningún enlace de compra', () => {
    const html = render(<MarquesinaHero brandName="Sala Rodrigo" hero={{ ...hero, primaryCta: null }} featured={null} />);
    expect(html).not.toContain('<a ');
  });
});

describe('EventRows', () => {
  it('una fila por evento, con enlace a su ficha, lugar, precio y estado', () => {
    const rows = [toTemplateEvent(event()), toTemplateEvent(event({ id: 'e2', slug: 'otra', name: 'Otra Noche', imageUrl: null, ticketTypes: [{ price: 15, maxQuantity: 100, soldCount: 100 }] }))];
    const html = render(<EventRows events={rows} />);
    expect(html.match(/class="mq-row /g)).toHaveLength(2);
    expect(html).toContain('href="/eventos/noche-de-verano"');
    expect(html).toContain('href="/eventos/otra"');
    expect(html).toContain('Sin plazas online');
    expect(html).toContain('desde 15.00€');
  });

  it('el cartel flotante empieza vacío y oculto: ningún cartel se descarga hasta pasar por su fila', () => {
    const html = render(<EventRows events={[toTemplateEvent(event())]} />);
    expect(html).toMatch(/class="mq-poster hidden md:block" data-on="false" aria-hidden="true"/);
    // La miniatura de las filas (táctil) es perezosa; el cartel grande no existe aún.
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('loading="lazy"');
  });
});

describe('HomeMarquesina — cada sección solo con su módulo', () => {
  const base: HomeMarquesinaProps = {
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

  it('con todo: programación, tienda, sobre nosotros y patrocinio', () => {
    const html = render(<HomeMarquesina {...base} />);
    expect(html).toContain('Programación');
    expect(html).toContain('href="/tienda"');
    expect(html).toContain('Merch');
    expect(html).toContain('Una sala con historia.');
    expect(html).toContain('href="/sponsors"');
  });

  it('sin Entradas, Tienda ni Sponsors solo quedan la cabecera y lo que el cliente haya escrito', () => {
    const html = render(<HomeMarquesina {...base} hasEntradas={false} hasTienda={false} hasSponsors={false} events={[]} />);
    expect(html).not.toContain('Programación');
    expect(html).not.toContain('href="/tienda"');
    expect(html).not.toContain('href="/sponsors"');
    expect(html).not.toContain('/eventos/');
    expect(html).toContain('Una sala con historia.');
  });

  it('error de carga y lista vacía se distinguen', () => {
    expect(render(<HomeMarquesina {...base} events={[]} loadError />)).toContain('No hemos podido cargar los eventos');
    const vacio = render(<HomeMarquesina {...base} events={[]} />);
    expect(vacio).toContain('Aún no hay eventos publicados');
    expect(vacio).not.toContain('No hemos podido cargar');
  });
});

describe('EventRows con la optimización de imágenes activa (BLOB_PUBLIC_HOST)', () => {
  const blob = `https://${BLOB_PUBLIC_HOST}/t1/events/e1/cartel.jpg`;

  it('la miniatura pide la variante de 96 px; las que no son del store siguen con su src', () => {
    const rows = [toTemplateEvent(event({ imageUrl: blob })), toTemplateEvent(event({ id: 'e2', slug: 'otra', name: 'Otra' }))];
    const html = withBlobHost(() => render(<EventRows events={rows} />));
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html.match(/srcSet=/g)).toHaveLength(1);
    expectOptimized(html, blob);
    expect(attr(html, 'sizes')).toBe('96px');
    expect(html).toContain('src="https://example.com/cartel.jpg"');
  });
});
