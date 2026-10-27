import { describe, it, expect } from 'vitest';
import { buildVariantsPayload } from '@/lib/product-variants-payload';

// AUDIT P0-01 / TI-01: guardar un producto mandaba el stock de TODAS las variantes con el valor cargado al abrir el diálogo y el servidor
// lo escribía como absoluto: las ventas hechas entre medias se deshacían (sobreventa). Ahora solo viajan las filas que el admin tocó.
describe('buildVariantsPayload', () => {
  const base = {
    editing: true,
    sizes: 'M,L',
    colors: 'Negro',
    sizesChanged: false,
    colorsChanged: false,
    originalStock: { 'M|Negro': 5, 'L|Negro': 3 },
    stockByKey: { 'M|Negro': 5, 'L|Negro': 3 },
    stockTouched: false,
  };

  it('cambiar solo el precio u otro dato no manda variants (no toca el stock)', () => {
    expect(buildVariantsPayload(base)).toBeUndefined();
  });

  it('escribir un stock y volver al valor original no manda nada', () => {
    expect(buildVariantsPayload({ ...base, stockTouched: true })).toBeUndefined();
  });

  it('manda solo la variante cuyo stock cambió, con el valor original como expectedStock', () => {
    const rows = buildVariantsPayload({ ...base, stockByKey: { 'M|Negro': 9, 'L|Negro': 3 }, stockTouched: true });
    expect(rows).toEqual([{ size: 'M', color: 'Negro', stock: 9, expectedStock: 5 }]);
  });

  it('una talla nueva va con su stock y sin expectedStock; las existentes sin tocar no van', () => {
    const rows = buildVariantsPayload({
      ...base,
      sizes: 'M,L,XL',
      sizesChanged: true,
      stockByKey: { 'M|Negro': 5, 'L|Negro': 3, 'XL|Negro': 4 },
      stockTouched: true,
    });
    expect(rows).toEqual([{ size: 'XL', color: 'Negro', stock: 4 }]);
  });

  it('quitar una talla manda variants (para que el servidor la borre) pero sin stock de las demás', () => {
    const rows = buildVariantsPayload({ ...base, sizes: 'M', sizesChanged: true });
    expect(rows).toEqual([]);
  });

  it('crear un producto manda todas las combinaciones con su stock', () => {
    const rows = buildVariantsPayload({ ...base, editing: false, originalStock: {}, stockByKey: { 'M|Negro': 2 } });
    expect(rows).toEqual([
      { size: 'M', color: 'Negro', stock: 2 },
      { size: 'L', color: 'Negro', stock: 0 },
    ]);
  });

  it('producto sin variantes y sin tocar el stock no genera filas a 0', () => {
    const rows = buildVariantsPayload({ ...base, originalStock: {}, stockByKey: {} });
    expect(rows).toBeUndefined();
  });

  it('producto sin variantes con stock escrito crea las filas', () => {
    const rows = buildVariantsPayload({ ...base, originalStock: {}, stockByKey: { 'M|Negro': 2 }, stockTouched: true });
    expect(rows).toHaveLength(2);
    expect(rows?.[0]).toEqual({ size: 'M', color: 'Negro', stock: 2 });
  });
});
