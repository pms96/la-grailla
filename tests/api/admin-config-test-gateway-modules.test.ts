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
 * de pago. H-173 (fase 5): H-058 reservó las credenciales de cobro al PROPIETARIO (un rol restringido ni las ve ni las guarda), pero el probador seguía
 * dejándolo a quien tuviera el módulo de la cuenta. Ahora lo usa solo el propietario, con la máscara o con una clave escrita. */
describe('POST /api/admin/config/test-gateway solo para el propietario (H-068, H-173)', () => {
  it('un rol restringido, sea cual sea su módulo, recibe 403 con la máscara o con una clave escrita y no se llama a la pasarela', async () => {
    tested.length = 0;
    for (const modules of [['contabilidad'], ['entradas'], ['tienda'], ['entradas', 'tienda'], []]) {
      session = as(modules);
      for (const scope of ['entradas', 'tienda', undefined]) {
        for (const secretKey of [SECRET_MASK, 'sk_test_escrita']) {
          const res = await post({ gateway: 'stripe', secretKey, ...(scope ? { scope } : {}) });
          expect(res.status, `${modules.join('+') || 'sin módulos'} ${scope} ${secretKey}`).toBe(403);
        }
      }
    }
    expect(tested).toEqual([]);
  });

  it('el propietario (sin lista de módulos) prueba la cuenta de entradas y la de tienda', async () => {
    session = as(null);
    for (const scope of ['entradas', 'tienda']) {
      expect((await post({ gateway: 'stripe', secretKey: SECRET_MASK, scope })).status, scope).toBe(200);
    }
    expect((await post({ gateway: 'stripe', secretKey: SECRET_MASK })).status).toBe(200);
  });

  it('sin sesión de administrador, 401', async () => {
    session = null;
    expect((await post({ gateway: 'stripe', secretKey: SECRET_MASK })).status).toBe(401);
  });
});
