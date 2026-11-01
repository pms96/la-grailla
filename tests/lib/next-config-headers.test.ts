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
    for (const source of ['/', '/eventos', '/tienda', '/sponsors', '/legal/:path*']) {
      expect(rules.some((r) => r.source === source && r.headers.some((h) => h.key === 'Vercel-CDN-Cache-Control')), source).toBe(true);
    }
  });
});
