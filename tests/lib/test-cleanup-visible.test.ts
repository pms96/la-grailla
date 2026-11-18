import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupWarn } from '../helpers/fixtures';

/* H-200: 44 limpiezas de `tests/api` terminaban en `.catch(() => {})`: si un borrado fallaba (una clave foránea) la fila de prueba se quedaba en la BD de desarrollo sin que nadie
 * lo viera (`fixtures.ts` ya lo había corregido para `cleanupTestEvent` y `restoreConfig`). Ahora el error se ve; solo se calla «la fila ya no existe» (P2025), que es el caso
 * normal de limpiar algo que la propia prueba ya borró. */
afterEach(() => vi.restoreAllMocks());

describe('cleanupWarn', () => {
  it('calla un P2025 (la fila ya no existe: nada que limpiar)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanupWarn(Object.assign(new Error('No record was found'), { code: 'P2025' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('avisa de cualquier otro error (clave foránea, BD caída…) sin lanzar', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => cleanupWarn(Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' }))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toMatch(/cleanup de prueba/);
  });
});

describe('H-200: ninguna limpieza de tests/api traga el error en silencio', () => {
  const dir = path.resolve(__dirname, '../api');
  const offenders = fs.readdirSync(dir).filter((f) => /\.test\.tsx?$/.test(f) && /\.catch\(\(\) => \{\}\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  it('no queda ningún `.catch(() => {})` en tests/api', () => {
    expect(offenders).toEqual([]);
  });
});
