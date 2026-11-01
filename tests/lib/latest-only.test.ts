import { describe, expect, it } from 'vitest';
import { createLatestOnly } from '@/lib/latest-only';

describe('createLatestOnly (H-097)', () => {
  it('la petición más reciente es la vigente; las anteriores dejan de serlo', () => {
    const l = createLatestOnly();
    const a = l.next();
    expect(l.isCurrent(a)).toBe(true);
    const b = l.next();
    expect(l.isCurrent(a)).toBe(false);
    expect(l.isCurrent(b)).toBe(true);
  });

  it('simula el filtro: la respuesta tardía de «Gastos» no pinta cuando ya está activo «Pedidos»', async () => {
    const l = createLatestOnly();
    const painted: string[] = [];
    const request = async (filter: string, delay: number) => {
      const token = l.next();
      await new Promise((r) => setTimeout(r, delay));
      if (l.isCurrent(token)) painted.push(filter);
    };
    await Promise.all([request('gastos', 40), request('pedidos', 5)]);
    expect(painted).toEqual(['pedidos']);
  });

  it('un token inventado nunca es vigente', () => {
    const l = createLatestOnly();
    l.next();
    expect(l.isCurrent(0)).toBe(false);
    expect(l.isCurrent(99)).toBe(false);
  });
});
