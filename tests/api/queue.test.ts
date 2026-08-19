import { describe, it, expect, afterEach } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as joinQueue } from '@/app/api/queue/join/route';
import { GET as queueStatus } from '@/app/api/queue/status/route';
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
