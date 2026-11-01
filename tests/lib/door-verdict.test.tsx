import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VerdictOverlay } from '@/app/acceso/_components/verdict-overlay';
import { VERDICT_STYLE, contrastRatio, verdictStyle, verdictWord } from '@/lib/door-verdict-style';

const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const noop = () => {};

/* H-085: el veredicto de la puerta se leía mal (texto blanco sobre amarillo ≈1,9:1 y sobre verde ≈2,3:1, subtexto a 60-80 % de opacidad) y el overlay era un `div onClick`
 * sin rol, sin anuncio y sin teclado. */

describe('colores del veredicto', () => {
  it.each(Object.entries(VERDICT_STYLE))('%s: texto y fondo con contraste WCAG AA (≥ 4,5:1)', (_name, { bg, fg }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('el cálculo de contraste es el de WCAG (negro sobre blanco = 21:1; los colores de antes no pasaban)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#eab308')).toBeLessThan(2.5); // yellow-500 de antes
    expect(contrastRatio('#ffffff', '#22c55e')).toBeLessThan(2.5); // green-500 de antes
  });

  it('un color desconocido se pinta como error, nunca como un «pasa»', () => {
    expect(verdictStyle('azul')).toEqual(VERDICT_STYLE.red);
    expect(verdictStyle(undefined)).toEqual(VERDICT_STYLE.red);
    expect(verdictStyle('green')).toEqual(VERDICT_STYLE.green);
  });

  it('cada veredicto tiene su palabra', () => {
    expect(verdictWord('VALID')).toBe('Entrada válida');
    expect(verdictWord('DUPLICATE')).toBe('Entrada ya usada');
    expect(verdictWord('WRONG_EVENT')).toBe('Otro evento');
    expect(verdictWord('ERROR')).toBe('No se pudo comprobar');
    expect(verdictWord('INVALID')).toBe('Entrada no válida');
  });
});

describe('VerdictOverlay', () => {
  const result = { result: 'DUPLICATE', message: 'Ya entró a las 22:10', color: 'yellow', ticketType: 'General', ticketId: 't1' };

  it('se anuncia solo (role alert, aria-live) y dice el veredicto con palabras, no solo con emoji y color', () => {
    const html = render(<VerdictOverlay result={result} onDismiss={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('Entrada ya usada');
    expect(html).toContain('Ya entró a las 22:10');
    expect(html).toContain('aria-hidden="true"'); // el emoji no se lee
  });

  it('se cierra con un BOTÓN real (teclado), no con un div clicable', () => {
    const html = render(<VerdictOverlay result={result} onDismiss={noop} />);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Continuar<\/button>/);
    expect(html).not.toContain('onclick');
  });

  it('colores del estilo, sin opacidad en el subtexto', () => {
    const html = render(<VerdictOverlay result={result} onDismiss={noop} />);
    expect(html).toContain(`background-color:${VERDICT_STYLE.yellow.bg}`);
    expect(html).toContain(`color:${VERDICT_STYLE.yellow.fg}`);
    expect(html).not.toMatch(/opacity-(60|80)/);
  });

  it('el botón «Permitir reentrada» solo sale si se le pasa la acción', () => {
    expect(render(<VerdictOverlay result={result} onDismiss={noop} />)).not.toContain('Permitir reentrada');
    expect(render(<VerdictOverlay result={result} onDismiss={noop} reentry={{ onAllow: noop }} />)).toContain('Permitir reentrada');
  });
});
