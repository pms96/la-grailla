import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SNAPSHOT_MAX_AGE_MS, getRegistryReader, registryReadToken, snapshotMaxAgeMs } from '@/lib/tenant/resolve';

/* El front no escribe nunca en el registro: lee con el token de SOLO LECTURA. Con el de escritura, quien comprometiera el front podría borrar
 * `revoked:{tenantId}` (cortar una revocación de emergencia) o reponer snapshots antiguos. */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('token con el que el front lee el registro', () => {
  it('prefiere el de solo lectura aunque también esté el de escritura', () => {
    expect(registryReadToken({ UPSTASH_REDIS_REST_READ_ONLY_TOKEN: 'ro', UPSTASH_REDIS_REST_TOKEN: 'rw' })).toBe('ro');
  });

  it('sin el de solo lectura cae al de escritura (alternativa señalada por el preflight)', () => {
    expect(registryReadToken({ UPSTASH_REDIS_REST_TOKEN: 'rw' })).toBe('rw');
  });

  it('sin ninguno, nada', () => {
    expect(registryReadToken({})).toBeUndefined();
    expect(registryReadToken({ UPSTASH_REDIS_REST_READ_ONLY_TOKEN: '' })).toBeUndefined();
  });

  it('el lector envía el token de solo lectura en la cabecera', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://eu.example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_READ_ONLY_TOKEN', 'solo-lectura');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'escritura');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: 'v' })));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await getRegistryReader().get('k')).toBe('v');
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer solo-lectura');
  });

  it('sin URL o sin token falla diciendo cuál falta', () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_READ_ONLY_TOKEN', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    expect(() => getRegistryReader()).toThrow(/UPSTASH_REDIS_REST_READ_ONLY_TOKEN/);
  });
});

describe('caducidad dura de los snapshots', () => {
  it('30 días por defecto', () => {
    expect(snapshotMaxAgeMs({})).toBe(DEFAULT_SNAPSHOT_MAX_AGE_MS);
    expect(DEFAULT_SNAPSHOT_MAX_AGE_MS).toBe(30 * 24 * 3_600_000);
  });

  it('SNAPSHOT_MAX_AGE_DAYS lo cambia; un valor absurdo se ignora', () => {
    expect(snapshotMaxAgeMs({ SNAPSHOT_MAX_AGE_DAYS: '7' })).toBe(7 * 24 * 3_600_000);
    for (const bad of ['0', '-3', 'mucho', '']) expect(snapshotMaxAgeMs({ SNAPSHOT_MAX_AGE_DAYS: bad })).toBe(DEFAULT_SNAPSHOT_MAX_AGE_MS);
  });
});
