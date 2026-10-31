import { describe, it, expect, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

type Sess = { user: { id: string; role: string } } | null;
let session: Sess = null;

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: scanTicket } = await import('@/app/api/scan/route');

// H-075: el límite por IP (1200/min) se gastaba ANTES de autenticar. Quien compartiese la IP del recinto (wifi del local) podía agotarlo sin sesión y
// dar 429 a TODAS las puertas durante un minuto. Ahora la IP solo frena a quien NO se identifica; con sesión manda el límite por usuario.

const IP = '203.0.113.77';
const USER_ID = 'scan-rate-limit-user';
const keys = [`scan:${IP}`, `scan-user:${USER_ID}`];

function scanRequest() {
  return new Request('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': IP },
    body: JSON.stringify({ qrCode: 'QR-RATE-LIMIT' }),
  });
}

async function exhaust(key: string) {
  await prisma.rateLimitBucket.upsert({
    where: { key },
    create: { key, count: 100_000, resetAt: new Date(Date.now() + 60_000) },
    update: { count: 100_000, resetAt: new Date(Date.now() + 60_000) },
  });
}

describe('POST /api/scan — límites de ritmo', () => {
  afterEach(async () => {
    session = null;
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: keys } } });
  });

  it('con el cubo de la IP agotado por tráfico sin sesión, una puerta con sesión sigue pasando', async () => {
    await exhaust(`scan:${IP}`);
    session = { user: { id: USER_ID, role: 'TAQUILLA' } };
    const res = await scanTicket(scanRequest());
    // Llega a la lógica de escaneo (falta el evento ⇒ 400 NO_EVENT), no se corta con 429.
    expect(res.status).toBe(400);
    expect((await res.json()).result).toBe('NO_EVENT');
  });

  it('sin sesión, la IP agotada sigue dando 429 (la red de seguridad contra inundaciones se mantiene)', async () => {
    await exhaust(`scan:${IP}`);
    const res = await scanTicket(scanRequest());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('sin sesión y con la IP libre, 401', async () => {
    const res = await scanTicket(scanRequest());
    expect(res.status).toBe(401);
  });

  it('con sesión, el límite por usuario sigue mandando', async () => {
    await exhaust(`scan-user:${USER_ID}`);
    session = { user: { id: USER_ID, role: 'TAQUILLA' } };
    const res = await scanTicket(scanRequest());
    expect(res.status).toBe(429);
  });
});
