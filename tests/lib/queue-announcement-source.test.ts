import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* H-167 (fase 4): al llegar al último minuto de la compra el aviso salía por DOS regiones `aria-live` a la vez: el toast visible («Te queda 1 minuto…», que sonner anuncia
 * solo) y el texto `sr-only` («Queda un minuto…»). Un lector de pantalla lo decía dos veces. Un mismo aviso, un solo canal: con toast (a 60 s) no se vuelve a anunciar a
 * mano; a 10 s no hay toast y sí el aviso para lectores. */

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../app/(public)/eventos/[slug]/comprar/_components/waiting-room-gate.tsx'), 'utf8');

describe('H-167: el aviso del último minuto no se anuncia por dos canales', () => {
  it('el toast de «1 minuto» y el anuncio sr-only son excluyentes', () => {
    expect(SOURCE).toMatch(/if \(seconds > 10\) toast\.warning\([^)]*\);\s*else setAnnouncement\(message\);/);
  });

  it('no queda un `setAnnouncement(message)` incondicional junto al toast', () => {
    const calls = SOURCE.match(/setAnnouncement\(message\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('el texto «turno guardado en este dispositivo» depende de que el navegador guarde de verdad (`tokens.persistent()`)', () => {
    expect(SOURCE).toMatch(/tokens\.persistent\(\) \? \(\s*<p>Tu turno está guardado en este dispositivo/);
    expect(SOURCE).toContain('no cierres ni recargues esta pestaña');
  });
});
