import { describe, it, expect, vi, beforeEach } from 'vitest';

const config = vi.hoisted(() => ({ getConfigsOrFail: vi.fn() }));
const ops = vi.hoisted(() => ({ captureOpsError: vi.fn() }));
vi.mock('@/lib/config', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/config')>()), getConfigsOrFail: config.getConfigsOrFail }));
vi.mock('@/lib/observability/capture', () => ({ captureOpsError: ops.captureOpsError }));

const { termsVersionOrNull, computeTermsVersion, getPrivacyText } = await import('@/lib/legal-terms');
const { defaultPrivacyText } = await import('@/lib/legal-defaults');
const { getBrand } = await import('@/lib/brand/brand');

/* H-143: si `computeTermsVersion` fallaba al pintar el checkout, `.catch(() => undefined)` dejaba `termsVersion` vacío: el formulario salía igualmente, el servidor
 * omitía la comprobación de versión (409) y guardaba la vigente: el comprador aceptaba algo que no había visto. Ahora no hay formulario sin versión. */

beforeEach(() => {
  config.getConfigsOrFail.mockReset();
  ops.captureOpsError.mockReset();
});

describe('termsVersionOrNull', () => {
  it('devuelve el hash de lo que se está mostrando', async () => {
    config.getConfigsOrFail.mockImplementation(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, k === 'legal_terms_tienda' ? 'Condiciones propias' : 'Privacidad propia'])));
    const hash = await termsVersionOrNull('tienda');
    expect(hash).toBe((await computeTermsVersion('tienda')).hash);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(ops.captureOpsError).not.toHaveBeenCalled();
  });

  it('si no se pueden leer las condiciones devuelve null y avisa a operación (no «sin versión» en silencio)', async () => {
    config.getConfigsOrFail.mockRejectedValue(new Error('db caída'));
    expect(await termsVersionOrNull('entradas', 'extra')).toBeNull();
    expect(ops.captureOpsError).toHaveBeenCalledTimes(1);
    expect(ops.captureOpsError.mock.calls[0][1]).toMatchObject({ kind: 'entradas', reason: 'terms_version_unavailable' });
  });
});

describe('getPrivacyText', () => {
  it('con la política en blanco o solo con espacios usa la de reserva, la misma que se muestra y la que entra en el hash', async () => {
    const brand = await getBrand();
    const reserva = defaultPrivacyText({ name: brand.name, email: brand.contactEmail || undefined });
    config.getConfigsOrFail.mockResolvedValue({ privacy_policy: '   \n  ' });
    expect(await getPrivacyText()).toBe(reserva);
    config.getConfigsOrFail.mockResolvedValue({ privacy_policy: '' });
    expect(await getPrivacyText()).toBe(reserva);
  });

  it('con texto propio devuelve ese texto recortado', async () => {
    config.getConfigsOrFail.mockResolvedValue({ privacy_policy: '  Mi política \n' });
    expect(await getPrivacyText()).toBe('Mi política');
  });
});
