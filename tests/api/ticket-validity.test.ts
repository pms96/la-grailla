import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { orderAccessQuery, ticketAccessQuery } from '@/lib/access-token';
import { ticketUnusable } from '@/lib/ticket-validity';
import bcrypt from 'bcryptjs';

const scannerEmail = `validity-test-${Date.now()}@test.local`;
let scannerUserId: string;

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: scannerUserId, role: 'TAQUILLA', email: scannerEmail } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
// Las credenciales de Wallet no existen en el entorno de pruebas: lo que se comprueba aquí es que NO se llega a emitir nada para un pedido que no vale.
const buildApplePass = vi.hoisted(() => vi.fn(async () => Buffer.from('pkpass')));
const buildGoogleWalletSaveUrl = vi.hoisted(() => vi.fn(async () => 'https://pay.google.com/gp/v/save/jwt'));
vi.mock('@/lib/wallet', async (orig) => ({ ...(await orig<typeof import('@/lib/wallet')>()), buildApplePass, buildGoogleWalletSaveUrl }));

const { POST: scanTicket } = await import('@/app/api/scan/route');
const { GET: pdfHtml } = await import('@/app/api/tickets/[orderId]/pdf-html/route');
const { GET: appleWallet } = await import('@/app/api/wallet/apple/[ticketId]/route');
const { GET: googleWallet } = await import('@/app/api/wallet/google/[ticketId]/route');
const { GET: doorEvents } = await import('@/app/api/access/events/route');

/* P1-02: la validez de una entrada la decide el estado del PEDIDO y del EVENTO, no solo el de la entrada. Un pedido reembolsado desde el panel de la
 * pasarela, o anulado a medias, deja la entrada en VALID: ni el escáner, ni el PDF, ni Wallet pueden darla por buena. */

const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.77`;
const scan = (body: unknown) =>
  scanTicket(new Request('http://localhost/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) }));

describe('ticketUnusable (regla pura)', () => {
  it('solo un pedido COMPLETED de un evento no cancelado vale', () => {
    expect(ticketUnusable({ status: 'COMPLETED' }, { status: 'PUBLISHED' })).toBeNull();
    expect(ticketUnusable({ status: 'COMPLETED' }, { status: 'FINISHED' })).toBeNull(); // un evento ya cerrado no impide validar
    expect(ticketUnusable({ status: 'COMPLETED' }, undefined)).toBeNull();
  });
  it.each([
    ['PENDING', 'order_pending'],
    ['CANCELLED', 'order_cancelled'],
    ['REFUNDED', 'order_refunded'],
  ])('pedido %s → %s', (status, reason) => {
    expect(ticketUnusable({ status }, { status: 'PUBLISHED' })?.reason).toBe(reason);
  });
  it('evento CANCELLED invalida aunque el pedido esté completo', () => {
    expect(ticketUnusable({ status: 'COMPLETED' }, { status: 'CANCELLED' })?.reason).toBe('event_cancelled');
  });
  it('sin pedido o con un estado desconocido falla cerrado', () => {
    expect(ticketUnusable(null, { status: 'PUBLISHED' })?.reason).toBe('order_cancelled');
    expect(ticketUnusable({ status: 'ALGO_NUEVO' }, { status: 'PUBLISHED' })?.reason).toBe('order_cancelled');
  });
});

describe('P1-02: escáner, PDF y Wallet respetan el estado del pedido y del evento', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;
  let n = 0;

  beforeAll(async () => {
    scannerUserId = (await prisma.user.create({ data: { email: scannerEmail, name: 'Validity', hashedPassword: await bcrypt.hash('x', 4), role: 'TAQUILLA' } })).id;
    event = await createTestEvent();
    ticketType = await createTicketType(event.id);
  });
  afterAll(async () => {
    await prisma.scanLog.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
    await prisma.user.delete({ where: { id: scannerUserId } }).catch(() => {});
  });
  beforeEach(async () => {
    await prisma.event.update({ where: { id: event.id }, data: { status: 'PUBLISHED' } });
    buildApplePass.mockClear();
    buildGoogleWalletSaveUrl.mockClear();
  });

  /** Un pedido con UNA entrada en VALID, en el estado de pedido indicado (la entrada no se toca: es el «zombi»). */
  async function mk(orderStatus: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED') {
    n += 1;
    const qrCode = `QR-VALIDITY-${Date.now()}-${n}`;
    const order = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Val', buyerLastName: 'Idity', buyerEmail: `val-${n}@example.com`, totalAmount: 10, status: orderStatus,
        tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode, holderName: 'Val Idity', status: 'VALID' } },
      },
      include: { tickets: true },
    });
    return { order, ticket: order.tickets[0], qrCode };
  }
  const pdf = (orderId: string) =>
    pdfHtml(new Request(`http://localhost/api/tickets/${orderId}/pdf-html?${orderAccessQuery(orderId)}`), { params: Promise.resolve({ orderId }) });
  const wallet = (handler: typeof appleWallet, ticketId: string) =>
    handler(new Request(`http://localhost/api/wallet/x/${ticketId}?${ticketAccessQuery(ticketId)}`), { params: Promise.resolve({ ticketId }) });

  describe('escáner', () => {
    it('un pedido COMPLETED con la entrada VALID entra (el camino normal no cambia)', async () => {
      const { qrCode, ticket } = await mk('COMPLETED');
      expect((await (await scan({ qrCode, eventId: event.id })).json()).result).toBe('VALID');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('USED');
    });

    it.each(['REFUNDED', 'CANCELLED'] as const)('pedido %s con la entrada aún VALID NO entra, queda anotado y la entrada no se marca usada', async (status) => {
      const { qrCode, ticket } = await mk(status);
      const before = (await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).currentCount;
      const res = await scan({ qrCode, eventId: event.id });
      const json = await res.json();
      expect(json.result).toBe('CANCELLED');
      expect(json.color).toBe('red');
      expect(json.message).toMatch(status === 'REFUNDED' ? /reembolsado/i : /anulado/i);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VALID');
      expect(await prisma.scanLog.count({ where: { ticketId: ticket.id, result: 'CANCELLED' } })).toBe(1);
      expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).currentCount).toBe(before); // y no cuenta en el aforo
    });

    it('pedido PENDING con la entrada VALID da «pago no confirmado»', async () => {
      const { qrCode } = await mk('PENDING');
      expect((await (await scan({ qrCode, eventId: event.id })).json()).result).toBe('PENDING_PAYMENT');
    });

    it('evento CANCELLED: no entra nadie, aunque el pedido esté completo', async () => {
      const { qrCode, ticket } = await mk('COMPLETED');
      await prisma.event.update({ where: { id: event.id }, data: { status: 'CANCELLED' } });
      const json = await (await scan({ qrCode, eventId: event.id })).json();
      expect(json.result).toBe('CANCELLED');
      expect(json.message).toMatch(/evento cancelado/i);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VALID');
    });

    it('un evento FINISHED no bloquea la validación (el personal puede cerrarlo antes que la puerta)', async () => {
      const { qrCode } = await mk('COMPLETED');
      await prisma.event.update({ where: { id: event.id }, data: { status: 'FINISHED' } });
      expect((await (await scan({ qrCode, eventId: event.id })).json()).result).toBe('VALID');
    });

    it('una entrada de OTRO evento da «otro evento» aunque ese evento esté cancelado (y no ensucia su registro de escaneos)', async () => {
      const other = await createTestEvent();
      const otherType = await createTicketType(other.id);
      const qr = `QR-VALIDITY-OTHER-${Date.now()}`;
      const o = await prisma.order.create({
        data: { eventId: other.id, buyerName: 'Ot', buyerLastName: 'Ro', buyerEmail: 'otro@example.com', totalAmount: 10, status: 'COMPLETED', tickets: { create: { eventId: other.id, ticketTypeId: otherType.id, qrCode: qr, holderName: 'Ot Ro', status: 'VALID' } } },
        include: { tickets: true },
      });
      await prisma.event.update({ where: { id: other.id }, data: { status: 'CANCELLED' } });
      const json = await (await scan({ qrCode: qr, eventId: event.id })).json();
      expect(json.result).toBe('WRONG_EVENT');
      expect(await prisma.scanLog.count({ where: { ticketId: o.tickets[0].id, result: 'CANCELLED' } })).toBe(0);
      await prisma.scanLog.deleteMany({ where: { eventId: other.id } });
      await prisma.ticketType.deleteMany({ where: { eventId: other.id } });
      await cleanupTestEvent(other.id);
    });

    it('sin `eventId` no se valida nada: 400 NO_EVENT y la entrada no se toca', async () => {
      const { qrCode, ticket } = await mk('COMPLETED');
      const res = await scan({ qrCode });
      expect(res.status).toBe(400);
      expect((await res.json()).result).toBe('NO_EVENT');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VALID');
    });
  });

  describe('lista de eventos de la puerta', () => {
    it('incluye un evento FINISHED de hace poco (se puede cerrar antes que la puerta) y no uno de hace semanas', async () => {
      const recent = await createTestEvent();
      const old = await createTestEvent();
      await prisma.event.update({ where: { id: recent.id }, data: { status: 'FINISHED', date: new Date(Date.now() - 6 * 3600_000) } });
      await prisma.event.update({ where: { id: old.id }, data: { status: 'FINISHED', date: new Date(Date.now() - 20 * 24 * 3600_000) } });
      const ids = ((await (await doorEvents()).json()) as { id: string }[]).map((e) => e.id);
      expect(ids).toContain(recent.id);
      expect(ids).not.toContain(old.id);
      await cleanupTestEvent(recent.id);
      await cleanupTestEvent(old.id);
    });
  });

  describe('PDF imprimible', () => {
    it('pedido completo: 200 con el QR', async () => {
      const { order, qrCode } = await mk('COMPLETED');
      const res = await pdf(order.id);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(qrCode);
    });

    it.each(['REFUNDED', 'CANCELLED', 'PENDING'] as const)('pedido %s: 410 con un mensaje y SIN el QR', async (status) => {
      const { order, qrCode } = await mk(status);
      const res = await pdf(order.id);
      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain('Entradas no disponibles');
      expect(html).not.toContain(qrCode);
    });

    it('evento cancelado: 410', async () => {
      const { order } = await mk('COMPLETED');
      await prisma.event.update({ where: { id: event.id }, data: { status: 'CANCELLED' } });
      expect((await pdf(order.id)).status).toBe(410);
    });
  });

  describe('pases de Wallet', () => {
    it('pedido completo: se emite el pase', async () => {
      const { ticket } = await mk('COMPLETED');
      expect((await wallet(appleWallet, ticket.id)).status).toBe(200);
      expect(buildApplePass).toHaveBeenCalledTimes(1);
      expect((await wallet(googleWallet, ticket.id)).status).toBe(307);
    });

    it.each(['REFUNDED', 'CANCELLED', 'PENDING'] as const)('pedido %s: 410 y no se genera ningún pase (Apple ni Google)', async (status) => {
      const { ticket } = await mk(status);
      const a = await wallet(appleWallet, ticket.id);
      const g = await wallet(googleWallet, ticket.id);
      expect([a.status, g.status]).toEqual([410, 410]);
      expect(await a.json()).toMatchObject({ code: expect.stringMatching(/^order_/) });
      expect(buildApplePass).not.toHaveBeenCalled();
      expect(buildGoogleWalletSaveUrl).not.toHaveBeenCalled();
    });

    it('evento cancelado: 410', async () => {
      const { ticket } = await mk('COMPLETED');
      await prisma.event.update({ where: { id: event.id }, data: { status: 'CANCELLED' } });
      const res = await wallet(appleWallet, ticket.id);
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ code: 'event_cancelled' });
    });
  });
});
