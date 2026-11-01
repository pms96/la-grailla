import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { purgeAuditLog } from '../helpers/audit';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';

const ACTOR = 'audit-integrity-test';
const ACTOR_EMAIL = 'audit-integrity-test@example.com';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: ACTOR, email: ACTOR_EMAIL, role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
// Marcar un pedido como pagado manda el email de confirmación: en este test no sale nada a ningún servidor de correo.
vi.mock('@/lib/mailer', async (orig) => ({ ...(await orig<typeof import('@/lib/mailer')>()), sendMail: async () => ({ success: true, transport: 'smtp' as const }) }));
// Pasarela falsa: el reembolso de un pedido con tarjeta pregunta a la pasarela, y ningún test sale a la red.
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return {
    ...actual,
    getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)),
    getPaymentProvider: async (s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProvider(s)),
  };
});
// H-020: el aviso de reembolso sale por correo, que puede colgarse. Aquí solo se mira QUÉ había ya en el rastro cuando se intentó enviar.
const traceWhenMailing = new Map<string, number>();
vi.mock('@/lib/reconciliation/gateway-refund', async (orig) => {
  const actual = await orig<typeof import('@/lib/reconciliation/gateway-refund')>();
  return {
    ...actual,
    sendRefundEmail: async (kind: 'entradas' | 'tienda', order: { id: string }) => {
      const { prisma: db } = await import('@/lib/prisma');
      traceWhenMailing.set(order.id, await db.adminAuditLog.count({ where: { targetId: order.id, action: kind === 'entradas' ? 'order.refund' : 'order.shop_refund' } }));
    },
  };
});
// Aceptar un patrocinio envía la invitación al portal: aquí no se manda nada.
vi.mock('@/lib/sponsor-portal', async (orig) => {
  const actual = await orig<typeof import('@/lib/sponsor-portal')>();
  return { ...actual, ensureSponsorPortalInvite: async () => ({ portalUrl: null, emailResult: { success: true } }) };
});
// H-021: permite hacer fallar la escritura del rastro DENTRO de la transacción del cambio: sin rastro no puede quedar cambio.
let failAudit = false;
vi.mock('@/lib/admin-audit', async (orig) => {
  const actual = await orig<typeof import('@/lib/admin-audit')>();
  return {
    ...actual,
    recordAdminAudit: (...args: Parameters<typeof actual.recordAdminAudit>) => {
      if (failAudit) throw new Error('auditoría caída (test)');
      return actual.recordAdminAudit(...args);
    },
  };
});

const { PUT: putConfig } = await import('@/app/api/admin/config/route');
const { PATCH: patchOrder } = await import('@/app/api/admin/orders/[id]/route');
const { PUT: putShopOrder } = await import('@/app/api/admin/shop-orders/[id]/route');
const { POST: createEvent } = await import('@/app/api/admin/events/route');
const { PUT: putEvent, DELETE: deleteEvent } = await import('@/app/api/admin/events/[id]/route');
const { POST: createTicketTypeRoute } = await import('@/app/api/admin/ticket-types/route');
const { PUT: putTicketType, DELETE: deleteTicketType } = await import('@/app/api/admin/ticket-types/[id]/route');
const { POST: createTemporada } = await import('@/app/api/admin/compras/temporadas/route');
const { PUT: putSponsor } = await import('@/app/api/admin/sponsors/[id]/route');
const { POST: markPaid } = await import('@/app/api/admin/sponsors-portal/[id]/mark-paid/route');
const { POST: createUser } = await import('@/app/api/admin/users/route');
const { PUT: updateUser, DELETE: deleteUser } = await import('@/app/api/admin/users/[id]/route');
const { POST: createRole } = await import('@/app/api/admin/roles/route');
const { PUT: updateRole, DELETE: deleteRole } = await import('@/app/api/admin/roles/[id]/route');
const { GET: exportCsv } = await import('@/app/api/admin/export/route');
const { GET: exportShopCsv } = await import('@/app/api/admin/shop-orders/export/route');

const json = (method: string, body?: unknown) =>
  new Request('http://localhost', { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
const get = (url: string) => new Request(url);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const rastro = (where: Record<string, unknown>) => prisma.adminAuditLog.findMany({ where: { actorId: ACTOR, ...where }, orderBy: { createdAt: 'asc' } });
const sinRastro = async <T,>(fn: () => Promise<T>): Promise<T> => {
  failAudit = true;
  try {
    return await fn();
  } finally {
    failAudit = false;
  }
};

describe('rastro de auditoría: cobertura e integridad (lote 4)', () => {
  const TOUCHED_CONFIG = ['smtp_password', 'jornada_corte_hora'];
  const originalConfig = new Map<string, string | undefined>();
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  const createdEvents: string[] = [];
  const createdTemporadas: string[] = [];
  const createdSponsors: string[] = [];
  let tiersBefore: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    // Restos de una ejecución anterior interrumpida (o de una mutación): los casos «sin rastro no queda nada» parten de cero.
    await prisma.user.deleteMany({ where: { email: 'sin-rastro-usuario@example.com' } });
    await prisma.accessRole.deleteMany({ where: { name: '[TEST] Rol sin rastro' } });
    await prisma.temporada.deleteMany({ where: { nombre: '[TEST] Temporada sin rastro' } });
    for (const key of TOUCHED_CONFIG) originalConfig.set(key, (await prisma.appConfig.findUnique({ where: { key } }))?.value);
    tiersBefore = await getAndSetConfig('sponsor_tiers', JSON.stringify([{ value: 'oro-test', label: 'Oro', priceLabel: '100€', priceAmount: 100 }]));
    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 20 });
    await prisma.user.upsert({ where: { id: ACTOR }, update: {}, create: { id: ACTOR, email: ACTOR_EMAIL, role: 'ADMIN' } });
  });

  afterAll(async () => {
    failAudit = false;
    gateway.reset();
    for (const key of TOUCHED_CONFIG) {
      const v = originalConfig.get(key);
      if (v === undefined) await prisma.appConfig.delete({ where: { key } }).catch(() => {});
      else await prisma.appConfig.update({ where: { key }, data: { value: v } }).catch(() => {});
    }
    await restoreConfig('sponsor_tiers', tiersBefore);
    await prisma.sponsor.deleteMany({ where: { sponsorRequestId: { in: createdSponsors } } });
    await prisma.sponsorRequest.deleteMany({ where: { id: { in: createdSponsors } } });
    await prisma.gasto.deleteMany({ where: { temporadaId: { in: createdTemporadas } } });
    await prisma.ingreso.deleteMany({ where: { temporadaId: { in: createdTemporadas } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.accessRole.deleteMany({ where: { id: { in: createdRoles } } });
    for (const id of createdEvents) await cleanupTestEvent(id);
    await cleanupTestEvent(event.id);
    await prisma.temporada.deleteMany({ where: { id: { in: createdTemporadas } } });
    await purgeAuditLog({ actorId: ACTOR });
    await prisma.user.delete({ where: { id: ACTOR } }).catch(() => {});
  });

  beforeEach(() => {
    failAudit = false;
  });

  // H-018: el rastro no cubría eventos, precios de entrada, temporadas nuevas, patrocinios ni el pago marcado a mano de un pedido de tienda o de un patrocinio.
  describe('lo que faltaba (H-018)', () => {
    it('crear, cambiar y borrar un evento deja rastro (y un guardado sin cambios no)', async () => {
      const alta = await createEvent(json('POST', { name: `[TEST] Rastro evento ${Date.now()}`, maxCapacity: 120, status: 'DRAFT' }));
      expect(alta.status).toBe(200);
      const { id } = await alta.json();
      createdEvents.push(id);
      const [creado] = await rastro({ action: 'event.create', targetId: id });
      expect(creado).toMatchObject({ targetType: 'Event', actorEmail: ACTOR_EMAIL });
      expect(creado.meta).toMatchObject({ maxCapacity: 120, status: 'DRAFT' });

      const cambio = await putEvent(json('PUT', { maxCapacity: 200, status: 'PUBLISHED' }), ctx(id));
      expect(cambio.status).toBe(200);
      const [modificado] = await rastro({ action: 'event.update', targetId: id });
      expect((modificado.meta as { cambios: Record<string, unknown> }).cambios).toEqual({
        maxCapacity: { from: 120, to: 200 },
        status: { from: 'DRAFT', to: 'PUBLISHED' },
      });

      // Reenviar lo mismo (el formulario lo manda todo) no escribe otra fila.
      expect((await putEvent(json('PUT', { maxCapacity: 200 }), ctx(id))).status).toBe(200);
      expect(await rastro({ action: 'event.update', targetId: id })).toHaveLength(1);

      expect((await deleteEvent(json('DELETE'), ctx(id))).status).toBe(200);
      const [borrado] = await rastro({ action: 'event.delete', targetId: id });
      expect(borrado.meta).toMatchObject({ status: 'PUBLISHED' });
    });

    it('crear, cambiar el precio y borrar un tipo de entrada deja rastro con el precio de → a', async () => {
      const alta = await createTicketTypeRoute(json('POST', { eventId: event.id, name: '[TEST] Anticipada', price: 12, maxQuantity: 30 }));
      expect(alta.status).toBe(200);
      const { id } = await alta.json();
      const [creado] = await rastro({ action: 'event.ticket_type_create', targetId: id });
      expect(creado).toMatchObject({ targetType: 'TicketType' });
      expect(creado.meta).toMatchObject({ eventId: event.id, name: '[TEST] Anticipada', price: 12, maxQuantity: 30 });

      expect((await putTicketType(json('PUT', { price: 15, name: '[TEST] Anticipada' }), ctx(id))).status).toBe(200);
      const [cambio] = await rastro({ action: 'event.ticket_type_update', targetId: id });
      expect((cambio.meta as { cambios: Record<string, unknown> }).cambios).toEqual({ price: { from: 12, to: 15 } });

      expect((await deleteTicketType(json('DELETE'), ctx(id))).status).toBe(200);
      const [borrado] = await rastro({ action: 'event.ticket_type_delete', targetId: id });
      expect(borrado.meta).toMatchObject({ name: '[TEST] Anticipada', price: 15 });
    });

    it('crear una temporada deja rastro', async () => {
      const res = await createTemporada(json('POST', { nombre: '[TEST] Rastro temporada nueva', anio: 2093 }));
      expect(res.status).toBe(200);
      const { id } = await res.json();
      createdTemporadas.push(id);
      const [fila] = await rastro({ action: 'temporada.create', targetId: id });
      expect(fila).toMatchObject({ targetType: 'Temporada' });
      expect(fila.meta).toMatchObject({ nombre: '[TEST] Rastro temporada nueva', anio: 2093 });
    });

    it('aceptar un patrocinio o cambiar su tipo deja rastro de → a; guardar sin cambios no', async () => {
      const sponsor = await prisma.sponsorRequest.create({ data: { companyName: '[TEST] Rastro patrocinio', contactName: 'Test', status: 'PENDING' } });
      createdSponsors.push(sponsor.id);
      expect((await putSponsor(json('PUT', { status: 'ACCEPTED', sponsorType: 'oro-test' }), ctx(sponsor.id))).status).toBe(200);
      const [fila] = await rastro({ action: 'sponsor.update', targetId: sponsor.id });
      expect(fila).toMatchObject({ targetType: 'SponsorRequest' });
      expect((fila.meta as { cambios: Record<string, unknown> }).cambios).toEqual({
        status: { from: 'PENDING', to: 'ACCEPTED' },
        sponsorType: { from: null, to: 'oro-test' },
      });
      expect((await putSponsor(json('PUT', { status: 'ACCEPTED', adminNotes: 'una nota' }), ctx(sponsor.id))).status).toBe(200);
      expect(await rastro({ action: 'sponsor.update', targetId: sponsor.id })).toHaveLength(1);
    });

    it('marcar un patrocinio como pagado (y desmarcarlo) deja rastro con el importe; sin rastro no queda marcado', async () => {
      const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada patrocinio', anio: 2088 } });
      createdTemporadas.push(temporada.id);
      const request = await prisma.sponsorRequest.create({ data: { companyName: '[TEST] Rastro pago patrocinio', contactName: 'Test', status: 'ACCEPTED', sponsorType: 'oro-test', temporadaId: temporada.id } });
      createdSponsors.push(request.id);
      const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId: request.id } });

      const sin = await sinRastro(() => markPaid(json('POST', { mode: 'paid' }), ctx(sponsor.id)));
      expect(sin.status).toBe(500);
      expect((await prisma.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } })).isPaid).toBe(false);

      expect((await markPaid(json('POST', { mode: 'paid' }), ctx(sponsor.id))).status).toBe(200);
      const [pagado] = await rastro({ action: 'sponsor.mark_paid', targetId: sponsor.id });
      expect(pagado).toMatchObject({ targetType: 'Sponsor' });
      expect(pagado.meta).toMatchObject({ mode: 'paid', paidAmount: 100, cambios: { isPaid: { from: false, to: true } } });

      expect((await markPaid(json('POST', { mode: 'unpaid' }), ctx(sponsor.id))).status).toBe(200);
      const filas = await rastro({ action: 'sponsor.mark_paid', targetId: sponsor.id });
      expect(filas).toHaveLength(2);
      expect(filas[1].meta).toMatchObject({ mode: 'unpaid', cambios: { isPaid: { from: true, to: false } } });
    });

    it('marcar a mano un pedido de tienda como pagado deja rastro con el estado de → a y sin datos del comprador', async () => {
      const shop = await prisma.shopOrder.create({
        data: { buyerName: '[TEST] Rastro Pago Manual', buyerEmail: 'rastro-pago-manual@example.com', shippingAddress: 'Calle Test 3', shippingCity: 'Madrid', shippingZip: '28001', totalAmount: 61, status: 'PENDING' },
      });
      try {
        expect((await putShopOrder(json('PUT', { status: 'PAID' }), ctx(shop.id))).status).toBe(200);
        const [fila] = await rastro({ action: 'order.shop_status', targetId: shop.id });
        expect(fila).toMatchObject({ targetType: 'ShopOrder' });
        expect(fila.meta).toMatchObject({ totalAmount: 61, cambios: { status: { from: 'PENDING', to: 'PAID' } } });
        expect(JSON.stringify(fila)).not.toMatch(/rastro-pago-manual@example\.com|Rastro Pago Manual/);
        // Solo el número de seguimiento: no es un cambio de estado, no hay fila.
        expect((await putShopOrder(json('PUT', { trackingNumber: 'ABC123' }), ctx(shop.id))).status).toBe(200);
        expect(await rastro({ action: 'order.shop_status', targetId: shop.id })).toHaveLength(1);
      } finally {
        await prisma.shopOrder.delete({ where: { id: shop.id } }).catch(() => {});
      }
    });
  });

  // H-020: en pedidos de entradas el rastro se escribía DESPUÉS del correo del reembolso. Si el SMTP se cuelga y la función muere, el dinero ya devuelto no deja fila.
  describe('el rastro del reembolso va antes del correo (H-020)', () => {
    it('pedido de entradas: cuando se intenta avisar al comprador, la fila de rastro ya existe', async () => {
      gateway.reset();
      gateway.active = true;
      try {
        const order = await prisma.order.create({
          data: {
            eventId: event.id, buyerName: 'Rastro', buyerLastName: 'Correo', buyerEmail: 'rastro-correo@example.com', totalAmount: 25, status: 'COMPLETED', paymentMethod: 'CARD',
            paymentProvider: 'stripe', paymentId: `pi_rastro_correo_${Date.now()}`,
            tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-RASTRO-CORREO-${Date.now()}`, holderName: 'Rastro Correo', status: 'VALID' } },
          },
        });
        const res = await patchOrder(json('PATCH', { action: 'refund' }), ctx(order.id));
        expect(res.status).toBe(200);
        expect(traceWhenMailing.get(order.id)).toBe(1);
      } finally {
        gateway.reset();
      }
    });

    it('pedido de tienda: ídem', async () => {
      const shop = await prisma.shopOrder.create({
        data: {
          buyerName: '[TEST] Rastro Correo', buyerEmail: 'rastro-correo-tienda@example.com', shippingAddress: 'Calle Test 4', shippingCity: 'Madrid', shippingZip: '28001', totalAmount: 19,
          status: 'PAID', paymentProvider: 'stripe', paymentId: `pi_rastro_correo_shop_${Date.now()}`,
        },
      });
      gateway.reset();
      gateway.active = true;
      try {
        expect((await putShopOrder(json('PUT', { status: 'REFUNDED' }), ctx(shop.id))).status).toBe(200);
        expect(traceWhenMailing.get(shop.id)).toBe(1);
      } finally {
        gateway.reset();
        await prisma.shopOrder.delete({ where: { id: shop.id } }).catch(() => {});
      }
    });
  });

  // H-022: el rastro de pedidos guardaba poco: cancelar no dejaba ni el importe y cambiar el email no dejaba ni un valor enmascarado.
  describe('contenido del rastro de pedidos (H-022)', () => {
    const crear = (status: 'PENDING' | 'COMPLETED', buyerEmail: string) =>
      prisma.order.create({
        data: {
          eventId: event.id, buyerName: 'Rastro', buyerLastName: 'Contenido', buyerEmail, totalAmount: 25, status, paymentMethod: 'CASH',
          tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-RASTRO-CONT-${Date.now()}-${Math.random()}`, holderName: 'Rastro Contenido', status: 'VALID' } },
        },
      });

    it('cancelar un pedido guarda el importe, el medio de pago y el estado anterior', async () => {
      const order = await crear('PENDING', 'rastro-cont-cancel@example.com');
      expect((await patchOrder(json('PATCH', { action: 'cancel' }), ctx(order.id))).status).toBe(200);
      const [fila] = await rastro({ action: 'order.cancel', targetId: order.id });
      expect(fila.meta).toMatchObject({ totalAmount: 25, paymentMethod: 'CASH', estadoAnterior: 'PENDING' });
      expect(JSON.stringify(fila)).not.toMatch(/rastro-cont-cancel@example\.com/);
    });

    it('cambiar el email guarda los dos valores ENMASCARADOS, nunca el correo entero', async () => {
      const order = await crear('COMPLETED', 'antonio.garcia@example.com');
      expect((await patchOrder(json('PATCH', { action: 'update-email', email: 'beatriz.lopez@example.org' }), ctx(order.id))).status).toBe(200);
      const [fila] = await rastro({ action: 'order.update_email', targetId: order.id });
      expect(fila.meta).toEqual({ campo: 'buyerEmail', desde: 'a***@example.com', hacia: 'b***@example.org' });
      expect(JSON.stringify(fila)).not.toMatch(/antonio\.garcia|beatriz\.lopez/);
    });
  });

  // H-021: el rastro de usuarios, roles y configuración era «mejor esfuerzo»: un fallo de BD lo perdía sin avisar. Ahora va en la transacción del cambio.
  describe('sin rastro no hay cambio: usuarios, roles, configuración y datos de eventos (H-021)', () => {
    it('crear un usuario: si falla el rastro no queda el usuario', async () => {
      const res = await sinRastro(() => createUser(json('POST', { email: 'sin-rastro-usuario@example.com', password: 'contraseña-larga-123', role: 'ADMIN' })));
      expect(res.status).toBe(500);
      expect(await prisma.user.count({ where: { email: 'sin-rastro-usuario@example.com' } })).toBe(0);
    });

    it('modificar y borrar un usuario: si falla el rastro no cambia nada', async () => {
      const alta = await createUser(json('POST', { email: 'sin-rastro-usuario-2@example.com', password: 'contraseña-larga-123', name: 'Original', role: 'ADMIN' }));
      const { id } = await alta.json();
      createdUsers.push(id);
      const upd = await sinRastro(() => updateUser(json('PUT', { name: 'Cambiado' }), ctx(id)));
      expect(upd.status).toBe(500);
      expect((await prisma.user.findUniqueOrThrow({ where: { id } })).name).toBe('Original');
      const del = await sinRastro(() => deleteUser(json('DELETE'), ctx(id)));
      expect(del.status).toBe(500);
      expect(await prisma.user.count({ where: { id } })).toBe(1);
    });

    it('crear, modificar y borrar un rol: si falla el rastro no cambia nada', async () => {
      const res = await sinRastro(() => createRole(json('POST', { name: '[TEST] Rol sin rastro', modules: ['contabilidad'] })));
      expect(res.status).toBe(500);
      expect(await prisma.accessRole.count({ where: { name: '[TEST] Rol sin rastro' } })).toBe(0);

      const alta = await createRole(json('POST', { name: '[TEST] Rol con rastro', modules: ['contabilidad'] }));
      const { id } = await alta.json();
      createdRoles.push(id);
      const upd = await sinRastro(() => updateRole(json('PUT', { name: '[TEST] Rol cambiado', modules: ['contabilidad', 'tienda'] }), ctx(id)));
      expect(upd.status).toBe(500);
      expect(await prisma.accessRole.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: '[TEST] Rol con rastro', modules: ['contabilidad'] });
      const del = await sinRastro(() => deleteRole(json('DELETE'), ctx(id)));
      expect(del.status).toBe(500);
      expect(await prisma.accessRole.count({ where: { id } })).toBe(1);
    });

    it('guardar configuración: si falla el rastro el valor no cambia', async () => {
      await putConfig(json('PUT', { configs: [{ key: 'jornada_corte_hora', value: '5' }] }));
      const res = await sinRastro(() => putConfig(json('PUT', { configs: [{ key: 'jornada_corte_hora', value: '3' }] })));
      expect(res.status).toBe(500);
      expect((await prisma.appConfig.findUniqueOrThrow({ where: { key: 'jornada_corte_hora' } })).value).toBe('5');
    });

    it('cambiar un evento, un precio de entrada o una temporada nueva: si falla el rastro no queda cambio', async () => {
      const res = await sinRastro(() => putEvent(json('PUT', { maxCapacity: 777 }), ctx(event.id)));
      expect(res.status).toBe(500);
      expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).maxCapacity).not.toBe(777);

      const tt = await sinRastro(() => putTicketType(json('PUT', { price: 99 }), ctx(ticketType.id)));
      expect(tt.status).toBe(500);
      expect(Number((await prisma.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } })).price)).toBe(10);

      const temp = await sinRastro(() => createTemporada(json('POST', { nombre: '[TEST] Temporada sin rastro', anio: 2092 })));
      expect(temp.status).toBe(500);
      expect(await prisma.temporada.count({ where: { nombre: '[TEST] Temporada sin rastro' } })).toBe(0);
    });
  });

  // H-023: la lista de claves «sensibles» del rastro usaba isSensitiveConfigKey: `smtp_password` (de solo escritura, aún sin cifrar) quedaba fuera.
  describe('claves de solo escritura en el rastro (H-023)', () => {
    it('cambiar la contraseña SMTP la anota entre las sensibles y no guarda su valor', async () => {
      const SECRET = 'smtp-secreto-que-no-debe-aparecer-77c1';
      expect((await putConfig(json('PUT', { configs: [{ key: 'smtp_password', value: SECRET }] }))).status).toBe(200);
      const [fila] = (await rastro({ action: 'config.update' })).filter((r) => (r.meta as { claves: string[] }).claves.includes('smtp_password'));
      expect((fila.meta as { sensibles: string[] }).sensibles).toEqual(['smtp_password']);
      expect(JSON.stringify(fila)).not.toContain(SECRET);
    });
  });

  // H-145: las exportaciones con datos personales no dejaban rastro. Sin rastro no hay datos: si no se puede anotar, no se entrega el fichero.
  describe('exportar datos personales deja rastro (H-145)', () => {
    beforeAll(async () => {
      await prisma.order.create({
        data: {
          eventId: event.id, buyerName: 'Rastro', buyerLastName: 'Exporta', buyerEmail: 'rastro-exporta@example.com', totalAmount: 25, status: 'COMPLETED', paymentMethod: 'CASH',
          tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-RASTRO-EXPORT-${Date.now()}`, holderName: 'Rastro Exporta', status: 'VALID' } },
        },
      });
    });

    it('el CSV de pedidos anota el filtro y cuántas filas salieron, sin los datos exportados', async () => {
      const res = await exportCsv(get(`http://localhost/api/admin/export?type=orders&eventId=${event.id}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('rastro-exporta@example.com');
      const [fila] = await rastro({ action: 'export.orders' });
      expect(fila).toMatchObject({ targetType: 'Event', targetId: event.id });
      expect(fila.meta).toMatchObject({ filas: expect.any(Number), filtro: { eventId: event.id, status: '' } }); // sin estado = todos (H-137)
      expect((fila.meta as { filas: number }).filas).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(fila)).not.toMatch(/rastro-exporta@example\.com|Rastro/);
    });

    it('el CSV de asistentes lo anota igual', async () => {
      const res = await exportCsv(get(`http://localhost/api/admin/export?type=tickets&eventId=${event.id}`));
      expect(res.status).toBe(200);
      const [fila] = await rastro({ action: 'export.attendees', targetId: event.id });
      expect(fila.meta).toMatchObject({ filas: expect.any(Number), filtro: { eventId: event.id } });
    });

    it('el CSV de pedidos de tienda lo anota con el filtro', async () => {
      const shop = await prisma.shopOrder.create({
        data: { buyerName: '[TEST] Rastro Exporta Tienda', buyerEmail: 'rastro-exporta-tienda@example.com', shippingAddress: 'Calle Test 5', shippingCity: 'Madrid', shippingZip: '28001', totalAmount: 8, status: 'PAID' },
      });
      try {
        const res = await exportShopCsv(get('http://localhost/api/admin/shop-orders/export?status=PAID&q=Rastro%20Exporta%20Tienda'));
        expect(res.status).toBe(200);
        const [fila] = await rastro({ action: 'export.shop_orders' });
        expect(fila.meta).toMatchObject({ filas: 1, filtro: { status: 'PAID', q: 'Rastro Exporta Tienda' } });
        expect(JSON.stringify(fila)).not.toMatch(/rastro-exporta-tienda@example\.com/);
      } finally {
        await prisma.shopOrder.delete({ where: { id: shop.id } }).catch(() => {});
      }
    });

    it('si el rastro no se puede escribir, no se entrega el fichero', async () => {
      const res = await sinRastro(() => exportCsv(get(`http://localhost/api/admin/export?type=orders&eventId=${event.id}`)));
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('rastro-exporta@example.com');
    });

    it('una petición inválida (400) no deja rastro', async () => {
      const antes = (await rastro({ action: 'export.attendees' })).length;
      expect((await exportCsv(get('http://localhost/api/admin/export?type=tickets'))).status).toBe(400);
      expect((await rastro({ action: 'export.attendees' })).length).toBe(antes);
    });
  });

  // H-053: al borrar un usuario, Gasto.createdById e Ingreso.createdById pasaban a null y se perdía quién registró el dinero.
  describe('un usuario con gastos o ingresos a su nombre no se borra (H-053)', () => {
    const nuevoUsuario = async (email: string) => {
      const alta = await createUser(json('POST', { email, password: 'contraseña-larga-123', role: 'ADMIN' }));
      const { id } = await alta.json();
      createdUsers.push(id);
      return id as string;
    };

    it('con un gasto o un ingreso registrados: 409 con su código y el usuario sigue ahí', async () => {
      const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada autoría', anio: 2091 } });
      createdTemporadas.push(temporada.id);
      const conGasto = await nuevoUsuario('autoria-gasto@example.com');
      const conIngreso = await nuevoUsuario('autoria-ingreso@example.com');
      await prisma.gasto.create({ data: { temporadaId: temporada.id, categoria: 'Otros', concepto: '[TEST] Autoría', importeSinIva: 10, ivaPercent: 0, createdById: conGasto } });
      await prisma.ingreso.create({ data: { temporadaId: temporada.id, concepto: '[TEST] Autoría', importe: 10, createdById: conIngreso } });

      for (const id of [conGasto, conIngreso]) {
        const res = await deleteUser(json('DELETE'), ctx(id));
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('user_has_accounting_records');
        expect(await prisma.user.count({ where: { id } })).toBe(1);
      }
      expect((await prisma.gasto.findFirstOrThrow({ where: { concepto: '[TEST] Autoría' } })).createdById).toBe(conGasto);
    });

    it('un gasto anulado también cuenta: su autoría sigue siendo contable', async () => {
      const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada autoría 2', anio: 2090 } });
      createdTemporadas.push(temporada.id);
      const id = await nuevoUsuario('autoria-anulado@example.com');
      await prisma.gasto.create({ data: { temporadaId: temporada.id, categoria: 'Otros', concepto: '[TEST] Autoría anulado', importeSinIva: 10, ivaPercent: 0, createdById: id, voidedAt: new Date() } });
      expect((await deleteUser(json('DELETE'), ctx(id))).status).toBe(409);
    });

    it('sin nada contable a su nombre se borra como siempre', async () => {
      const id = await nuevoUsuario('autoria-limpio@example.com');
      expect((await deleteUser(json('DELETE'), ctx(id))).status).toBe(200);
      expect(await prisma.user.count({ where: { id } })).toBe(0);
    });
  });
});
