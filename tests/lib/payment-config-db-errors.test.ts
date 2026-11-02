import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { paymentAccountFingerprint, getPaymentProviderByName } from '@/lib/payment-adapter';
import { runGatewayReconciliation } from '@/lib/reconciliation/gateway';
import { restoreConfigSnapshot, snapshotConfig } from '../helpers/fixtures';
import type { ConfigRow } from '../helpers/config-journal';

/* H-177 y H-178 (fase 5): `getConfig` y `hasConfigRow` TRAGAN un error de base de datos y devuelven el valor por defecto (`payment_gateway` = «mock», «no hay fila»). Para pintar una
 * pantalla vale; para decidir DE QUÉ CUENTA se cobra o se concilia, no:
 *  - la conciliación diaria tomaba el «mock» por «sin pasarela real», se saltaba la cuenta SIN contarla como error y la ruta respondía 200 con `ops_gateway_last` fresco: un
 *    fallo transitorio de BD a esa hora eran 24 h sin conciliar y marcadas como hechas (H-177);
 *  - la Tienda con cuenta propia cobraba o consultaba con las claves de Entradas (H-178).
 * Ahora un error de BD al decidir la cuenta se propaga (la conciliación lo cuenta como error y reintenta con backoff; el cobro falla en vez de ir a otra cuenta). */
const KEYS = ['payment_gateway', 'shop_payment_gateway', 'stripe_secret_key', 'shop_stripe_secret_key', 'sumup_api_key', 'sumup_merchant_code'];

describe('errores de BD al decidir la cuenta de cobro (H-177, H-178)', () => {
  let saved: ConfigRow[] = [];
  beforeAll(async () => {
    saved = await snapshotConfig(KEYS);
  });
  afterAll(async () => {
    await restoreConfigSnapshot(KEYS, saved);
  });
  afterEach(() => vi.restoreAllMocks());

  /** Hace que la lectura de ESA clave de AppConfig falle como un corte de conexión (las demás siguen yendo a la BD real). */
  function failRead(key: string) {
    const real = prisma.appConfig.findUnique.bind(prisma.appConfig) as (args: { where: { key: string } }) => Promise<unknown>;
    return vi.spyOn(prisma.appConfig, 'findUnique').mockImplementation(((args: { where: { key: string } }) => {
      if (args.where.key === key) return Promise.reject(new Error('Connection terminated unexpectedly'));
      return real(args);
    }) as never);
  }

  it('con la BD sana y la pasarela en «mock» no hay cuenta real (null): el comportamiento de siempre', async () => {
    await prisma.appConfig.upsert({ where: { key: 'payment_gateway' }, update: { value: 'mock' }, create: { key: 'payment_gateway', value: 'mock' } });
    expect(await paymentAccountFingerprint('entradas')).toBeNull();
  });

  it('H-177: si falla la lectura de la pasarela, la huella de la cuenta FALLA (no se confunde con «sin pasarela real»)', async () => {
    failRead('payment_gateway');
    await expect(paymentAccountFingerprint('entradas')).rejects.toThrow(/Connection terminated/);
  });

  it('H-177: la conciliación diaria cuenta ese fallo como error (y no responde «0 comprobadas, 0 errores»)', async () => {
    failRead('payment_gateway');
    failRead('shop_payment_gateway');
    const { summary } = await runGatewayReconciliation({ deadline: Date.now() + 5_000 });
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.checked).toBe(0);
  });

  it('H-178: si falla la lectura de «¿tiene la Tienda cuenta propia?», NO se usan las claves de Entradas: falla', async () => {
    await prisma.appConfig.upsert({ where: { key: 'stripe_secret_key' }, update: { value: 'sk_test_entradas' }, create: { key: 'stripe_secret_key', value: 'sk_test_entradas' } });
    await prisma.appConfig.deleteMany({ where: { key: 'shop_payment_gateway' } }); // sin fila propia = hereda Entradas cuando la BD responde
    expect(await getPaymentProviderByName('stripe', 'tienda')).toBeTruthy(); // control: con la BD sana hereda
    failRead('shop_payment_gateway');
    await expect(getPaymentProviderByName('stripe', 'tienda')).rejects.toThrow(/Connection terminated/);
  });

  it('H-178: la huella de la cuenta de la Tienda tampoco se calcula con las claves de Entradas ante un fallo de BD', async () => {
    failRead('shop_payment_gateway');
    await expect(paymentAccountFingerprint('tienda')).rejects.toThrow(/Connection terminated/);
  });

  // H-232: el mismo defecto en el camino del COBRO. Un corte de BD de un instante daba «pasarela en modo mock» (un mensaje falso, y en desarrollo el pedido se marcaba pagado)
  // o «falta la clave de Stripe» (el webhook respondía 400, que Stripe no reintenta como un 500). Ahora el error de BD llega tal cual.
  it('H-232: si falla la lectura de la pasarela activa, `getPaymentProvider` propaga el error de BD (no dice «modo mock»)', async () => {
    const { getPaymentProvider } = await import('@/lib/payment-adapter');
    failRead('payment_gateway');
    await expect(getPaymentProvider('entradas')).rejects.toThrow(/Connection terminated/);
  });

  it('H-232: si falla la lectura de la clave de Stripe o de SumUp, el error de BD llega tal cual (no «falta la clave»)', async () => {
    failRead('stripe_secret_key');
    await expect(getPaymentProviderByName('stripe', 'entradas')).rejects.toThrow(/Connection terminated/);
    vi.restoreAllMocks();
    failRead('sumup_api_key');
    await expect(getPaymentProviderByName('sumup', 'entradas')).rejects.toThrow(/Connection terminated/);
    vi.restoreAllMocks();
    failRead('sumup_merchant_code');
    await prisma.appConfig.upsert({ where: { key: 'sumup_api_key' }, update: { value: 'sup_sk_test' }, create: { key: 'sumup_api_key', value: 'sup_sk_test' } });
    await expect(getPaymentProviderByName('sumup', 'entradas')).rejects.toThrow(/Connection terminated/);
  });
});
