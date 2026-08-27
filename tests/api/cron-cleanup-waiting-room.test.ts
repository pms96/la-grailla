import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as cleanupWaitingRoom } from '@/app/api/cron/cleanup-waiting-room/route';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

// Red de seguridad para la limpieza de WaitingRoomEntry: la limpieza normal
// (lib/waiting-room.ts) solo se dispara con tráfico sobre el evento, así que
// un evento ya pasado nunca la activa y sus filas terminales se acumulan.
function cronRequest(secret: string | null) {
  return new Request('http://localhost/api/cron/cleanup-waiting-room', {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
}

describe('GET /api/cron/cleanup-waiting-room', () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const TEST_SECRET = 'test-cron-secret';
  let event: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    process.env.CRON_SECRET = TEST_SECRET;
    event = await createTestEvent();
  });

  afterAll(async () => {
    process.env.CRON_SECRET = originalCronSecret;
    await cleanupTestEvent(event.id);
  });

  it('rechaza sin el secreto correcto', async () => {
    const res = await cleanupWaitingRoom(cronRequest('secreto-incorrecto'));
    expect(res.status).toBe(401);
  });

  it('rechaza sin cabecera de autorización', async () => {
    const res = await cleanupWaitingRoom(cronRequest(null));
    expect(res.status).toBe(401);
  });

  it('borra entradas EXPIRED/COMPLETED con más de 24h de un evento sin tráfico reciente', async () => {
    const old = await prisma.waitingRoomEntry.create({
      data: {
        eventId: event.id,
        token: `cron-old-${Date.now()}`,
        status: 'EXPIRED',
        joinedAt: new Date(Date.now() - 25 * 60 * 60_000),
      },
    });
    const recent = await prisma.waitingRoomEntry.create({
      data: { eventId: event.id, token: `cron-recent-${Date.now()}`, status: 'EXPIRED', joinedAt: new Date() },
    });

    const res = await cleanupWaitingRoom(cronRequest(TEST_SECRET));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deleted).toBeGreaterThanOrEqual(1);

    const remainingIds = (await prisma.waitingRoomEntry.findMany({ where: { eventId: event.id } })).map((e) => e.id);
    expect(remainingIds).not.toContain(old.id);
    expect(remainingIds).toContain(recent.id);
  });
});
