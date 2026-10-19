import { describe, expect, it } from 'vitest';
import {
  RESERVED_PRODUCT_SLUGS,
  categoriesOf,
  filterByCategory,
  lowStockNote,
  productJsonLd,
  productPath,
  safeJsonLd,
  toProductView,
  variantStock,
  type ProductInput,
} from '@/lib/shop/product-view';

const product = (over: Partial<ProductInput> = {}): ProductInput => ({
  id: 'p1',
  slug: 'camiseta-oficial',
  name: 'Camiseta oficial',
  description: '  Algodón orgánico.  ',
  price: 19,
  imageUrl: 'https://x.test/a.jpg',
  images: ['https://x.test/a.jpg', 'https://x.test/b.jpg', 'https://x.test/b.jpg'],
  category: ' Ropa ',
  sizes: 'S, M, M, L',
  colors: 'Negro, Blanco',
  variants: [
    { size: 'S', color: 'Negro', stock: 3 },
    { size: 'M', color: 'Negro', stock: 0 },
  ],
  ...over,
});

describe('productPath', () => {
  it('usa el slug; si está vacío o es uno reservado de la tienda, usa el id', () => {
    expect(productPath({ id: 'p1', slug: 'camiseta' })).toBe('/tienda/camiseta');
    expect(productPath({ id: 'p1', slug: '' })).toBe('/tienda/p1');
    expect(productPath({ id: 'p1', slug: '  ' })).toBe('/tienda/p1');
    for (const reserved of RESERVED_PRODUCT_SLUGS) expect(productPath({ id: 'p9', slug: reserved })).toBe('/tienda/p9');
  });
});

describe('toProductView', () => {
  it('normaliza texto, opciones, imágenes (la principal primero y sin repetir) y la ruta', () => {
    const v = toProductView(product());
    expect(v.path).toBe('/tienda/camiseta-oficial');
    expect(v.description).toBe('Algodón orgánico.');
    expect(v.category).toBe('Ropa');
    expect(v.sizes).toEqual(['S', 'M', 'L']); // sin repetidos
    expect(v.colors).toEqual(['Negro', 'Blanco']);
    expect(v.images).toEqual(['https://x.test/a.jpg', 'https://x.test/b.jpg']);
    expect(v.imageUrl).toBe('https://x.test/a.jpg');
  });

  it('sin imagen principal usa la primera de la galería; sin nada, ninguna', () => {
    expect(toProductView(product({ imageUrl: null, images: ['https://x.test/z.jpg'] })).imageUrl).toBe('https://x.test/z.jpg');
    const none = toProductView(product({ imageUrl: null, images: [] }));
    expect(none.imageUrl).toBeNull();
    expect(none.images).toEqual([]);
  });

  it('sin variantes no controla stock y se vende; con variantes, solo si alguna tiene stock', () => {
    expect(toProductView(product({ variants: [] })).inStock).toBe(true);
    expect(toProductView(product()).inStock).toBe(true);
    expect(toProductView(product({ variants: [{ size: 'S', color: 'Negro', stock: 0 }] })).inStock).toBe(false);
  });

  it('no arrastra campos internos (como el vínculo a la temporada) aunque la fila los traiga', () => {
    const v = toProductView({ ...product(), temporadaId: 't1', isActive: true } as ProductInput);
    expect(JSON.stringify(v)).not.toContain('temporadaId');
    expect(JSON.stringify(v)).not.toContain('isActive');
  });
});

describe('variantStock', () => {
  const v = toProductView(product());
  it('null si no controla stock; el de la combinación si existe; 0 si no existe', () => {
    expect(variantStock(toProductView(product({ variants: [] })), 'S', 'Negro')).toBeNull();
    expect(variantStock(v, 'S', 'Negro')).toBe(3);
    expect(variantStock(v, 'M', 'Negro')).toBe(0);
    expect(variantStock(v, 'XL', 'Rojo')).toBe(0);
  });
});

describe('categorías', () => {
  const list = [{ category: 'Ropa' }, { category: 'ropa' }, { category: 'Tazas' }, { category: null }];
  it('categoriesOf: distintas, en orden de aparición y sin distinguir mayúsculas', () => {
    expect(categoriesOf(list)).toEqual(['Ropa', 'Tazas']);
  });
  it('filterByCategory: filtra sin distinguir mayúsculas; vacía o inexistente no filtra', () => {
    expect(filterByCategory(list, 'ROPA')).toHaveLength(2);
    expect(filterByCategory(list, 'Tazas')).toHaveLength(1);
    expect(filterByCategory(list, '')).toHaveLength(4);
    expect(filterByCategory(list, null)).toHaveLength(4);
    expect(filterByCategory(list, 'No existe')).toHaveLength(4);
  });
});

describe('lowStockNote', () => {
  it('avisa solo cuando quedan entre 1 y 5', () => {
    expect(lowStockNote(null)).toBeNull();
    expect(lowStockNote(0)).toBeNull();
    expect(lowStockNote(1)).toBe('Queda 1 unidad');
    expect(lowStockNote(3)).toBe('Quedan 3 unidades');
    expect(lowStockNote(6)).toBeNull();
  });
});

describe('datos estructurados', () => {
  it('productJsonLd: precio con dos decimales, disponibilidad y direcciones absolutas', () => {
    const ld = productJsonLd(toProductView(product({ images: ['/uploads/b.jpg'] })), 'Sala Rodrigo', 'https://tienda.test') as any;
    expect(ld['@type']).toBe('Product');
    expect(ld.offers.price).toBe('19.00');
    expect(ld.offers.priceCurrency).toBe('EUR');
    expect(ld.offers.availability).toBe('https://schema.org/InStock');
    expect(ld.offers.url).toBe('https://tienda.test/tienda/camiseta-oficial');
    expect(ld.image).toEqual(['https://x.test/a.jpg', 'https://tienda.test/uploads/b.jpg']);
    expect(ld.brand.name).toBe('Sala Rodrigo');
    const out = productJsonLd(toProductView(product({ variants: [{ size: 'S', color: 'Negro', stock: 0 }] })), 'X', '') as any;
    expect(out.offers.availability).toBe('https://schema.org/OutOfStock');
    expect(out.offers.url).toBeUndefined(); // sin base, sin dirección absoluta
  });

  it('safeJsonLd: un texto del cliente no puede cerrar la etiqueta <script> ni romper la línea', () => {
    const separador = String.fromCharCode(0x2028); // separador de línea de Unicode: rompe una cadena JavaScript si se deja sin escapar
    const out = safeJsonLd({ name: '</script><script>alert(1)</script>', d: `a${separador}b` });
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain(separador);
    expect(JSON.parse(out).name).toBe('</script><script>alert(1)</script>'); // sigue siendo JSON válido y recupera el texto
  });
});
