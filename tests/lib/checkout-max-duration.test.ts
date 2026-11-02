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
