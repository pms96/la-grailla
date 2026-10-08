import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SECRET_MASK } from '@/lib/secrets';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'gateway-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/config', () => ({
  getConfigOrThrow: vi.fn(async (key: string) => `guardada-${key}`),
}));

const seen: { stripe: string[]; sumup: string[] } = { stripe: [], sumup: [] };
vi.mock('@/lib/payment-adapter', () => ({
  StripeAdapter: class {
    constructor(key: string) {
      seen.stripe.push(key);
    }
    async testConnection() {
      return { ok: true };
    }
  },
  SumUpAdapter: class {
    constructor(key: string, merchant: string) {
      seen.sumup.push(`${key}|${merchant}`);
    }
    async testConnection() {
      return { ok: true };
    }
  },
}));

const { POST } = await import('@/app/api/admin/config/test-gateway/route');

function post(body: unknown): Request {
  return new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  seen.stripe = [];
  seen.sumup = [];
});

describe('POST /api/admin/config/test-gateway', () => {
  it('con la máscara prueba la credencial guardada, no la máscara', async () => {
    await POST(post({ gateway: 'stripe', secretKey: SECRET_MASK }));
    await POST(post({ gateway: 'sumup', apiKey: SECRET_MASK, merchantCode: 'MC1' }));
    expect(seen.stripe).toEqual(['guardada-stripe_secret_key']);
    expect(seen.sumup).toEqual(['guardada-sumup_api_key|MC1']);
  });

  it('con una clave escrita en el formulario prueba esa', async () => {
    await POST(post({ gateway: 'stripe', secretKey: ' sk_test_nueva ' }));
    expect(seen.stripe).toEqual(['sk_test_nueva']);
  });
});
