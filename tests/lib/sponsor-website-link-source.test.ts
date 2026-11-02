import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* H-169 (fase 5): la ficha de un sponsor pintaba `detail.website` como `href` sin mirarlo. Con filas ya guardadas antes del arreglo
 * (o por una vía futura sin validar), `javascript:…` llegaba al enlace. El enlace solo se pinta si pasa por `normalizePublicUrl`. */
describe('H-169: el enlace «Web» de la ficha del sponsor', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../app/admin/sponsors/[id]/page.tsx'), 'utf8');

  it('no usa `detail.website` directamente como href', () => {
    expect(src).not.toMatch(/href=\{detail\.website\}/);
  });

  // H-241: `normalizePublicUrl` lo importan componentes de CLIENTE (el formulario público y la ficha del admin); `lib/safe-url.ts` importaba zod en el nivel superior y lo metía en
  // esos bundles del navegador. La parte con zod (`optionalPublicUrl`) vive aparte, solo para las rutas de servidor.
  it('H-241: lib/safe-url.ts (importado desde el navegador) no importa zod; la parte de zod vive en lib/optional-public-url.ts', () => {
    const safeUrl = fs.readFileSync(path.resolve(__dirname, '../../lib/safe-url.ts'), 'utf8');
    expect(safeUrl).not.toMatch(/from 'zod'/);
    expect(safeUrl).not.toMatch(/optionalPublicUrl/);
    const zodPart = fs.readFileSync(path.resolve(__dirname, '../../lib/optional-public-url.ts'), 'utf8');
    expect(zodPart).toMatch(/export const optionalPublicUrl/);
  });

  // H-242: el alta manual no validaba la web en el cliente: «@club» daba el 400 genérico («Los datos enviados no son válidos…») sin decir qué campo. El formulario público ya lo hace.
  it('H-242: el diálogo de alta manual valida la web con normalizePublicUrl y avisa de ese campo antes de enviar', () => {
    const dialog = fs.readFileSync(path.resolve(__dirname, '../../app/admin/sponsors/_components/create-sponsor-dialog.tsx'), 'utf8');
    expect(dialog).toMatch(/import \{[^}]*normalizePublicUrl[^}]*\} from '@\/lib\/safe-url'/);
    expect(dialog).toMatch(/normalizePublicUrl\(form\.website\)/);
    expect(dialog).toContain('Escribe una dirección web válida');
  });

  it('pasa la web por normalizePublicUrl antes de enlazarla', () => {
    expect(src).toMatch(/import \{[^}]*normalizePublicUrl[^}]*\} from '@\/lib\/safe-url'/);
    expect(src).toMatch(/\{normalizePublicUrl\(detail\.website\) \? \(/); // solo se enlaza si pasa el filtro; si no, texto
    expect(src).toMatch(/href=\{normalizePublicUrl\(detail\.website\) \?\? undefined\}/);
  });
});
