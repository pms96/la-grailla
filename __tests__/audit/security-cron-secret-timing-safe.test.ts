// AUDIT: comparación no constante en tiempo del CRON_SECRET (SEC-05) | Severidad: Baja
//
// Los endpoints de cron (cleanup-waiting-room, reconcile-payments) comparaban la
// cabecera Authorization contra `Bearer ${CRON_SECRET}` con `!==`, que compara
// byte a byte y corta en cuanto encuentra una diferencia — en teoría permite
// reconstruir el secreto midiendo cuánto tarda en fallar cada intento. Se sustituye
// por `timingSafeEqualString` (lib/secrets.ts), mismo patrón que ya usa
// lib/access-token.ts para los tokens de acceso a pedidos.
//
// Este test no mide temporización (no es fiable en CI); verifica que el cambio de
// comparación no ha roto el comportamiento funcional: secreto correcto -> autorizado,
// secreto incorrecto o ausente -> 401.
import { describe, it, expect } from 'vitest';
// @prisma/client recarga .env (y por tanto CRON_SECRET) como efecto de
// módulo la primera vez que se importa en el proceso — al ser una ruta de
// cron, la propia importación dinámica del route handler arrastra
// @/lib/prisma. Importarlo aquí primero consume ese efecto una sola vez
// para que los `delete process.env.CRON_SECRET` de abajo no se deshagan
// solos durante el `import()` del handler.
import '@/lib/prisma';

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

function cronRequest(authorization: string | null) {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return new Request('http://localhost/api/cron/cleanup-waiting-room', { headers });
}

describe('AUDIT — comparación del CRON_SECRET sigue siendo correcta tras el fix', () => {
  it('rechaza sin CRON_SECRET configurado', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/cleanup-waiting-room/route');
    const res = await GET(cronRequest('Bearer lo-que-sea'));
    expect(res.status).toBe(500);
  });

  it('rechaza con secreto incorrecto', async () => {
    process.env.CRON_SECRET = 'secreto-correcto-de-test';
    const { GET } = await import('@/app/api/cron/cleanup-waiting-room/route');
    const res = await GET(cronRequest('Bearer secreto-incorrecto'));
    expect(res.status).toBe(401);
  });

  it('rechaza sin cabecera Authorization', async () => {
    process.env.CRON_SECRET = 'secreto-correcto-de-test';
    const { GET } = await import('@/app/api/cron/cleanup-waiting-room/route');
    const res = await GET(cronRequest(null));
    expect(res.status).toBe(401);
  });

  it('acepta el secreto correcto', async () => {
    process.env.CRON_SECRET = 'secreto-correcto-de-test';
    const { GET } = await import('@/app/api/cron/cleanup-waiting-room/route');
    const res = await GET(cronRequest('Bearer secreto-correcto-de-test'));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(500);
  });

  it('reconcile-payments también rechaza con secreto incorrecto', async () => {
    process.env.CRON_SECRET = 'secreto-correcto-de-test';
    const { GET } = await import('@/app/api/cron/reconcile-payments/route');
    const res = await GET(
      new Request('http://localhost/api/cron/reconcile-payments', {
        headers: { authorization: 'Bearer secreto-incorrecto' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('reconcile-payments acepta el secreto correcto', async () => {
    process.env.CRON_SECRET = 'secreto-correcto-de-test';
    const { GET } = await import('@/app/api/cron/reconcile-payments/route');
    const res = await GET(
      new Request('http://localhost/api/cron/reconcile-payments', {
        headers: { authorization: 'Bearer secreto-correcto-de-test' },
      })
    );
    expect(res.status).not.toBe(401);
    if (ORIGINAL_CRON_SECRET !== undefined) process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    else delete process.env.CRON_SECRET;
  });
});
