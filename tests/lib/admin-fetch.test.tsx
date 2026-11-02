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

  it.each(PAGES)('%s: ninguna carga termina en un `.catch(() => {})` mudo', (rel) => {
    expect(read(rel)).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  it.each(['app/admin/gastos/page.tsx', 'app/admin/ingresos/page.tsx', 'app/admin/estadisticas/page.tsx'])('%s: una carga fallida pinta LoadError en lugar de los totales', (rel) => {
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
