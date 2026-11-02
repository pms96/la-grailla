import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAdminJson, responseError } from '@/lib/admin-fetch';
import { LoadError } from '@/components/admin/load-error';

/* H-176 (fase 5): gastos, ingresos, ventas, entradas y estadísticas leían `fetch(url).then((r) => r.json())` sin mirar `r.ok`: un 401, 423 o 500 devolvía `{ error }`, que se pintaba como lista
 * vacía y totales «0,00 €» (o se tragaba en un `.catch(() => {})`). Quien lleva la caja podía dar por vacía, o cerrar, una temporada sobre datos que no habían cargado. */

const respond = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));
afterEach(() => vi.unstubAllGlobals());

describe('fetchAdminJson', () => {
  it('devuelve el JSON de una respuesta correcta', async () => {
    respond(200, [{ id: 1 }]);
    expect(await fetchAdminJson('/x', 'reserva')).toEqual([{ id: 1 }]);
  });

  it.each([401, 403, 423, 500, 502])('un %s LANZA (no devuelve el `{ error }` como si fuera un dato)', async (status) => {
    respond(status, { error: 'La temporada está cerrada' });
    await expect(fetchAdminJson('/x', 'reserva')).rejects.toThrow('La temporada está cerrada');
  });

  it('sin mensaje del servidor (cuerpo vacío o HTML de un proxy) usa el de reserva', async () => {
    respond(502, '<html>Bad Gateway</html>');
    await expect(fetchAdminJson('/x', 'No se pudieron cargar los gastos')).rejects.toThrow('No se pudieron cargar los gastos');
    respond(500, {});
    await expect(fetchAdminJson('/x', 'reserva')).rejects.toThrow('reserva');
  });

  it('una caída de red propaga el error de `fetch`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchAdminJson('/x', 'reserva')).rejects.toThrow('Failed to fetch');
  });

  // H-237: un 200 con el cuerpo vacío o que no es JSON (el HTML de un proxy) devolvía `null` «con éxito» y la pantalla pintaba ceros.
  it.each([['', 'vacío'], ['<html>Bad Gateway</html>', 'HTML de un proxy'], ['null', 'JSON null']])('un 200 con el cuerpo %j (%s) LANZA el mensaje de reserva', async (text) => {
    respond(200, text);
    await expect(fetchAdminJson('/x', 'No se pudieron cargar los datos')).rejects.toThrow('No se pudieron cargar los datos');
  });
});

describe('responseError', () => {
  it('el mensaje del servidor o el de reserva', async () => {
    expect(await responseError(new Response(JSON.stringify({ error: 'Hay pedidos' }), { status: 409 }), 'reserva')).toBe('Hay pedidos');
    expect(await responseError(new Response('no es json', { status: 500 }), 'No se pudo eliminar')).toBe('No se pudo eliminar');
  });
});

describe('LoadError', () => {
  it('es un aviso (role=alert) con el título, el motivo y «Reintentar»', () => {
    const html = renderToStaticMarkup(LoadError({ title: 'No se han podido cargar los gastos.', message: 'Sin permiso', onRetry: () => {} }) as unknown as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain('role="alert"');
    expect(html).toContain('No se han podido cargar los gastos.');
    expect(html).toContain('Sin permiso');
    expect(html).toContain('Reintentar');
  });

  // H-237: «Reintentar» pone la pantalla en carga y el aviso se desmonta: el foco del teclado se perdía en el body. El aviso se puede enfocar (tabIndex -1) y toma el foco al montarse
  // con una función de ref ESTABLE (una en línea volvería a enfocarlo en cada render de la pantalla y robaría el foco mientras se escribe en un filtro).
  it('H-237: es enfocable y toma el foco al montarse con una ref estable', () => {
    const html = renderToStaticMarkup(LoadError({ title: 'Error', message: 'x', onRetry: () => {} }) as unknown as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain('tabindex="-1"');
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/admin/load-error.tsx'), 'utf8');
    expect(src).toMatch(/const focusOnMount = \(el: HTMLDivElement \| null\) => el\?\.focus\(\);/);
    expect(src).toMatch(/ref=\{focusOnMount\}/);
  });
});

describe('H-237: Estadísticas no vacía el selector de eventos tras un fallo', () => {
  it('guarda la última lista de eventos conocida y el selector la usa cuando no hay datos', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/admin/estadisticas/page.tsx'), 'utf8');
    expect(src).toMatch(/setLastEvents\(d\.events\)/);
    expect(src).toMatch(/\(stats\?\.events \?\? lastEvents\)\.map/); // el selector; la tabla por evento sí se vacía sin datos
  });
});

describe('H-176: las pantallas del admin no leen la API sin mirar el estado', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /** El cuerpo de una función flecha de primer nivel del componente: desde su declaración hasta el primer `\n  };`. */
  const body = (src: string, start: string) => {
    const i = src.indexOf(start);
    return src.slice(i, src.indexOf('\n  };', i) + 5);
  };
  const PAGES = ['app/admin/gastos/page.tsx', 'app/admin/ingresos/page.tsx', 'app/admin/ventas/page.tsx', 'app/admin/entradas/page.tsx', 'app/admin/estadisticas/page.tsx'];

  it.each(PAGES)('%s: nada de `.then((r) => r.json())` suelto (se usa fetchAdminJson)', (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/\.then\(\(\w+\) => \w+\.json\(\)\)/);
    expect(src).toContain('fetchAdminJson');
  });

  // H-222: el defecto de H-176 seguía en el resto del admin (pedidos, compras y sus pestañas, productos, usuarios, sponsors, invitaciones, secciones, noche, escaneos, aforo, apariencia,
  // el panel de inicio…). Un `{ error }` se pintaba como «No hay pedidos aún» o como una lista vacía. En todo `app/admin` la lectura pasa por `fetchAdminJson`.
  it('H-222: ninguna pantalla del admin hace `.then((r) => r.json())` sin mirar el estado', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const offenders = walk(path.join(ROOT, 'app/admin')).filter((f) => /\.then\(\(?\w+\)? => \w+\.json\(\)\)/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  // H-225: una respuesta vieja que llega tarde no puede pisar (ni su error tapar) los datos de la selección actual.
  it.each(['app/admin/gastos/page.tsx', 'app/admin/ingresos/page.tsx', 'app/admin/ventas/page.tsx', 'app/admin/estadisticas/page.tsx'])('H-225: %s descarta las respuestas viejas (createLatest)', (rel) => {
    const src = read(rel);
    expect(src).toContain("from '@/lib/latest-request'");
    expect(src).toMatch(/\.isCurrent\(/);
  });

  // H-224: «Reintentar» limpiaba el error sin estado de carga y la pantalla pintaba «0,00 €» y «Sin gastos» hasta que llegaba la respuesta; y no repetía la carga inicial de proveedores.
  it.each(['app/admin/gastos/page.tsx', 'app/admin/ingresos/page.tsx'])('H-224: %s: «Reintentar» pone el estado de carga y repite la carga inicial', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/onRetry=\{\(\) => \{ setLoadError\(null\); setLoading\(true\); void loadBase\(\); fetchDatos\(\); \}\}/);
    expect(src).toMatch(/datosLoading && !resumen/); // mientras llegan los datos de un reintento no se pintan ceros
  });

  it.each(PAGES)('%s: ninguna carga termina en un `.catch(() => {})` mudo', (rel) => {
    expect(read(rel)).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  it.each(PAGES)('%s: una carga fallida pinta LoadError en lugar de los totales (H-248: las cinco pantallas, no solo tres)', (rel) => {
    const src = read(rel);
    expect(src).toContain("from '@/components/admin/load-error'");
    expect(src).toMatch(/<LoadError/);
  });

  it('borrar un evento mira `res.ok` y enseña el error del servidor (409 con pedidos) en lugar de «Evento eliminado»', () => {
    const src = read('app/admin/eventos/_components/events-manager.tsx');
    const fn = body(src, 'const confirmDelete');
    expect(fn).toMatch(/if \(res\.ok\) \{[\s\S]*toast\.success\('Evento eliminado'\)[\s\S]*\} else \{[\s\S]*toast\.error\(await responseError\(res,/); // el éxito solo con res.ok; si no, el error del servidor
  });

  it.each(['app/admin/gastos/page.tsx', 'app/admin/ingresos/page.tsx'])('%s: anular sin conexión avisa (try/catch con toast), no se queda mudo', (rel) => {
    const src = read(rel);
    const fn = body(src, 'const confirmDelete');
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/catch \(e\)/);
    expect(fn).toMatch(/toast\.error\(userMessage\(e/);
  });
});
