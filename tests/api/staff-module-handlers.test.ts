import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { orderAccessQuery, ticketAccessQuery } from '@/lib/access-token';

type TestSession = { user: { id: string; role: string; email: string; modules: string[] | null } } | null;
let session: TestSession = null;
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/wallet', async (orig) => ({ ...(await orig<typeof import('@/lib/wallet')>()), buildApplePass: async () => Buffer.from('pkpass'), buildGoogleWalletSaveUrl: async () => 'https://pay.google.com/x' }));

const { POST: scan } = await import('@/app/api/scan/route');
const { POST: sale } = await import('@/app/api/taquilla/sale/route');
const { GET: listInvitations, POST: createInvitation } = await import('@/app/api/invitations/route');
const { GET: listGuestLists } = await import('@/app/api/guest-lists/route');
const { GET: doorEvents } = await import('@/app/api/access/events/route');
const { GET: doorCapacity } = await import('@/app/api/access/capacity/route');
const { GET: orderGet } = await import('@/app/api/orders/[orderId]/route');
const { GET: pdfHtml } = await import('@/app/api/tickets/[orderId]/pdf-html/route');
const { GET: appleWallet } = await import('@/app/api/wallet/apple/[ticketId]/route');
const { GET: eventsList } = await import('@/app/api/events/route');

/* P1-03, red de seguridad EN LOS HANDLERS: aunque el middleware no llegara a aplicarse (p. ej. una variante de ruta que no normaliza), un ADMIN con un rol
 * restringido SIN Entradas no puede usar las APIs de personal ni leer los pedidos de los compradores. El personal de puerta (TAQUILLA, que trae
 * `modules: null` igual que el propietario) y el propietario no se ven afectados. */

const as = (role: 'ADMIN' | 'TAQUILLA', modules: string[] | null): TestSession => ({ user: { id: 'u-test', role, email: 'u@test.local', modules } });
const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.88`;
const json = (url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('APIs de personal: un rol restringido sin Entradas no pasa en el handler', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;
  let orderId: string;
  let ticketId: string;

  beforeAll(async () => {
    event = await createTestEvent();
    ticketType = await createTicketType(event.id);
    const order = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Pri', buyerLastName: 'Vado', buyerEmail: 'privado@example.com', totalAmount: 10, status: 'COMPLETED',
        tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-MODS-${Date.now()}`, holderName: 'Pri Vado', status: 'VALID' } },
      },
      include: { tickets: true },
    });
    orderId = order.id;
    ticketId = order.tickets[0].id;
  });
  afterAll(async () => {
    await prisma.scanLog.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });
  beforeEach(() => {
    session = null;
  });

  const STAFF_CALLS: [string, () => Promise<Response>][] = [
    ['scan', () => scan(json('/api/scan', { qrCode: 'x', eventId: event.id }))],
    ['taquilla/sale', () => sale(json('/api/taquilla/sale', { eventId: event.id, items: [{ ticketTypeId: ticketType.id, quantity: 1 }], buyerName: 'X', paymentMethod: 'CASH' }))],
    ['invitations GET', () => listInvitations(json('/api/invitations'))],
    ['invitations POST', () => createInvitation(json('/api/invitations', { eventId: event.id, guestName: 'Invitado', quantity: 1 }))],
    ['guest-lists GET', () => listGuestLists(json('/api/guest-lists'))],
    ['access/events', () => doorEvents()],
    ['access/capacity', () => doorCapacity(json(`/api/access/capacity?eventId=${event.id}`))],
  ];

  it.each(STAFF_CALLS)('%s: un gestor de tienda recibe 401/403 y no se crea nada', async (_name, call) => {
    session = as('ADMIN', ['tienda']);
    const res = await call();
    expect([401, 403]).toContain(res.status);
    expect(await prisma.invitation.count({ where: { eventId: event.id } })).toBe(0);
  });

  it.each(STAFF_CALLS)('%s: un rol restringido CON Entradas pasa la comprobación de módulo', async (_name, call) => {
    session = as('ADMIN', ['entradas']);
    expect([401, 403]).not.toContain((await call()).status);
  });

  it('el personal de puerta (TAQUILLA, modules nulo) y el propietario pasan la comprobación de módulo', async () => {
    for (const s of [as('TAQUILLA', null), as('ADMIN', null)]) {
      session = s;
      expect([401, 403]).not.toContain((await scan(json('/api/scan', { qrCode: 'x', eventId: event.id }))).status);
      expect((await doorEvents()).status).toBe(200);
    }
  });
});

describe('APIs con token de comprador: el fallback de personal exige el módulo', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let orderId: string;
  let ticketId: string;

  beforeAll(async () => {
    event = await createTestEvent();
    const tt = await createTicketType(event.id);
    const order = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Pri', buyerLastName: 'Vado', buyerEmail: 'privado2@example.com', totalAmount: 10, status: 'COMPLETED',
        tickets: { create: { eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-MODS2-${Date.now()}`, holderName: 'Pri Vado', status: 'VALID' } },
      },
      include: { tickets: true },
    });
    orderId = order.id;
    ticketId = order.tickets[0].id;
  });
  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });
  beforeEach(() => {
    session = null;
  });

  const noToken = {
    order: () => orderGet(json(`/api/orders/${orderId}`), { params: Promise.resolve({ orderId }) }),
    pdf: () => pdfHtml(json(`/api/tickets/${orderId}/pdf-html`), { params: Promise.resolve({ orderId }) }),
    wallet: () => appleWallet(json(`/api/wallet/apple/${ticketId}`), { params: Promise.resolve({ ticketId }) }),
  };

  it.each(Object.entries(noToken))('%s: SIN token, un contable (rol restringido sin Entradas) NO puede leerlo', async (_n, call) => {
    session = as('ADMIN', ['contabilidad']);
    expect((await call()).status).toBe(401);
  });

  it.each(Object.entries(noToken))('%s: sin token, el propietario, un gestor de entradas y la taquilla SÍ', async (_n, call) => {
    for (const s of [as('ADMIN', null), as('ADMIN', ['entradas']), as('TAQUILLA', null)]) {
      session = s;
      expect((await call()).status, JSON.stringify(s?.user.modules)).toBe(200);
    }
  });

  it('con el token del comprador funciona sin sesión (no cambia nada para el comprador)', async () => {
    session = null;
    expect((await pdfHtml(json(`/api/tickets/${orderId}/pdf-html?${orderAccessQuery(orderId)}`), { params: Promise.resolve({ orderId }) })).status).toBe(200);
    expect((await appleWallet(json(`/api/wallet/apple/${ticketId}?${ticketAccessQuery(ticketId)}`), { params: Promise.resolve({ ticketId }) })).status).toBe(200);
  });

  it('los borradores de eventos solo los ve un ADMIN con Entradas', async () => {
    const draft = await createTestEvent({ status: 'DRAFT' });
    try {
      for (const [s, sees] of [[as('ADMIN', ['tienda']), false], [as('ADMIN', ['entradas']), true], [as('ADMIN', null), true]] as const) {
        session = s;
        const res = await eventsList(json('/api/events?status=DRAFT'));
        const body = (await res.json()) as unknown;
        const ids = Array.isArray(body) ? (body as { id: string }[]).map((e) => e.id) : [];
        expect(ids.includes(draft.id), JSON.stringify(s?.user.modules)).toBe(sees);
      }
    } finally {
      await cleanupTestEvent(draft.id);
    }
  });
});
