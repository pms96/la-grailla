import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* H-166 (fase 4): a 375 px de ancho el navegador encogía la vista en `/admin/eventos` (471 px), `/admin/compras` (499), `/admin/usuarios` (417), `/admin/pedidos` (452),
 * `/admin/estadisticas` (786) y la cabecera de la puerta (381): cada fila o barra metía todo en una línea con `flex items-center justify-between` o `shrink-0`. Medido en
 * navegador tras el arreglo (21 pantallas del admin + la puerta caben en 375 px). Estas comprobaciones solo guardan la intención para que un cambio de clases no la pierda. */

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

describe('H-166: el admin y la puerta no desbordan en un móvil', () => {
  it('PageHeader parte la cabecera en filas y no impide que las acciones encojan (sin `shrink-0`)', () => {
    const src = read('components/layouts/page-header.tsx');
    expect(src).toMatch(/flex flex-wrap items-start justify-between/);
    expect(src).not.toContain('shrink-0');
    expect(src).toMatch(/max-w-full flex-wrap/);
  });

  it('cabecera de la puerta: se parte en filas (título, «Modo noche», rol y «Salir»)', () => {
    expect(read('app/acceso/_components/access-client.tsx')).toMatch(/flex flex-wrap items-center justify-between gap-x-3 gap-y-2/);
  });

  it('fila de evento y de usuario: en móvil en columna, en pantallas anchas en fila', () => {
    expect(read('app/admin/eventos/_components/events-manager.tsx')).toMatch(/p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between/);
    expect(read('app/admin/usuarios/page.tsx')).toMatch(/p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between/);
  });

  it('pestañas de Compras y acciones de un pedido de tienda pueden envolver', () => {
    expect(read('app/admin/compras/page.tsx')).toMatch(/<TabsList className="h-auto max-w-full flex-wrap justify-start">/);
    expect(read('app/admin/pedidos/page.tsx')).toMatch(/<div className="flex flex-wrap items-center gap-2">\s*<Select value=\{order\?\.status/);
  });
});
