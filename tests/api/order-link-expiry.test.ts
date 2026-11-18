import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

/* H-212: los enlaces de pedido y de entrada (`?t=`) eran permanentes: un enlace filtrado (captura, historial compartido, un log con la URL) daba acceso para siempre a los QR reales y a los datos del
 * comprador. Ahora el enlace caduca ORDER_LINK_GRACE_DAYS (30) días después del evento. La caducidad se mira al ABRIR el enlace, no al emitirlo: el token no cambia de formato, así que también cubre
 * los enlaces que ya se enviaron. El personal con sesión no se ve afectado, y solo quien trae un token VÁLIDO se entera de que caducó (los demás reciben el 401 de siempre). */

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => (session.user ? { user: session.user } : null)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const {
  ORDER_LINK_GRACE_DAYS, allowOrderAccess, allowTicketAccess, allowShopOrderAccess, orderLinkExpired, signOrderAccess, signTicketAccess, signShopOrderAccess,
} = await import('@/lib/access-token');
const { GET: getOrder } = await import('@/app/api/orders/[orderId]/route');
const { GET: getPdfHtml } = await import('@/app/api/tickets/[orderId]/pdf-html/route');
const { GET: getAppleWallet } = await import('@/app/api/wallet/apple/[ticketId]/route');
const { GET: getGoogleWallet } = await import('@/app/api/wallet/google/[ticketId]/route');

const DAY = 86_400_000;
type Fixture = { eventId: string; orderId: string; ticketId: string };

describe('H-212: los enlaces de pedido y de entrada caducan después del evento', () => {
  const fixtures: Record<'future' | 'recent' | 'expired', Fixture> = {} as never;
  const eventIds: string[] = [];

  async function make(date: Date): Promise<Fixture> {
    const event = await createTestEvent({ maxCapacity: 10, date });
    eventIds.push(event.id);
    const tt = await createTicketType(event.id, { maxQuantity: 10 });
    const order = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Ana', buyerLastName: 'Gil', buyerEmail: 'h212@example.com', totalAmount: 10, status: 'COMPLETED', paymentMethod: 'CASH', channel: 'TAQUILLA',
        idempotencyKey: `h212-${event.id}`,
        tickets: { create: { eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-H212-${event.id}`, holderName: 'Ana', status: 'VALID' } },
      },
      include: { tickets: true },
    });
    return { eventId: event.id, orderId: order.id, ticketId: order.tickets[0].id };
  }

  beforeAll(async () => {
    fixtures.future = await make(new Date(Date.now() + 7 * DAY));
    fixtures.recent = await make(new Date(Date.now() - (ORDER_LINK_GRACE_DAYS - 1) * DAY)); // el evento fue hace 29 días: aún vale
    fixtures.expired = await make(new Date(Date.now() - (ORDER_LINK_GRACE_DAYS + 1) * DAY)); // hace 31 días: caducado
  });
  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.order.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
    for (const id of eventIds) await cleanupTestEvent(id);
  });
  beforeEach(() => {
    session.user = null;
  });

  const withToken = (path: string, token: string) => new Request(`http://localhost${path}?t=${encodeURIComponent(token)}`);
  const orderCtx = (orderId: string) => ({ params: Promise.resolve({ orderId }) });

  it('el plazo es de 30 días', () => {
    expect(ORDER_LINK_GRACE_DAYS).toBe(30);
  });

  it('allowOrderAccess: vale antes del evento y dentro del plazo; caduca pasado el plazo', async () => {
    expect(await allowOrderAccess(fixtures.future.orderId, signOrderAccess(fixtures.future.orderId))).toBe(true);
    expect(await allowOrderAccess(fixtures.recent.orderId, signOrderAccess(fixtures.recent.orderId))).toBe(true);
    expect(await allowOrderAccess(fixtures.expired.orderId, signOrderAccess(fixtures.expired.orderId))).toBe(false);
  });

  it('orderLinkExpired: el límite está a los 30 días exactos del evento', async () => {
    const date = (await prisma.event.findUniqueOrThrow({ where: { id: fixtures.recent.eventId } })).date.getTime();
    expect(await orderLinkExpired(fixtures.recent.orderId, date + 30 * DAY)).toBe(false);
    expect(await orderLinkExpired(fixtures.recent.orderId, date + 30 * DAY + 1)).toBe(true);
    expect(await orderLinkExpired('pedido-que-no-existe')).toBe(false);
  });

  it('allowTicketAccess: ni el token de la entrada ni el del pedido sirven después del plazo', async () => {
    const f = fixtures.expired;
    expect(await allowTicketAccess(f.ticketId, f.orderId, signTicketAccess(f.ticketId))).toBe(false);
    expect(await allowTicketAccess(f.ticketId, f.orderId, signOrderAccess(f.orderId))).toBe(false);
    const ok = fixtures.recent;
    expect(await allowTicketAccess(ok.ticketId, ok.orderId, signTicketAccess(ok.ticketId))).toBe(true);
    expect(await allowTicketAccess(ok.ticketId, ok.orderId, signOrderAccess(ok.orderId))).toBe(true);
  });

  it('el personal con sesión sigue entrando aunque el enlace haya caducado', async () => {
    const f = fixtures.expired;
    session.user = { id: 'staff-h212', role: 'ADMIN' };
    expect(await allowOrderAccess(f.orderId, null)).toBe(true);
    expect(await allowOrderAccess(f.orderId, signOrderAccess(f.orderId))).toBe(true);
    expect(await allowTicketAccess(f.ticketId, f.orderId, signTicketAccess(f.ticketId))).toBe(true);
  });

  it('GET /api/orders/[id]: 410 con un token válido pero caducado, sin datos del pedido', async () => {
    const f = fixtures.expired;
    const res = await getOrder(withToken(`/api/orders/${f.orderId}`, signOrderAccess(f.orderId)), orderCtx(f.orderId));
    const body = await res.json();
    expect(res.status).toBe(410);
    expect(body.error).toMatch(/caducado/i);
    expect(JSON.stringify(body)).not.toMatch(/h212@example\.com|Ana|QR-H212/);
  });

  it('GET /api/orders/[id]: 401 si el token no vale (no se revela que el pedido existe ni que caducó); 200 dentro del plazo', async () => {
    const f = fixtures.expired;
    const bad = await getOrder(withToken(`/api/orders/${f.orderId}`, 'token-inventado'), orderCtx(f.orderId));
    expect(bad.status).toBe(401);
    const none = await getOrder(new Request(`http://localhost/api/orders/${f.orderId}`), orderCtx(f.orderId));
    expect(none.status).toBe(401);
    for (const ok of [fixtures.future, fixtures.recent]) {
      const res = await getOrder(withToken(`/api/orders/${ok.orderId}`, signOrderAccess(ok.orderId)), orderCtx(ok.orderId));
      expect(res.status).toBe(200);
    }
  });

  it('GET /api/orders/[id]: el personal con sesión lo ve aunque haya caducado', async () => {
    const f = fixtures.expired;
    session.user = { id: 'staff-h212', role: 'ADMIN' };
    const res = await getOrder(withToken(`/api/orders/${f.orderId}`, signOrderAccess(f.orderId)), orderCtx(f.orderId));
    expect(res.status).toBe(200);
  });

  it('GET /api/tickets/[id]/pdf-html: 410 caducado y 200 dentro del plazo', async () => {
    const f = fixtures.expired;
    const gone = await getPdfHtml(withToken(`/api/tickets/${f.orderId}/pdf-html`, signOrderAccess(f.orderId)), orderCtx(f.orderId));
    expect(gone.status).toBe(410);
    const ok = fixtures.recent;
    const fine = await getPdfHtml(withToken(`/api/tickets/${ok.orderId}/pdf-html`, signOrderAccess(ok.orderId)), orderCtx(ok.orderId));
    expect(fine.status).toBe(200);
  });

  it('wallet de Apple y de Google: 410 caducado; dentro del plazo no se rechaza por el enlace', async () => {
    const f = fixtures.expired;
    const ctx = (ticketId: string) => ({ params: { ticketId } }) as never;
    for (const get of [getAppleWallet, getGoogleWallet]) {
      const gone = await get(withToken(`/api/wallet/x/${f.ticketId}`, signTicketAccess(f.ticketId)), ctx(f.ticketId));
      expect(gone.status).toBe(410);
      const ok = fixtures.recent;
      const fine = await get(withToken(`/api/wallet/x/${ok.ticketId}`, signTicketAccess(ok.ticketId)), ctx(ok.ticketId));
      expect([401, 410]).not.toContain(fine.status); // si falla es por la configuración del wallet de la prueba, no por el enlace
    }
  });

  it('los enlaces de tienda no cambian: no tienen evento y siguen valiendo', async () => {
    expect(await allowShopOrderAccess('cualquier-pedido-de-tienda', signShopOrderAccess('cualquier-pedido-de-tienda'))).toBe(true);
  });
});
