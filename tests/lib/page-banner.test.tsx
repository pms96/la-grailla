import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Brand } from '@/lib/brand/brand';
import { TEMPLATES } from '@/lib/brand/theme';
import { BANNER_TEMPLATES, PageBanner, hasBanner, type PageBannerProps } from '@/app/(public)/_templates/page-banner';
import { LegalShell } from '@/app/(public)/_templates/legal-shell';

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const h1 = (html: string) => html.match(/<h1[\s\S]*?<\/h1>/)![0];

const facts = [
  { label: 'Fecha', value: 'Sábado, 14 de noviembre' },
  { label: 'Lugar', value: 'Sala Rodrigo, Valencia' },
];
const base = (template: PageBannerProps['template'], over: Partial<PageBannerProps> = {}): PageBannerProps => ({
  template,
  brandName: 'Sala Rodrigo',
  title: 'Noche de Verano',
  facts,
  imageUrl: 'https://example.com/cartel.jpg',
  ...over,
});

describe('hasBanner', () => {
  it('solo las plantillas nuevas tienen cabecera propia; Feria y Editorial conservan la de cada página', () => {
    expect(BANNER_TEMPLATES).toEqual(['marquesina', 'galeria', 'tipo', 'estudio']);
    expect(hasBanner('feria')).toBe(false);
    expect(hasBanner('editorial')).toBe(false);
    for (const t of BANNER_TEMPLATES) expect(hasBanner(t)).toBe(true);
  });

  it('toda plantilla del catálogo está decidida: o tiene cabecera o es una de las dos clásicas', () => {
    const classic = ['feria', 'editorial'];
    for (const t of TEMPLATES) expect(hasBanner(t) || classic.includes(t), `plantilla sin decidir: ${t}`).toBe(true);
  });
});

describe('PageBanner — común a las tres plantillas', () => {
  for (const template of BANNER_TEMPLATES) {
    describe(template, () => {
      it('un único h1 con el título completo, y el nombre de la marca como rótulo por defecto', () => {
        const html = render(<PageBanner {...base(template)} />);
        expect(html.match(/<h1/g)).toHaveLength(1);
        expect(text(h1(html))).toBe('Noche de Verano');
        expect(html).toContain('Sala Rodrigo');
      });

      it('los datos clave salen con su etiqueta accesible', () => {
        const html = render(<PageBanner {...base(template)} />);
        expect(html).toContain('Sábado, 14 de noviembre');
        expect(html).toContain('Sala Rodrigo, Valencia');
        expect(html).toContain('Fecha');
        expect(html).toContain('Lugar');
      });

      it('la versión compacta no lleva imagen ni composición, solo título (textos legales)', () => {
        const html = render(<PageBanner {...base(template, { compact: true, facts: [], eyebrow: 'Legal' })} />);
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<svg');
        expect(html).not.toContain('marquee');
        expect(html).toContain('Legal');
        expect(html).toContain('data-size="s"');
      });

      it('sin datos ni imagen no pinta listas vacías', () => {
        const html = render(<PageBanner {...base(template, { facts: [], imageUrl: null })} />);
        expect(html).not.toContain('<ul');
        expect(html).not.toContain('<dl');
      });
    });
  }
});

describe('PageBanner — lo propio de cada plantilla', () => {
  it('marquesina: cartel enmarcado con texto alternativo, y cinta con los datos', () => {
    const html = render(<PageBanner {...base('marquesina')} />);
    expect(html).toContain('alt="Cartel de Noche de Verano"');
    expect(html).toContain('mq-band');
    expect(html).toContain('mq-title');
  });

  it('galería: foto con revelado en la cabecera, datos en lista de definiciones y cursiva solo si la fuente la tiene', () => {
    const html = render(<PageBanner {...base('galeria')} />);
    expect(html).toContain('data-hero');
    expect(html).toContain('alt="Cartel de Noche de Verano"');
    expect(html).toContain('<dl');
    expect(h1(html)).not.toContain('<em>');
    expect(h1(render(<PageBanner {...base('galeria', { italicAccent: true })} />))).toContain('<em>Verano</em>');
  });

  it('tipo: nunca usa la foto, pone una composición generada propia del título', () => {
    const html = render(<PageBanner {...base('tipo')} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('cartel.jpg');
    expect(html).toContain('tp-composition');
    expect(html).toContain('tp-hero');
    // La composición depende de la semilla: dos eventos distintos no comparten dibujo, y el mismo siempre es igual.
    const svg = (s: string) => render(<PageBanner {...base('tipo', { seed: s })} />).match(/<svg[\s\S]*?<\/svg>/)![0];
    expect(svg('uno')).toBe(svg('uno'));
    expect(svg('uno')).not.toBe(svg('dos'));
  });

  it('ninguna cabecera lleva texto ni estilo fijo de La Grailla', () => {
    for (const t of BANNER_TEMPLATES) {
      const html = render(<PageBanner {...base(t)} />);
      expect(html).not.toMatch(/caseta|Noches que no se pierden|PROGRAMACI|brand-sticker|hero-gradient/i);
    }
  });
});

describe('LegalShell', () => {
  const brand = (template: Brand['template']) => ({ template, name: 'Sala Rodrigo', theme: null }) as unknown as Brand;

  it('Feria y Editorial: el mismo marcado de siempre (h1 con font-display y contenido centrado)', () => {
    for (const t of ['feria', 'editorial'] as const) {
      const html = render(<LegalShell title="Aviso legal" brand={brand(t)}><p>Texto legal</p></LegalShell>);
      expect(html).toContain('font-display text-3xl md:text-4xl font-bold tracking-tight');
      expect(html).toContain('max-w-3xl mx-auto');
      expect(html).toContain('Texto legal');
      expect(html).not.toContain('mq-title');
      expect(html).not.toContain('gl-title');
      expect(html).not.toContain('tp-title');
    }
  });

  it('plantillas nuevas: cabecera compacta con el título y el texto legal debajo', () => {
    for (const t of BANNER_TEMPLATES) {
      const html = render(<LegalShell title="Aviso legal" brand={brand(t)}><p>Texto legal</p></LegalShell>);
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(text(h1(html))).toBe('Aviso legal');
      expect(html).toContain('Legal');
      expect(html).toContain('Texto legal');
      expect(html.indexOf('</h1>')).toBeLessThan(html.indexOf('Texto legal'));
    }
  });
});
