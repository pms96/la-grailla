import { describe, it, expect } from 'vitest';
import { ivaEfectivo } from '@/lib/gasto-calc';

// AUDIT: el diálogo "Registrar factura" de un pedido guardaba siempre el gasto con IVA del 21 %, aunque las líneas del pedido
// llevaran 10 % o 4 %. El gasto quedaba con un total distinto del de la factura real. Severidad: Alto (contabilidad).
describe('ivaEfectivo — IVA con el que registrar un pedido como gasto', () => {
  it('si todas las líneas llevan el mismo IVA, ese es el IVA (no el 21 % por defecto)', () => {
    expect(ivaEfectivo([{ base: 100, ivaPercent: 10 }, { base: 50, ivaPercent: 10 }])).toBe(10);
    expect(ivaEfectivo([{ base: 80, ivaPercent: 4 }])).toBe(4);
  });

  it('con IVA mezclado, es la media ponderada por base: el total con IVA coincide con el del pedido', () => {
    const lineas = [{ base: 100, ivaPercent: 21 }, { base: 100, ivaPercent: 10 }];
    const iva = ivaEfectivo(lineas);
    expect(iva).toBe(15.5);
    const conIva = lineas.reduce((s, l) => s + l.base * (1 + l.ivaPercent / 100), 0);
    expect(Math.round(200 * (1 + iva / 100) * 100) / 100).toBe(conIva);
  });

  it('las líneas con base 0 o negativa (abonos) no rompen el cálculo', () => {
    expect(ivaEfectivo([{ base: 0, ivaPercent: 4 }, { base: 100, ivaPercent: 21 }])).toBe(21);
    expect(ivaEfectivo([{ base: 100, ivaPercent: 21 }, { base: -20, ivaPercent: 21 }])).toBe(21);
  });

  it('sin líneas o con base total 0 devuelve el 21 % habitual', () => {
    expect(ivaEfectivo([])).toBe(21);
    expect(ivaEfectivo([{ base: 0, ivaPercent: 10 }])).toBe(21);
  });
});
