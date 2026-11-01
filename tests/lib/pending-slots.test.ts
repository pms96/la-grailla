import { describe, it, expect, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { countPendingSlots, rateLimit, releasePendingSlot, takePendingSlot } from '@/lib/rate-limit';

/* H-051: el cupo de pedidos pendientes por IP vivía en `RateLimitBucket` con claves `pending:<ámbito>:<ip>#<pedido>`: contar era una búsqueda por prefijo de texto y
 * liberar una por prefijo Y sufijo (escaneo de toda la tabla DENTRO del cerrojo de compra del evento, que serializaba las compras), y la fila ataba una IP a un id de
 * pedido durante el TTL más una hora. Ahora es una fila por pedido en `PendingSlot`: contar usa el índice (ámbito, identificador, caducidad) y liberar, la clave primaria. */

const scope = `t-${Date.now()}`;
const refs: string[] = [];
const ref = (n: string) => {
  const r = `${scope}-${n}`;
  refs.push(r);
  return r;
};

describe('cupos de pedidos pendientes (PendingSlot)', () => {
  afterAll(async () => {
    await prisma.pendingSlot.deleteMany({ where: { ref: { in: refs } } });
  });

  it('cuenta los cupos vivos de un ámbito e identificador, y no los de otro', async () => {
    await takePendingSlot(prisma, scope, 'ip-1', ref('a'), 60_000);
    await takePendingSlot(prisma, scope, 'ip-1', ref('b'), 60_000);
    await takePendingSlot(prisma, scope, 'ip-2', ref('c'), 60_000);
    await takePendingSlot(prisma, `${scope}-otro`, 'ip-1', ref('d'), 60_000);
    expect(await countPendingSlots(prisma, scope, 'ip-1')).toBe(2);
    expect(await countPendingSlots(prisma, scope, 'ip-2')).toBe(1);
    expect(await countPendingSlots(prisma, `${scope}-otro`, 'ip-1')).toBe(1);
    expect(await countPendingSlots(prisma, scope, 'ip-3')).toBe(0);
    await prisma.pendingSlot.deleteMany({ where: { scope: `${scope}-otro` } });
  });

  it('un identificador que es prefijo de otro no cuenta sus cupos (ip-1 frente a ip-10)', async () => {
    await takePendingSlot(prisma, scope, 'ip-10', ref('e'), 60_000);
    expect(await countPendingSlots(prisma, scope, 'ip-1')).toBe(2); // solo a y b
    expect(await countPendingSlots(prisma, scope, 'ip-10')).toBe(1);
  });

  it('un cupo caducado no cuenta', async () => {
    await takePendingSlot(prisma, scope, 'ip-viejo', ref('f'), -1000);
    expect(await countPendingSlots(prisma, scope, 'ip-viejo')).toBe(0);
  });

  it('tomar dos veces el cupo del mismo pedido es idempotente', async () => {
    const r = ref('g');
    await takePendingSlot(prisma, scope, 'ip-dup', r, 60_000);
    await takePendingSlot(prisma, scope, 'ip-dup', r, 60_000);
    expect(await countPendingSlots(prisma, scope, 'ip-dup')).toBe(1);
  });

  it('liberar por pedido (sin saber la IP) borra solo ese cupo', async () => {
    const r = ref('h');
    await takePendingSlot(prisma, scope, 'ip-rel', r, 60_000);
    await takePendingSlot(prisma, scope, 'ip-rel', ref('i'), 60_000);
    await releasePendingSlot(r);
    expect(await countPendingSlots(prisma, scope, 'ip-rel')).toBe(1);
    await releasePendingSlot('no-existe'); // no lanza
  });

  it('la tabla guarda la IP solo mientras vive el cupo, y tiene caducidad para limpiarla', async () => {
    const row = await prisma.pendingSlot.findUnique({ where: { ref: refs[0] } });
    expect(row?.expiresAt).toBeInstanceOf(Date);
  });

  it('la limpieza oportunista del limitador borra los cupos caducados (y con ellos la IP que guardaban)', async () => {
    const r = ref('j');
    await takePendingSlot(prisma, scope, 'ip-caducada', r, -60_000);
    vi.spyOn(Math, 'random').mockReturnValue(0); // fuerza la limpieza (normalmente 1 de cada 100 llamadas)
    try {
      await rateLimit(`${scope}-limpieza`, 'x', 100, 1000);
      await new Promise((res) => setTimeout(res, 300)); // la limpieza no se espera: va en segundo plano
    } finally {
      vi.restoreAllMocks();
      await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: `${scope}-limpieza:` } } });
    }
    expect(await prisma.pendingSlot.findUnique({ where: { ref: r } })).toBeNull();
  });
});
