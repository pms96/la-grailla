import { describe, it, expect } from 'vitest';
import { parseFormNumber, parseIvaPercent } from '@/lib/contabilidad/form-numbers';

// H-140: `Number(texto) || 0` convertía un campo vacío en 0 (un gasto de 0 € o un IVA del 0 %) sin avisar.
describe('números de los formularios de Contabilidad (H-140)', () => {
  it('vacío, en blanco o ilegible es null, no 0', () => {
    for (const raw of ['', '   ', 'abc', '12abc', '1e3', '--5', '.', '12,5,3', null, undefined]) expect(parseFormNumber(raw), String(raw)).toBeNull();
  });

  it('acepta coma o punto decimal, negativos y el 0 escrito a propósito', () => {
    expect(parseFormNumber('12,50')).toBe(12.5);
    expect(parseFormNumber('12.50')).toBe(12.5);
    expect(parseFormNumber(' 0 ')).toBe(0);
    expect(parseFormNumber('-3')).toBe(-3);
    expect(parseFormNumber(7)).toBe(7);
  });

  it('el IVA va de 0 a 100: fuera de rango o vacío es null; el 0 solo si se escribe', () => {
    expect(parseIvaPercent('21')).toBe(21);
    expect(parseIvaPercent('0')).toBe(0);
    expect(parseIvaPercent('10,5')).toBe(10.5);
    for (const raw of ['', '210', '-1', '100,1', 'abc']) expect(parseIvaPercent(raw), raw).toBeNull();
  });
});
