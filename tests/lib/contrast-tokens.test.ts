import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* H-083: `text-destructive` usaba `--destructive`, que en oscuro es un rojo de FONDO (0 63% 31%) y sobre el fondo oscuro da ~2:1 (AA exige 4,5:1);
 * en claro, ~3,8:1. El texto de error usa ahora `--destructive-text`, un token propio por tema. */

const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
const darkStart = css.indexOf('.dark {');
const light = css.slice(css.indexOf(':root'), darkStart);
const dark = css.slice(darkStart, css.indexOf('}', darkStart));

function token(block: string, name: string): [number, number, number] {
  const m = block.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
  if (!m) throw new Error(`falta --${name}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance([h, s, l]: [number, number, number]): number {
  const S = s / 100;
  const L = l / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return L - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}

const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('contraste del texto de error (H-083)', () => {
  for (const [theme, block] of [['claro', light], ['oscuro', dark]] as const) {
    it(`en tema ${theme}, --destructive-text llega a 4,5:1 sobre el fondo y sobre las tarjetas`, () => {
      const text = token(block, 'destructive-text');
      expect(contrast(text, token(block, 'background'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text, token(block, 'card'))).toBeGreaterThanOrEqual(4.5);
    });
  }

  // H-093: las pegatinas «En cola» y «Es tu turno» usaban `text-lima` (#C5E63A) sobre la tarjeta blanca: ~1,4:1 en tema claro. El texto lima usa `--lima-text`.
  for (const [theme, block] of [['claro', light], ['oscuro', dark]] as const) {
    it(`en tema ${theme}, --lima-text llega a 4,5:1 sobre el fondo y sobre las tarjetas`, () => {
      const text = token(block, 'lima-text');
      expect(contrast(text, token(block, 'background'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text, token(block, 'card'))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('las pegatinas de la sala de espera usan `text-lima-text`, no `text-lima`', () => {
    const src = readFileSync(join(process.cwd(), 'app/(public)/eventos/[slug]/comprar/_components/waiting-room-gate.tsx'), 'utf8');
    expect(src).not.toMatch(/brand-sticker[^"]*text-lima(?![-\w])/);
    expect(src).toMatch(/brand-sticker[^"]*text-lima-text/);
  });

  it('ningún texto usa `text-destructive` a secas (usa `text-destructive-text`); solo los iconos decorativos con opacidad', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.tsx')) {
          const src = readFileSync(p, 'utf8');
          if (/(?<![\w-])text-destructive(?![-/\w])/.test(src)) offenders.push(p.replace(process.cwd() + '/', ''));
        }
      }
    };
    walk(join(process.cwd(), 'app'));
    walk(join(process.cwd(), 'components'));
    expect(offenders).toEqual([]);
  });
});
