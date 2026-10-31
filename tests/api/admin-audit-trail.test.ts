import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTIONS } from '@/lib/admin-audit';

const ACTOR = 'audit-trail-test';
const ACTOR_EMAIL = 'audit-trail-test@example.com';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: ACTOR, email: ACTOR_EMAIL, role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
// Pasarela falsa: «verificar» un pedido pregunta a la pasarela, y ningún test sale a la red.
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return {
    ...actual,
    getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)),
    getPaymentProvider: async (s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProvider(s)),
  };
});

const { PUT: putConfig } = await import('@/app/api/admin/config/route');
const { PATCH: patchOrder } = await import('@/app/api/admin/orders/[id]/route');
const { PUT: putShopOrder } = await import('@/app/api/admin/shop-orders/[id]/route');
const { POST: cancelEvent } = await import('@/app/api/admin/events/[id]/cancel/route');
const { PATCH: patchTemporada } = await import('@/app/api/admin/compras/temporadas/[id]/route');
const { POST: createIngreso } = await import('@/app/api/admin/ingresos/route');
const { POST: createUser } = await import('@/app/api/admin/users/route');
const { PUT: updateUser, DELETE: deleteUser } = await import('@/app/api/admin/users/[id]/route');
const { POST: createRole } = await import('@/app/api/admin/roles/route');
const { PUT: updateRole, DELETE: deleteRole } = await import('@/app/api/admin/roles/[id]/route');

const json = (method: string, body?: unknown) =>
  new Request('http://localhost', { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const rastro = (where: Record<string, unknown>) => prisma.adminAuditLog.findMany({ where: { actorId: ACTOR, ...where }, orderBy: { createdAt: 'asc' } });

/* OB-12 / P1-16: reembolsos, cambios de configuración (pasarela, claves, SMTP), usuarios y roles dejan rastro: quién, qué y cuándo, SIN secretos. */
describe('registro de auditoría de acciones sensibles', () => {
  const SECRET_VALUE = 'sk-secreto-que-no-debe-aparecer-9f3a';
  const TOUCHED = ['abacus_ai_api_key', 'jornada_corte_hora'];
  const originalConfig = new Map<string, string | undefined>();
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    for (const key of TOUCHED) originalConfig.set(key, (await prisma.appConfig.findUnique({ where: { key } }))?.value);
    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 20 });
  });

  afterAll(async () => {
    for (const key of TOUCHED) {
      const v = originalConfig.get(key);
      if (v === undefined) await prisma.appConfig.delete({ where: { key } }).catch(() => {});
      else await prisma.appConfig.update({ where: { key }, data: { value: v } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.accessRole.deleteMany({ where: { id: { in: createdRoles } } });
    await cleanupTestEvent(event.id);
    await prisma.adminAuditLog.deleteMany({ where: { actorId: ACTOR } });
  });

  describe('configuración', () => {
    it('anota los NOMBRES de las claves cambiadas y nunca el valor de un secreto', async () => {
      const res = await putConfig(json('PUT', { configs: [{ key: 'abacus_ai_api_key', value: SECRET_VALUE }, { key: 'jornada_corte_hora', value: '6' }] }));
      expect(res.status).toBe(200);

      const filas = await rastro({ action: 'config.update' });
      expect(filas).toHaveLength(1);
      const meta = filas[0].meta as { claves: string[]; sensibles: string[]; valores: Record<string, { to: string }> };
      expect(meta.claves).toEqual(expect.arrayContaining(['abacus_ai_api_key', 'jornada_corte_hora']));
      expect(meta.sensibles).toEqual(['abacus_ai_api_key']);
      expect(meta.valores.jornada_corte_hora.to).toBe('6');
      expect(meta.valores.abacus_ai_api_key).toBeUndefined();
      expect(JSON.stringify(filas[0])).not.toContain(SECRET_VALUE);
    });

    it('guardar sin cambios reales no escribe una fila nueva', async () => {
      const antes = (await rastro({ action: 'config.update' })).length;
      await putConfig(json('PUT', { configs: [{ key: 'jornada_corte_hora', value: '6' }] }));
      expect((await rastro({ action: 'config.update' })).length).toBe(antes);
    });

    it('un cambio de valor sí se anota con de → a', async () => {
      await putConfig(json('PUT', { configs: [{ key: 'jornada_corte_hora', value: '4' }] }));
      const ultima = (await rastro({ action: 'config.update' })).at(-1)!;
      expect((ultima.meta as { valores: Record<string, unknown> }).valores).toEqual({ jornada_corte_hora: { from: '6', to: '4' } });
    });
  });

  describe('pedidos', () => {
    const crearPedido = (status: 'PENDING' | 'COMPLETED', buyerEmail: string, extra: Record<string, unknown> = {}) =>
      prisma.order.create({
        data: {
          eventId: event.id, buyerName: 'Rastro', buyerLastName: 'Test', buyerEmail, totalAmount: 25, status, ...extra,
          tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-AUDIT-${Date.now()}-${Math.random()}`, holderName: 'Rastro Test', status: 'VALID' } },
        },
      });

    it('cancelar un pedido deja rastro con el objetivo', async () => {
      const order = await crearPedido('PENDING', 'rastro-cancel@example.com');
      const res = await patchOrder(json('PATCH', { action: 'cancel' }), ctx(order.id));
      expect(res.status).toBe(200);
      const [fila] = await rastro({ action: 'order.cancel', targetId: order.id });
      expect(fila).toMatchObject({ targetType: 'Order', actorEmail: ACTOR_EMAIL });
    });

    it('cambiar el email del comprador se anota sin guardar el email (dato personal)', async () => {
      const order = await crearPedido('COMPLETED', 'rastro-antes@example.com');
      const res = await patchOrder(json('PATCH', { action: 'update-email', email: 'rastro-despues@example.com' }), ctx(order.id));
      expect(res.status).toBe(200);
      const [fila] = await rastro({ action: 'order.update_email', targetId: order.id });
      expect(fila.meta).toEqual({ campo: 'buyerEmail' });
      expect(JSON.stringify(fila)).not.toMatch(/rastro-(antes|despues)@example\.com/);
    });

    it('cancelar un pedido de tienda deja rastro con el importe y sin datos del comprador', async () => {
      const shop = await prisma.shopOrder.create({
        data: {
          buyerName: '[TEST] Rastro Tienda', buyerEmail: 'rastro-tienda@example.com', shippingAddress: 'Calle Test 1', shippingCity: 'Madrid',
          shippingZip: '28001', totalAmount: 42, status: 'PENDING',
        },
      });
      try {
        const res = await putShopOrder(json('PUT', { status: 'CANCELLED' }), ctx(shop.id));
        expect(res.status).toBe(200);
        const [fila] = await rastro({ action: 'order.shop_cancel', targetId: shop.id });
        expect(fila).toMatchObject({ targetType: 'ShopOrder' });
        expect(fila.meta).toMatchObject({ totalAmount: 42 });
        expect(JSON.stringify(fila)).not.toMatch(/rastro-tienda@example\.com|Rastro Tienda/);
      } finally {
        await prisma.shopOrder.delete({ where: { id: shop.id } }).catch(() => {});
      }
    });

    // H-146: antes ninguna de estas acciones (dinero y estado de pedidos) tenía una aserción sobre su fila: borrar el rastro de la ruta dejaba la suite en verde.
    it('marcar un pedido como pagado deja rastro con el objetivo', async () => {
      const order = await crearPedido('PENDING', 'rastro-complete@example.com');
      const res = await patchOrder(json('PATCH', { action: 'complete' }), ctx(order.id));
      expect(res.status).toBe(200);
      const [fila] = await rastro({ action: 'order.complete', targetId: order.id });
      expect(fila).toMatchObject({ targetType: 'Order', actorId: ACTOR, actorEmail: ACTOR_EMAIL });
    });

    it('reembolsar un pedido deja rastro con el importe y el medio de pago, sin datos del comprador', async () => {
      const order = await crearPedido('COMPLETED', 'rastro-refund@example.com', { paymentMethod: 'CASH', channel: 'TAQUILLA' });
      const res = await patchOrder(json('PATCH', { action: 'refund' }), ctx(order.id));
      expect(res.status).toBe(200);
      const [fila] = await rastro({ action: 'order.refund', targetId: order.id });
      expect(fila).toMatchObject({ targetType: 'Order' });
      expect(fila.meta).toMatchObject({ totalAmount: 25, paymentMethod: 'CASH' });
      expect(JSON.stringify(fila)).not.toMatch(/rastro-refund@example\.com|Rastro Test/);
    });

    it('verificar un pedido contra la pasarela deja rastro', async () => {
      gateway.reset();
      gateway.active = true;
      try {
        const paymentId = `cs_audit_verify_${Date.now()}`;
        gateway.script(paymentId, { success: true, paymentId, provider: 'stripe', status: 'PAID', amount: 25, currency: 'EUR' });
        const order = await crearPedido('PENDING', 'rastro-verify@example.com', { paymentProvider: 'stripe', paymentId });
        const res = await patchOrder(json('PATCH', { action: 'verify' }), ctx(order.id));
        expect(res.status).toBe(200);
        const [fila] = await rastro({ action: 'order.verify', targetId: order.id });
        expect(fila).toMatchObject({ targetType: 'Order' });
      } finally {
        gateway.reset();
      }
    });

    it('reembolsar un pedido de tienda deja rastro con el importe y sin datos del comprador', async () => {
      const shop = await prisma.shopOrder.create({
        data: {
          buyerName: '[TEST] Rastro Reembolso', buyerEmail: 'rastro-tienda-refund@example.com', shippingAddress: 'Calle Test 2', shippingCity: 'Madrid',
          shippingZip: '28001', totalAmount: 33, status: 'PAID',
        },
      });
      try {
        const res = await putShopOrder(json('PUT', { status: 'REFUNDED' }), ctx(shop.id));
        expect(res.status).toBe(200);
        const [fila] = await rastro({ action: 'order.shop_refund', targetId: shop.id });
        expect(fila).toMatchObject({ targetType: 'ShopOrder' });
        expect(fila.meta).toMatchObject({ totalAmount: 33 });
        expect(JSON.stringify(fila)).not.toMatch(/rastro-tienda-refund@example\.com|Rastro Reembolso/);
      } finally {
        await prisma.shopOrder.delete({ where: { id: shop.id } }).catch(() => {});
      }
    });

    it('una acción que falla no deja rastro', async () => {
      const antes = (await rastro({ action: 'order.complete' })).length;
      const res = await patchOrder(json('PATCH', { action: 'complete' }), ctx('no-existe'));
      expect(res.status).toBe(404);
      expect((await rastro({ action: 'order.complete' })).length).toBe(antes);
    });
  });

  describe('eventos, temporadas e ingresos (H-146)', () => {
    it('cancelar un evento deja rastro con las opciones elegidas', async () => {
      const res = await cancelEvent(json('POST', { action: 'start', refund: false, notify: false }), ctx(event.id));
      expect(res.status).toBe(200);
      const [fila] = await rastro({ action: 'event.cancel', targetId: event.id });
      expect(fila).toMatchObject({ targetType: 'Event' });
      expect(fila.meta).toMatchObject({ refund: false, notify: false });
      await prisma.appConfig.deleteMany({ where: { key: `event_cancellation:${event.id}` } });
    });

    it('cambiar los datos de una temporada deja rastro con de → a, y un ingreso nuevo también', async () => {
      const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Rastro temporada', anio: 2094 } });
      await prisma.user.upsert({ where: { id: ACTOR }, update: {}, create: { id: ACTOR, email: ACTOR_EMAIL, role: 'ADMIN' } }); // el ingreso guarda quién lo creó (clave foránea)
      try {
        const res = await patchTemporada(json('PATCH', { nombre: '[TEST] Rastro temporada 2' }), ctx(temporada.id));
        expect(res.status).toBe(200);
        const [cambio] = await rastro({ action: 'temporada.update', targetId: temporada.id });
        expect(cambio).toMatchObject({ targetType: 'Temporada' });
        expect(JSON.stringify(cambio.meta)).toContain('[TEST] Rastro temporada 2');

        const alta = await createIngreso(json('POST', { temporadaId: temporada.id, concepto: '[TEST] Caja rastro', importe: 12, fecha: '2026-09-25' }));
        expect(alta.status).toBe(200);
        const { id } = await alta.json();
        const [ingreso] = await rastro({ action: 'ingreso.create', targetId: id });
        expect(ingreso).toMatchObject({ targetType: 'Ingreso', actorEmail: ACTOR_EMAIL });
      } finally {
        await prisma.ingreso.deleteMany({ where: { temporadaId: temporada.id } });
        await prisma.temporada.delete({ where: { id: temporada.id } }).catch(() => {});
        await prisma.user.delete({ where: { id: ACTOR } }).catch(() => {});
      }
    });
  });

  // H-146: que cada acción de AUDIT_ACTIONS esté al menos nombrada en un test de integración (tests/api). No prueba que la aserción sea la correcta,
  // pero una acción nueva sin ningún test de ruta falla aquí en vez de pasar inadvertida.
  describe('cobertura del registro', () => {
    it('cada acción de AUDIT_ACTIONS aparece en algún test de tests/api', () => {
      const dir = join(process.cwd(), 'tests/api');
      const fuentes = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
      const sinTest = AUDIT_ACTIONS.filter((a) => !fuentes.includes(`'${a}'`));
      expect(sinTest).toEqual([]);
    });
  });

  describe('usuarios', () => {
    it('alta, cambio (con contraseña) y baja: rastro sin contraseñas ni hashes', async () => {
      const PASSWORD = 'contraseña-secreta-123';
      const alta = await createUser(json('POST', { email: 'rastro-usuario@example.com', password: PASSWORD, name: 'Rastro', role: 'ADMIN' }));
      expect(alta.status).toBe(200);
      const { id } = await alta.json();
      createdUsers.push(id);
      const [creado] = await rastro({ action: 'user.create', targetId: id });
      expect(creado.meta).toMatchObject({ email: 'rastro-usuario@example.com', role: 'ADMIN' });

      const NUEVA = 'otra-contraseña-secreta-456';
      const cambio = await updateUser(json('PUT', { password: NUEVA, name: 'Rastro 2' }), ctx(id));
      expect(cambio.status).toBe(200);
      const [modificado] = await rastro({ action: 'user.update', targetId: id });
      expect(modificado.meta).toMatchObject({ contrasenaCambiada: true, sessionsRevoked: true });

      const baja = await deleteUser(json('DELETE'), ctx(id));
      expect(baja.status).toBe(200);
      const [eliminado] = await rastro({ action: 'user.delete', targetId: id });
      expect(eliminado.meta).toMatchObject({ email: 'rastro-usuario@example.com' });

      const todo = JSON.stringify(await rastro({ targetId: id }));
      expect(todo).not.toContain(PASSWORD);
      expect(todo).not.toContain(NUEVA);
      expect(todo).not.toMatch(/\$2[aby]\$/);
    });
  });

  describe('roles', () => {
    it('crear, cambiar y borrar un rol personalizado deja rastro con de → a', async () => {
      const alta = await createRole(json('POST', { name: '[TEST] Rol de rastro', modules: ['contabilidad'] }));
      expect(alta.status).toBe(201);
      const { id } = await alta.json();
      createdRoles.push(id);
      expect((await rastro({ action: 'role.create', targetId: id }))[0].meta).toMatchObject({ name: '[TEST] Rol de rastro', modules: ['contabilidad'] });

      const cambio = await updateRole(json('PUT', { name: '[TEST] Rol de rastro 2', modules: ['contabilidad', 'tienda'] }), ctx(id));
      expect(cambio.status).toBe(200);
      expect((await rastro({ action: 'role.update', targetId: id }))[0].meta).toEqual({
        name: { from: '[TEST] Rol de rastro', to: '[TEST] Rol de rastro 2' },
        modules: { from: ['contabilidad'], to: ['contabilidad', 'tienda'] },
      });

      expect((await deleteRole(json('DELETE'), ctx(id))).status).toBe(200);
      expect((await rastro({ action: 'role.delete', targetId: id }))[0].meta).toMatchObject({ name: '[TEST] Rol de rastro 2' });
    });
  });
});
