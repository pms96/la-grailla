import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';
import { completeOrder } from '@/lib/reconciliation/entradas';
import { completeShopOrder } from '@/lib/reconciliation/tienda';
import { getEmailState } from '@/lib/email-delivery';

/* P0-08 con dos clientes en dos BDs: el envío del email tras la respuesta (`after`) viaja con el contexto de SU cliente. Sin él, `prisma` no sabría a
 * qué BD ir (en modo plataforma lanza) y el pedido se quedaría sin email; con el contexto equivocado, el rastro acabaría en la BD de otro cliente. */

const ctl = vi.hoisted(() => ({ queue: [] as (() => unknown)[], mails: [] as { to: string; subject: string }[] }));
vi.mock('next/server', async (orig) => {
  const actual = await orig<typeof import('next/server')>();
  return { ...actual, after: (task: () => unknown) => void ctl.queue.push(task) };
});
vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  sendMail: async (p: { to: string; subject: string }) => {
    ctl.mails.push({ to: p.to, subject: p.subject });
    return { success: true, transport: 'smtp' as const };
  },
}));

let env: ReturnType<typeof enablePlatformEnv>;
const onA = <T,>(fn: () => T) => withTenantForTest('a', fn);
const onB = <T,>(fn: () => T) => withTenantForTest('b', fn);

async function pendingOrder(slot: 'a' | 'b') {
  const db = tenantClient(slot);
  const event = await db.event.create({ data: { name: 'Evento', slug: `evento-${slot}`, venue: 'Sala', city: 'Madrid', date: new Date(Date.now() + 5 * 86_400_000), maxCapacity: 100, status: 'PUBLISHED' } });
  const tt = await db.ticketType.create({ data: { eventId: event.id, name: 'General', price: 10, maxQuantity: 100 } });
  return db.order.create({
    data: {
      eventId: event.id, buyerName: 'Ana', buyerLastName: 'Pérez', buyerEmail: `ana-${slot}@ejemplo.es`, totalAmount: 10, status: 'PENDING',
      tickets: { create: [{ eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-${slot}-1`, holderName: 'Ana Pérez', status: 'PENDING' }] },
    },
  });
}

beforeAll(async () => {
  await ensureTenantDatabases();
}, 180_000);
beforeEach(async () => {
  env = enablePlatformEnv();
  ctl.queue.length = 0;
  ctl.mails.length = 0;
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  env.restore();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('el email tras la respuesta conserva el cliente (modo plataforma)', () => {
  it('entradas: la tarea posterior se ejecuta FUERA del contexto de la petición y aun así escribe en la BD de su cliente (y solo en ella)', async () => {
    const a = await pendingOrder('a');
    const b = await pendingOrder('b');
    await onA(() => completeOrder(a.id));
    await onB(() => completeOrder(b.id));
    expect(ctl.mails).toHaveLength(0); // diferido: nada enviado todavía
    expect(ctl.queue).toHaveLength(2);

    // Como hace `after`: las tareas corren más tarde, sin el contexto de ninguna petición.
    for (const task of ctl.queue.splice(0)) await task();

    expect(ctl.mails.map((m) => m.to).sort()).toEqual(['ana-a@ejemplo.es', 'ana-b@ejemplo.es']);
    expect((await tenantClient('a').order.findUnique({ where: { id: a.id } }))?.emailSentAt).toBeTruthy();
    expect((await tenantClient('b').order.findUnique({ where: { id: b.id } }))?.emailSentAt).toBeTruthy();
    expect(await onA(() => getEmailState('entradas', a.id))).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await onA(() => getEmailState('entradas', b.id))).toBeNull(); // el pedido de B no existe en la BD de A
  });

  it('tienda: los marcadores de envío quedan en la BD del cliente que compró, no en la de otro', async () => {
    const db = tenantClient('a');
    const product = await db.product.create({ data: { name: 'Camiseta', slug: 'camiseta', price: 10, variants: { create: { size: 'M', color: '', stock: 5 } } } });
    const o = await db.shopOrder.create({
      data: { buyerName: 'Luis', buyerEmail: 'luis@ejemplo.es', shippingAddress: 'x', shippingCity: 'x', shippingZip: '28001', totalAmount: 10, status: 'PENDING', items: { create: { productId: product.id, quantity: 1, unitPrice: 10, size: 'M', color: '' } } },
    });
    await onA(() => completeShopOrder(o.id));
    // La anotación «se le debe un email» ya está (misma transacción que el pago); el envío está diferido.
    expect((await tenantClient('a').processedWebhookEvent.findMany({ where: { id: { startsWith: 'email:shop:' } } })).map((r) => r.id)).toEqual([`email:shop:${o.id}:due`]);
    for (const task of ctl.queue.splice(0)) await task();
    expect(ctl.mails.map((m) => m.subject)).toEqual([expect.stringMatching(/Pedido confirmado/)]);
    const markersA = (await tenantClient('a').processedWebhookEvent.findMany({ where: { id: { startsWith: 'email:shop:' } } })).map((r) => r.id).sort();
    expect(markersA).toEqual([`email:shop:${o.id}`, `email:shop:${o.id}:due`, `email:shop:${o.id}:try:1`].sort());
    expect(await tenantClient('b').processedWebhookEvent.count()).toBe(0);
  });
});
