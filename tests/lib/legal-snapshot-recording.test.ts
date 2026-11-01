import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const captured: Array<{ route?: string; reason?: string }> = [];
vi.mock('@/lib/observability/capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/observability/capture')>()),
  captureOpsError: vi.fn((_e: unknown, ctx: { route?: string; reason?: string }) => {
    captured.push(ctx);
  }),
}));

const { recordTermsVersion, computeTermsVersion, RECORDED_TTL_MS } = await import('@/lib/legal-terms');

/* H-054: el pedido guarda el hash de las condiciones que aceptó el comprador y LegalSnapshot guarda su copia (sin clave foránea). Dos huecos: (1) la marca
 * «ya guardado» vivía en memoria PARA SIEMPRE, así que tras restaurar la BD (o borrar la fila) las ventas siguientes seguían apuntando a una copia que ya no
 * existía; (2) un fallo transitorio del upsert dejaba el pedido sin copia aunque un segundo intento habría funcionado. */

const created: string[] = [];
const unique = () => `h054-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const rowFor = (hash: string) => prisma.legalSnapshot.findUnique({ where: { hash } });

/** Registra una versión nueva (el texto extra cambia el hash sin tocar la configuración) y apunta su hash para limpiar. */
async function record(extra: string) {
  const hash = await recordTermsVersion('entradas', extra);
  created.push(hash);
  return hash;
}

describe('H-054: copia de las condiciones aceptadas (LegalSnapshot)', () => {
  beforeEach(() => {
    captured.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.legalSnapshot.deleteMany({ where: { hash: { in: created } } });
  });

  it('guarda la copia una sola vez mientras la marca en memoria es reciente', async () => {
    const extra = unique();
    const upsert = vi.spyOn(prisma.legalSnapshot, 'upsert');
    const hash = await record(extra);
    await record(extra);
    expect(await rowFor(hash)).not.toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('con la marca caducada comprueba de nuevo y recrea una copia perdida (BD restaurada)', async () => {
    const extra = unique();
    const hash = await record(extra);
    await prisma.legalSnapshot.delete({ where: { hash } });
    expect(await rowFor(hash)).toBeNull();

    // Aún dentro del plazo: se fía de la memoria (no consulta la BD en cada pedido).
    await record(extra);
    expect(await rowFor(hash)).toBeNull();

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + RECORDED_TTL_MS + 1000);
    await record(extra);
    expect(await rowFor(hash)).not.toBeNull();
  });

  it('un fallo transitorio del upsert se reintenta una vez y no avisa', async () => {
    const extra = unique();
    vi.spyOn(prisma.legalSnapshot, 'upsert').mockRejectedValueOnce(new Error('conexión caída un instante'));
    const hash = await record(extra);
    expect(await rowFor(hash)).not.toBeNull();
    expect(captured).toEqual([]);
  });

  it('un fallo persistente no bloquea la venta, avisa a operación y se reintenta en la siguiente', async () => {
    const extra = unique();
    const upsert = vi.spyOn(prisma.legalSnapshot, 'upsert').mockRejectedValue(new Error('BD no disponible'));
    const hash = await record(extra);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(captured).toEqual([expect.objectContaining({ route: 'legal-snapshot', reason: 'snapshot_not_saved' })]);
    expect(await rowFor(hash)).toBeNull();

    // No quedó marcada como guardada: la siguiente venta lo intenta de nuevo.
    upsert.mockRestore();
    await record(extra);
    expect(await rowFor(hash)).not.toBeNull();
  });

  it('la carrera benigna de dos primeras ventas a la vez (P2002) no avisa', async () => {
    const extra = unique();
    const dup = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
    vi.spyOn(prisma.legalSnapshot, 'upsert').mockRejectedValue(dup);
    const hash = await record(extra);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(captured).toEqual([]);
  });

  it('el plazo de la marca es de minutos: ni una escritura por pedido ni una copia perdida durante horas', () => {
    expect(RECORDED_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(RECORDED_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
  });

  it('la versión que devuelve es la misma que calcula computeTermsVersion', async () => {
    const extra = unique();
    expect(await record(extra)).toBe((await computeTermsVersion('entradas', extra)).hash);
  });
});
