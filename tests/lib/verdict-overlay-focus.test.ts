import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = fs.readFileSync(path.resolve(__dirname, '../../app/acceso/_components/verdict-overlay.tsx'), 'utf8');

/* H-191: el efecto que enfoca «Continuar» dependía de `[onDismiss]` y `access-client` pasa una flecha nueva en cada render: el sondeo del aforo (cada 8 s) volvía a ejecutar
 * `focus()` y le quitaba el foco a «Permitir reentrada» (o a un lector de pantalla), contra H-085. El foco debe tomarse UNA vez, al montarse el veredicto, y el cierre con
 * Escape debe usar siempre la última función sin volver a montar el efecto. */
describe('H-191: el foco del veredicto no se vuelve a robar en cada render', () => {
  it('el efecto de foco y de Escape no depende de `onDismiss` (dependencias vacías)', () => {
    const effect = src.slice(src.indexOf('useEffect('), src.indexOf('}, [', src.indexOf('useEffect(')) + 20);
    expect(effect).toMatch(/\}, \[\]\);/);
    expect(effect).not.toMatch(/\[onDismiss\]/);
  });

  it('Escape llama a la última `onDismiss` a través de una ref', () => {
    expect(src).toMatch(/const dismissRef = useRef\(onDismiss\);/);
    expect(src).toMatch(/dismissRef\.current = onDismiss;/);
    expect(src).toMatch(/dismissRef\.current\(\)/);
  });
});
