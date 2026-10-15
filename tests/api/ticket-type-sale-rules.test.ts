import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'taquilla-rules-test', role: 'TAQUILLA', email: 'taquilla-rules@test.local' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: createOrder } = await import('@/app/api/orders/route');
const { POST: taquillaSale } = await import('@/app/api/taquilla/sale/route');

const json = (url: string, body: unknown, ip = '203.0.113.50') =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

// AUDIT: un tipo de entrada desactivado en el admin se podía comprar llamando a la API a mano (la web solo lo oculta), y la taquilla
// aceptaba un tipo de entrada de OTRO evento: vendía la entrada contra el aforo equivocado y subía el contador de ventas del evento
// ajeno. Severidad: Alto (venta de algo que el organizador había retirado; contadores corruptos).
describe('Reglas de venta por tipo de entrada', () => {
  let originalGateway: string | null;
  let originalCommission: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let otherEvent: Awaited<ReturnType<typeof createTestEvent>>;
  let inactiveType: Awaited<ReturnType<typeof createTicketType>>;
  let foreignType: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    originalGateway = await getAndSetConfig('payment_gateway', 'mock');
    originalCommission = await getAndSetConfig('commission_percentage', '0');
    event = await createTestEvent();
    otherEvent = await createTestEvent();
    inactiveType = await createTicketType(event.id, { maxQuantity: 10, price: 10 });
    await prisma.ticketType.update({ where: { id: inactiveType.id }, data: { isActive: false } });
    foreignType = await createTicketType(otherEvent.id, { maxQuantity: 10, price: 10 });
  });

  afterAll(async () => {
    await restoreConfig('payment_gateway', originalGateway);
    await restoreConfig('commission_percentage', originalCommission);
    await cleanupTestEvent(event.id);
    await cleanupTestEvent(otherEvent.id);
  });

  it('POST /api/orders rechaza un tipo de entrada desactivado', async () => {
    const res = await createOrder(
      json('http://localhost/api/orders', {
        eventId: event.id,
        buyerName: 'Ana',
        buyerLastName: 'García',
        buyerEmail: 'ana-inactiva@example.com',
        items: [{ ticketTypeId: inactiveType.id, quantity: 1 }],
      })
    );
    expect(res.status).toBe(400);
    expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(0);
    expect((await prisma.ticketType.findUnique({ where: { id: inactiveType.id } }))?.soldCount).toBe(0);
  });

  it('POST /api/taquilla/sale rechaza un tipo de entrada de otro evento y no toca su contador', async () => {
    const res = await taquillaSale(
      json('http://localhost/api/taquilla/sale', {
        eventId: event.id,
        buyerName: 'Luis',
        buyerLastName: 'Pérez',
        buyerEmail: '',
        items: [{ ticketTypeId: foreignType.id, quantity: 1 }],
        paymentMethod: 'cash',
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(0);
    expect((await prisma.ticketType.findUnique({ where: { id: foreignType.id } }))?.soldCount).toBe(0);
  });
});
