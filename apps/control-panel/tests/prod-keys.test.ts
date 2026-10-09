import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';
import { checkProdKeys, fingerprint, generateProdKeys, HEADERS, PLACEHOLDER, renderEnv, type ProdKeySet } from '../lib/ops/prod-keys';

/** Lo que haría el dueño: sustituir los __RELLENA__ por datos de Neon y Upstash. */
function filled(set: ProdKeySet): ProdKeySet {
  const s = structuredClone(set);
  s.panel.CONTROL_DATABASE_URL = 'postgresql://u:p@ep-abc-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&pgbouncer=true';
  s.panel.CONTROL_DIRECT_URL = 'postgresql://u:p@ep-abc.eu-central-1.aws.neon.tech/neondb?sslmode=require';
  s.panel.UPSTASH_REDIS_REST_URL = s.platform.UPSTASH_REDIS_REST_URL = 'https://eu1-abc.upstash.io';
  s.panel.UPSTASH_REDIS_REST_TOKEN = 'token-de-escritura-abcdefghijkl';
  s.platform.UPSTASH_REDIS_REST_READ_ONLY_TOKEN = 'token-solo-lectura-abcdefghijkl';
  return s;
}
const failures = (checks: Awaited<ReturnType<typeof checkProdKeys>>) => checks.filter((c) => c.status === 'fail').map((c) => c.title);

describe('claves de producción', () => {
  it('generate deja los datos externos por rellenar y las claves compartidas idénticas en panel y front', async () => {
    const k = await generateProdKeys();
    expect(k.panel.CONTROL_DATABASE_URL).toBe(PLACEHOLDER);
    expect(k.platform.UPSTASH_REDIS_REST_READ_ONLY_TOKEN).toBe(PLACEHOLDER);
    for (const n of ['SECRETS_KEYS', 'SECRETS_ACTIVE_KID', 'PLATFORM_CRON_MASTER']) expect(k.panel[n]).toBe(k.platform[n]);
    expect(k.platform).not.toHaveProperty('UPSTASH_REDIS_REST_TOKEN');
    expect(k.ops).toHaveProperty('REGISTRY_EXPORT_KEY');
    expect(k.platform).not.toHaveProperty('REGISTRY_EXPORT_KEY');
  });

  it('cada ejecución da claves distintas', async () => {
    const a = await generateProdKeys();
    const b = await generateProdKeys();
    expect(a.panel.SECRETS_KEYS).not.toBe(b.panel.SECRETS_KEYS);
    expect(a.panel.SNAPSHOT_SIGNING_KEY).not.toBe(b.panel.SNAPSHOT_SIGNING_KEY);
  });

  it('con los datos de Neon y Upstash puestos, la comprobación pasa entera', async () => {
    expect(failures(await checkProdKeys(filled(await generateProdKeys())))).toEqual([]);
  });

  it('mientras queden __RELLENA__, falla y dice cuáles', async () => {
    const f = failures(await checkProdKeys(await generateProdKeys()));
    expect(f.join(' ')).toContain('CONTROL_DATABASE_URL (panel)');
    expect(f.join(' ')).toContain('UPSTASH_REDIS_REST_READ_ONLY_TOKEN (platform)');
  });

  it('lo que se escribe en el fichero vuelve igual al leerlo con dotenv (JSON con comillas incluido)', async () => {
    const k = filled(await generateProdKeys());
    const back = {
      panel: parse(renderEnv(k.panel, HEADERS.panel)),
      platform: parse(renderEnv(k.platform, HEADERS.platform)),
      ops: parse(renderEnv(k.ops, HEADERS.ops)),
    };
    expect(back).toEqual(k);
    expect(failures(await checkProdKeys(back))).toEqual([]);
  });

  it('detecta que el front no tiene la misma clave de secretos que el panel', async () => {
    const k = filled(await generateProdKeys());
    k.platform.SECRETS_KEYS = JSON.stringify({ m1: generateMasterKey() });
    expect(failures(await checkProdKeys(k)).join(' ')).toContain('SECRETS_KEYS DIFIERE');
  });

  it('detecta una clave pública que no es la de la privada, y una privada inválida', async () => {
    const other = await generateProdKeys();
    const k = filled(await generateProdKeys());
    k.platform.SNAPSHOT_PUBKEYS = other.platform.SNAPSHOT_PUBKEYS;
    expect(failures(await checkProdKeys(k)).join(' ')).toContain('rechazaría todos los registros');
    k.panel.SNAPSHOT_SIGNING_KEY = 'no-es-una-clave';
    expect(failures(await checkProdKeys(k)).join(' ')).toContain('no es una clave Ed25519');
  });

  it('rechaza claves repetidas entre sí y valores reutilizados del .env de desarrollo', async () => {
    const k = filled(await generateProdKeys());
    k.platform.PLATFORM_SESSION_MASTER = k.platform.PLATFORM_CONTEXT_KEY;
    expect(failures(await checkProdKeys(k)).join(' ')).toContain('repetidas');
    const k2 = filled(await generateProdKeys());
    expect(failures(await checkProdKeys(k2, { SECRETS_KEYS: k2.panel.SECRETS_KEYS })).join(' ')).toContain('Valores iguales a los de desarrollo: SECRETS_KEYS');
  });

  it('rechaza BD locales, la URL pooled como directa, el mismo token en panel y front y el de escritura en el front', async () => {
    const k = filled(await generateProdKeys());
    k.panel.CONTROL_DATABASE_URL = 'postgresql://u:p@localhost:5432/x';
    k.panel.CONTROL_DIRECT_URL = k.panel.CONTROL_DATABASE_URL.replace('localhost', 'ep-abc-pooler.neon.tech');
    k.platform.UPSTASH_REDIS_REST_READ_ONLY_TOKEN = k.panel.UPSTASH_REDIS_REST_TOKEN;
    k.platform.UPSTASH_REDIS_REST_TOKEN = 'otro-token-abcdefghij';
    const f = failures(await checkProdKeys(k)).join(' | ');
    expect(f).toContain('CONTROL_DATABASE_URL apunta a una BD local');
    expect(f).toContain('es la URL pooled');
    expect(f).toContain('MISMO token');
    expect(f).toContain('no debe llevar UPSTASH_REDIS_REST_TOKEN');
  });

  it('avisa (sin fallar) si la URL pooled no lleva pgbouncer=true', async () => {
    const k = filled(await generateProdKeys());
    k.panel.CONTROL_DATABASE_URL = k.panel.CONTROL_DATABASE_URL.replace('&pgbouncer=true', '');
    const checks = await checkProdKeys(k);
    expect(checks.some((c) => c.status === 'warn' && c.title.includes('pgbouncer=true'))).toBe(true);
    expect(failures(checks)).toEqual([]);
  });

  it('las comprobaciones nunca contienen un valor secreto', async () => {
    const k = filled(await generateProdKeys());
    const text = JSON.stringify(await checkProdKeys(k));
    for (const secret of [k.panel.SNAPSHOT_SIGNING_KEY, k.panel.CRON_SECRET, k.platform.PLATFORM_CONTEXT_KEY, k.ops.REGISTRY_EXPORT_KEY, k.panel.UPSTASH_REDIS_REST_TOKEN]) expect(text).not.toContain(secret);
    expect(fingerprint(k.panel.PLATFORM_CRON_MASTER)).toHaveLength(8);
  });
});
