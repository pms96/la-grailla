import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicLoadError, loadOrFail } from '@/lib/public-load';
import { withCacheBust } from '@/components/reload-button';
import PublicError from '@/app/(public)/error';

/* H-104: la caché del CDN congelaba la página de error de una caída de BD (HTTP 200 + `Vercel-CDN-Cache-Control`). El CDN de Vercel solo guarda 200/301/302/307/308/404/410:
 * un fallo de carga tiene que ser un 500. Esto solo es cierto sin `loading.tsx` en la ruta (con él, Next manda el esqueleto con 200 antes de que falle nada). */

const ROOT = path.resolve(__dirname, '../..');
const PUBLIC = path.join(ROOT, 'app/(public)');
type Rule = { source: string; headers: { key: string; value: string }[] };
const nextConfig = createRequire(import.meta.url)('../../next.config.js') as { headers: () => Promise<Rule[]> };

/** Ruta de la página (`page.tsx`) de cada patrón que guarda el CDN. */
const PAGE_OF: Record<string, string> = {
  '/': 'page.tsx',
  '/eventos': 'eventos/page.tsx',
  '/eventos/:slug': 'eventos/[slug]/page.tsx',
  '/tienda': 'tienda/page.tsx',
  '/sponsors': 'sponsors/page.tsx',
  '/legal/aviso-legal': 'legal/aviso-legal/page.tsx',
  '/legal/cookies': 'legal/cookies/page.tsx',
};

describe('loadOrFail', () => {
  let logged: unknown[][];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a));
  });
  afterEach(() => vi.restoreAllMocks());

  it('devuelve lo que carga la función', async () => {
    await expect(loadOrFail('X', async () => 42)).resolves.toBe(42);
    expect(logged).toHaveLength(0);
  });

  it('si falla, lanza un PublicLoadError de mensaje fijo, sin la consulta ni los datos del error original', async () => {
    const boom = new Error('Invalid `prisma.event.findMany()` invocation: buyerEmail "ana@example.com" postgresql://u:secreto@host/db');
    const err = await loadOrFail('EventosPage', async () => Promise.reject(boom)).catch((e) => e);
    expect(err).toBeInstanceOf(PublicLoadError);
    expect(err.message).toBe('No se pudo cargar EventosPage');
    expect(err.cause).toBeUndefined();
    expect(String(err.stack)).not.toMatch(/ana@example|secreto/);
  });

  it('deja constancia en el log del motivo, redactado (sin emails)', async () => {
    await loadOrFail('EventosPage', async () => Promise.reject(new Error('fallo con ana@example.com'))).catch(() => {});
    const text = logged.flat().map(String).join(' ');
    expect(text).toContain('[EventosPage]');
    expect(text).not.toContain('ana@example.com');
  });
});

describe('páginas que guarda el CDN (H-104)', () => {
  it('la lista de este test cubre TODAS las reglas de caché de CDN de las páginas públicas (si se añade una, hay que clasificarla aquí)', async () => {
    const sources = (await nextConfig.headers()).filter((r) => r.headers.some((h) => h.key === 'Vercel-CDN-Cache-Control')).map((r) => r.source);
    expect([...new Set(sources)].sort()).toEqual(Object.keys(PAGE_OF).sort());
  });

  it.each(Object.entries(PAGE_OF))('%s: ninguna carpeta entre app/(public) y la página tiene loading.tsx (con él, un fallo o un 404 salen con 200 y el CDN los guarda)', (_source, page) => {
    const dirs = path.dirname(page).split('/').filter((d) => d !== '.');
    let dir = PUBLIC;
    const checked = [dir];
    for (const d of dirs) checked.push((dir = path.join(dir, d)));
    for (const d of checked) expect(fs.existsSync(path.join(d, 'loading.tsx')), `${path.relative(ROOT, d)}/loading.tsx`).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app/loading.tsx'))).toBe(false);
  });

  it.each(Object.entries(PAGE_OF))('%s: no atrapa un fallo de BD para pintar un aviso (getConfig/getConfigs degradan a un valor por defecto; `loadError` pinta con 200)', (_source, page) => {
    const src = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    expect(src, 'getConfig/getConfigs').not.toMatch(/\bgetConfigs?\(/);
    expect(src, 'loadError').not.toMatch(/loadError\s*=\s*true/);
  });

  it('hay una pantalla de error para toda la web pública (si no, Next enseñaría la suya, sin la marca ni el botón de reintentar)', () => {
    expect(fs.existsSync(path.join(PUBLIC, 'error.tsx'))).toBe(true);
  });
});

describe('H-159: las plantillas públicas no llevan ramas de error de carga', () => {
  /** Todos los fuentes de app/(public)/_home (plantillas y sus props). */
  const sourcesOf = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourcesOf(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));

  it('ninguna plantilla recibe ni pinta `loadError`: un fallo de carga lanza y lo pinta error.tsx', () => {
    const offenders = sourcesOf(path.join(PUBLIC, '_home')).filter((f) => /\bloadError\b/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});

describe('pantalla de error pública y «Reintentar»', () => {
  const html = renderToStaticMarkup((PublicError as unknown as () => JSX.Element)() as unknown as Parameters<typeof renderToStaticMarkup>[0]);

  it('avisa del fallo (role=alert), no dice que no haya eventos y ofrece reintentar y volver al inicio', () => {
    expect(html).toContain('role="alert"');
    expect(html).toContain('No hemos podido cargar esta página');
    expect(html).toContain('no significa que no haya fechas');
    expect(html).toContain('Reintentar');
    expect(html).toContain('href="/"');
  });

  it('«Reintentar» de la pantalla de error recarga con la URL renovada (`bustCache`), no con un reload que recibiría la copia del CDN', () => {
    expect(fs.readFileSync(path.join(PUBLIC, 'error.tsx'), 'utf8')).toMatch(/<ReloadButton[^>]*\bbustCache\b/);
    expect(fs.readFileSync(path.join(ROOT, 'components/reload-button.tsx'), 'utf8')).toMatch(/bustCache\s*\?\s*window\.location\.assign\(withCacheBust\(window\.location\.href\)\)\s*:\s*window\.location\.reload\(\)/);
  });

  it('withCacheBust: misma URL con un parámetro `_r` nuevo, conservando el resto de la consulta; y se renueva en cada llamada', () => {
    expect(withCacheBust('https://x.es/eventos?a=1#top', 111)).toBe('https://x.es/eventos?a=1&_r=111#top');
    expect(withCacheBust('https://x.es/eventos?_r=1', 222)).toBe('https://x.es/eventos?_r=222');
  });
});
