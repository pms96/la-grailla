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

  it('pasa la web por normalizePublicUrl antes de enlazarla', () => {
    expect(src).toMatch(/import \{[^}]*normalizePublicUrl[^}]*\} from '@\/lib\/safe-url'/);
    expect(src).toMatch(/\{normalizePublicUrl\(detail\.website\) \? \(/); // solo se enlaza si pasa el filtro; si no, texto
    expect(src).toMatch(/href=\{normalizePublicUrl\(detail\.website\) \?\? undefined\}/);
  });
});
