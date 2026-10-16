import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_CATALOG, TEMPLATES, TEMPLATE_LABELS, TEMPLATE_PRESETS, parseTheme } from '@/lib/brand/theme';
import { toTemplateEvent, type EventInput } from '@/app/(public)/_home/event-view';
import { Composition } from '@/app/(public)/_home/tipo/composition';
import { EventList } from '@/app/(public)/_home/tipo/event-list';
import { EventosTipo } from '@/app/(public)/_home/tipo/eventos-tipo';
import { HomeTipo, TipoHero, type HomeTipoProps } from '@/app/(public)/_home/tipo/home-tipo';
import { cellPath, composeShapes, type ShapeColor } from '@/app/(public)/_home/tipo/shapes';

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);

const event = (over: Partial<EventInput> = {}): EventInput => ({
  id: 'e1',
  slug: 'noche-de-verano',
  name: 'Noche de Verano',
  imageUrl: null,
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

describe('plantilla «tipo» — catálogo', () => {
  it('está en el catálogo con su etiqueta y una sugerencia de ajustes válida', () => {
    expect(TEMPLATES).toContain('tipo');
    expect(TEMPLATE_LABELS.tipo.label).toBe('Tipo');
    const preset = TEMPLATE_PRESETS.tipo!;
    expect(FONT_CATALOG[preset.fonts.display].roles).toContain('display');
    expect(FONT_CATALOG[preset.fonts.body].roles).toContain('body');
  });

  it('un tema guardado con la plantilla y los ajustes sugeridos es válido', () => {
    const preset = TEMPLATE_PRESETS.tipo!;
    const theme = parseTheme({
      v: 1,
      template: 'tipo',
      mode: preset.mode,
      radius: preset.radius,
      colors: { primary: '#1d4ed8', accent: '#f59e0b' },
      fonts: preset.fonts,
      brand: { name: 'Estudio Rodrigo' },
    });
    expect(theme?.template).toBe('tipo');
  });
});

describe('composeShapes — formas generadas', () => {
  it('es determinista: el mismo texto da siempre la misma composición (el HTML no cambia entre peticiones)', () => {
    expect(composeShapes('Noche de Verano', 4)).toEqual(composeShapes('Noche de Verano', 4));
  });

  it('no distingue mayúsculas ni espacios a los lados, y textos distintos dan composiciones distintas', () => {
    expect(composeShapes('  NOCHE DE VERANO ', 3)).toEqual(composeShapes('noche de verano', 3));
    const textos = ['noche-de-verano', 'sesion-vermut', 'danza-contemporanea', 'concierto-de-otono', 'los-planetas'];
    const firmas = new Set(textos.map((t) => JSON.stringify(composeShapes(t, 3))));
    expect(firmas.size).toBe(textos.length);
  });

  it('todas las celdas caen dentro de la cuadrícula y siempre hay al menos una forma', () => {
    for (const seed of ['a', 'b', 'c', 'noche', 'verano', '', ' ']) {
      for (const n of [2, 3, 4, 8]) {
        const c = composeShapes(seed, n);
        expect(c.n).toBe(n);
        expect(c.cells.length).toBeGreaterThan(0);
        for (const cell of c.cells) {
          expect(cell.col).toBeGreaterThanOrEqual(0);
          expect(cell.col).toBeLessThan(n);
          expect(cell.row).toBeGreaterThanOrEqual(0);
          expect(cell.row).toBeLessThan(n);
          expect([0, 1, 2, 3]).toContain(cell.rot);
        }
      }
    }
  });

  it('el tamaño se acota entre 2 y 8 y la paleta vacía no rompe nada', () => {
    expect(composeShapes('x', 1).n).toBe(2);
    expect(composeShapes('x', 99).n).toBe(8);
    expect(composeShapes('x', 3, []).cells.length).toBeGreaterThan(0);
  });

  it('solo usa colores de la paleta pedida', () => {
    const palette: ShapeColor[] = ['accent', 'ink'];
    for (const seed of ['uno', 'dos', 'tres', 'cuatro']) {
      for (const cell of composeShapes(seed, 5, palette).cells) {
        expect(palette).toContain(cell.color);
        expect(palette).toContain(cell.hole);
      }
    }
  });

  it('cellPath da trazado para cuarto, semicírculo y triángulo, y null para el resto; siempre dentro de 0-100', () => {
    const base = { col: 1, row: 2, rot: 0 as const, color: 'primary' as const, hole: 'ink' as const };
    for (const kind of ['quarter', 'half', 'triangle'] as const) {
      const d = cellPath({ ...base, kind }, 4)!;
      expect(d).toMatch(/^M/);
      const nums = [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
      // Los radios y las banderas del arco también son números: se comprueba solo que nada se sale de la cuadrícula.
      expect(Math.max(...nums)).toBeLessThanOrEqual(100);
      expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
    }
    for (const kind of ['circle', 'ring', 'square'] as const) expect(cellPath({ ...base, kind }, 4)).toBeNull();
  });
});

describe('Composition (SVG)', () => {
  it('es decorativa: oculta a lectores de pantalla y sin enfoque', () => {
    const html = render(<Composition seed="noche" n={3} />);
    expect(html).toMatch(/^<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('focusable="false"');
  });

  it('los colores son tokens del tema, nunca colores fijos', () => {
    const html = render(<Composition seed="noche" n={5} palette={['primary', 'accent', 'ink', 'paper', 'onPrimary']} />);
    expect(html).toContain('hsl(var(--');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(html).not.toMatch(/rgb\(/);
  });

  it('el mismo texto da el mismo SVG (sin aleatoriedad en el servidor)', () => {
    expect(render(<Composition seed="noche" n={4} />)).toBe(render(<Composition seed="noche" n={4} />));
    expect(render(<Composition seed="noche" n={4} />)).not.toBe(render(<Composition seed="otra" n={4} />));
  });

  it('con una paleta de un solo color solo aparece ese token', () => {
    const html = render(<Composition seed="x" n={4} palette={['accent']} />);
    expect(html).toContain('hsl(var(--accent))');
    expect(html).not.toContain('hsl(var(--primary))');
    expect(html).not.toContain('hsl(var(--foreground))');
  });
});

describe('TipoHero', () => {
  const hero = { badge: '', title: 'Estudio Rodrigo', subtitle: 'Diseño y eventos', primaryCta: { href: '/eventos', label: 'Ver eventos', icon: 'ticket' as const } };

  it('con evento: nombre completo en el único h1, botón de compra y una composición propia', () => {
    const html = render(<TipoHero brandName="Estudio Rodrigo" hero={hero} featured={toTemplateEvent(event())} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(h1(html))).toBe('Noche de Verano');
    expect(html).toContain('href="/eventos/noche-de-verano/comprar"');
    expect(html).toContain('desde 15.00€');
    expect(html).toContain('sábado, 14 de noviembre');
    expect(html.match(/<svg[^>]*class="tp-composition/g)).toHaveLength(1);
  });

  it('sin evento: titular de la marca y el botón de la página', () => {
    const html = render(<TipoHero brandName="Estudio Rodrigo" hero={hero} featured={null} />);
    expect(text(h1(html))).toBe('Estudio Rodrigo');
    expect(html).toContain('href="/eventos"');
    expect(html).not.toContain('Comprar entradas');
  });

  it('no usa ninguna imagen: la «foto» es la composición generada', () => {
    const html = render(<TipoHero brandName="Estudio Rodrigo" hero={hero} featured={toTemplateEvent(event({ imageUrl: 'https://example.com/cartel.jpg' }))} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('cartel.jpg');
  });
});

describe('EventList', () => {
  const rows = [toTemplateEvent(event()), toTemplateEvent(event({ id: 'e2', slug: 'otra', name: 'Otra Noche', maxCapacity: 100, currentCount: 100 }))];

  it('una fila por evento, con su enlace, el día, el lugar, el precio y el estado', () => {
    const html = render(<EventList events={rows} />);
    expect(html.match(/class="tp-row /g)).toHaveLength(2);
    expect(html).toContain('href="/eventos/noche-de-verano"');
    expect(html).toContain('href="/eventos/otra"');
    expect(html).toContain('>14<');
    expect(html).toContain('Sala Rodrigo, Valencia');
    expect(html).toContain('desde 15.00€');
    expect(html).toContain('Sin plazas online');
  });

  it('cada fila lleva su propia forma, y la de un evento es siempre la misma', () => {
    const html = render(<EventList events={rows} />);
    const svgs = html.match(/<svg[\s\S]*?<\/svg>/g)!.filter((s) => s.includes('tp-composition'));
    expect(svgs).toHaveLength(2);
    expect(svgs[0]).not.toBe(svgs[1]);
    expect(render(<EventList events={rows} />)).toBe(html);
  });
});

describe('HomeTipo y EventosTipo — cada sección solo con su módulo', () => {
  const base: HomeTipoProps = {
    brandName: 'Estudio Rodrigo',
    hero: { badge: '', title: 'Estudio Rodrigo', subtitle: '', primaryCta: null },
    events: [toTemplateEvent(event())],
    loadError: false,
    hasEntradas: true,
    hasTienda: true,
    hasSponsors: true,
    contactEnabled: false,
    copy: { shopTitle: 'Merch', shopSubtitle: '', aboutTitle: '', aboutText: 'Hacemos cosas con letras.', sponsorsTitle: '', sponsorsSubtitle: '' },
  };

  it('con todo: programa, tienda, texto propio y patrocinio', () => {
    const html = render(<HomeTipo {...base} />);
    expect(html).toContain('>Programa<');
    expect(html).toContain('href="/tienda"');
    expect(html).toContain('Merch');
    expect(html).toContain('Hacemos cosas con letras.');
    expect(html).toContain('href="/sponsors"');
  });

  it('sin Entradas, Tienda ni Sponsors no hay ni programa ni enlaces a esos módulos', () => {
    const html = render(<HomeTipo {...base} hasEntradas={false} hasTienda={false} hasSponsors={false} events={[]} />);
    expect(html).not.toContain('>Programa<');
    expect(html).not.toContain('href="/tienda"');
    expect(html).not.toContain('href="/sponsors"');
    expect(html).not.toContain('/eventos/');
    expect(html).toContain('Hacemos cosas con letras.');
  });

  it('error de carga y lista vacía se distinguen', () => {
    expect(render(<HomeTipo {...base} events={[]} loadError />)).toContain('No hemos podido cargar los eventos');
    const vacio = render(<HomeTipo {...base} events={[]} />);
    expect(vacio).toContain('Aún no hay eventos publicados');
    expect(vacio).not.toContain('No hemos podido cargar');
  });

  it('/eventos: titular, filas y los estados de error y vacío', () => {
    const ok = render(<EventosTipo brandName="Estudio Rodrigo" events={[toTemplateEvent(event())]} loadError={false} />);
    expect(text(h1(ok))).toBe('Programa completo');
    expect(ok).toContain('href="/eventos/noche-de-verano"');
    expect(render(<EventosTipo brandName="Estudio Rodrigo" events={[]} loadError />)).toContain('No hemos podido cargar la programación');
    expect(render(<EventosTipo brandName="Estudio Rodrigo" events={[]} loadError={false} />)).toContain('Todavía no hay fechas publicadas');
  });
});
