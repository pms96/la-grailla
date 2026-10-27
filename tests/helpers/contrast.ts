import { hslToRgb, type Hsl } from '@/lib/brand/theme';

/* Contraste WCAG de un texto sobre un fondo con un velo translúcido encima (p. ej. `bg-warm-yellow/15` sobre el fondo de la página).
 * Los colores llegan como los tokens de globals.css: «H S% L%». */

const parse = (v: string): Hsl => {
  const [h, s, l] = v.split(' ');
  return { h: parseFloat(h!), s: parseFloat(s!), l: parseFloat(l!) };
};

const luminance = ([r, g, b]: number[]): number => {
  const [R, G, B] = [r!, g!, b!].map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};

/** Contraste de `foreground` sobre `background` con `veil` mezclado al `alpha` por encima. */
export function contrastOnVeil(foreground: string, background: string, veil: string, alpha: number): number {
  const bg = hslToRgb(parse(background));
  const v = hslToRgb(parse(veil));
  const blended = bg.map((c, i) => c * (1 - alpha) + v[i]! * alpha);
  const a = luminance(hslToRgb(parse(foreground)));
  const b = luminance(blended);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
