import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/prisma';
import { AUDIT_ACTIONS } from '@/lib/admin-audit';
import { purgeAuditLog } from '../helpers/audit';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

/* H-253: una venta de taquilla «durante el evento» crea las entradas ya usadas y la app no dejaba anular un pedido con entradas usadas: un error de cantidad o de método solo se corregía con
 * un ingreso negativo manual y la caja del día quedaba inflada. Ahora el PROPIETARIO puede anular una venta de puerta, con motivo y rastro, ajustando en una transacción el pedido, las entradas,
 * lo vendido por tipo y el aforo en puerta. La caja, las ventas por día y las estadísticas se corrigen solas porque cuentan pedidos COMPLETED. */

const ACTOR = 'void-door-sale-test';
const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string; modules?: string[] | null } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => (session.user ? { user: session.user } : null)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
const licence = vi.hoisted(() => ({ restricted: false }));
vi.mock('@/lib/modules/runtime', async (orig) => ({ ...(await orig<typeof import('@/lib/modules/runtime')>()), isFullAccessRestricted: () => licence.restricted }));

const { PATCH: patchOrder, GET: getAdminOrder } = await import('@/app/api/admin/orders/[id]/route');
const { isVoidableDoorSale } = await import('@/lib/door-sale-void');

const REASON = 'Cantidad mal tecleada: eran 2 entradas, no 3';
const eventIds: string[] = [];
const temporadaIds: string[] = [];

type Sale = { eventId: string; orderId: string; ticketTypeId: string };

async function doorSale(opts: { qty?: number; used?: number; channel?: string; method?: 'CASH' | 'CARD' | 'FREE'; provider?: string | null; status?: 'COMPLETED' | 'CANCELLED'; temporadaId?: string; currentCount?: number } = {}): Promise<Sale> {
  const qty = opts.qty ?? 3;
  const used = opts.used ?? qty;
  const event = await createTestEvent({ maxCapacity: 50 });
  eventIds.push(event.id);
  const tt = await createTicketType(event.id, { maxQuantity: 50, price: 10 });
  const order = await prisma.order.create({
    data: {
      eventId: event.id, buyerName: 'Entrada directa', buyerLastName: '', buyerEmail: 'taquilla@interno.local', totalAmount: qty * 10, commission: 0, paymentMethod: opts.method ?? 'CASH',
      status: opts.status ?? 'COMPLETED', channel: opts.channel ?? 'TAQUILLA', soldById: 'staff-h253', idempotencyKey: `h253-${event.id}`,
      paymentProvider: opts.provider ?? null, paymentId: opts.provider ? `pay_${event.id}` : null,
      tickets: { create: Array.from({ length: qty }, (_, i) => ({ eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-H253-${event.id}-${i}`, holderName: 'Entrada directa', status: i < used ? ('USED' as const) : ('VALID' as const), entryTime: i < used ? new Date() : null })) },
    },
  });
  await prisma.ticketType.update({ where: { id: tt.id }, data: { soldCount: qty } });
  await prisma.event.update({ where: { id: event.id }, data: { currentCount: opts.currentCount ?? used, temporadaId: opts.temporadaId ?? null } });
  return { eventId: event.id, orderId: order.id, ticketTypeId: tt.id };
}

const call = (orderId: string, body: Record<string, unknown>) =>
  patchOrder(new Request(`http://localhost/api/admin/orders/${orderId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: orderId }) });
const voidSale = (orderId: string, reason: unknown = REASON) => call(orderId, { action: 'void-door-sale', reason });
const state = async (s: Sale) => ({
  order: (await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status,
  tickets: (await prisma.ticket.findMany({ where: { orderId: s.orderId }, select: { status: true } })).map((t) => t.status).sort(),
  sold: (await prisma.ticketType.findUniqueOrThrow({ where: { id: s.ticketTypeId } })).soldCount,
  current: (await prisma.event.findUniqueOrThrow({ where: { id: s.eventId } })).currentCount,
});
const audit = (orderId: string) => prisma.adminAuditLog.findMany({ where: { actorId: ACTOR, action: 'order.void_door_sale', targetId: orderId } });

describe('H-253: anular una venta de taquilla de puerta', () => {
  beforeEach(() => {
    session.user = { id: ACTOR, role: 'ADMIN', modules: null }; // propietario
    licence.restricted = false;
  });
  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.order.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
    for (const id of eventIds) await cleanupTestEvent(id);
    await prisma.temporada.deleteMany({ where: { id: { in: temporadaIds } } });
    await purgeAuditLog({ actorId: ACTOR });
  });

  it('el propietario anula la venta: pedido y entradas anulados, vendidas y aforo en puerta ajustados, y rastro con motivo', async () => {
    const s = await doorSale({ qty: 3, used: 3 });
    const res = await voidSale(s.orderId);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('CANCELLED');
    expect(await state(s)).toEqual({ order: 'CANCELLED', tickets: ['CANCELLED', 'CANCELLED', 'CANCELLED'], sold: 0, current: 0 });
    const rows = await audit(s.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ motivo: REASON, totalAmount: 30, paymentMethod: 'CASH', entradas: 3, entradasUsadas: 3, estadoAnterior: 'COMPLETED' });
    expect(JSON.stringify(rows[0].meta)).not.toMatch(/interno\.local/); // sin datos personales
  });

  it('la caja del día deja de contar la venta (cuenta pedidos COMPLETED) y otra venta del mismo evento no se toca', async () => {
    const s = await doorSale({ qty: 3, used: 3 });
    const other = await prisma.order.create({
      data: { eventId: s.eventId, buyerName: 'Otra', buyerLastName: '', buyerEmail: 'taquilla@interno.local', totalAmount: 20, commission: 0, paymentMethod: 'CARD', status: 'COMPLETED', channel: 'TAQUILLA' },
    });
    const cash = () => prisma.order.aggregate({ where: { eventId: s.eventId, status: 'COMPLETED', channel: 'TAQUILLA' }, _sum: { totalAmount: true } });
    expect(Number((await cash())._sum.totalAmount)).toBe(50);
    expect((await voidSale(s.orderId)).status).toBe(200);
    expect(Number((await cash())._sum.totalAmount)).toBe(20);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('COMPLETED');
  });

  it('una venta con entradas mezcladas (2 sin usar, 1 usada): baja lo vendido de las 3 y el aforo solo de la usada', async () => {
    const s = await doorSale({ qty: 3, used: 1, currentCount: 5 });
    expect((await voidSale(s.orderId)).status).toBe(200);
    expect(await state(s)).toEqual({ order: 'CANCELLED', tickets: ['CANCELLED', 'CANCELLED', 'CANCELLED'], sold: 0, current: 4 });
  });

  it('el aforo en puerta nunca baja de cero', async () => {
    const s = await doorSale({ qty: 3, used: 3, currentCount: 1 });
    expect((await voidSale(s.orderId)).status).toBe(200);
    expect((await state(s)).current).toBe(0);
  });

  it('solo el propietario: un administrador con rol restringido recibe 403 y no cambia nada', async () => {
    const s = await doorSale();
    session.user = { id: ACTOR, role: 'ADMIN', modules: ['contabilidad'] };
    const res = await voidSale(s.orderId);
    expect(res.status).toBe(403);
    expect(await state(s)).toEqual({ order: 'COMPLETED', tickets: ['USED', 'USED', 'USED'], sold: 3, current: 3 });
    expect(await audit(s.orderId)).toHaveLength(0);
  });

  it('sin sesión de administrador: 401; la taquilla tampoco puede', async () => {
    const s = await doorSale();
    session.user = null;
    expect((await voidSale(s.orderId)).status).toBe(401);
    session.user = { id: ACTOR, role: 'TAQUILLA', modules: null };
    expect((await voidSale(s.orderId)).status).toBe(401);
    expect((await state(s)).order).toBe('COMPLETED');
  });

  it('el motivo es obligatorio (mínimo 5 caracteres, máximo 300) y no se cambia nada sin él', async () => {
    const s = await doorSale();
    expect((await call(s.orderId, { action: 'void-door-sale' })).status, 'sin motivo').toBe(400); // `voidSale(id, undefined)` usaría el motivo por defecto
    for (const bad of ['', '   ', 'abc', 'x'.repeat(301), 42]) {
      expect((await voidSale(s.orderId, bad)).status, String(bad)).toBe(400);
    }
    expect(await state(s)).toEqual({ order: 'COMPLETED', tickets: ['USED', 'USED', 'USED'], sold: 3, current: 3 });
    expect(await audit(s.orderId)).toHaveLength(0);
  });

  it('solo ventas de taquilla con entradas usadas: una venta online, o de taquilla sin usar, devuelve 422 (para eso está «Cancelar pedido»)', async () => {
    const online = await doorSale({ channel: 'ONLINE' });
    const unused = await doorSale({ qty: 2, used: 0 });
    for (const s of [online, unused]) {
      const res = await voidSale(s.orderId);
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('not_door_sale');
    }
    expect((await state(online)).order).toBe('COMPLETED');
    expect((await state(unused)).order).toBe('COMPLETED');
  });

  it('una venta pagada por la pasarela no se anula así: 422, hay que reembolsarla', async () => {
    const s = await doorSale({ method: 'CARD', provider: 'stripe' });
    const res = await voidSale(s.orderId);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('gateway_payment');
    expect((await state(s)).order).toBe('COMPLETED');
  });

  it('una venta ya anulada devuelve 409 y no vuelve a ajustar nada', async () => {
    const s = await doorSale();
    expect((await voidSale(s.orderId)).status).toBe(200);
    const again = await voidSale(s.orderId);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('already_voided');
    expect(await state(s)).toEqual({ order: 'CANCELLED', tickets: ['CANCELLED', 'CANCELLED', 'CANCELLED'], sold: 0, current: 0 });
    expect(await audit(s.orderId)).toHaveLength(1);
  });

  it('dos anulaciones a la vez: solo una se aplica y lo vendido baja una sola vez', async () => {
    const s = await doorSale({ qty: 3, used: 3, currentCount: 3 });
    const results = await Promise.all([voidSale(s.orderId), voidSale(s.orderId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await state(s)).toEqual({ order: 'CANCELLED', tickets: ['CANCELLED', 'CANCELLED', 'CANCELLED'], sold: 0, current: 0 });
    expect(await audit(s.orderId)).toHaveLength(1);
  });

  it('temporada CERRADA: 423 y no se cambia nada; con la temporada reabierta, se anula', async () => {
    const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada anular puerta', anio: 2098, status: 'CERRADA' } });
    temporadaIds.push(temporada.id);
    const s = await doorSale({ temporadaId: temporada.id });
    const locked = await voidSale(s.orderId);
    expect(locked.status).toBe(423);
    expect((await locked.json()).code).toBe('temporada_cerrada');
    expect(await state(s)).toEqual({ order: 'COMPLETED', tickets: ['USED', 'USED', 'USED'], sold: 3, current: 3 });
    expect(await audit(s.orderId)).toHaveLength(0);
    await prisma.temporada.update({ where: { id: temporada.id }, data: { status: 'ABIERTA' } });
    expect((await voidSale(s.orderId)).status).toBe(200);
  });

  it('un pedido que no existe devuelve 404', async () => {
    expect((await voidSale('pedido-inexistente')).status).toBe(404);
  });

  it('«Cancelar pedido» sigue rechazando entradas usadas: la anulación de puerta es una acción aparte', async () => {
    const s = await doorSale();
    const res = await call(s.orderId, { action: 'cancel' });
    expect(res.status).toBe(422);
    expect((await state(s)).order).toBe('COMPLETED');
  });

  it('queda registrada en el catálogo de auditoría, con etiqueta en la pantalla de auditoría', () => {
    expect(AUDIT_ACTIONS).toContain('order.void_door_sale');
    const page = readFileSync(join(process.cwd(), 'app/admin/auditoria/page.tsx'), 'utf8');
    expect(page).toMatch(/'order\.void_door_sale':/);
  });

  it('el rastro se escribe DENTRO de la misma transacción que el cambio (invariante de código)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/door-sale-void.ts'), 'utf8');
    expect(src).toMatch(/\$transaction\(/);
    expect(src).toMatch(/recordAdminAudit\(tx,/);
    expect(src).toMatch(/pg_advisory_xact_lock/); // el mismo cerrojo por evento que la venta de taquilla
    expect(src).toMatch(/checkTemporadaAbiertaTx\(tx,/);
  });

  it('el servidor dice si se puede anular (`canVoidDoorSale`): sí para el propietario en una venta de puerta; no para un rol restringido, una venta online ni una ya anulada', async () => {
    const door = await doorSale();
    const online = await doorSale({ channel: 'ONLINE' });
    const flag = async (orderId: string) => (await (await getAdminOrder(new Request('http://localhost'), { params: Promise.resolve({ id: orderId }) })).json()).canVoidDoorSale;
    expect(await flag(door.orderId)).toBe(true);
    expect(await flag(online.orderId)).toBe(false);
    session.user = { id: ACTOR, role: 'ADMIN', modules: ['contabilidad'] };
    expect(await flag(door.orderId)).toBe(false);
    session.user = { id: ACTOR, role: 'ADMIN', modules: null };
    expect((await voidSale(door.orderId)).status).toBe(200);
    expect(await flag(door.orderId)).toBe(false);
  });

  it('isVoidableDoorSale (pura): taquilla + completada + sin pasarela + alguna entrada usada', () => {
    const base = { channel: 'TAQUILLA', status: 'COMPLETED', paymentProvider: null, paymentId: null, tickets: [{ status: 'USED' }, { status: 'VALID' }] };
    expect(isVoidableDoorSale(base)).toBe(true);
    expect(isVoidableDoorSale({ ...base, channel: 'ONLINE' })).toBe(false);
    expect(isVoidableDoorSale({ ...base, status: 'CANCELLED' })).toBe(false);
    expect(isVoidableDoorSale({ ...base, paymentProvider: 'stripe', paymentId: 'pi_1' })).toBe(false);
    expect(isVoidableDoorSale({ ...base, paymentProvider: 'mock', paymentId: 'x' })).toBe(true);
    expect(isVoidableDoorSale({ ...base, tickets: [{ status: 'VALID' }] })).toBe(false);
    expect(isVoidableDoorSale({ ...base, tickets: [] })).toBe(false);
  });

  it('la pantalla de ventas enseña el botón solo si el servidor lo permite y exige el motivo (invariante de código)', () => {
    const page = readFileSync(join(process.cwd(), 'app/admin/ventas/page.tsx'), 'utf8');
    expect(page).toMatch(/detail\.canVoidDoorSale &&/);
    expect(page).toMatch(/action: 'void-door-sale'/);
    expect(page).toMatch(/disabled=\{voiding \|\| voidReason\.trim\(\)\.length < 5\}/);
    expect(page).toMatch(/no devuelve dinero/); // avisa de que la devolución del efectivo o datáfono se hace en caja
  });

  it('con la licencia vencida se puede anular (es dinero ya cobrado, como cancelar o reembolsar), pero no completar un pedido', async () => {
    const s = await doorSale();
    licence.restricted = true;
    expect((await call(s.orderId, { action: 'complete' })).status).toBe(402);
    expect((await voidSale(s.orderId)).status).toBe(200);
    expect((await state(s)).order).toBe('CANCELLED');
  });
});
