import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentAdapter, ProviderNotConfiguredError, getPaymentProviderByName } from '@/lib/payment-adapter';

/* H-164 (fase 4): `getPaymentProviderByName` devolvía el adaptador mock (cuyo `verifyPayment` da el pago por bueno) para CUALQUIER nombre que no fuera `stripe` o
 * `sumup`, y el freno de producción solo miraba la pasarela activa. Un pedido con `paymentProvider: 'f4'` pasó a PAID solo con abrir su confirmación. Falla
 * ABIERTO con dinero: un nombre que no se reconoce no puede ser nunca «pago verificado». */

afterEach(() => vi.unstubAllEnvs());

describe('H-164: un nombre de pasarela desconocido no se resuelve a mock', () => {
  it.each(['f4', 'paypal', 'Stripe', 'stripe ', ''])('«%s» lanza ProviderNotConfiguredError en vez de devolver el mock', async (name) => {
    const err = await getPaymentProviderByName(name).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotConfiguredError);
    expect((err as ProviderNotConfiguredError).provider).toBe(name);
  });

  it('también con la cuenta de la tienda', async () => {
    await expect(getPaymentProviderByName('f4', 'tienda')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it('mock sigue funcionando fuera de producción (desarrollo y tests)', async () => {
    const provider = await getPaymentProviderByName('mock');
    expect(provider).toBeInstanceOf(MockPaymentAdapter);
    expect(provider.name).toBe('mock');
  });

  it('en producción mock se rechaza también por nombre: el freno ya no depende de qué función se llame', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(getPaymentProviderByName('mock')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(getPaymentProviderByName('mock', 'tienda')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});
