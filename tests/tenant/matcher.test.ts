import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { config } from '@/middleware';

/* El matcher decide qué rutas pasan por el middleware. En modo plataforma, lo que no pase NO tiene cliente resuelto ni
 * comprobación de Origin; en modo normal, no tiene la protección de staff. Por eso se excluyen SOLO los estáticos de `public/`. */

// Es el mismo compilador de rutas que usa Next para el matcher (no tiene tipos publicados).
const { pathToRegexp } = createRequire(import.meta.url)('next/dist/compiled/path-to-regexp') as { pathToRegexp: (source: string) => RegExp };
const regexps = config.matcher.map((m) => pathToRegexp(m));
const runs = (path: string) => regexps.some((r) => r.test(path));

describe('matcher del middleware', () => {
  it('páginas, API, admin y acceso siempre pasan por el middleware', () => {
    for (const p of ['/', '/eventos', '/eventos/fiesta', '/tienda', '/legal/privacidad', '/auth/login', '/robots.txt', '/sitemap.xml']) {
      expect(runs(p), p).toBe(true);
    }
    for (const p of ['/api/events', '/api/webhooks/stripe', '/admin', '/admin/eventos', '/acceso', '/acceso/escaner']) {
      expect(runs(p), p).toBe(true);
    }
  });

  it('una API o ruta de staff cuyo nombre acabe en extensión de imagen sigue protegida', () => {
    for (const p of ['/api/tickets/qr.png', '/api/admin/export.svg', '/admin/logo.png', '/acceso/x.webp']) {
      expect(runs(p), p).toBe(true);
    }
  });

  it('los estáticos de public/ y de Next no cuestan una invocación del edge', () => {
    for (const p of ['/brand/logo-black.png', '/brand/sticker-vaso.png', '/og-image.png', '/icon-32.png', '/apple-icon.png', '/pdf.worker.min.mjs', '/favicon.ico', '/_next/static/chunks/a.js', '/_next/image']) {
      expect(runs(p), p).toBe(false);
    }
  });
});
