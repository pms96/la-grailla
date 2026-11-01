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

  // H-050: la limpieza solo borraba COMPLETED y EXPIRED. Las filas WAITING abandonadas (el comprador cerró la pestaña) y las ADMITTED caducadas se quedaban para
  // siempre con la IP del comprador (hueco RGPD) y distorsionaban las estadísticas de la cola.
  describe('filas abandonadas (H-050)', () => {
    const HOURS = 60 * 60_000;
    const mk = (suffix: string, data: { status: 'WAITING' | 'ADMITTED' | 'EXPIRED' | 'COMPLETED'; joinedAt: Date; lastSeenAt?: Date | null; expiresAt?: Date | null }) =>
      prisma.waitingRoomEntry.create({ data: { eventId: event.id, token: `h050-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ip: '203.0.113.9', ...data } });
    const remaining = async () => new Set((await prisma.waitingRoomEntry.findMany({ where: { eventId: event.id } })).map((e) => e.id));

    it('borra WAITING sin latido desde hace más de 24 h y ADMITTED caducadas hace más de 24 h; conserva lo vivo', async () => {
      const ago = (h: number) => new Date(Date.now() - h * HOURS);
      const abandonedNoBeat = await mk('wait-null', { status: 'WAITING', joinedAt: ago(30), lastSeenAt: null });
      const abandonedOldBeat = await mk('wait-old', { status: 'WAITING', joinedAt: ago(30), lastSeenAt: ago(26) });
      const stillPolling = await mk('wait-live', { status: 'WAITING', joinedAt: ago(30), lastSeenAt: new Date() });
      const justJoined = await mk('wait-new', { status: 'WAITING', joinedAt: new Date(), lastSeenAt: null });
      const expiredAdmitted = await mk('adm-exp', { status: 'ADMITTED', joinedAt: ago(30), expiresAt: ago(26) });
      const admittedNoExpiry = await mk('adm-null', { status: 'ADMITTED', joinedAt: ago(30), expiresAt: null });
      const liveAdmitted = await mk('adm-live', { status: 'ADMITTED', joinedAt: ago(30), expiresAt: new Date(Date.now() + HOURS) });
      const recentlyExpiredAdmitted = await mk('adm-recent', { status: 'ADMITTED', joinedAt: ago(30), expiresAt: ago(1) });

      const res = await cleanupWaitingRoom(cronRequest(TEST_SECRET));
      expect(res.status).toBe(200);
      const left = await remaining();
      for (const gone of [abandonedNoBeat, abandonedOldBeat, expiredAdmitted, admittedNoExpiry]) expect(left.has(gone.id), gone.token).toBe(false);
      for (const kept of [stillPolling, justJoined, liveAdmitted, recentlyExpiredAdmitted]) expect(left.has(kept.id), kept.token).toBe(true);
    });

    it('la limpieza por evento (la oportunista del tráfico) aplica el mismo criterio', async () => {
      const { cleanupStaleEntries } = await import('@/lib/waiting-room');
      const old = await mk('ev-wait', { status: 'WAITING', joinedAt: new Date(Date.now() - 30 * HOURS), lastSeenAt: null });
      const live = await mk('ev-live', { status: 'WAITING', joinedAt: new Date(Date.now() - 30 * HOURS), lastSeenAt: new Date() });
      await cleanupStaleEntries(event.id);
      const left = await remaining();
      expect(left.has(old.id)).toBe(false);
      expect(left.has(live.id)).toBe(true);
    });
  });
});
