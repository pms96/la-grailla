import { describe, it, expect, vi } from 'vitest';
import { SECRET_MASK } from '@/lib/secrets';

type TestSession = { user: { id: string; role: string; modules: string[] | null } } | null;
let session: TestSession = null;
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/config', () => ({ getConfigOrThrow: vi.fn(async (key: string) => `guardada-${key}`) }));
const tested: string[] = [];
vi.mock('@/lib/payment-adapter', () => ({
  StripeAdapter: class {
    constructor(key: string) {
      tested.push(key);
    }
    async testConnection() {
      return { ok: true };
    }
  },
  SumUpAdapter: class {
    async testConnection() {
      return { ok: true };
    }
  },
}));

const { POST } = await import('@/app/api/admin/config/test-gateway/route');
const post = (body: unknown) => POST(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const as = (modules: string[] | null): TestSession => ({ user: { id: 'u', role: 'ADMIN', modules } });

/* H-068: la ruta de «probar pasarela» estaba abierta a cualquier rol restringido y, con la máscara, prueba la clave GUARDADA: un oráculo de las claves
 * de pago de un módulo que ese rol no tiene. Cada cuenta (`scope`) pide su módulo. */
describe('POST /api/admin/config/test-gateway por módulo (H-068)', () => {
  it('un contable no prueba las claves guardadas de Entradas ni de Tienda: 403 y no se llama a la pasarela', async () => {
    tested.length = 0;
    session = as(['contabilidad']);
    for (const scope of ['entradas', 'tienda']) {
      const res = await post({ gateway: 'stripe', secretKey: SECRET_MASK, scope });
      expect(res.status, scope).toBe(403);
    }
    expect(tested).toEqual([]);
  });

  it('un gestor de tienda prueba SU cuenta (tienda) y no la de entradas', async () => {
    session = as(['tienda']);
    expect((await post({ gateway: 'stripe', secretKey: SECRET_MASK, scope: 'tienda' })).status).toBe(200);
    expect((await post({ gateway: 'stripe', secretKey: SECRET_MASK, scope: 'entradas' })).status).toBe(403);
    expect((await post({ gateway: 'stripe', secretKey: SECRET_MASK })).status).toBe(403); // sin scope = entradas
  });

  it('el propietario y un gestor de entradas pasan', async () => {
    for (const s of [as(null), as(['entradas'])]) {
      session = s;
      expect((await post({ gateway: 'stripe', secretKey: SECRET_MASK, scope: 'entradas' })).status).toBe(200);
    }
  });
});
