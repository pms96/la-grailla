import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TEMPLATES } from '@/lib/brand/theme';
import { parseSection, type ContentSection, type SectionKind } from '@/lib/content/sections';
import { ContentSections, sectionAnchors, type SectionsData, type SectionSlot } from '@/app/(public)/_home/sections/content-sections';
import { attr, expectOptimized, withBlobHost } from '../helpers/blob-host';

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);

const BLOB = 'https://abc123.public.blob.vercel-storage.com/t1/sections/foto.jpg';
const section = (kind: SectionKind, items: Record<string, unknown>[], extra: Record<string, unknown> = {}): ContentSection =>
  parseSection(JSON.stringify({ title: '', intro: '', items, ...extra }), kind);

const sample: SectionsData = {
  servicios: section('servicios', [
    { title: 'Diseño web', text: 'Sitios a medida.', meta: 'Desde 300 €', href: 'https://ejemplo.es/diseno' },
    { title: 'Mantenimiento', text: 'Cuidamos tu web.', href: '/contacto' },
  ]),
  proyectos: section('proyectos', [
    { title: 'Web de una cooperativa', text: 'Rediseño completo.', meta: 'Cooperativa · 2025', imageUrl: BLOB },
    { title: 'Tienda de ceramica', text: '' },
  ]),
  equipo: section('equipo', [
    { title: 'Ana López', meta: 'Dirección', text: 'Lleva el estudio.' },
    { title: 'Biel Serra', meta: 'Desarrollo', imageUrl: BLOB },
  ]),
  faq: section('faq', [
    { title: '¿Cuánto tarda un proyecto?', text: 'Entre cuatro y ocho semanas.' },
    { title: '¿Trabajáis con empresas pequeñas?', text: 'Sí.' },
  ]),
};

const all = (template: (typeof TEMPLATES)[number], sections: SectionsData = sample) =>
  (['before-about', 'after-about'] as SectionSlot[]).map((slot) => render(<ContentSections template={template} sections={sections} slot={slot} />)).join('');

describe('ContentSections: lo que no hay no se pinta', () => {
  it('sin secciones, o con secciones sin elementos, no pinta nada en ninguna plantilla', () => {
    for (const t of TEMPLATES) {
      expect(all(t, {})).toBe('');
      expect(all(t, { servicios: section('servicios', [], { title: 'Servicios' }), faq: section('faq', []) })).toBe('');
    }
    expect(render(<ContentSections template="feria" slot="before-about" />)).toBe('');
  });

  it('cada tramo pinta solo sus secciones: servicios y proyectos antes de «Sobre nosotros», equipo y preguntas después', () => {
    const before = render(<ContentSections template="feria" sections={sample} slot="before-about" />);
    const after = render(<ContentSections template="feria" sections={sample} slot="after-about" />);
    expect(before).toContain('id="servicios"');
    expect(before).toContain('id="proyectos"');
    expect(before).not.toContain('id="equipo"');
    expect(after).toContain('id="equipo"');
    expect(after).toContain('id="preguntas-frecuentes"');
    expect(after).not.toContain('id="servicios"');
  });
});

describe('ContentSections: el contenido sale en todas las plantillas', () => {
  it.each(TEMPLATES)('«%s»: títulos, elementos y un solo h2 por sección', (t) => {
    const html = all(t);
    expect(html.match(/<h2/g)).toHaveLength(4);
    for (const text of ['Diseño web', 'Sitios a medida.', 'Desde 300 €', 'Web de una cooperativa', 'Cooperativa · 2025', 'Ana López', 'Dirección', '¿Cuánto tarda un proyecto?', 'Entre cuatro y ocho semanas.']) {
      expect(html, text).toContain(text);
    }
    // Cada sección se nombra a sí misma para los lectores de pantalla.
    expect(html).toMatch(/aria-labelledby="servicios-titulo"/);
    expect(html).toMatch(/<h2 id="preguntas-frecuentes-titulo"/);
  });

  it('el título y la introducción los pone el cliente; sin título, uno neutro', () => {
    const html = render(
      <ContentSections
        template="feria"
        slot="before-about"
        sections={{ servicios: section('servicios', [{ title: 'Diseño' }], { title: 'Qué hacemos', intro: 'Tres cosas bien hechas.' }), proyectos: section('proyectos', [{ title: 'Uno' }]) }}
      />
    );
    expect(html).toContain('Qué hacemos');
    expect(html).toContain('Tres cosas bien hechas.');
    expect(html).toMatch(/<h2 id="proyectos-titulo"[^>]*>Proyectos<\/h2>/);
  });

  it('cada plantilla usa su propia tipografía de titulares', () => {
    expect(all('marquesina')).toContain('uppercase');
    expect(all('galeria')).toContain('gl-serif');
    expect(all('tipo')).toContain('tp-heading');
    expect(all('feria')).toContain('font-display');
  });
});

describe('ContentSections: enlaces e imágenes', () => {
  it('un enlace externo se abre en otra pestaña y lo dice a lectores de pantalla; uno interno, no', () => {
    const html = all('feria');
    expect(html).toMatch(/<a href="https:\/\/ejemplo\.es\/diseno" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('(se abre en otra pestaña)');
    expect(html).toMatch(/<a href="\/contacto" class=/);
    expect(html.match(/\(se abre en otra pestaña\)/g)).toHaveLength(1);
  });

  it('un enlace peligroso no llega a la web: se descarta al leer y el título queda sin enlace', () => {
    const html = render(<ContentSections template="feria" slot="before-about" sections={{ servicios: section('servicios', [{ title: 'Diseño', href: 'javascript:alert(1)' }]) }} />);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('Diseño');
  });

  it('el texto del cliente se escapa: no se puede colar HTML', () => {
    const html = render(<ContentSections template="feria" slot="before-about" sections={{ servicios: section('servicios', [{ title: '<script>alert(1)</script>', text: '<img src=x onerror=alert(1)>' }]) }} />);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('las imágenes son perezosas y de Blob; sin imagen, nada (y en «tipo», una composición generada)', () => {
    const feria = render(<ContentSections template="feria" slot="before-about" sections={{ proyectos: sample.proyectos }} />);
    expect(feria.match(/<img /g)).toHaveLength(1);
    expect(feria).toContain(`src="${BLOB}"`);
    expect(feria).toContain('loading="lazy"');
    expect(feria).not.toContain('tp-composition');
    const tipo = render(<ContentSections template="tipo" slot="before-about" sections={{ proyectos: sample.proyectos }} />);
    expect(tipo.match(/<img /g)).toHaveLength(1);
    expect(tipo.match(/tp-composition/g)).toHaveLength(1); // el proyecto sin imagen lleva su composición
  });

  it('si nadie ha subido imágenes, las tarjetas son solo de texto (sin marcos vacíos); en «tipo» siguen las formas generadas', () => {
    const sinFotos: SectionsData = {
      proyectos: section('proyectos', [{ title: 'Cerámica Rovira', text: 'Tienda online.' }, { title: 'Festival de cine', text: 'Entradas.' }]),
      equipo: section('equipo', [{ title: 'Ana López', meta: 'Dirección' }, { title: 'Biel Serra', meta: 'Desarrollo' }]),
    };
    for (const slot of ['before-about', 'after-about'] as const) {
      const feria = render(<ContentSections template="feria" slot={slot} sections={sinFotos} />);
      expect(feria).not.toContain('aspect-');
      expect(feria).not.toContain('<img ');
    }
    const tipo = all('tipo', sinFotos);
    expect(tipo.match(/tp-composition/g)).toHaveLength(4);
  });

  it('con fotos en unos y no en otros, quien no la tiene lleva sus iniciales (no un hueco)', () => {
    const html = render(<ContentSections template="feria" slot="before-about" sections={{ proyectos: sample.proyectos }} />);
    expect(html).toContain('>TD<'); // «Tienda de ceramica» no tiene imagen
    expect(html).not.toContain('>WD<'); // «Web de una cooperativa» sí: se ve su imagen, no sus iniciales
    expect(html.match(/<img /g)).toHaveLength(1);
  });

  it('el equipo sin foto muestra sus iniciales', () => {
    const html = render(<ContentSections template="feria" slot="after-about" sections={{ equipo: sample.equipo }} />);
    expect(html).toContain('>AL<');
    expect(html.match(/<img /g)).toHaveLength(1); // solo Biel tiene foto
  });
});

describe('ContentSections: preguntas frecuentes', () => {
  it('usa <details> nativo: las respuestas están en el HTML y la pregunta es un encabezado', () => {
    const html = render(<ContentSections template="galeria" slot="after-about" sections={{ faq: sample.faq }} />);
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html.match(/<summary/g)).toHaveLength(2);
    expect(html).toMatch(/<summary[^>]*><h3[^>]*>¿Cuánto tarda un proyecto\?<\/h3>/);
    expect(html).toContain('Entre cuatro y ocho semanas.');
    expect(html).not.toMatch(/<details[^>]* open/); // empiezan cerradas
  });
});

describe('sectionAnchors: enlaces del menú', () => {
  it('solo las secciones con contenido, en el orden de la portada y con su título', () => {
    expect(sectionAnchors({})).toEqual([]);
    expect(sectionAnchors({ faq: section('faq', [{ title: 'P' }]), servicios: section('servicios', [{ title: 'S' }], { title: 'Qué hacemos' }), equipo: section('equipo', []) })).toEqual([
      { href: '/#servicios', label: 'Qué hacemos' },
      { href: '/#preguntas-frecuentes', label: 'Preguntas frecuentes' },
    ]);
  });
});

describe('imágenes de Blob con la optimización activa (BLOB_PUBLIC_HOST)', () => {
  it('las miniaturas piden variantes de /_next/image con la URL original codificada, sin perder clases ni loading', () => {
    const html = withBlobHost(() => render(<ContentSections template="feria" slot="before-about" sections={{ proyectos: sample.proyectos }} />));
    expect(html.match(/<img /g)).toHaveLength(1);
    expectOptimized(html, BLOB);
    expect(attr(html, 'sizes')).toBe('(min-width:1024px) 33vw, (min-width:640px) 50vw, 100vw');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('class="h-full w-full object-cover"');
  });

  it('el equipo usa su rejilla de 2 / 4 columnas', () => {
    const html = withBlobHost(() => render(<ContentSections template="feria" slot="after-about" sections={{ equipo: sample.equipo }} />));
    expectOptimized(html, BLOB);
    expect(attr(html, 'sizes')).toBe('(min-width:1024px) 25vw, 50vw');
  });

  it('sin la variable el src sigue siendo el original', () => {
    const html = withBlobHost(() => render(<ContentSections template="feria" slot="before-about" sections={{ proyectos: sample.proyectos }} />), null);
    expect(html).toContain(`src="${BLOB}"`);
    expect(html).not.toContain('srcSet');
  });
});
