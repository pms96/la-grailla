import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE_DEFAULT, SESSION_COOKIE_HOST, SESSION_COOKIE_SECURE } from '@/lib/tenant/session-cookie';

type HeaderRule = { source: string; headers: { key: string; value: string }[]; missing?: { type: string; key: string }[] };
const nextConfig = createRequire(import.meta.url)('../../next.config.js') as { headers: () => Promise<HeaderRule[]> };

/* H-059: la ficha `/eventos/:slug` muestra un borrador a un ADMIN (vista previa) y el CDN guarda la respuesta 60 s POR DOMINIO sin mirar cookies: sin esta
 * condición, la vista previa del admin se serviría a cualquier visitante durante ese minuto. La regla de caché del CDN solo se aplica a quien NO trae sesión. */
describe('caché del CDN de la ficha de evento (H-059)', () => {
  it('no se aplica a las peticiones con cookie de sesión (ninguno de los tres nombres posibles)', async () => {
    const rule = (await nextConfig.headers()).find((r) => r.source === '/eventos/:slug' && r.headers.some((h) => h.key === 'Vercel-CDN-Cache-Control'));
    expect(rule).toBeDefined();
    const missing = (rule?.missing ?? []).filter((m) => m.type === 'cookie').map((m) => m.key);
    for (const name of [SESSION_COOKIE_DEFAULT, SESSION_COOKIE_SECURE, SESSION_COOKIE_HOST]) {
      expect(missing, name).toContain(name);
      expect(missing, `${name}.0 (sesión troceada)`).toContain(`${name}.0`);
    }
  });

  it('el resto de páginas públicas conserva su caché de siempre', async () => {
    const rules = await nextConfig.headers();
    for (const source of ['/', '/eventos', '/tienda', '/sponsors', '/legal/aviso-legal', '/legal/cookies']) {
      expect(rules.some((r) => r.source === source && r.headers.some((h) => h.key === 'Vercel-CDN-Cache-Control')), source).toBe(true);
    }
  });

  // H-143: el enlace de la casilla («he leído las condiciones») enseñaba el texto antiguo hasta 90 s después de que el hash ya fuera el nuevo.
  it('las condiciones de venta y la privacidad NO se guardan en el CDN: el texto mostrado y el hash que se acepta no pueden desfasarse', async () => {
    const rules = await nextConfig.headers();
    const cached = (path: string) =>
      rules.some((r) => r.headers.some((h) => h.key === 'Vercel-CDN-Cache-Control') && new RegExp(`^${r.source.replace(/:path\*/g, '.*')}$`).test(path));
    for (const path of ['/legal/condiciones-entradas', '/legal/condiciones-tienda', '/legal/privacidad']) {
      expect(cached(path), path).toBe(false);
    }
  });
});

/* H-171 (fase 5): la CSP restrictiva (H-112) y la lista blanca de host de Blob (H-067) colgaban de la OPTIMIZACIÓN de imágenes: con `IMAGES_UNOPTIMIZED=1` (algo que se
 * apaga por coste) `blobHost` quedaba vacío, volvía el comodín `*.public.blob.vercel-storage.com` y `isPlatformBlobHost` aceptaba cualquier almacén. La optimización y la
 * restricción de host son cosas distintas: el host válido restringe siempre; `IMAGES_UNOPTIMIZED` solo decide si Next optimiza. */
describe('BLOB_PUBLIC_HOST e IMAGES_UNOPTIMIZED (H-171)', () => {
  const HOST = 'abc123.public.blob.vercel-storage.com';
  const WILDCARD = '*.public.blob.vercel-storage.com';
  type Loaded = { headers: () => Promise<HeaderRule[]>; env: Record<string, string>; images: { unoptimized?: boolean; remotePatterns?: unknown[] } };

  function load(env: Record<string, string | undefined>): Loaded {
    const saved = { host: process.env.BLOB_PUBLIC_HOST, off: process.env.IMAGES_UNOPTIMIZED };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const req = createRequire(import.meta.url);
    const file = req.resolve('../../next.config.js');
    delete req.cache[file];
    try {
      return req(file) as Loaded;
    } finally {
      delete req.cache[file];
      if (saved.host === undefined) delete process.env.BLOB_PUBLIC_HOST;
      else process.env.BLOB_PUBLIC_HOST = saved.host;
      if (saved.off === undefined) delete process.env.IMAGES_UNOPTIMIZED;
      else process.env.IMAGES_UNOPTIMIZED = saved.off;
    }
  }
  const csp = async (cfg: Loaded) => (await cfg.headers()).flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy')!.value;

  it('con el host válido y la optimización activa: CSP restringida al almacén y imágenes optimizadas', async () => {
    const cfg = load({ BLOB_PUBLIC_HOST: HOST, IMAGES_UNOPTIMIZED: undefined });
    const value = await csp(cfg);
    expect(value).toContain(`img-src 'self' data: blob: https://${HOST}`);
    expect(value).not.toContain(WILDCARD);
    expect(cfg.images.remotePatterns).toHaveLength(1);
    expect(cfg.env.BLOB_PUBLIC_HOST).toBe(HOST);
  });

  it('con IMAGES_UNOPTIMIZED=1 la CSP y el host de Blob SIGUEN restringidos; solo se apaga la optimización', async () => {
    const cfg = load({ BLOB_PUBLIC_HOST: HOST, IMAGES_UNOPTIMIZED: '1' });
    const value = await csp(cfg);
    expect(value).toContain(`https://${HOST}`);
    expect(value).not.toContain(WILDCARD);
    expect(cfg.env.BLOB_PUBLIC_HOST).toBe(HOST); // `isPlatformBlobHost` lee esta variable en el servidor
    expect(cfg.env.IMAGES_UNOPTIMIZED).toBe('1');
    expect(cfg.images).toEqual({ unoptimized: true });
  });

  it('sin la variable (desarrollo y despliegue antiguo) queda el comodín de siempre y sin optimizar', async () => {
    const cfg = load({ BLOB_PUBLIC_HOST: undefined, IMAGES_UNOPTIMIZED: undefined });
    expect(await csp(cfg)).toContain(WILDCARD);
    expect(cfg.images).toEqual({ unoptimized: true });
    expect(cfg.env.BLOB_PUBLIC_HOST).toBe('');
  });
});
