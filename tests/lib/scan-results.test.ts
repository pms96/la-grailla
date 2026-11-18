import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanResultLabel } from '@/lib/scan-results';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* H-192: «Últimos escaneos» de /admin/noche pintaba `REENTRY` y `PENDING_PAYMENT` en crudo (la tabla de etiquetas era local y H-077 solo añadió la reentrada en /admin/escaneos).
 * Ahora hay una sola función de etiquetas y las dos pantallas la usan. */
describe('H-192: etiqueta de cada resultado de escaneo', () => {
  // Todos los valores que el servidor escribe en `ScanLog.result` (app/api/scan, app/api/access, lib/).
  const WRITTEN = ['VALID', 'VALID_MANUAL', 'DUPLICATE', 'INVALID', 'CANCELLED', 'WRONG_EVENT', 'ERROR', 'REENTRY', 'PENDING_PAYMENT', 'NO_EVENT'];

  it.each(WRITTEN)('%s tiene una etiqueta legible (no el código en crudo)', (value) => {
    const label = scanResultLabel(value);
    expect(label).not.toBe(value);
    expect(label).not.toMatch(/^[A-Z_]+$/);
  });

  it('un valor desconocido se enseña tal cual (no se pierde)', () => {
    expect(scanResultLabel('ALGO_NUEVO')).toBe('ALGO_NUEVO');
  });

  it('todos los valores que el servidor escribe están cubiertos (si aparece uno nuevo, hay que etiquetarlo)', () => {
    const sources = ['app/api/scan/route.ts', 'app/api/access/allow-reentry/route.ts', 'app/api/access/validate/route.ts', 'app/api/access/admit/route.ts'].filter((f) => fs.existsSync(path.join(ROOT, f)));
    const written = new Set(sources.flatMap((f) => [...read(f).matchAll(/result: '([A-Z_]+)'/g)].map((m) => m[1])));
    for (const value of written) expect(WRITTEN, value).toContain(value);
  });

  it.each(['app/admin/noche/page.tsx', 'app/admin/escaneos/page.tsx'])('%s usa la función compartida y no una tabla local', (rel) => {
    const src = read(rel);
    expect(src).toContain("from '@/lib/scan-results'");
    expect(src).toMatch(/scanResultLabel\(/);
    expect(src).not.toMatch(/const (scanResultLabel|resultLabel): Record/);
  });
});
