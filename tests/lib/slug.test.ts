import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { baseSlug, createWithUniqueSlug } from '@/lib/slug';

/* H-052: el slug de un evento o producto se derivaba SOLO del nombre. «Noche de Feria» al año siguiente, o un nombre sin letras (solo símbolos o emojis, que dejaba
 * el slug vacío), daban P2002 en la BD, `handleApiError` no lo mapeaba (500 genérico) y el admin no podía crear el evento. */

const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x', meta: { target: ['slug'] } });

describe('baseSlug', () => {
  it('minúsculas, sin tildes ni símbolos, con guiones', () => {
    expect(baseSlug('Noche de Feria 2026', 'evento')).toBe('noche-de-feria-2026');
    expect(baseSlug('  ¡Fería   Ñandú!  ', 'evento')).toBe('feria-nandu');
    expect(baseSlug('Camiseta "Édición" Ñ', 'producto')).toBe('camiseta-edicion-n');
  });
  it('un nombre sin letras ni números usa el valor de reserva (antes quedaba vacío)', () => {
    expect(baseSlug('🍺🍺', 'evento')).toBe('evento');
    expect(baseSlug('!!!', 'producto')).toBe('producto');
    expect(baseSlug('', 'evento')).toBe('evento');
  });
  it('acota la longitud', () => {
    expect(baseSlug('a'.repeat(300), 'evento').length).toBeLessThanOrEqual(80);
  });
});

describe('createWithUniqueSlug', () => {
  it('usa el slug base si está libre', async () => {
    const out = await createWithUniqueSlug('feria', async () => false, async (slug) => slug);
    expect(out).toBe('feria');
  });

  it('si el base está ocupado prueba base-2, base-3…', async () => {
    const taken = new Set(['feria', 'feria-2']);
    const out = await createWithUniqueSlug('feria', async (s) => taken.has(s), async (slug) => slug);
    expect(out).toBe('feria-3');
  });

  it('si otro alta ganó la carrera (P2002 al crear), reintenta con el siguiente', async () => {
    const tried: string[] = [];
    const out = await createWithUniqueSlug('feria', async () => false, async (slug) => {
      tried.push(slug);
      if (slug === 'feria') throw p2002();
      return slug;
    });
    expect(tried).toEqual(['feria', 'feria-2']);
    expect(out).toBe('feria-2');
  });

  it('un P2002 de OTRA columna no se reintenta: se propaga', async () => {
    const other = new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'x', meta: { target: ['email'] } });
    await expect(createWithUniqueSlug('feria', async () => false, async () => { throw other; })).rejects.toBe(other);
  });

  it('otros errores se propagan sin reintentar', async () => {
    let calls = 0;
    await expect(createWithUniqueSlug('feria', async () => false, async () => { calls += 1; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('tras agotar los intentos numerados usa un sufijo aleatorio en vez de fallar', async () => {
    const out = await createWithUniqueSlug('feria', async () => true, async (slug) => slug);
    expect(out).toMatch(/^feria-[a-z0-9]{6}$/);
  });
});
