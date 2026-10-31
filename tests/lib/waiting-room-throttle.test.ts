import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* P1-12: el límite de barrido de `sweepAndAdmit`, aislado (sin BD): `prisma` simulado y reloj propio. El comportamiento contra la BD real
 * (que un sondeo admite de verdad en cuanto toca) lo cubre tests/api/queue.test.ts. */

const transaction = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => transaction(...args),
    waitingRoomEntry: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));
let tenantId: string | null = null;
vi.mock('@/lib/tenant/context', () => ({ currentTenant: () => (tenantId ? { tenantId } : null) }));

import { resetSweepThrottle, sweepAndAdmit } from '@/lib/waiting-room';

const clock = { t: 5_000_000 };
const sweep = (eventId: string, minIntervalMs?: number) => sweepAndAdmit(eventId, 1, 300, minIntervalMs === undefined ? {} : { minIntervalMs });

beforeEach(() => {
  transaction.mockReset();
  transaction.mockResolvedValue(undefined);
  tenantId = null;
  clock.t = 5_000_000;
  resetSweepThrottle(() => clock.t);
  vi.spyOn(Math, 'random').mockReturnValue(0.99); // la limpieza oportunista (2 %) no entra
});
afterEach(() => {
  vi.restoreAllMocks();
  resetSweepThrottle();
});

describe('sweepAndAdmit: límite de barrido por evento (P1-12)', () => {
  it('sin `minIntervalMs` (join) barre SIEMPRE, aunque se acabe de barrer', async () => {
    await sweep('e1');
    await sweep('e1');
    await sweep('e1', 1000); // los join no ponen marca: este sondeo no encuentra ninguna y también barre
    await sweep('e1'); // y un join justo después sigue barriendo
    expect(transaction).toHaveBeenCalledTimes(4);
  });

  it('con `minIntervalMs` salta el barrido dentro del intervalo y vuelve a barrer al cumplirse', async () => {
    await sweep('e1', 1000);
    clock.t += 999;
    await sweep('e1', 1000);
    expect(transaction).toHaveBeenCalledTimes(1);
    clock.t += 1;
    await sweep('e1', 1000);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('cada evento tiene su marca', async () => {
    await sweep('e1', 1000);
    await sweep('e2', 1000);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('la marca es por CLIENTE: mismo id de evento en otro cliente no se salta', async () => {
    tenantId = 'cliente-a';
    await sweep('e1', 1000);
    tenantId = 'cliente-b';
    await sweep('e1', 1000);
    expect(transaction).toHaveBeenCalledTimes(2);
    tenantId = 'cliente-a';
    await sweep('e1', 1000); // el mismo cliente sí se salta
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('un barrido que falla no deja la marca puesta: el error sube y el siguiente sondeo reintenta', async () => {
    transaction.mockRejectedValueOnce(new Error('BD caída'));
    await expect(sweep('e1', 1000)).rejects.toThrow('BD caída');
    await sweep('e1', 1000); // sin avanzar el reloj: con la marca puesta se saltaría
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('las llamadas simultáneas de una instancia no repiten el trabajo (la marca se pone antes de barrer)', async () => {
    let release: () => void = () => {};
    transaction.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const first = sweep('e1', 1000);
    await sweep('e1', 1000); // llega mientras el primero aún barre: se salta
    release();
    await first;
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('el mapa tiene tope: al llenarse se vacía (como mucho cuesta un barrido de más, nunca un fallo)', async () => {
    for (let i = 0; i < 2000; i++) await sweep(`evento-${i}`, 1000);
    expect(transaction).toHaveBeenCalledTimes(2000);
    await sweep('evento-nuevo', 1000); // con el mapa lleno se vacía y se marca este
    await sweep('evento-0', 1000); // su marca se perdió con el vaciado: barre otra vez
    expect(transaction).toHaveBeenCalledTimes(2002);
  });
});
