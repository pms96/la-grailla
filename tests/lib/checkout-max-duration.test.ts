import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* H-180 (fase 5): las rutas que crean un pedido esperan hasta 20 s el cerrojo del evento y 20 s de transacción (`maxWait` + `timeout` de `app/api/orders/route.ts`) y
 * DESPUÉS del commit llaman a la pasarela (SumUp 12 s, Stripe 10 s). Sin `maxDuration`, la plataforma las corta con su límite por defecto, a veces entre el commit y
 * guardar `paymentId`: el pedido queda `PENDING` sin `paymentId` y el cron lo libera 24 h después, reteniendo aforo o stock. */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('H-180: las rutas de creación de pedido declaran su tiempo máximo', () => {
  const orders = read('app/api/orders/route.ts');
  const budgetMs = Number(/maxWait: ([\d_]+)/.exec(orders)![1].replace(/_/g, '')) + Number(/timeout: ([\d_]+)/.exec(orders)![1].replace(/_/g, '')) + 12_000; // + SumUp

  it.each(['app/api/orders/route.ts', 'app/api/shop/orders/route.ts'])('%s exporta maxDuration y cubre cerrojo + transacción + pasarela', (rel) => {
    const m = /^export const maxDuration = (\d+);/m.exec(read(rel));
    expect(m, `${rel} no exporta maxDuration`).not.toBeNull();
    expect(Number(m![1]) * 1000).toBeGreaterThanOrEqual(budgetMs);
  });
});

/* H-218 (fase 5, ronda 2): la taquilla y las invitaciones toman el MISMO cerrojo por evento (`pg_advisory_xact_lock`) que el checkout. Con los valores por defecto de Prisma
 * (`maxWait` 2 s, `timeout` 5 s) una venta física o una invitación que espera detrás de una cola de compras online muere con P2028 (500), o el cobro con datáfono queda sin
 * registrar. Deben esperar lo mismo que el checkout. */
describe('H-218: quien toma el cerrojo del evento espera lo mismo que el checkout', () => {
  const orders = read('app/api/orders/route.ts');
  const wait = /maxWait: ([\d_]+)/.exec(orders)![1];
  const timeout = /timeout: ([\d_]+)/.exec(orders)![1];

  it.each(['app/api/taquilla/sale/route.ts', 'app/api/invitations/route.ts'])('%s: la transacción lleva maxWait y timeout como el checkout', (rel) => {
    const src = read(rel);
    expect(src).toMatch(new RegExp(`maxWait: ${wait}`));
    expect(src).toMatch(new RegExp(`timeout: ${timeout}`));
  });

  it('la venta de taquilla exporta un maxDuration que cubre cerrojo + transacción', () => {
    const m = /^export const maxDuration = (\d+);/m.exec(read('app/api/taquilla/sale/route.ts'));
    expect(m, 'taquilla/sale no exporta maxDuration').not.toBeNull();
    expect(Number(m![1]) * 1000).toBeGreaterThanOrEqual(Number(wait.replace(/_/g, '')) + Number(timeout.replace(/_/g, '')));
  });
});
