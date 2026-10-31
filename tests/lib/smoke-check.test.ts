import { describe, expect, it } from 'vitest';
import { discoverEventSlug, formatReport, oneLine, parseTargets, smokeAll, smokeTarget } from '@/scripts/smoke-check';

/* P1-22 · OB-14: el smoke post-despliegue. Un `fetch` simulado por ruta; sin red. */

type Reply = { status: number; body?: string } | Error;
const html = (extra = '') => `<!doctype html><html><body>${extra}</body></html>`;
const HEALTHY: Record<string, Reply> = {
  '/': { status: 200, body: html() },
  '/api/health': { status: 200, body: JSON.stringify({ status: 'ok' }) },
  '/eventos': { status: 200, body: html('<a href="/eventos/noche-grande">Noche grande</a>') },
  '/eventos/noche-grande': { status: 200, body: html() },
  '/eventos/noche-grande/comprar': { status: 200, body: html() },
};

/** `routes[path]` puede ser una respuesta fija o una lista (una por intento, la última se repite). */
function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  const impl = async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const entry = routes[path];
    if (!entry) return { status: 404, text: async () => 'no encontrado' };
    const list = Array.isArray(entry) ? entry : [entry];
    const i = Math.min(counters.get(path) ?? 0, list.length - 1);
    counters.set(path, (counters.get(path) ?? 0) + 1);
    const reply = list[i];
    if (reply instanceof Error) throw reply;
    return { status: reply.status, text: async () => reply.body ?? '' };
  };
  return { impl, calls };
}
const noSleep = async () => {};
const run = (routes: Record<string, Reply | Reply[]>, origin = 'https://a.test') => {
  const f = fakeFetch(routes);
  return smokeTarget(origin, { fetchImpl: f.impl, sleep: noSleep }).then((report) => ({ report, calls: f.calls }));
};
const byName = (r: Awaited<ReturnType<typeof run>>['report']) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

describe('parseTargets', () => {
  it('acepta comas, espacios y saltos de línea; añade https y deja solo el origen, sin duplicados', () => {
    expect(parseTargets('https://a.es/ruta?x=1, b.es\nhttps://a.es  http://localhost:3000/x')).toEqual(['https://a.es', 'https://b.es', 'http://localhost:3000']);
  });
  it('vacío = ninguna URL; algo que no es una URL o no es http(s) lanza', () => {
    expect(parseTargets('')).toEqual([]);
    expect(parseTargets(' , ')).toEqual([]);
    expect(() => parseTargets('ftp://a.es')).toThrow(/http/);
    expect(() => parseTargets('https://')).toThrow(/no válida/);
  });
});

describe('discoverEventSlug', () => {
  it('toma el primer evento enlazado; sin ninguno, null', () => {
    expect(discoverEventSlug('<a href="/eventos/uno-2">x</a><a href="/eventos/dos">y</a>')).toBe('uno-2');
    expect(discoverEventSlug('<a href="/eventos">todos</a><a href="/tienda">t</a>')).toBeNull();
  });
});

describe('smokeTarget', () => {
  it('cliente sano: home, health, listado, ficha y página de compra, todo en verde', async () => {
    const { report, calls } = await run(HEALTHY);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(['home', 'health', 'eventos', 'evento', 'comprar']);
    expect(calls).toEqual(['/', '/api/health', '/eventos', '/eventos/noche-grande', '/eventos/noche-grande/comprar']);
  });

  it('un cliente en mantenimiento (health 503) falla aunque la home responda', async () => {
    const { report } = await run({ ...HEALTHY, '/api/health': { status: 503, body: JSON.stringify({ status: 'maintenance' }) } });
    expect(report.ok).toBe(false);
    const c = byName(report);
    expect(c.health).toMatchObject({ ok: false, status: 503 });
    expect(c.health.detail).toMatch(/maintenance/);
    expect(c.home.ok).toBe(true);
  });

  it('health 200 pero con otro estado (por ejemplo «error») también falla', async () => {
    const { report } = await run({ ...HEALTHY, '/api/health': { status: 200, body: JSON.stringify({ status: 'error' }) } });
    expect(byName(report).health.ok).toBe(false);
  });

  it('la página de compra caída es un fallo aunque lo demás vaya bien', async () => {
    const { report } = await run({ ...HEALTHY, '/eventos/noche-grande/comprar': { status: 500 } });
    expect(report.ok).toBe(false);
    expect(byName(report).comprar).toMatchObject({ ok: false, status: 500 });
  });

  it('la home sin HTML (una respuesta vacía con 200) no vale', async () => {
    const { report } = await run({ ...HEALTHY, '/': { status: 200, body: '' } });
    expect(byName(report).home.ok).toBe(false);
  });

  it('sin módulo de entradas (/eventos da 404) NO es un fallo y no se piden ficha ni compra', async () => {
    const { report, calls } = await run({ '/': HEALTHY['/'], '/api/health': HEALTHY['/api/health'], '/eventos': { status: 404 } });
    expect(report.ok).toBe(true);
    expect(byName(report).eventos.detail).toMatch(/sin módulo/);
    expect(calls).toEqual(['/', '/api/health', '/eventos']);
  });

  it('/eventos que da 404 estando ENLAZADO desde la home es un fallo: la ruta ha desaparecido, no es un cliente sin el módulo', async () => {
    const { report } = await run({ ...HEALTHY, '/': { status: 200, body: html('<nav><a href="/eventos">Eventos</a></nav>') }, '/eventos': { status: 404 } });
    expect(report.ok).toBe(false);
    const eventos = byName(report).eventos;
    expect(eventos.ok).toBe(false);
    expect(eventos.detail).toMatch(/la home enlaza \/eventos/);
  });

  it('/eventos que responde 200 con el aviso de que no pudo cargar es un fallo (la página captura el error de BD), en cualquier plantilla', async () => {
    for (const text of ['No hemos podido cargar la programación', 'No hemos podido cargar la agenda', 'No hemos podido cargar la cartelera', 'No hemos podido cargar los eventos']) {
      const { report, calls } = await run({ ...HEALTHY, '/eventos': { status: 200, body: html(`<div role="alert">${text}</div>`) } });
      expect(report.ok, text).toBe(false);
      expect(byName(report).eventos.detail).toMatch(/no pudo cargar los eventos/);
      expect(calls.some((p) => p.includes('comprar'))).toBe(false); // sin evento que comprobar
    }
  });

  it('el estado de health que llega del cliente no puede abrir una orden de log nueva (saltos de línea y control fuera)', async () => {
    const evil = 'error\n::set-output name=x::y';
    const { report } = await run({ ...HEALTHY, '/api/health': { status: 200, body: JSON.stringify({ status: evil }) } });
    expect(byName(report).health.ok).toBe(false);
    const lines = formatReport([report]);
    expect(lines.filter((l) => l.startsWith('::'))).toHaveLength(1); // solo nuestra anotación, al inicio de su línea
    expect(lines.join('\n')).not.toMatch(/\n::set-output/);
    expect(oneLine('a\r\nb\u0000c')).toBe('a b c');
    expect(oneLine('x'.repeat(500), 10)).toHaveLength(10);
  });

  it('sin eventos publicados NO es un fallo: se dice y se omiten ficha y compra', async () => {
    const { report } = await run({ ...HEALTHY, '/eventos': { status: 200, body: html('<p>Próximamente</p>') } });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(['home', 'health', 'eventos']);
    expect(byName(report).eventos.detail).toMatch(/sin eventos publicados/);
  });

  it('un 5xx suelto o una caída puntual se reintenta una vez; si la segunda va bien, pasa', async () => {
    const { report, calls } = await run({ ...HEALTHY, '/': [{ status: 502 }, HEALTHY['/'] as Reply], '/api/health': [new Error('ECONNRESET'), HEALTHY['/api/health'] as Reply] });
    expect(report.ok).toBe(true);
    expect(calls.filter((p) => p === '/')).toHaveLength(2);
    expect(calls.filter((p) => p === '/api/health')).toHaveLength(2);
  });

  it('si no responde nunca, falla con el motivo y sin colgarse (2 intentos por ruta)', async () => {
    const down = new Error('getaddrinfo ENOTFOUND a.test');
    const { report, calls } = await run({ '/': down, '/api/health': down, '/eventos': down });
    expect(report.ok).toBe(false);
    const c = byName(report);
    expect(c.home).toMatchObject({ ok: false, status: null });
    expect(c.home.detail).toMatch(/ENOTFOUND/);
    expect(calls).toHaveLength(6);
  });

  it('un 4xx NO se reintenta (no es transitorio)', async () => {
    const { calls } = await run({ ...HEALTHY, '/': { status: 404 } });
    expect(calls.filter((p) => p === '/')).toHaveLength(1);
  });

  it('marca como lenta una respuesta que tarda, sin convertirla en fallo', async () => {
    let t = 0;
    const f = fakeFetch(HEALTHY);
    // Cada petición «tarda» 9 s: `now()` se llama al empezar y al acabar cada una, y avanza 9 s por llamada.
    const report = await smokeTarget('https://a.test', { fetchImpl: f.impl, sleep: noSleep, now: () => (t += 9_000) });
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => /lento/.test(c.detail ?? ''))).toBe(true);
  });
});

describe('smokeAll y formatReport', () => {
  it('comprueba cada cliente por separado: uno caído no oculta al que va bien, y los fallos salen como anotaciones', async () => {
    const f = fakeFetch(HEALTHY);
    const impl = async (url: string) => (url.startsWith('https://caido.test') ? { status: 503, text: async () => '' } : f.impl(url));
    const reports = await smokeAll(['https://bien.test', 'https://caido.test'], { fetchImpl: impl, sleep: noSleep });
    expect(reports.map((r) => r.ok)).toEqual([true, false]);
    const lines = formatReport(reports);
    expect(lines[0]).toBe('✓ https://bien.test');
    expect(lines.some((l) => l.startsWith('::error title=Smoke https://caido.test::home'))).toBe(true);
    expect(lines.some((l) => l.startsWith('::error') && l.includes('bien.test'))).toBe(false);
  });
});
