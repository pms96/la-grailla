/* Colores del veredicto de la puerta (H-085). Antes: texto blanco sobre `bg-yellow-500` (~1,9:1) y `bg-green-500` (~2,3:1), con el subtexto además a 60-80 % de opacidad:
 * en una puerta de noche, a pleno sol o con el brillo bajo, no se leía. Cada veredicto lleva ahora un fondo y un texto con contraste de al menos 4,5:1 (WCAG AA), y los
 * dos valores viven JUNTOS aquí para que una prueba pueda calcularlo. Pura: la usan el componente y su test. */

export type VerdictColor = 'green' | 'red' | 'yellow';

export const VERDICT_STYLE: Record<VerdictColor, { bg: string; fg: string }> = {
  green: { bg: '#15803d', fg: '#ffffff' },
  red: { bg: '#b91c1c', fg: '#ffffff' },
  yellow: { bg: '#facc15', fg: '#111111' },
};

/** Cualquier color que el servidor mande y no sea uno de los tres se pinta como error (rojo): ante la duda, que no parezca un «pasa». */
export function verdictStyle(color: string | null | undefined): { bg: string; fg: string } {
  return VERDICT_STYLE[(color as VerdictColor) ?? 'red'] ?? VERDICT_STYLE.red;
}

const luminance = (hex: string): number => {
  const n = parseInt(hex.replace('#', ''), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const lin = (c: number) => {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

/** Contraste WCAG entre dos colores `#rrggbb`. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** El veredicto dicho con palabras (el emoji solo no lo lee un lector de pantalla ni se distingue sin color). */
export function verdictWord(result: string | null | undefined): string {
  switch (result) {
    case 'VALID':
      return 'Entrada válida';
    case 'DUPLICATE':
      return 'Entrada ya usada';
    case 'WRONG_EVENT':
      return 'Otro evento';
    case 'ERROR':
      return 'No se pudo comprobar';
    default:
      return 'Entrada no válida';
  }
}
