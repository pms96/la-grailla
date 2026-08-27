import { describe, it, expect, afterEach } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as joinQueue } from '@/app/api/queue/join/route';
import { GET as queueStatus } from '@/app/api/queue/status/route';
import { cleanupStaleEntries, cleanupAllStaleEntries } from '@/lib/waiting-room';
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
    for (let i = 0; i < 5; i++) {
      responses.push(await joinQueue(joinRequest({ eventId: event.id }, sameIp)));
    }
    const rejected = responses.filter((r) => r.status === 429);
    const allowed = responses.filter((r) => r.status === 200);
    expect(allowed.length).toBe(3);
    expect(rejected.length).toBe(2);

    const liveEntries = await prisma.waitingRoomEntry.count({
      where: { eventId: event.id, ip: sameIp, status: { in: ['WAITING', 'ADMITTED'] } },
    });
    expect(liveEntries).toBe(3);
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
