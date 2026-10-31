import { describe, it, expect, afterEach } from 'vitest';
import { runWithTenant } from '@/lib/tenant/context';
import type { TenantContext } from '@/lib/tenant/context-types';
import { prisma } from '@/lib/prisma';
import { POST as joinQueue } from '@/app/api/queue/join/route';
import { GET as queueStatus } from '@/app/api/queue/status/route';
import { cleanupStaleEntries, cleanupAllStaleEntries, pollAfterMsFor, resetSweepThrottle, sweepAndAdmit } from '@/lib/waiting-room';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

function joinRequest(body: unknown, ip: string) {
  return new Request('http://localhost/api/queue/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

function statusRequest(eventId: string, token: string, ip: string) {
  return new Request(`http://localhost/api/queue/status?eventId=${eventId}&token=${token}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

async function createWaitingRoomEvent(overrides: { concurrentSlots?: number; purchaseWindowSeconds?: number } = {}) {
  const event = await createTestEvent();
  return prisma.event.update({
    where: { id: event.id },
    data: {
      waitingRoomEnabled: true,
      waitingRoomConcurrentSlots: overrides.concurrentSlots ?? 1,
      waitingRoomPurchaseWindowSeconds: overrides.purchaseWindowSeconds ?? 300,
    },
  });
}

describe('sala de espera (queue/join, queue/status)', () => {
  const createdEventIds: string[] = [];

  afterEach(async () => {
    while (createdEventIds.length) {
      const id = createdEventIds.pop();
      if (id) await cleanupTestEvent(id);
    }
  });

  it('con la cola desactivada, admite directamente sin crear ninguna entrada', async () => {
    const event = await createTestEvent();
    createdEventIds.push(event.id);

    const res = await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.30'));
    const json = await res.json();

    expect(json.status).toBe('ADMITTED');
    const entries = await prisma.waitingRoomEntry.count({ where: { eventId: event.id } });
    expect(entries).toBe(0);
  });

  it('con hueco libre, admite inmediatamente al primero en entrar', async () => {
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);

    const res = await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.31'));
    const json = await res.json();

    expect(json.status).toBe('ADMITTED');
    expect(json.token).toBeTruthy();
    expect(json.expiresAt).toBeTruthy();
  });

  it('sin hueco libre, deja en espera con la posición correcta', async () => {
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);

    const first = await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.32'));
    expect((await first.json()).status).toBe('ADMITTED');

    const second = await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.33'));
    const secondJson = await second.json();
    expect(secondJson.status).toBe('WAITING');
    expect(secondJson.position).toBe(1);
  });

  it('GET /api/queue/status devuelve el token en la respuesta', async () => {
    // Regresión directa del bug de producción: el token no viajaba en la
    // respuesta de status, así que el frontend lo pisaba con vacío al
    // enterarse del ADMITTED por polling en vez de por el join inicial, y la
    // compra siguiente se rechazaba con "turno no válido".
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);

    const joinRes = await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.34'));
    const joinJson = await joinRes.json();
    expect(joinJson.status).toBe('ADMITTED');

    const statusRes = await queueStatus(statusRequest(event.id, joinJson.token, '203.0.113.34'));
    const statusJson = await statusRes.json();

    expect(statusJson.status).toBe('ADMITTED');
    expect(statusJson.token).toBe(joinJson.token);
  });

  it('nunca admite más entradas simultáneas que concurrentSlots bajo peticiones concurrentes', async () => {
    // Antes de proteger sweepAndAdmit con un advisory lock con scope propio,
    // contar huecos libres y promover eran dos pasos sueltos: bajo peticiones
    // casi simultáneas, varias podían leer "quedan N huecos" antes de que
    // ninguna hubiera escrito, y se admitía de más — el mismo tipo de bug de
    // sobreventa que el proyecto ya resuelve para el stock, aplicado aquí a
    // los huecos de la cola.
    const CONCURRENT_SLOTS = 3;
    const CONCURRENT_JOINERS = 20;
    const event = await createWaitingRoomEvent({ concurrentSlots: CONCURRENT_SLOTS });
    createdEventIds.push(event.id);

    await Promise.all(
      Array.from({ length: CONCURRENT_JOINERS }, (_, i) => joinQueue(joinRequest({ eventId: event.id }, `203.0.113.4${i}`)))
    );

    const activeAdmitted = await prisma.waitingRoomEntry.count({
      where: { eventId: event.id, status: 'ADMITTED', expiresAt: { gt: new Date() } },
    });
    expect(activeAdmitted).toBe(CONCURRENT_SLOTS);

    const total = await prisma.waitingRoomEntry.count({ where: { eventId: event.id } });
    expect(total).toBe(CONCURRENT_JOINERS);
  });

  it('limita cuántos turnos vivos puede abrir la misma IP para el mismo evento', async () => {
    // El rate limit de /api/queue/join frena ráfagas (peticiones por
    // minuto), no volumen sostenido — un script que reparte sus peticiones
    // despacio podría acumular turnos indefinidamente sin este límite.
    const event = await createWaitingRoomEvent({ concurrentSlots: 50 });
    createdEventIds.push(event.id);
    const sameIp = '203.0.113.50';

    const responses = [];
    for (let i = 0; i < 12; i++) {
      responses.push(await joinQueue(joinRequest({ eventId: event.id }, sameIp)));
    }
    const rejected = responses.filter((r) => r.status === 429);
    const allowed = responses.filter((r) => r.status === 200);
    // H-072: el tope era 3 y una oficina, un wifi de local o una IP móvil compartida dejaba a la 4.ª persona fuera. Ahora 10.
    expect(allowed.length).toBe(10);
    expect(rejected.length).toBe(2);
    // El rechazo lleva un código propio y un texto para el comprador: el cliente ya no lo confunde con «sin conexión».
    const body = await rejected[0].json();
    expect(body.code).toBe('queue_ip_limit');
    expect(body.error).toMatch(/turnos abiertos/);

    const liveEntries = await prisma.waitingRoomEntry.count({
      where: { eventId: event.id, ip: sameIp, status: { in: ['WAITING', 'ADMITTED'] } },
    });
    expect(liveEntries).toBe(10);
  });

  it('H-072: los sondeos de varias personas tras la misma IP no agotan el límite (antes, a partir del sondeo 41 de la IP, 429)', async () => {
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);
    resetSweepThrottle();
    const joined = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.70'))).json();
    const codes = new Set<number>();
    for (let i = 0; i < 45; i++) codes.add((await queueStatus(statusRequest(event.id, joined.token, '203.0.113.70'))).status);
    expect([...codes]).toEqual([200]);
  });

  // H-071: los turnos ABANDONADOS (pestaña cerrada) se admitían igualmente y retenían hueco hasta caducar. Con 5 000 en cola y un 40 % de pestañas
  // cerradas eran horas de huecos muertos. Ahora solo se admite a quien ha sondeado hace poco (`lastSeenAt`), y una espera sin latido 15 min caduca.
  describe('latido del sondeo (H-071)', () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const waiting = (eventId: string, tag: string, joinedMin: number, lastSeenMin: number | null) =>
      prisma.waitingRoomEntry.create({
        data: { eventId, token: `hb-${tag}-${Date.now()}-${Math.random()}`, ip: `198.51.100.${Math.floor(Math.random() * 200)}`, status: 'WAITING', joinedAt: minutesAgo(joinedMin), lastSeenAt: lastSeenMin === null ? null : minutesAgo(lastSeenMin) },
      });
    const statusOf = async (id: string) => (await prisma.waitingRoomEntry.findUniqueOrThrow({ where: { id } })).status;

    it('un turno abandonado no se admite; el siguiente que sigue ahí, sí', async () => {
      const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
      createdEventIds.push(event.id);
      const abandoned = await waiting(event.id, 'a', 10, 5); // el primero de la cola, sin sondear desde hace 5 min
      const alive = await waiting(event.id, 'b', 9, 0); // detrás, pero vivo
      await sweepAndAdmit(event.id, 1, 300);
      expect(await statusOf(alive.id)).toBe('ADMITTED');
      expect(await statusOf(abandoned.id)).toBe('WAITING'); // no ha pasado el tiempo de caducidad: sigue esperando si vuelve
    });

    it('sin latido durante 15 minutos la espera caduca (y si vuelve, entra de nuevo por detrás)', async () => {
      const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
      createdEventIds.push(event.id);
      const gone = await waiting(event.id, 'g', 40, 20);
      await sweepAndAdmit(event.id, 1, 300);
      expect(await statusOf(gone.id)).toBe('EXPIRED');
    });

    it('una fila sin `lastSeenAt` (la creó un front anterior) cuenta como vista al entrar: no se deja a nadie fuera por el despliegue', async () => {
      const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
      createdEventIds.push(event.id);
      const fresh = await prisma.waitingRoomEntry.create({ data: { eventId: event.id, token: `hb-null-${Date.now()}`, status: 'WAITING', joinedAt: new Date(Date.now() - 10_000) } });
      await sweepAndAdmit(event.id, 1, 300);
      expect(await statusOf(fresh.id)).toBe('ADMITTED');
    });

    it('la posición solo cuenta a los que siguen ahí', async () => {
      const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
      createdEventIds.push(event.id);
      resetSweepThrottle();
      const first = await (await joinQueue(joinRequest({ eventId: event.id }, '198.51.100.201'))).json();
      expect(first.status).toBe('ADMITTED'); // ocupa el único hueco
      await waiting(event.id, 'x', 8, 6); // abandonado por delante
      await waiting(event.id, 'y', 7, 6); // abandonado por delante
      const me = await (await joinQueue(joinRequest({ eventId: event.id }, '198.51.100.202'))).json();
      expect(me.status).toBe('WAITING');
      expect(me.position).toBe(1);
    });

    it('cada sondeo refresca el latido de quien espera', async () => {
      const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
      createdEventIds.push(event.id);
      resetSweepThrottle();
      const first = await (await joinQueue(joinRequest({ eventId: event.id }, '198.51.100.203'))).json();
      expect(first.status).toBe('ADMITTED');
      const mine = await waiting(event.id, 'm', 3, 3);
      await queueStatus(statusRequest(event.id, mine.token, '198.51.100.204'));
      const after = await prisma.waitingRoomEntry.findUniqueOrThrow({ where: { id: mine.id } });
      expect(Date.now() - after.lastSeenAt!.getTime()).toBeLessThan(5_000);
    });
  });

  it('una IP distinta no se ve afectada por el límite de otra', async () => {
    const event = await createWaitingRoomEvent({ concurrentSlots: 50 });
    createdEventIds.push(event.id);

    for (let i = 0; i < 3; i++) {
      await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.51'));
    }
    const otherIpRes = await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.52'));
    expect(otherIpRes.status).toBe(200);
  });

  it('cleanupStaleEntries borra entradas terminales viejas pero conserva las recientes o activas', async () => {
    const event = await createWaitingRoomEvent();
    createdEventIds.push(event.id);

    const old = await prisma.waitingRoomEntry.create({
      data: { eventId: event.id, token: `old-${Date.now()}`, status: 'EXPIRED', joinedAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });
    const recent = await prisma.waitingRoomEntry.create({
      data: { eventId: event.id, token: `recent-${Date.now()}`, status: 'COMPLETED', joinedAt: new Date() },
    });
    const stillWaiting = await prisma.waitingRoomEntry.create({
      data: { eventId: event.id, token: `waiting-${Date.now()}`, status: 'WAITING', joinedAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });

    await cleanupStaleEntries(event.id);

    const remaining = await prisma.waitingRoomEntry.findMany({ where: { eventId: event.id } });
    const remainingIds = remaining.map((e) => e.id);
    expect(remainingIds).not.toContain(old.id);
    expect(remainingIds).toContain(recent.id);
    expect(remainingIds).toContain(stillWaiting.id);
  });

  it('con un token EXPIRED guardado, crea una entrada nueva en vez de devolver EXPIRED en bucle', async () => {
    // AUDIT: alguien que vuelve a /comprar días después con el token de un
    // turno ya caducado en localStorage se encontraba la pantalla de "tu
    // turno ha terminado" de entrada, para siempre, porque join() reutilizaba
    // la misma fila EXPIRED y devolvía ese mismo estado en cada visita.
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);

    const expired = await prisma.waitingRoomEntry.create({
      data: { eventId: event.id, token: `expired-${Date.now()}`, status: 'EXPIRED', ip: '203.0.113.60' },
    });

    const res = await joinQueue(joinRequest({ eventId: event.id, token: expired.token }, '203.0.113.60'));
    const json = await res.json();

    expect(json.status).not.toBe('EXPIRED');
    expect(json.token).not.toBe(expired.token);

    const entries = await prisma.waitingRoomEntry.count({ where: { eventId: event.id } });
    expect(entries).toBe(2);
  });

  it('cleanupAllStaleEntries borra entradas terminales viejas de cualquier evento', async () => {
    const eventA = await createWaitingRoomEvent();
    const eventB = await createWaitingRoomEvent();
    createdEventIds.push(eventA.id, eventB.id);

    const oldA = await prisma.waitingRoomEntry.create({
      data: { eventId: eventA.id, token: `old-a-${Date.now()}`, status: 'EXPIRED', joinedAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });
    const oldB = await prisma.waitingRoomEntry.create({
      data: { eventId: eventB.id, token: `old-b-${Date.now()}`, status: 'COMPLETED', joinedAt: new Date(Date.now() - 48 * 60 * 60_000) },
    });
    const recent = await prisma.waitingRoomEntry.create({
      data: { eventId: eventA.id, token: `recent-${Date.now()}`, status: 'EXPIRED', joinedAt: new Date() },
    });

    const deleted = await cleanupAllStaleEntries();
    expect(deleted).toBeGreaterThanOrEqual(2);

    const remainingIds = (await prisma.waitingRoomEntry.findMany({ where: { eventId: { in: [eventA.id, eventB.id] } } })).map(
      (e) => e.id
    );
    expect(remainingIds).not.toContain(oldA.id);
    expect(remainingIds).not.toContain(oldB.id);
    expect(remainingIds).toContain(recent.id);
  });

  it('al reenviar el token guardado, reutiliza la misma entrada en vez de crear otra', async () => {
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);

    const first = await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.35'));
    const firstJson = await first.json();

    const second = await joinQueue(joinRequest({ eventId: event.id, token: firstJson.token }, '203.0.113.35'));
    const secondJson = await second.json();

    expect(secondJson.token).toBe(firstJson.token);
    const entries = await prisma.waitingRoomEntry.count({ where: { eventId: event.id } });
    expect(entries).toBe(1);
  });
});

describe('sala de espera: carga por sondeo (P1-12)', () => {
  const createdEventIds: string[] = [];
  afterEach(async () => {
    resetSweepThrottle(); // vuelve al reloj real
    while (createdEventIds.length) {
      const id = createdEventIds.pop();
      if (id) await cleanupTestEvent(id);
    }
  });

  it('pollAfterMsFor: cuanto más lejos está el turno, menos a menudo se sondea, con ±20 % de dispersión', () => {
    const at = (position: number, r: number) => pollAfterMsFor(position, () => r);
    // Sin dispersión (r = 0,5 → ×1,0): las franjas.
    expect([1, 10, 11, 50, 51, 200, 201, 1000, 1001, 5000].map((p) => at(p, 0.5))).toEqual([2000, 2000, 5000, 5000, 8000, 8000, 12000, 12000, 20000, 20000]);
    // Extremos de la dispersión.
    expect(at(1, 0)).toBe(1600);
    expect(at(1, 1)).toBe(2400);
    expect(at(5000, 0)).toBe(16000);
    expect(at(5000, 1)).toBe(24000);
    // Con aleatoriedad real nunca sale de los márgenes, y no es siempre el mismo valor.
    const many = Array.from({ length: 200 }, () => pollAfterMsFor(300));
    expect(Math.min(...many)).toBeGreaterThanOrEqual(9600);
    expect(Math.max(...many)).toBeLessThanOrEqual(14400);
    expect(new Set(many).size).toBeGreaterThan(20);
  });

  it('las respuestas de espera (join y status) dicen cuándo volver a sondear', async () => {
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);
    await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.60')); // ocupa el único hueco
    const waiting = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.61'))).json();
    expect(waiting.status).toBe('WAITING');
    expect(waiting.pollAfterMs).toBeGreaterThanOrEqual(1600);
    expect(waiting.pollAfterMs).toBeLessThanOrEqual(2400);
    const polled = await (await queueStatus(statusRequest(event.id, waiting.token, '203.0.113.61'))).json();
    expect(polled.status).toBe('WAITING');
    expect(polled.pollAfterMs).toBeGreaterThanOrEqual(1600);
    expect(polled.pollAfterMs).toBeLessThanOrEqual(2400);
  });

  // Un reloj que solo avanza cuando el test lo dice: el límite de barrido no depende de cuánto tarde la BD.
  const fakeClock = () => {
    const c = { t: 1_000_000 };
    return { now: () => c.t, advance: (ms: number) => (c.t += ms) };
  };

  it('un sondeo de estado no repite el barrido en menos de un segundo, y aun así admite en cuanto toca', async () => {
    const clock = fakeClock();
    resetSweepThrottle(clock.now);
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);
    const expireAdmitted = () => prisma.waitingRoomEntry.updateMany({ where: { eventId: event.id, status: 'ADMITTED' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const poll = async (token: string, ip: string) => (await (await queueStatus(statusRequest(event.id, token, ip))).json()).status;

    const a = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.62'))).json();
    const b = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.63'))).json();
    expect([a.status, b.status]).toEqual(['ADMITTED', 'WAITING']);

    // Libera el hueco: el primer sondeo de B barre (no había barrido reciente) y le admite.
    await expireAdmitted();
    expect(await poll(b.token, '203.0.113.63')).toBe('ADMITTED');

    // C entra detrás; el turno de B vuelve a caducar. Con el barrido reciente (999 ms), el sondeo de C NO barre y sigue esperando...
    const c = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.64'))).json();
    expect(c.status).toBe('WAITING');
    await expireAdmitted();
    clock.advance(999);
    expect(await poll(c.token, '203.0.113.64')).toBe('WAITING');
    // ...y al cumplirse el segundo, el siguiente sondeo sí barre y le admite.
    clock.advance(1);
    expect(await poll(c.token, '203.0.113.64')).toBe('ADMITTED');
  });

  it('la marca del límite es POR CLIENTE: el barrido de uno no deja sin barrer a otro aunque repitan el id de evento', async () => {
    const clock = fakeClock();
    resetSweepThrottle(clock.now);
    const event = await createWaitingRoomEvent({ concurrentSlots: 1 });
    createdEventIds.push(event.id);
    const ctx = (tenantId: string) => ({ tenantId, product: 'p', host: 'x.test', primaryDomain: 'x.test', epoch: 0, status: 'ACTIVE', modules: [], db: { pooledEnc: '', directEnc: '' } }) as TenantContext;
    const a = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.67'))).json();
    const b = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.68'))).json();
    expect([a.status, b.status]).toEqual(['ADMITTED', 'WAITING']);
    await prisma.waitingRoomEntry.updateMany({ where: { eventId: event.id, status: 'ADMITTED' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // El cliente A acaba de barrir este id de evento (sondeo de a): marca puesta, sin avanzar el reloj.
    await runWithTenant(ctx('cliente-a'), async () => queueStatus(statusRequest(event.id, a.token, '203.0.113.67')));
    // El cliente B sondea el MISMO id dentro del segundo: con una marca compartida se saltaría el barrido y B seguiría esperando.
    const res = await runWithTenant(ctx('cliente-b'), async () => queueStatus(statusRequest(event.id, b.token, '203.0.113.68')));
    expect((await res.json()).status).toBe('ADMITTED');
  });

  it('join NO está limitado: con huecos libres admite al momento aunque se acabe de barrer', async () => {
    const event = await createWaitingRoomEvent({ concurrentSlots: 2 });
    createdEventIds.push(event.id);
    const first = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.65'))).json();
    await queueStatus(statusRequest(event.id, first.token, '203.0.113.65')); // deja marcado un barrido reciente
    const second = await (await joinQueue(joinRequest({ eventId: event.id }, '203.0.113.66'))).json();
    expect(second.status).toBe('ADMITTED');
  });
});
