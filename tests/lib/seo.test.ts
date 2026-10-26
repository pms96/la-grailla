import { afterEach, describe, expect, it } from 'vitest';
import { absoluteUrl, safeJsonLd } from '@/lib/seo/json-ld';
import { eventJsonLd, type EventLdInput } from '@/lib/seo/event-json-ld';
import { fallbackDescription } from '@/lib/seo/description';
import { canonicalAlternates, siteBaseUrl } from '@/lib/seo/canonical';

const event = (over: Partial<EventLdInput> = {}): EventLdInput => ({
  name: 'Noche de Verano',
  slug: 'noche-de-verano',
  description: '  Una noche\n de música   en directo. ',
  venue: 'Sala Rodrigo',
  city: 'Valencia',
  address: 'Calle Mayor 1',
  imageUrl: '/uploads/cartel.jpg',
  date: '2026-11-14T20:00:00Z',
  ticketTypes: [
    { name: 'General', price: 15, maxQuantity: 100, soldCount: 10 },
    { name: 'VIP', price: 35.5, maxQuantity: 10, soldCount: 10 },
  ],
  ...over,
});

describe('absoluteUrl / safeJsonLd', () => {
  it('absoluteUrl respeta las URLs completas y cuelga las rutas de la base (sin base, las deja tal cual)', () => {
    expect(absoluteUrl('https://x.test/a.jpg', 'https://b.test')).toBe('https://x.test/a.jpg');
    expect(absoluteUrl('/uploads/a.jpg', 'https://b.test')).toBe('https://b.test/uploads/a.jpg');
    expect(absoluteUrl('/uploads/a.jpg', '')).toBe('/uploads/a.jpg');
  });

  it('safeJsonLd: un texto del cliente no puede cerrar la etiqueta <script> ni romper la línea', () => {
    const separador = String.fromCharCode(0x2028);
    const out = safeJsonLd({ name: '</script><script>alert(1)</script>', d: `a${separador}b` });
    expect(out).not.toContain('<');
    expect(out).not.toContain(separador);
    expect(JSON.parse(out).name).toBe('</script><script>alert(1)</script>');
  });
});

describe('eventJsonLd', () => {
  it('describe el evento con fecha ISO, lugar, cartel absoluto y una oferta por tipo de entrada', () => {
    const ld = eventJsonLd(event(), 'Sala Rodrigo', 'https://sala.test') as any;
    expect(ld['@type']).toBe('Event');
    expect(ld.name).toBe('Noche de Verano');
    expect(ld.startDate).toBe('2026-11-14T20:00:00.000Z');
    expect(ld.description).toBe('Una noche de música en directo.'); // espacios y saltos de línea normalizados
    expect(ld.location).toEqual({ '@type': 'Place', name: 'Sala Rodrigo', address: { '@type': 'PostalAddress', addressLocality: 'Valencia', streetAddress: 'Calle Mayor 1' } });
    expect(ld.image).toEqual(['https://sala.test/uploads/cartel.jpg']);
    expect(ld.url).toBe('https://sala.test/eventos/noche-de-verano');
    expect(ld.organizer).toEqual({ '@type': 'Organization', name: 'Sala Rodrigo' });
    expect(ld.offers).toHaveLength(2);
    expect(ld.offers[0]).toMatchObject({ name: 'General', price: '15.00', priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: 'https://sala.test/eventos/noche-de-verano/comprar' });
    expect(ld.offers[1]).toMatchObject({ price: '35.50', availability: 'https://schema.org/SoldOut' });
  });

  it('«solo en taquilla»: disponibilidad en tienda y sin enlace de compra online', () => {
    const ld = eventJsonLd(event({ onlineSalesClosed: true }), 'X', 'https://sala.test') as any;
    for (const o of ld.offers) {
      expect(o.availability).toBe('https://schema.org/InStoreOnly');
      expect(o.url).toBeUndefined();
    }
  });

  it('un evento que ya pasó no anuncia ofertas: la ficha no vende y el buscador no debe mostrar «comprar»', () => {
    const ld = eventJsonLd(event({ ended: true }), 'X', 'https://sala.test') as any;
    expect(ld['@type']).toBe('Event');
    expect(ld.startDate).toBe('2026-11-14T20:00:00.000Z');
    expect(ld.offers).toBeUndefined();
  });

  it('no inventa nada: sin descripción, dirección, cartel, entradas ni dominio, esos campos no salen', () => {
    const ld = eventJsonLd(event({ description: null, address: '', imageUrl: null, ticketTypes: [] }), 'X', '') as any;
    expect(ld.description).toBeUndefined();
    expect(ld.location.address.streetAddress).toBeUndefined();
    expect(ld.image).toBeUndefined();
    expect(ld.offers).toBeUndefined();
    expect(ld.url).toBeUndefined();
  });

  it('una fecha inválida no produce datos estructurados', () => {
    expect(eventJsonLd(event({ date: 'no es una fecha' }), 'X', '')).toBeNull();
  });

  it('un texto del cliente con </script> sale escapado al serializarlo para la página', () => {
    const html = safeJsonLd(eventJsonLd(event({ name: 'a</script><b>' }), 'X', '')!);
    expect(html).not.toContain('</script>');
    expect(JSON.parse(html).name).toBe('a</script><b>');
  });
});

describe('fallbackDescription', () => {
  it('dice solo lo que el sitio ofrece según sus módulos, con la marca delante', () => {
    expect(fallbackDescription('Sala Rodrigo', ['nucleo', 'entradas'])).toBe('Sala Rodrigo: eventos y entradas online.');
    expect(fallbackDescription('Sala Rodrigo', ['nucleo', 'entradas', 'tienda'])).toBe('Sala Rodrigo: eventos y entradas online y tienda online.');
    expect(fallbackDescription('Sala Rodrigo', ['nucleo', 'entradas', 'tienda', 'sponsors'])).toBe('Sala Rodrigo: eventos y entradas online, tienda online y patrocinio para marcas.');
  });

  it('sin nada cierto que decir, no hay descripción (mejor ninguna que una vacía)', () => {
    expect(fallbackDescription('Sala Rodrigo', ['nucleo'])).toBeUndefined();
    expect(fallbackDescription('   ', ['entradas'])).toBeUndefined();
    expect(fallbackDescription('X', ['contabilidad', 'wallets'])).toBeUndefined();
  });
});

describe('URL canónica', () => {
  const prev = process.env.NEXTAUTH_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = prev;
  });

  it('cuelga la ruta del dominio del sitio, sin barra final ni parámetros; la portada lleva su barra', () => {
    process.env.NEXTAUTH_URL = 'https://sala.test/';
    expect(siteBaseUrl()).toBe('https://sala.test');
    expect(canonicalAlternates('/')).toEqual({ alternates: { canonical: 'https://sala.test/' } });
    expect(canonicalAlternates('/eventos')).toEqual({ alternates: { canonical: 'https://sala.test/eventos' } });
    expect(canonicalAlternates('tienda/')).toEqual({ alternates: { canonical: 'https://sala.test/tienda' } });
  });

  it('sin dominio conocido o con uno inválido no emite canónica (una a localhost sería peor que ninguna)', () => {
    delete process.env.NEXTAUTH_URL;
    expect(siteBaseUrl()).toBe('');
    expect(canonicalAlternates('/eventos')).toEqual({});
    process.env.NEXTAUTH_URL = 'esto no es una url';
    expect(canonicalAlternates('/eventos')).toEqual({});
  });
});
