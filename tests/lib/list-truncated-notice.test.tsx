import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ListTruncatedNotice } from '@/components/admin/list-truncated-notice';
import { ADMIN_ORDERS_PAGE_SIZE } from '@/lib/admin-orders-page';

/* H-223: el listado de Ventas devuelve como mucho 100 pedidos, sin paginación ni aviso: pasadas las 100 ventas el administrador ve solo las más recientes y, con el filtro «Pendientes»
 * o «Email fallido», puede creer que no hay más (los CSV sí avisan con 413). Si la lista llega al tope, la pantalla lo dice. */

const html = (shown: number) => renderToStaticMarkup(ListTruncatedNotice({ shown, limit: 100, what: 'ventas' }) as unknown as Parameters<typeof renderToStaticMarkup>[0]);

describe('ListTruncatedNotice', () => {
  it('con menos filas que el tope no dice nada', () => {
    expect(html(37)).toBe('');
    expect(html(99)).toBe('');
  });
  it('al llegar al tope avisa de que hay más y qué hacer (buscar, filtrar o exportar)', () => {
    const out = html(100);
    expect(out).toContain('role="status"');
    expect(out).toContain('100');
    expect(out).toContain('ventas');
    expect(out).toMatch(/busca|filtra|exporta/i);
  });
});

describe('H-223: el tope del listado es uno solo, el del servidor y el de la pantalla', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('la API usa ADMIN_ORDERS_PAGE_SIZE como tope por defecto y la pantalla de Ventas lo usa para avisar', () => {
    expect(ADMIN_ORDERS_PAGE_SIZE).toBe(100);
    expect(read('app/api/admin/orders/route.ts')).toContain('ADMIN_ORDERS_PAGE_SIZE');
    const page = read('app/admin/ventas/page.tsx');
    expect(page).toContain('ListTruncatedNotice');
    expect(page).toContain('ADMIN_ORDERS_PAGE_SIZE');
  });
});
