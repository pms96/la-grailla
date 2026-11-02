import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sortedByKey } from '@/lib/lock-order';
import type { PrismaTransactionClient } from '@/lib/prisma';
import { releaseShopStock, reserveShopStock } from '@/lib/product-stock';

/* H-181 (fase 5): `reserveShopStock` y `releaseShopStock` recorrían las líneas en el orden de la petición y cada `updateMany` bloquea una fila de `ProductVariant` hasta
 * el final de la transacción: dos pedidos con las mismas variantes en orden inverso (A,B y B,A) se interbloquean y Postgres aborta uno con 40P01 (un 500 en pleno
 * lanzamiento). Con las filas SIEMPRE en el mismo orden, el segundo espera al primero y no hay ciclo. Lo mismo vale para `TicketType.soldCount` en entradas. */

describe('sortedByKey', () => {
  it('ordena por clave sin tocar la lista original y es estable', () => {
    const items = [{ k: 'b', n: 1 }, { k: 'a', n: 2 }, { k: 'b', n: 3 }, { k: 'a', n: 4 }];
    expect(sortedByKey(items, (i) => i.k).map((i) => i.n)).toEqual([2, 4, 1, 3]);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4]);
  });
  it('acepta cualquier iterable (un Map)', () => {
    const m = new Map([['z', 1], ['a', 2]]);
    expect(sortedByKey(m.entries(), ([k]) => k)).toEqual([['a', 2], ['z', 1]]);
  });
});

describe('H-181: reserva y liberación de stock bloquean las variantes en un orden fijo', () => {
  const touched: string[] = [];
  const fakeTx = {
    productVariant: {
      count: async () => 1,
      updateMany: async (args: { where: { productId: string; size: string | null; color: string | null } }) => {
        touched.push(`${args.where.productId}|${args.where.size ?? ''}|${args.where.color ?? ''}`);
        return { count: 1 };
      },
    },
    product: { findUnique: async () => ({ name: 'P' }) },
  } as unknown as PrismaTransactionClient;

  const lines = [
    { productId: 'p2', quantity: 1, size: 'M', color: '' },
    { productId: 'p1', quantity: 1, size: 'L', color: 'rojo' },
    { productId: 'p1', quantity: 1, size: 'L', color: 'azul' },
    { productId: 'p2', quantity: 1, size: 'S', color: '' },
  ];
  const expected = ['p1|L|azul', 'p1|L|rojo', 'p2|M|', 'p2|S|'];

  it('reserveShopStock toca las variantes ordenadas, venga la petición como venga', async () => {
    touched.length = 0;
    expect(await reserveShopStock(fakeTx, lines)).toBeNull();
    expect(touched).toEqual(expected);
    touched.length = 0;
    await reserveShopStock(fakeTx, [...lines].reverse());
    expect(touched).toEqual(expected);
  });

  it('releaseShopStock también', async () => {
    touched.length = 0;
    await releaseShopStock(fakeTx, lines);
    expect(touched).toEqual(expected);
    touched.length = 0;
    await releaseShopStock(fakeTx, [...lines].reverse());
    expect(touched).toEqual(expected);
  });
});

describe('H-181: toda actualización de `soldCount` por tipo de entrada recorre los tipos en orden', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const FILES = ['app/api/orders/route.ts', 'app/api/taquilla/sale/route.ts', 'lib/reconciliation/entradas.ts', 'lib/reconciliation/gateway-refund.ts'];

  it.each(FILES)('%s: cada `soldCount: { increment|decrement }` va dentro de un recorrido ordenado con sortedByKey', (rel) => {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    const sites = lines.map((l, i) => (/soldCount: \{ (increment|decrement)/.test(l) ? i : -1)).filter((i) => i >= 0);
    expect(sites.length, `${rel} ya no actualiza soldCount: revisa este test`).toBeGreaterThan(0);
    for (const i of sites) {
      const window = lines.slice(Math.max(0, i - 25), i + 1).join('\n'); // el recorrido ordenado abre el bucle (en taquilla, ~20 líneas antes)
      expect(window, `${rel}:${i + 1}`).toContain('sortedByKey(');
    }
  });
});
