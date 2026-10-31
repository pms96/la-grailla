import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
vi.mock('@/lib/prisma', () => ({ prisma: { temporada: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));

const { parseMotivo, temporadaCerrada, checkTemporadaAbierta, MOTIVO_MIN, MOTIVO_MAX } = await import('@/lib/contabilidad/control');

beforeEach(() => findUnique.mockReset());

describe('parseMotivo (P1-16): anular, cerrar o reabrir exige un motivo real', () => {
  it('acepta un motivo y lo recorta', () => {
    expect(parseMotivo('  Factura duplicada  ')).toEqual({ ok: true, motivo: 'Factura duplicada' });
  });

  it('rechaza vacío, solo espacios, no texto y demasiado corto', () => {
    for (const raw of [undefined, null, 42, '', '     ', 'a'.repeat(MOTIVO_MIN - 1)]) {
      expect(parseMotivo(raw).ok).toBe(false);
    }
  });

  it('el mínimo cuenta sin los espacios de los extremos', () => {
    expect(parseMotivo(` ${'a'.repeat(MOTIVO_MIN - 1)} `).ok).toBe(false);
    expect(parseMotivo('a'.repeat(MOTIVO_MIN)).ok).toBe(true);
  });

  it('rechaza un motivo que pasa del máximo', () => {
    expect(parseMotivo('a'.repeat(MOTIVO_MAX)).ok).toBe(true);
    expect(parseMotivo('a'.repeat(MOTIVO_MAX + 1)).ok).toBe(false);
  });
});

describe('temporadaCerrada', () => {
  it('solo CERRADA cuenta; archivada no', () => {
    expect(temporadaCerrada({ status: 'CERRADA' })).toBe(true);
    expect(temporadaCerrada({ status: 'ABIERTA' })).toBe(false);
    expect(temporadaCerrada(null)).toBe(false);
  });
});

describe('checkTemporadaAbierta', () => {
  it('abierta: se puede escribir', async () => {
    findUnique.mockResolvedValue({ nombre: 'Feria 2026', status: 'ABIERTA' });
    expect(await checkTemporadaAbierta('t1')).toEqual({ ok: true });
  });

  it('cerrada: 423 con el nombre de la temporada y un código estable', async () => {
    findUnique.mockResolvedValue({ nombre: 'Feria 2026', status: 'CERRADA' });
    const r = await checkTemporadaAbierta('t1');
    expect(r).toMatchObject({ ok: false, status: 423, code: 'temporada_cerrada' });
    expect(!r.ok && r.error).toContain('Feria 2026');
  });

  it('inexistente: 404', async () => {
    findUnique.mockResolvedValue(null);
    expect(await checkTemporadaAbierta('nope')).toMatchObject({ ok: false, status: 404, code: 'temporada_no_encontrada' });
  });
});
