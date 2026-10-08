import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, withTenantForTest } from '../helpers/tenant-dbs';

/* Revisión de seguridad de M5: PATCH /api/admin/orders/[id] está exento de fase y de módulo en el middleware (para no frenar un
 * reembolso), pero el handler también completa pedidos, emite entradas y cambia el email del comprador. */

vi.mock('next-auth', async (orig) => ({ ...(await orig<typeof import('next-auth')>()), getServerSession: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) }));

let env: ReturnType<typeof enablePlatformEnv>;
beforeAll(async () => {
  await ensureTenantDatabases();
  await resetTenantDatabase('a');
  env = enablePlatformEnv();
}, 180_000);
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

const patch = async (action: string, license?: { phase: 'ACTIVE' | 'GRACE' | 'PANEL_BLOCKED' | 'BLOCKED'; nextPhaseChangeAt: null }, modules = ['nucleo', 'entradas']) => {
  const { PATCH } = await import('@/app/api/admin/orders/[id]/route');
  const req = new Request('http://a.cliente.test/api/admin/orders/x', { method: 'PATCH', body: JSON.stringify({ action, email: 'otro@cliente.test' }) });
  return withTenantForTest('a', () => PATCH(req, { params: { id: 'no-existe' } }), { license, modules });
};

describe('PATCH /api/admin/orders/[id] bajo licencia vencida o sin módulo', () => {
  it('cancelar y reembolsar (dinero ya cobrado) siguen funcionando en cualquier fase y sin el módulo', async () => {
    for (const phase of ['ACTIVE', 'GRACE', 'PANEL_BLOCKED', 'BLOCKED'] as const) {
      for (const action of ['cancel', 'refund']) expect((await patch(action, { phase, nextPhaseChangeAt: null })).status, `${action} en ${phase}`).not.toBe(402);
    }
    expect((await patch('refund', undefined, ['nucleo'])).status).not.toBe(402);
  });

  it('completar, verificar o cambiar el email se rechazan en PANEL_BLOCKED, BLOCKED o sin el módulo de entradas', async () => {
    for (const action of ['complete', 'verify', 'update-email']) {
      expect((await patch(action, { phase: 'PANEL_BLOCKED', nextPhaseChangeAt: null })).status, `${action} PANEL_BLOCKED`).toBe(402);
      expect((await patch(action, { phase: 'BLOCKED', nextPhaseChangeAt: null })).status, `${action} BLOCKED`).toBe(402);
      expect((await patch(action, { phase: 'ACTIVE', nextPhaseChangeAt: null }, ['nucleo'])).status, `${action} sin módulo`).toBe(402);
    }
  });

  it('con la licencia al día y el módulo, siguen llegando a su lógica de siempre', async () => {
    for (const action of ['complete', 'verify', 'update-email']) {
      expect((await patch(action, { phase: 'ACTIVE', nextPhaseChangeAt: null })).status).not.toBe(402);
      expect((await patch(action, { phase: 'GRACE', nextPhaseChangeAt: null })).status).not.toBe(402);
    }
  });
});
