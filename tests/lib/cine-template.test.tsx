import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_CATALOG, TEMPLATES, TEMPLATE_LABELS, TEMPLATE_PRESETS, isBrandVideoUrl, parseTheme } from '@/lib/brand/theme';
import { HERO_VIDEO_MAX_BYTES, heroVideoBlobPrefix, heroVideoFileProblem, isHeroVideoPath } from '@/lib/brand/hero-video';
import { toTemplateEvent, type EventInput } from '@/app/(public)/_home/event-view';
import { CineHero, HomeCine, type HomeCineProps } from '@/app/(public)/_home/cine/home-cine';
import { EventosCine } from '@/app/(public)/_home/cine/eventos-cine';
import { CineCard, CineRail } from '@/app/(public)/_home/cine/event-card';
import { HeroMedia } from '@/app/(public)/_home/cine/hero-media';
import { CineTransitions, posterTransitionName } from '@/app/(public)/_home/cine/transitions';
import { ContentSections } from '@/app/(public)/_home/sections/content-sections';
import { PageBanner } from '@/app/(public)/_templates/page-banner';
import { parseSection } from '@/lib/content/sections';

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const BLOB = 'https://abc123.public.blob.vercel-storage.com';
const VIDEO = `${BLOB}/t1/brand/hero/abc-hero.mp4`;
const POSTER = `${BLOB}/t1/brand/abc-poster.jpg`;

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

describe('plantilla «cine» — catálogo y recursos', () => {
  it('está en el catálogo, con etiqueta y sugerencia de ajustes válida', () => {
    expect(TEMPLATES).toContain('cine');
    expect(TEMPLATE_LABELS.cine.label).toBe('Cine');
    const preset = TEMPLATE_PRESETS.cine!;
    expect(preset.mode).toBe('dark');
    expect(FONT_CATALOG[preset.fonts.display].roles).toContain('display');
    expect(FONT_CATALOG[preset.fonts.body].roles).toContain('body');
  });

  it('un tema con vídeo y póster de cabecera es válido; los temas sin ellos también', () => {
    const base = { v: 1, template: 'cine', colors: { primary: '#1d4ed8', accent: '#f59e0b' }, brand: { name: 'Sala Rodrigo' } };
    const t = parseTheme({ ...base, assets: { heroVideo: VIDEO, heroPoster: POSTER } });
    expect(t?.assets.heroVideo).toBe(VIDEO);
    expect(t?.assets.heroPoster).toBe(POSTER);
    expect(parseTheme(base)?.assets.heroVideo).toBeUndefined();
  });

  it('el vídeo solo puede ser un MP4 o WebM de Blob: nada de otros sitios, formatos ni rutas locales', () => {
    expect(isBrandVideoUrl(VIDEO)).toBe(true);
    expect(isBrandVideoUrl(`${BLOB}/t1/brand/hero/clip.WEBM`)).toBe(true);
    for (const bad of ['https://otro-sitio.com/hero.mp4', `${BLOB}/t1/brand/hero/clip.mov`, `${BLOB}/t1/brand/hero/clip.mp4?x=1`, 'http://abc123.public.blob.vercel-storage.com/a.mp4', '/brand/hero.mp4', 'javascript:alert(1)', `${BLOB}/t1/hero.mp4.exe`]) {
      expect(isBrandVideoUrl(bad), bad).toBe(false);
    }
    const t = parseTheme({ v: 1, template: 'cine', colors: { primary: '#1d4ed8', accent: '#f59e0b' }, brand: { name: 'X' }, assets: { heroVideo: 'https://otro-sitio.com/hero.mp4' } });
    expect(t).toBeNull();
  });
});

describe('reglas de subida del vídeo', () => {
  it('la ruta debe estar en la carpeta del cliente y acabar en .mp4 o .webm', () => {
    expect(heroVideoBlobPrefix('t1/')).toBe('t1/brand/hero/');
    expect(isHeroVideoPath('t1/brand/hero/a.mp4', 't1/')).toBe(true);
    expect(isHeroVideoPath('brand/hero/a.webm', '')).toBe(true);
    expect(isHeroVideoPath('t2/brand/hero/a.mp4', 't1/')).toBe(false); // otro cliente
    expect(isHeroVideoPath('brand/hero/a.mp4', 't1/')).toBe(false); // sin prefijo
    expect(isHeroVideoPath('t1/brand/hero/../../otro/a.mp4', 't1/')).toBe(false);
    expect(isHeroVideoPath('t1/brand/hero/a.exe', 't1/')).toBe(false);
    expect(isHeroVideoPath('t1/brand/logo/a.mp4', 't1/')).toBe(false);
  });

  it('el fichero elegido debe ser MP4 o WebM y no pasar del máximo', () => {
    expect(heroVideoFileProblem({ type: 'video/mp4', size: 1000 })).toBeNull();
    expect(heroVideoFileProblem({ type: 'video/webm', size: HERO_VIDEO_MAX_BYTES })).toBeNull();
    expect(heroVideoFileProblem({ type: 'video/quicktime', size: 1000 })).toMatch(/MP4 o WebM/);
    expect(heroVideoFileProblem({ type: 'video/mp4', size: HERO_VIDEO_MAX_BYTES + 1 })).toMatch(/pesa demasiado/);
  });
});

describe('transición del cartel', () => {
  it('el nombre es un identificador CSS válido y el mismo para la misma tarjeta', () => {
    expect(posterTransitionName('noche-de-verano')).toBe('cn-poster-noche-de-verano');
    expect(posterTransitionName('2026 Fiesta/Ñ!')).toMatch(/^cn-poster-[a-z0-9_-]+$/);
    expect(posterTransitionName('a')).not.toBe(posterTransitionName('b'));
  });

  it('la regla de transición entre páginas solo se emite en las páginas de «cine»', () => {
    expect(render(<CineTransitions />)).toContain('@view-transition{navigation:auto}');
    expect(render(<CineTransitions />)).toContain('prefers-reduced-motion');
    expect(render(<ContentSections template="feria" slot="before-about" />)).not.toContain('view-transition');
  });
});

describe('HeroMedia', () => {
  it('en el HTML del servidor no pide el vídeo (sin src, sin precarga) y el póster es una imagen prioritaria', () => {
    const html = render(<HeroMedia video={VIDEO} poster={POSTER} />);
    expect(html).not.toContain(VIDEO);
    expect(html).toContain('preload="none"');
    expect(html).toContain(`src="${POSTER}"`);
    expect(html).toContain('fetchPriority="high"');
    expect(html).not.toContain('<button'); // el botón de pausa solo existe cuando el vídeo se reproduce
  });

  it('sin vídeo no hay elemento de vídeo; sin nada solo queda el contenedor', () => {
    expect(render(<HeroMedia video={null} poster={POSTER} />)).not.toContain('<video');
    expect(render(<HeroMedia video={null} poster={null} />)).not.toContain('<img');
  });
});

describe('CineHero', () => {
  const hero = { badge: '', title: 'Sala Rodrigo', subtitle: 'Música en directo', primaryCta: { href: '/eventos', label: 'Ver eventos', icon: 'ticket' as const } };

  it('con evento destacado: su nombre es el único h1 y el botón lleva a comprar', () => {
    const html = render(<CineHero brandName="Sala Rodrigo" hero={hero} featured={toTemplateEvent(event())} media={{ video: VIDEO, poster: POSTER }} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])).toBe('Noche de Verano');
    expect(html).toContain('href="/eventos/noche-de-verano/comprar"');
    expect(html).toContain('desde 15.00€');
    expect(html).toContain('data-bare="false"');
  });

  it('sin evento: titular de la marca, frase y el botón de la página; sin vídeo ni póster, cabecera «desnuda»', () => {
    const html = render(<CineHero brandName="Sala Rodrigo" hero={hero} featured={null} />);
    expect(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])).toBe('Sala Rodrigo');
    expect(html).toContain('Música en directo');
    expect(html).toContain('href="/eventos"');
    expect(html).not.toContain('Comprar entradas');
    expect(html).toContain('data-bare="true"');
  });
});

describe('CineCard y CineRail', () => {
  it('la tarjeta es un enlace normal (para la View Transition) con el cartel nombrado por el evento', () => {
    const html = render(<CineCard event={toTemplateEvent(event())} />);
    expect(html).toMatch(/^<a href="\/eventos\/noche-de-verano" class="cn-card">/);
    expect(html).toContain('view-transition-name:cn-poster-noche-de-verano');
    expect(html).toContain('desde 15.00€');
  });

  it('sin cartel muestra el nombre sobre un bloque de color; con aforo agotado, la etiqueta de estado', () => {
    const html = render(<CineCard event={toTemplateEvent(event({ imageUrl: null, maxCapacity: 100, currentCount: 100 }))} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('cn-poster-blank');
    expect(html).toContain('Sin plazas online');
  });

  it('el riel es una región con nombre, enfocable, y una lista de tarjetas; solo las primeras se piden con prioridad', () => {
    const events = [1, 2, 3].map((n) => toTemplateEvent(event({ id: `e${n}`, slug: `ev-${n}`, name: `Evento ${n}` })));
    const html = render(<CineRail events={events} id="riel" label="Cartelera de eventos" />);
    expect(html).toMatch(/id="riel" class="cn-rail" role="region" aria-label="Cartelera de eventos" tabindex="0"/);
    expect(html.match(/<li class="cn-rail-item"/g)).toHaveLength(3);
    expect(html.match(/loading="eager"/g)).toHaveLength(2);
    expect(html.match(/loading="lazy"/g)).toHaveLength(1);
  });
});

describe('HomeCine', () => {
  const sec = (kind: 'servicios' | 'faq', items: Record<string, unknown>[]) => parseSection(JSON.stringify({ items }), kind);
  const base: HomeCineProps = {
    brandName: 'Sala Rodrigo',
    hero: { badge: '', title: 'Sala Rodrigo', subtitle: '', primaryCta: null },
    events: [toTemplateEvent(event()), toTemplateEvent(event({ id: 'e2', slug: 'otra', name: 'Otra noche' }))],
    loadError: false,
    hasEntradas: true,
    hasTienda: true,
    hasSponsors: true,
    contactEnabled: false,
    sections: { servicios: sec('servicios', [{ title: 'Alquiler de sala' }]), faq: sec('faq', [{ title: '¿Hay guardarropa?', text: 'Sí.' }]) },
    copy: { shopTitle: 'Merch', shopSubtitle: '', aboutTitle: '', aboutText: 'Una sala con historia.', sponsorsTitle: '', sponsorsSubtitle: '' },
  };
  const ids = (html: string) => [...html.matchAll(/<section[^>]*id="([^"]+)"/g)].map((m) => m[1]);

  it('con todo: cabecera, cartelera con flechas, tienda, servicios, sobre nosotros, preguntas y patrocinio', () => {
    const html = render(<HomeCine {...base} />);
    expect(ids(html)).toEqual(['cartelera', 'servicios', 'sobre-nosotros', 'preguntas-frecuentes']);
    expect(html).toContain('@view-transition');
    expect(html).toContain('href="/tienda"');
    expect(html).toContain('href="/sponsors"');
    expect(html).toContain('Una sala con historia.');
  });

  it('sin Entradas, Tienda ni Sponsors no hay cartelera ni enlaces a esos módulos', () => {
    const html = render(<HomeCine {...base} hasEntradas={false} hasTienda={false} hasSponsors={false} events={[]} />);
    expect(ids(html)).not.toContain('cartelera');
    expect(html).not.toContain('/eventos/');
    expect(html).not.toContain('href="/tienda"');
    expect(html).not.toContain('href="/sponsors"');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('error de carga y lista vacía se distinguen', () => {
    expect(render(<HomeCine {...base} events={[]} loadError />)).toContain('No hemos podido cargar los eventos');
    const vacio = render(<HomeCine {...base} events={[]} />);
    expect(vacio).toContain('Aún no hay eventos publicados');
    expect(vacio).not.toContain('No hemos podido cargar');
  });
});

describe('/eventos y cabecera interior con «cine»', () => {
  it('/eventos: rejilla de carteles y estados de error y vacío', () => {
    const lleno = render(<EventosCine brandName="Sala" events={[toTemplateEvent(event())]} loadError={false} />);
    expect(lleno).toContain('Noche de Verano');
    expect(lleno).toContain('@view-transition');
    expect(render(<EventosCine brandName="Sala" events={[]} loadError />)).toContain('No hemos podido cargar la cartelera');
    expect(render(<EventosCine brandName="Sala" events={[]} loadError={false} />)).toContain('Todavía no hay fechas publicadas');
  });

  it('la ficha lleva el cartel con el MISMO nombre de transición que su tarjeta (así crece de una a otra)', () => {
    const card = render(<CineCard event={toTemplateEvent(event())} />);
    const banner = render(<PageBanner template="cine" brandName="Sala" title="Noche de Verano" seed="noche-de-verano" imageUrl="https://example.com/cartel.jpg" facts={[{ label: 'Fecha', value: 'Sábado' }]} />);
    const name = 'view-transition-name:cn-poster-noche-de-verano';
    expect(card).toContain(name);
    expect(banner).toContain(name);
    expect(banner.match(/<h1/g)).toHaveLength(1);
    expect(banner).toContain('alt="Cartel de Noche de Verano"');
    expect(banner).toContain('<dl');
  });

  it('en versión baja (legales) no hay cartel ni nombre de transición', () => {
    const html = render(<PageBanner template="cine" brandName="Sala" title="Aviso legal" seed="aviso" imageUrl="https://example.com/c.jpg" compact />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('view-transition-name');
    expect(html).toContain('data-size="s"');
  });
});
