import { describe, expect, it } from 'vitest';
import { interleave } from '@/lib/reconciliation/interleave';

/* P1-13: la cola del cron de conciliación mezcla entradas y tienda por turnos, para que una pasada cortada por tiempo no deje a una de las dos sin examinar. */

describe('interleave', () => {
  it('mezcla por turnos y conserva el orden interno de cada lista', () => {
    expect(interleave(['a0', 'a1', 'a2'], ['b0', 'b1', 'b2'])).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2']);
  });

  it('cuando una lista se acaba, sigue con lo que queda de la otra (en cualquiera de los dos sentidos)', () => {
    expect(interleave(['a0'], ['b0', 'b1', 'b2'])).toEqual(['a0', 'b0', 'b1', 'b2']);
    expect(interleave(['a0', 'a1', 'a2'], ['b0'])).toEqual(['a0', 'b0', 'a1', 'a2']);
  });

  it('con una lista vacía devuelve la otra; con las dos vacías, vacío', () => {
    expect(interleave([], ['b0', 'b1'])).toEqual(['b0', 'b1']);
    expect(interleave(['a0', 'a1'], [])).toEqual(['a0', 'a1']);
    expect(interleave([], [])).toEqual([]);
  });

  it('no modifica las listas de entrada y no pierde ni duplica elementos', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [10, 20];
    const out = interleave(a, b);
    expect(a).toEqual([1, 2, 3, 4, 5]);
    expect(b).toEqual([10, 20]);
    expect([...out].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 10, 20]);
  });
});
