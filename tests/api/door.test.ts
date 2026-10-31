import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { doorFailure, isDoorVerdict } from '@/lib/door-errors';
import { maskEmail, orderRef } from '@/lib/door-search';
import { isEntryResult } from '@/lib/scan-results';

/* P1-06 / EN-12: la puerta. Mensajes por tipo de error, límite por usuario (y no por IP compartida), búsqueda de asistentes y admisión manual. */

const mock = vi.hoisted(() => ({ user: { id: '', role: 'TAQUILLA' } as { id: string; role: string } | null }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => (mock.user ? { user: mock.user } : null)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: scan } = await import('@/app/api/scan/route');
const { GET: search } = await import('@/app/api/access/search/route');
const { GET: capacity } = await import('@/app/api/access/capacity/route');
const { GET: noche } = await import('@/app/api/admin/noche/route');
const { GET: adminEvents } = await import('@/app/api/admin/events/route');

const IP = '203.0.113.77';
const suffix = `${Date.now()}`;
const scanReq = (body: unknown, ip = IP) =>
  new Request('http://localhost/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
const searchReq = (eventId: string, q: string) => search(new Request(`http://localhost/api/access/search?eventId=${encodeURIComponent(eventId)}&q=${encodeURIComponent(q)}`));

describe('mensajes de la puerta (lib/door-errors)', () => {
  it('un 429, 401, 403, 500 y la falta de red tienen cada uno su mensaje y NUNCA el rojo de «entrada inválida»', () => {
    const cases: [number | null, RegExp][] = [
      [429, /DEMASIADOS ESCANEOS/],
      [401, /SESIÓN CADUCADA/],
      [403, /SIN PERMISO/],
      [500, /ERROR DEL SERVIDOR/],
      [502, /ERROR DEL SERVIDOR/],
      [null, /SIN CONEXIÓN/],
    ];
    for (const [status, re] of cases) {
      const f = doorFailure(status);
      expect(f.message).toMatch(re);
      expect(f.color).toBe('yellow');
      expect(f.result).toBe('ERROR');
    }
  });

  it('un 400 con mensaje del servidor lo enseña; sin mensaje cae en el genérico', () => {
    expect(doorFailure(400, 'Indica qrCode o ticketId').message).toBe('Indica qrCode o ticketId');
    expect(doorFailure(400).message).toMatch(/ERROR DEL SERVIDOR/);
    // El código interno de un fallo de validación no es un texto para el personal.
    expect(doorFailure(400, 'validation_error').message).toMatch(/ERROR DEL SERVIDOR/);
    // H-084: el servidor manda ahora el texto en español y el código aparte; la puerta filtra por el código.
    expect(doorFailure(400, 'Los datos enviados no son válidos. Revisa el formulario e inténtalo de nuevo.', 'validation_error').message).toMatch(/ERROR DEL SERVIDOR/);
    expect(doorFailure(400, 'QR no válido', undefined).message).toBe('QR no válido');
  });

  it('distingue un veredicto del escáner de un cuerpo de error', () => {
    expect(isDoorVerdict({ result: 'VALID', message: 'ok', color: 'green' })).toBe(true);
    expect(isDoorVerdict({ error: 'Demasiadas peticiones' })).toBe(false);
    expect(isDoorVerdict(null)).toBe(false);
  });
});

describe('ayudas de búsqueda', () => {
  it('enmascara el email y da una referencia corta', () => {
    expect(maskEmail('maria.lopez@example.com')).toBe('ma***@example.com');
    expect(maskEmail('a@x.es')).toBe('a***@x.es');
    expect(maskEmail('sin-arroba')).toBe('***');
    expect(orderRef('cmabc123def456')).toBe('DEF456');
  });

  it('una admisión manual cuenta como entrada igual que una lectura', () => {
    expect(isEntryResult('VALID')).toBe(true);
    expect(isEntryResult('VALID_MANUAL')).toBe(true);
    expect(isEntryResult('DUPLICATE')).toBe(false);
    expect(isEntryResult(null)).toBe(false);
  });
});

describe('puerta: escaneo, búsqueda y admisión manual', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let other: Awaited<ReturnType<typeof createTestEvent>>;
  let typeId: string;
  let otherTypeId: string;
  let userA: string;
  let userB: string;
  const tickets: Record<string, { id: string; qr: string; orderId: string }> = {};

  async function makeTicket(key: string, o: { holder: string; buyer?: [string, string]; email?: string; orderStatus?: 'COMPLETED' | 'REFUNDED' | 'PENDING'; ticketStatus?: 'VALID' | 'USED' | 'CANCELLED'; ev?: typeof event }) {
    const ev = o.ev ?? event;
    const qr = `QR-DOOR-${suffix}-${key}`;
    const order = await prisma.order.create({
      data: {
        eventId: ev.id,
        buyerName: o.buyer?.[0] ?? 'Comprador',
        buyerLastName: o.buyer?.[1] ?? 'Puerta',
        buyerEmail: o.email ?? `${key}@door-test.example.com`,
        totalAmount: 10,
        status: o.orderStatus ?? 'COMPLETED',
        tickets: {
          create: {
            eventId: ev.id,
            ticketTypeId: ev === event ? typeId : otherTypeId,
            qrCode: qr,
            holderName: o.holder,
            status: o.ticketStatus ?? 'VALID',
            entryTime: o.ticketStatus === 'USED' ? new Date() : null,
          },
        },
      },
      include: { tickets: true },
    });
    tickets[key] = { id: order.tickets[0].id, qr, orderId: order.id };
  }

  beforeAll(async () => {
    const mk = async (tag: string) =>
      (await prisma.user.create({ data: { email: `door-${tag}-${suffix}@test.local`, name: `Puerta ${tag}`, hashedPassword: await bcrypt.hash('x', 4), role: 'TAQUILLA' } })).id;
    userA = await mk('a');
    userB = await mk('b');

    event = await createTestEvent();
    other = await createTestEvent();
    typeId = (await createTicketType(event.id)).id;
    otherTypeId = (await createTicketType(other.id)).id;

    await makeTicket('ana', { holder: 'Ana Quiñones Ruiz', buyer: ['Lucía', 'Ferrer'], email: 'lucia.ferrer@door-test.example.com' });
    await makeTicket('bea', { holder: 'Beatriz Soto', buyer: ['Beatriz', 'Soto'] });
    await makeTicket('carla', { holder: 'Carla Sinusar' });
    await makeTicket('dani', { holder: 'Dani Concurrente' });
    await makeTicket('canc', { holder: 'Elena Anulada', ticketStatus: 'CANCELLED' });
    await makeTicket('used', { holder: 'Carlos Yaentró', ticketStatus: 'USED' });
    await makeTicket('refunded', { holder: 'Dora Reembolsada', orderStatus: 'REFUNDED' });
    await makeTicket('pending', { holder: 'Eva Pendiente', orderStatus: 'PENDING' });
    await makeTicket('elsewhere', { holder: 'Ana Quiñones Ruiz', ev: other });
  });

  afterAll(async () => {
    await prisma.scanLog.deleteMany({ where: { eventId: { in: [event.id, other.id] } } });
    await cleanupTestEvent(event.id);
    await cleanupTestEvent(other.id);
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: [`scan:${IP}`, `scan-user:${userA}`, `scan-user:${userB}`, `scan-search:${userA}`] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  });

  beforeEach(async () => {
    mock.user = { id: userA, role: 'TAQUILLA' };
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: [`scan:${IP}`, `scan-user:${userA}`, `scan-user:${userB}`, `scan-search:${userA}`] } } });
  });

  const seedBucket = (key: string, count: number) =>
    prisma.rateLimitBucket.create({ data: { key, count, resetAt: new Date(Date.now() + 60_000) } });

  describe('límite de escaneos', () => {
    it('la IP compartida de la wifi del recinto ya no corta a 120/min: con 500 lecturas de esa IP en el minuto sigue validando', async () => {
      await seedBucket(`scan:${IP}`, 500);
      const res = await scan(scanReq({ qrCode: 'NO-EXISTE', eventId: event.id }));
      expect(res.status).toBe(200);
      expect((await res.json()).result).toBe('INVALID');
    });

    // H-075: la red por IP solo cuenta a quien NO se identifica; una puerta con sesión no se ve afectada por el tráfico anónimo de su misma IP.
    it('la red de seguridad por IP sigue existiendo (1200/min) para quien no tiene sesión', async () => {
      await seedBucket(`scan:${IP}`, 1200);
      mock.user = null;
      const res = await scan(scanReq({ qrCode: 'NO-EXISTE', eventId: event.id }));
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('con la IP agotada, una puerta con sesión sigue escaneando', async () => {
      await seedBucket(`scan:${IP}`, 1200);
      const res = await scan(scanReq({ qrCode: 'NO-EXISTE', eventId: event.id }));
      expect(res.status).toBe(200);
    });

    it('el límite fino es por USUARIO: una puerta saturada no frena a otra en la misma IP', async () => {
      await seedBucket(`scan-user:${userA}`, 240);
      const blocked = await scan(scanReq({ qrCode: 'NO-EXISTE', eventId: event.id }));
      expect(blocked.status).toBe(429);

      mock.user = { id: userB, role: 'TAQUILLA' };
      const ok = await scan(scanReq({ qrCode: 'NO-EXISTE', eventId: event.id }));
      expect(ok.status).toBe(200);
    });
  });

  describe('admisión manual (POST /api/scan con ticketId)', () => {
    it('admite, lo registra como VALID_MANUAL, suma al aforo y avisa de que fue manual', async () => {
      const before = (await prisma.event.findUnique({ where: { id: event.id } }))!.currentCount;
      const res = await scan(scanReq({ ticketId: tickets.ana.id, eventId: event.id }));
      const body = await res.json();
      expect(body.result).toBe('VALID');
      expect(body.manual).toBe(true);
      expect(body.holderName).toBe('Ana Quiñones Ruiz');

      const log = await prisma.scanLog.findFirst({ where: { ticketId: tickets.ana.id } });
      expect(log?.result).toBe('VALID_MANUAL');
      expect(log?.scannerId).toBe(userA);
      expect((await prisma.event.findUnique({ where: { id: event.id } }))!.currentCount).toBe(before + 1);
      expect((await prisma.ticket.findUnique({ where: { id: tickets.ana.id } }))!.status).toBe('USED');
    });

    it('una segunda admisión de la misma entrada sale YA ENTRÓ y no suma otra vez', async () => {
      const before = (await prisma.event.findUnique({ where: { id: event.id } }))!.currentCount;
      const body = await (await scan(scanReq({ ticketId: tickets.ana.id, eventId: event.id }))).json();
      expect(body.result).toBe('DUPLICATE');
      expect((await prisma.event.findUnique({ where: { id: event.id } }))!.currentCount).toBe(before);
    });

    it('pasa por las mismas comprobaciones que un escaneo: pedido reembolsado, pago pendiente y evento equivocado no entran', async () => {
      expect((await (await scan(scanReq({ ticketId: tickets.refunded.id, eventId: event.id }))).json()).result).toBe('CANCELLED');
      expect((await (await scan(scanReq({ ticketId: tickets.pending.id, eventId: event.id }))).json()).result).toBe('PENDING_PAYMENT');
      expect((await (await scan(scanReq({ ticketId: tickets.elsewhere.id, eventId: event.id }))).json()).result).toBe('WRONG_EVENT');
      expect(await prisma.scanLog.count({ where: { ticketId: { in: [tickets.refunded.id, tickets.pending.id, tickets.elsewhere.id] }, result: 'VALID_MANUAL' } })).toBe(0);
    });

    it('un id que no existe da «Entrada no encontrada»', async () => {
      const body = await (await scan(scanReq({ ticketId: 'no-existe', eventId: event.id }))).json();
      expect(body.result).toBe('INVALID');
      expect(body.message).toBe('Entrada no encontrada');
    });

    it('exige exactamente uno de qrCode o ticketId', async () => {
      expect((await scan(scanReq({ eventId: event.id }))).status).toBe(400);
      expect((await scan(scanReq({ qrCode: tickets.bea.qr, ticketId: tickets.bea.id, eventId: event.id }))).status).toBe(400);
    });

    it('sin evento elegido tampoco se admite a mano', async () => {
      const res = await scan(scanReq({ ticketId: tickets.bea.id }));
      expect(res.status).toBe(400);
      expect((await res.json()).result).toBe('NO_EVENT');
    });

    it('la lectura normal de QR sigue registrándose como VALID', async () => {
      const body = await (await scan(scanReq({ qrCode: tickets.bea.qr, eventId: event.id }))).json();
      expect(body.result).toBe('VALID');
      expect(body.manual).toBe(false);
      expect((await prisma.scanLog.findFirst({ where: { ticketId: tickets.bea.id } }))?.result).toBe('VALID');
    });

    it('revisión P1-06: QR y admisión manual a la vez sobre la misma entrada admiten UNA sola vez y suman UNA al aforo', async () => {
      const before = (await prisma.event.findUnique({ where: { id: event.id } }))!.currentCount;
      const [a, b] = await Promise.all([
        scan(scanReq({ qrCode: tickets.dani.qr, eventId: event.id })).then((r) => r.json()),
        scan(scanReq({ ticketId: tickets.dani.id, eventId: event.id })).then((r) => r.json()),
      ]);
      expect([a.result, b.result].sort()).toEqual(['DUPLICATE', 'VALID']);
      expect((await prisma.event.findUnique({ where: { id: event.id } }))!.currentCount).toBe(before + 1);
      expect(await prisma.scanLog.count({ where: { ticketId: tickets.dani.id, result: { in: ['VALID', 'VALID_MANUAL'] } } })).toBe(1);
    });

    it('revisión P1-06: una entrada anulada por su propio estado, o de un evento cancelado, no se admite a mano', async () => {
      expect((await (await scan(scanReq({ ticketId: tickets.canc.id, eventId: event.id }))).json()).result).toBe('CANCELLED');
      const cancelled = await createTestEvent({ status: 'CANCELLED' });
      try {
        const tType = await createTicketType(cancelled.id);
        const order = await prisma.order.create({
          data: { eventId: cancelled.id, buyerName: 'C', buyerLastName: 'C', buyerEmail: 'c@door-test.example.com', totalAmount: 10, status: 'COMPLETED', tickets: { create: { eventId: cancelled.id, ticketTypeId: tType.id, qrCode: `QR-DOOR-${suffix}-cancev`, holderName: 'Fran Cancelado', status: 'VALID' } } },
          include: { tickets: true },
        });
        const body = await (await scan(scanReq({ ticketId: order.tickets[0].id, eventId: cancelled.id }))).json();
        expect(body.result).toBe('CANCELLED');
        expect(body.message).toMatch(/EVENTO CANCELADO/);
        await prisma.scanLog.deleteMany({ where: { eventId: cancelled.id } });
      } finally {
        await cleanupTestEvent(cancelled.id);
      }
    });

    it('el ritmo de entradas del aforo cuenta las manuales y las de QR', async () => {
      mock.user = { id: userA, role: 'TAQUILLA' };
      const res = await capacity(new Request(`http://localhost/api/access/capacity?eventId=${event.id}`));
      expect((await res.json()).entryRate5min).toBe(3); // ana (manual) + bea (QR) + dani (una de las dos vías)
    });

    it('revisión P1-06: lo mismo en Modo noche y en el listado de eventos del admin (ritmo, rechazos y ranking de escáneres)', async () => {
      mock.user = { id: userA, role: 'ADMIN' };
      const n = await (await noche(new Request(`http://localhost/api/admin/noche?eventId=${event.id}`))).json();
      expect(n.capacity.entryRate5min).toBe(3);
      expect(n.topScanners[0].count).toBe(3);
      const list = await (await adminEvents(new Request('http://localhost/api/admin/events'))).json();
      const mine = list.find((e: { id: string }) => e.id === event.id);
      expect(mine.entryRate5min).toBe(3);
      expect(mine.topScanners[0].count).toBe(3);
    });
  });

  describe('búsqueda (GET /api/access/search)', () => {
    it('encuentra por nombre del titular, sin acentos exactos ni mayúsculas, y solo en el evento indicado', async () => {
      const body = await (await searchReq(event.id, 'quiñones')).json();
      expect(body.results.map((r: { ticketId: string }) => r.ticketId)).toEqual([tickets.ana.id]); // la del otro evento no sale
    });

    it('encuentra por el nombre del comprador, aunque el titular sea otro', async () => {
      const body = await (await searchReq(event.id, 'lucía ferrer')).json();
      expect(body.results.map((r: { ticketId: string }) => r.ticketId)).toContain(tickets.ana.id);
    });

    it('encuentra por el email COMPLETO (el asistente lo dicta), sin distinguir mayúsculas', async () => {
      const body = await (await searchReq(event.id, 'Lucia.Ferrer@door-test.example.com')).json();
      expect(body.results.map((r: { ticketId: string }) => r.ticketId)).toContain(tickets.ana.id);
    });

    it('revisión P1-06: un trozo del email NO encuentra nada (si no, se podría reconstruir el email que se enmascara probando carácter a carácter)', async () => {
      for (const part of ['lucia.ferrer@', 'lucia.ferrer@door', '@door-test.example.com', 'lucia.f@']) {
        const body = await (await searchReq(event.id, part)).json();
        expect(body.results, part).toEqual([]);
      }
    });

    it('encuentra por la referencia del pedido (últimos caracteres del id) y por el código QR exacto', async () => {
      const ref = orderRef(tickets.bea.orderId);
      const byRef = await (await searchReq(event.id, ref)).json();
      expect(byRef.results.map((r: { ticketId: string }) => r.ticketId)).toContain(tickets.bea.id);
      const byQr = await (await searchReq(event.id, tickets.bea.qr)).json();
      expect(byQr.results.map((r: { ticketId: string }) => r.ticketId)).toEqual([tickets.bea.id]);
    });

    it('enseña el email enmascarado y nunca el completo ni el QR', async () => {
      const res = await searchReq(event.id, 'lucía ferrer');
      const text = JSON.stringify(await res.json());
      expect(text).toContain('lu***@door-test.example.com');
      expect(text).not.toContain('lucia.ferrer@door-test');
      expect(text).not.toContain(tickets.ana.qr);
    });

    it('marca qué se puede admitir y por qué no: ya entró, pedido reembolsado, pago pendiente', async () => {
      const find = async (q: string) => (await (await searchReq(event.id, q)).json()).results[0];
      expect((await find('Carla Sinusar')).admittable).toBe(true);

      const used = await find('Yaentró');
      expect(used.admittable).toBe(false);
      expect(used.status).toBe('USED');
      expect(used.entryTime).toBeTruthy();

      const refunded = await find('Reembolsada');
      expect(refunded.admittable).toBe(false);
      expect(refunded.blockedMessage).toMatch(/reembolsado/i);

      const pending = await find('Pendiente');
      expect(pending.admittable).toBe(false);
      expect(pending.blockedMessage).toMatch(/PAGO NO CONFIRMADO/);
    });

    it('rechaza búsquedas demasiado cortas o sin evento', async () => {
      expect((await searchReq(event.id, 'an')).status).toBe(400);
      expect((await search(new Request('http://localhost/api/access/search?q=ana'))).status).toBe(400);
    });

    it('solo el personal puede buscar', async () => {
      mock.user = null;
      expect((await searchReq(event.id, 'ana')).status).toBe(401);
      mock.user = { id: userA, role: 'USER' };
      expect((await searchReq(event.id, 'ana')).status).toBe(401);
    });

    it('tiene su propio límite por usuario', async () => {
      await seedBucket(`scan-search:${userA}`, 90);
      const res = await searchReq(event.id, 'Beatriz');
      expect(res.status).toBe(429);
    });

    it('avisa cuando hay más resultados de los que caben', async () => {
      const order = await prisma.order.create({
        data: { eventId: event.id, buyerName: 'Masivo', buyerLastName: 'Grupo', buyerEmail: 'masivo@door-test.example.com', totalAmount: 10, status: 'COMPLETED' },
      });
      await prisma.ticket.createMany({
        data: Array.from({ length: 16 }, (_, i) => ({ orderId: order.id, eventId: event.id, ticketTypeId: typeId, qrCode: `QR-DOOR-${suffix}-masivo-${i}`, holderName: `Zzmasivo ${i}`, status: 'VALID' as const })),
      });
      const body = await (await searchReq(event.id, 'zzmasivo')).json();
      expect(body.results).toHaveLength(15);
      expect(body.truncated).toBe(true);
    });
  });
});
