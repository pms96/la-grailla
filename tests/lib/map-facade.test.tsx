import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MapFacade, mapEmbedUrl } from '@/app/(public)/eventos/[slug]/_components/map-facade';

const require = createRequire(import.meta.url);
// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí (igual que drop-template.test).
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);

describe('MapFacade (ficha de evento)', () => {
  const html = render(<MapFacade query="Sala Apolo, Carrer Nou de la Rambla 113, Barcelona" venue="Sala Apolo" />);

  it('no incluye el iframe de Google al cargar: nada de scripts de terceros hasta que el visitante lo pide', () => {
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('google.com');
  });

  it('ofrece un botón claro y avisa de que el mapa viene de Google', () => {
    expect(html).toContain('Ver mapa');
    expect(html).toContain('Google Maps');
    expect(html).toContain('type="button"');
  });

  it('reserva el mismo alto que el iframe (320 px) para no desplazar el contenido', () => {
    expect(html).toContain('h-80');
  });
});

describe('mapEmbedUrl', () => {
  it('codifica la consulta y pide la vista embebida', () => {
    const url = new URL(mapEmbedUrl('Sala Apolo & Cía, Barcelona'));
    expect(url.origin + url.pathname).toBe('https://maps.google.com/maps');
    expect(url.searchParams.get('q')).toBe('Sala Apolo & Cía, Barcelona');
    expect(url.searchParams.get('output')).toBe('embed');
  });
});

describe('next.config.js: htmlLimitedBots', () => {
  // Con Next 15 los metadatos se transmiten en streaming a los agentes «no limitados» y acaban al final del <body>; el CDN guarda una sola
  // variante por URL. El patrón tiene que cubrir a cualquier agente para que los metadatos vayan siempre en el <head>.
  const config = require('../../next.config.js');

  it.each([
    ['Chrome de escritorio', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'],
    ['Safari de iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'],
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['WhatsApp', 'WhatsApp/2.23.20.0'],
  ])('trata como limitado a %s', (_name, ua) => {
    expect(config.htmlLimitedBots).toBeInstanceOf(RegExp);
    expect(config.htmlLimitedBots.test(ua)).toBe(true);
  });
});
