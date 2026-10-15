import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { encryptSecret } from '@/lib/secrets';
import { ProviderNotConfiguredError, getPaymentProvider, getPaymentProviderByName } from '@/lib/payment-adapter';

// Decisión del dueño (2026-10-15): Entradas y Tienda NO comparten cuenta de cobro. Cada módulo lee SUS claves (`shop_*` para la tienda).
// Un cliente que ya cobraba la tienda con la cuenta de Entradas sigue igual HASTA que guarde la pasarela de la tienda: antes de ese
// momento no existe la fila `shop_payment_gateway` y se continúa con la cuenta de Entradas (para no cortar una tienda en marcha).
const KEYS = [
  'payment_gateway', 'sumup_api_key', 'sumup_merchant_code', 'stripe_secret_key', 'stripe_webhook_secret',
  'shop_payment_gateway', 'shop_sumup_api_key', 'shop_sumup_merchant_code', 'shop_stripe_secret_key', 'shop_stripe_webhook_secret',
];
const saved = new Map<string, string | null>();

async function set(key: string, value: string, sensitive = false) {
  const v = sensitive ? encryptSecret(value, key) : value;
  await prisma.appConfig.upsert({ where: { key }, update: { value: v }, create: { key, value: v, label: key, group: 'test' } });
}
const field = (provider: unknown, name: string) => (provider as Record<string, unknown>)[name];

beforeEach(async () => {
  for (const k of KEYS) {
    saved.set(k, (await prisma.appConfig.findUnique({ where: { key: k } }))?.value ?? null);
    await prisma.appConfig.deleteMany({ where: { key: k } });
  }
});
afterEach(async () => {
  for (const k of KEYS) {
    await prisma.appConfig.deleteMany({ where: { key: k } });
    const v = saved.get(k);
    if (v !== null && v !== undefined) await prisma.appConfig.create({ data: { key: k, value: v, label: k, group: 'test' } });
  }
});

describe('Cuenta de cobro por módulo', () => {
  it('la tienda cobra con SUS claves y Entradas con las suyas, aunque sea la misma pasarela', async () => {
    await set('payment_gateway', 'sumup');
    await set('sumup_api_key', 'KEY-ENTRADAS', true);
    await set('sumup_merchant_code', 'MC-ENTRADAS');
    await set('shop_payment_gateway', 'sumup');
    await set('shop_sumup_api_key', 'KEY-TIENDA', true);
    await set('shop_sumup_merchant_code', 'MC-TIENDA');

    const entradas = await getPaymentProvider();
    const tienda = await getPaymentProvider('tienda');
    expect(field(entradas, 'apiKey')).toBe('KEY-ENTRADAS');
    expect(field(entradas, 'merchantCode')).toBe('MC-ENTRADAS');
    expect(field(tienda, 'apiKey')).toBe('KEY-TIENDA');
    expect(field(tienda, 'merchantCode')).toBe('MC-TIENDA');
  });

  it('cada módulo puede usar una pasarela distinta', async () => {
    await set('payment_gateway', 'sumup');
    await set('sumup_api_key', 'KEY-ENTRADAS', true);
    await set('sumup_merchant_code', 'MC-ENTRADAS');
    await set('shop_payment_gateway', 'stripe');
    await set('shop_stripe_secret_key', 'sk_test_tienda', true);
    expect((await getPaymentProvider()).name).toBe('sumup');
    expect((await getPaymentProvider('tienda')).name).toBe('stripe');
  });

  it('verificar un pago antiguo de la tienda usa las claves de la tienda', async () => {
    await set('sumup_api_key', 'KEY-ENTRADAS', true);
    await set('sumup_merchant_code', 'MC-ENTRADAS');
    await set('shop_payment_gateway', 'sumup');
    await set('shop_sumup_api_key', 'KEY-TIENDA', true);
    await set('shop_sumup_merchant_code', 'MC-TIENDA');
    expect(field(await getPaymentProviderByName('sumup', 'tienda'), 'apiKey')).toBe('KEY-TIENDA');
    expect(field(await getPaymentProviderByName('sumup'), 'apiKey')).toBe('KEY-ENTRADAS');
  });

  it('con la pasarela de la tienda guardada pero sin sus claves, NO se cae a las de Entradas', async () => {
    await set('payment_gateway', 'sumup');
    await set('sumup_api_key', 'KEY-ENTRADAS', true);
    await set('sumup_merchant_code', 'MC-ENTRADAS');
    await set('shop_payment_gateway', 'sumup');
    await expect(getPaymentProvider('tienda')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it('continuidad: mientras no se guarde la pasarela de la tienda, sigue cobrando con la cuenta de Entradas', async () => {
    await set('payment_gateway', 'sumup');
    await set('sumup_api_key', 'KEY-ENTRADAS', true);
    await set('sumup_merchant_code', 'MC-ENTRADAS');
    const tienda = await getPaymentProvider('tienda');
    expect(field(tienda, 'apiKey')).toBe('KEY-ENTRADAS');
  });

  it('una vez guardada la pasarela de la tienda (aunque sea "mock") ya no hay continuidad', async () => {
    await set('payment_gateway', 'sumup');
    await set('sumup_api_key', 'KEY-ENTRADAS', true);
    await set('sumup_merchant_code', 'MC-ENTRADAS');
    await set('shop_payment_gateway', 'mock');
    expect((await getPaymentProvider('tienda')).name).toBe('mock');
  });
});
