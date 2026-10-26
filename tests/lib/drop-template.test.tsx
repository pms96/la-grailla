import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_CATALOG, TEMPLATES, TEMPLATE_LABELS, TEMPLATE_PRESETS, parseTheme } from '@/lib/brand/theme';
import { toProductView, type ProductInput, type ShopProductView } from '@/lib/shop/product-view';
import { toTemplateEvent, type EventInput } from '@/app/(public)/_home/event-view';
import { DropCard, toneAt } from '@/app/(public)/_home/drop/product-card';
import { DropShop } from '@/app/(public)/_home/drop/drop-shop';
import { DropHero, HomeDrop, type HomeDropProps } from '@/app/(public)/_home/drop/home-drop';
import { DropProductPage } from '@/app/(public)/_home/drop/product-page';
import { ProductBuy } from '@/app/(public)/_home/drop/product-buy';
import { DropCart } from '@/app/(public)/_home/drop/drop-cart';
import { DropEvents } from '@/app/(public)/_home/drop/drop-events';
import { EventosDrop } from '@/app/(public)/_home/drop/eventos-drop';
import { PageBanner } from '@/app/(public)/_templates/page-banner';
import { productJsonLd } from '@/lib/shop/product-view';
import { BLOB_PUBLIC_HOST, attr, expectOptimized, withBlobHost } from '../helpers/blob-host';

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const prod = (over: Partial<ProductInput> = {}): ShopProductView =>
  toProductView({
    id: 'p1',
    slug: 'camiseta-oficial',
    name: 'Camiseta oficial',
    description: 'Algodón orgánico.',
    price: 19,
    imageUrl: 'https://x.test/a.jpg',
    images: ['https://x.test/b.jpg'],
    category: 'Ropa',
    sizes: 'S, M',
    colors: 'Negro',
    variants: [
      { size: 'S', color: 'Negro', stock: 3 },
      { size: 'M', color: 'Negro', stock: 0 },
    ],
    ...over,
  });

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

const products = [
  prod(),
  prod({ id: 'p2', slug: 'taza', name: 'Taza', price: 9, category: 'Tazas', sizes: null, colors: null, variants: [], images: [] }),
  prod({ id: 'p3', slug: 'gorra', name: 'Gorra', price: 14, category: 'Ropa', sizes: null, colors: null, imageUrl: null, images: [], variants: [{ size: '', color: '', stock: 0 }] }),
];

describe('plantilla «drop» — catálogo', () => {
  it('está en el catálogo, con etiqueta y sugerencia de ajustes válida', () => {
    expect(TEMPLATES).toContain('drop');
    expect(TEMPLATE_LABELS.drop.label).toBe('Drop');
    const preset = TEMPLATE_PRESETS.drop!;
    expect(FONT_CATALOG[preset.fonts.display].roles).toContain('display');
    expect(FONT_CATALOG[preset.fonts.body].roles).toContain('body');
    expect(parseTheme({ v: 1, template: 'drop', colors: { primary: '#1d4ed8', accent: '#f59e0b' }, brand: { name: 'Merch' } })?.template).toBe('drop');
  });
});

describe('DropCard', () => {
  it('enlaza a la ficha, enseña el precio como etiqueta, la categoría y el nombre; el color de bloque viene de la tarjeta', () => {
    const html = render(<DropCard product={prod()} tone={toneAt(1)} />);
    expect(html).toMatch(/<a class="dp-card" href="\/tienda\/camiseta-oficial"/);
    expect(html).toContain('data-tone="accent"');
    expect(html).toContain('19.00€');
    expect(html).toContain('Ropa');
    expect(html).toContain('Camiseta oficial');
    expect(html).not.toContain('Agotado');
  });

  it('un producto agotado lo dice; sin imagen muestra su nombre sobre el bloque de color', () => {
    const html = render(<DropCard product={products[2]!} tone="primary" />);
    expect(html).toContain('Agotado');
    expect(html).toContain('dp-noimg');
    expect(html).not.toContain('<img');
  });

  it('los tonos se alternan sin salirse de la lista', () => {
    expect([0, 1, 2, 3, 4].map(toneAt)).toEqual(['primary', 'accent', 'muted', 'primary', 'accent']);
  });
});

describe('DropShop', () => {
  const shop = (over: Partial<Parameters<typeof DropShop>[0]> = {}) => render(<DropShop brandName="Merch" title="Tienda" lead="Elige talla." products={products} loadError={false} {...over} />);

  it('cabecera con el único h1, filtros por categoría como enlaces y una tarjeta por producto', () => {
    const html = shop();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('href="/tienda?categoria=Ropa"');
    expect(html).toContain('href="/tienda?categoria=Tazas"');
    expect(html.match(/class="dp-card"/g)).toHaveLength(3);
    expect(html).toMatch(/<a class="dp-chip" aria-current="true" href="\/tienda">Todo<\/a>/); // «Todo» activo
  });

  it('con una categoría pedida solo salen sus productos y su filtro queda activo; una inexistente no filtra', () => {
    const ropa = shop({ category: 'ropa' });
    expect(ropa.match(/class="dp-card"/g)).toHaveLength(2);
    expect(ropa).toMatch(/<a class="dp-chip" aria-current="true" href="\/tienda\?categoria=Ropa">Ropa<\/a>/);
    expect(ropa).not.toMatch(/aria-current="true" href="\/tienda">Todo/); // «Todo» ya no está activo
    expect(shop({ category: 'zapatos' }).match(/class="dp-card"/g)).toHaveLength(3);
  });

  it('error de carga, catálogo vacío y una sola categoría (sin filtros) se distinguen', () => {
    expect(shop({ products: [], loadError: true })).toContain('No hemos podido cargar la tienda');
    const vacio = shop({ products: [] });
    expect(vacio).toContain('Catálogo en preparación');
    expect(vacio).not.toContain('No hemos podido cargar');
    expect(shop({ products: [products[0]!, products[2]!] })).not.toContain('aria-label="Categorías"');
  });
});

describe('DropProductPage', () => {
  const page = (p = prod()) => render(<DropProductPage product={p} jsonLd={productJsonLd(p, 'Merch', 'https://tienda.test')} />);

  it('un solo h1, el precio como etiqueta, la descripción, las imágenes en una lista con nombre y el botón de compra', () => {
    const html = page();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])).toBe('Camiseta oficial');
    expect(html).toContain('19.00€');
    expect(html).toContain('Algodón orgánico.');
    expect(html).toMatch(/<ul class="dp-strip" aria-label="Imágenes de Camiseta oficial" tabindex="0">/);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('alt="Camiseta oficial"');
    expect(html).toContain('Añadir al carrito');
    expect(html).toContain('href="/tienda"'); // vuelta al catálogo
  });

  it('lleva datos estructurados de producto y un texto del cliente no puede cerrar la etiqueta', () => {
    const html = page(prod({ name: '</script><b>x', description: '' }));
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"Product"');
    expect(html.match(/<\/script>/g)).toHaveLength(1); // solo el cierre propio
    expect(html).toContain('\\u003c/script>');
  });

  it('con una sola imagen la tira no es enfocable; sin imágenes, el nombre sobre un bloque de color', () => {
    expect(page(prod({ images: [] }))).not.toContain('tabindex');
    const sin = page(prod({ imageUrl: null, images: [] }));
    expect(sin).not.toContain('<img');
    expect(sin).toContain('dp-noimg');
  });
});

describe('ProductBuy (HTML del servidor)', () => {
  it('talla y color son grupos de botones con nombre; el botón arranca en reposo y existe la región de avisos', () => {
    const html = render(<ProductBuy product={prod()} />);
    expect(html).toContain('role="group"');
    expect(html.match(/class="dp-chip"/g)).toHaveLength(3); // S, M, Negro
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('Añadido'); // el texto del estado «añadido» está en el DOM (oculto por CSS) para animar el cambio
  });

  it('una combinación ya agotada sale deshabilitada solo si es la única opción; un producto agotado no se puede comprar', () => {
    const soloTalla = render(<ProductBuy product={prod({ colors: null, variants: [{ size: 'S', color: '', stock: 2 }, { size: 'M', color: '', stock: 0 }] })} />);
    expect(soloTalla.match(/disabled=""/g)).toHaveLength(1);
    const agotado = render(<ProductBuy product={prod({ variants: [{ size: 'S', color: 'Negro', stock: 0 }] })} />);
    expect(agotado).toContain('Agotado');
    expect(agotado).toMatch(/class="dp-add"[^>]*disabled=""/);
  });

  it('un producto sin opciones no pide talla ni color', () => {
    const html = render(<ProductBuy product={products[1]!} />);
    expect(html).not.toContain('dp-chip');
    expect(html).not.toContain('role="group"');
  });
});

describe('DropCart (HTML del servidor)', () => {
  it('el botón flotante existe desde el principio, sin contador (el carrito se lee en el navegador)', () => {
    const html = render(<DropCart />);
    expect(html).toMatch(/<button type="button" class="dp-cart"[^>]*aria-label="Abrir carrito"/);
    expect(html).not.toContain('dp-cart-count');
  });
});

describe('HomeDrop', () => {
  const base: HomeDropProps = {
    brandName: 'Merch',
    hero: { badge: '', title: 'Ropa que se nota', subtitle: 'Hecha en pequeñas tiradas.', primaryCta: { href: '/eventos', label: 'Ver eventos', icon: 'ticket' } },
    events: [toTemplateEvent(event())],
    loadError: false,
    hasEntradas: false,
    hasTienda: true,
    hasSponsors: false,
    contactEnabled: false,
    products,
    copy: { shopTitle: '', shopSubtitle: '', aboutTitle: '', aboutText: 'Una marca pequeña.', sponsorsTitle: '', sponsorsSubtitle: '' },
  };
  const ids = (html: string) => [...html.matchAll(/<section[^>]*id="([^"]+)"/g)].map((m) => m[1]);

  it('con tienda: el botón lleva a /tienda, hay producto destacado y riel de novedades con una tarjeta por producto', () => {
    const html = render(<HomeDrop {...base} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('href="/tienda"');
    expect(html).toContain('Ir a la tienda');
    // La tarjeta destacada no lleva aria-label propio (no coincidía con el texto visible): su nombre sale del precio y del nombre que se ven.
    expect(html).not.toMatch(/class="dp-card" aria-label=/);
    expect(html).toMatch(/dp-tag dp-tag-lg">19\.00€<\/span>[\s\S]*?Camiseta oficial/);
    expect(ids(html)).toContain('novedades');
    expect(html).toContain('class="dp-rail"');
    expect(html.match(/class="dp-rail-item"/g)).toHaveLength(3);
    expect(html).toContain('dp-cart');
  });

  it('sin el módulo Tienda no hay productos, riel ni carrito y el botón es el de siempre', () => {
    const html = render(<HomeDrop {...base} hasTienda={false} />);
    expect(ids(html)).not.toContain('novedades');
    expect(html).not.toContain('dp-rail');
    expect(html).not.toContain('dp-cart');
    expect(html).not.toContain('Ir a la tienda');
    expect(html).toContain('href="/eventos"');
  });

  it('el destacado prefiere un producto con stock e imagen; sin productos solo queda el titular', () => {
    const agotadoPrimero = [prod({ variants: [{ size: 'S', color: 'Negro', stock: 0 }] }), products[1]!];
    expect(render(<DropHero brandName="Merch" hero={base.hero} hasTienda featured={agotadoPrimero.find((x) => x.inStock && x.imageUrl) ?? null} />)).toContain('Taza');
    const sin = render(<HomeDrop {...base} products={[]} />);
    expect(ids(sin)).not.toContain('novedades');
    expect(sin).not.toContain('dp-card');
  });

  it('con Entradas y Sponsors salen sus bloques; las tarjetas de evento enlazan a su ficha', () => {
    const html = render(<HomeDrop {...base} hasEntradas hasSponsors />);
    expect(ids(html)).toContain('eventos');
    expect(html).toContain('href="/eventos/noche-de-verano"');
    expect(html).toContain('href="/sponsors"');
  });
});

describe('eventos y cabecera interior con «drop»', () => {
  it('DropEvents y /eventos: tarjetas, estados de error y vacío', () => {
    expect(render(<DropEvents events={[toTemplateEvent(event())]} />)).toContain('desde 15.00€');
    expect(render(<EventosDrop brandName="Merch" events={[toTemplateEvent(event())]} loadError={false} />)).toContain('Noche de Verano');
    expect(render(<EventosDrop brandName="Merch" events={[]} loadError />)).toContain('No hemos podido cargar los eventos');
    expect(render(<EventosDrop brandName="Merch" events={[]} loadError={false} />)).toContain('Todavía no hay fechas publicadas');
  });

  it('PageBanner: un h1, datos como etiquetas, cartel a la derecha; en versión baja, sin imagen', () => {
    const html = render(<PageBanner template="drop" brandName="Merch" title="Noche de Verano" facts={[{ label: 'Fecha', value: 'Sábado' }]} imageUrl="https://x.test/c.jpg" />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('alt="Cartel de Noche de Verano"');
    expect(html).toContain('Sábado');
    const compact = render(<PageBanner template="drop" brandName="Merch" title="Aviso legal" imageUrl="https://x.test/c.jpg" compact />);
    expect(compact).not.toContain('<img');
    expect(compact).toContain('data-size="s"');
  });
});

describe('imágenes de Blob con la optimización activa (BLOB_PUBLIC_HOST)', () => {
  const blob = (name: string) => `https://${BLOB_PUBLIC_HOST}/t1/products/p1/${name}.jpg`;

  it('la tarjeta de rejilla y la del riel usan los sizes de su maquetación', () => {
    const p = prod({ imageUrl: blob('a') });
    const card = withBlobHost(() => render(<DropCard product={p} tone="primary" />));
    expectOptimized(card, blob('a'));
    expect(attr(card, 'sizes')).toContain('25vw');
    expect(card).toContain('loading="lazy"');
    const rail = withBlobHost(() => render(<DropCard product={p} tone="primary" priority sizes="(min-width:486px) 272px, 56vw" />));
    expect(attr(rail, 'sizes')).toBe('(min-width:486px) 272px, 56vw');
    expect(rail).toContain('loading="eager"');
  });

  it('la ficha de producto optimiza cada imagen de la tira y mantiene la prioridad de la primera', () => {
    const html = withBlobHost(() => render(<DropProductPage product={prod({ imageUrl: blob('a'), images: [blob('a'), blob('b')] })} jsonLd={{}} />));
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html.match(/srcSet=/g)).toHaveLength(2);
    expect(html).toContain(`url=${encodeURIComponent(blob('a'))}&amp;w=`);
    expect(html).toContain(`url=${encodeURIComponent(blob('b'))}&amp;w=`);
    expect(html).not.toContain(`src="${blob('a')}"`);
    expect(html).toContain('fetchPriority="high"');
  });

  it('sin la variable, o con otro store, el src es el original', () => {
    const p = prod({ imageUrl: blob('a') });
    expect(withBlobHost(() => render(<DropCard product={p} tone="primary" />), null)).toContain(`src="${blob('a')}"`);
    const other = 'https://zzz999.public.blob.vercel-storage.com/t1/a.jpg';
    const html = withBlobHost(() => render(<DropCard product={prod({ imageUrl: other })} tone="primary" />));
    expect(html).toContain(`src="${other}"`);
    expect(html).not.toContain('srcSet');
  });
});
