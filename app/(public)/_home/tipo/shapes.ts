/* Formas generativas de la plantilla «tipo»: en lugar de una foto, cada evento (o la cabecera) lleva una composición geométrica única, tipo
 * Bauhaus, calculada a partir de un texto (su nombre o su slug). Módulo PURO y determinista: el mismo texto da siempre la misma composición
 * (sin Math.random ni fecha), así que el HTML es idéntico entre servidor y navegador y entre peticiones, y la caché del CDN no se rompe. */

/** De dónde sale el color de cada forma: siempre tokens del tema del cliente, nunca colores fijos. */
export type ShapeColor = 'primary' | 'accent' | 'ink' | 'paper' | 'onPrimary';
export type ShapeKind = 'circle' | 'ring' | 'quarter' | 'half' | 'square' | 'triangle';

export type Cell = {
  /** Posición en la cuadrícula (0 = primera). */
  col: number;
  row: number;
  kind: ShapeKind;
  /** Giros de 90° (0-3). */
  rot: 0 | 1 | 2 | 3;
  color: ShapeColor;
  /** Segundo color, solo para el anillo (el hueco). */
  hole: ShapeColor;
};

export type Composition = { n: number; cells: Cell[] };

/** Hash de texto a número de 32 bits (xmur3). */
function hash(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Generador pseudoaleatorio con semilla (mulberry32): devuelve números en [0, 1). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Algunas celdas quedan vacías a propósito: el aire es parte de la composición.
const KINDS: (ShapeKind | 'empty')[] = ['empty', 'circle', 'ring', 'quarter', 'quarter', 'half', 'square', 'triangle'];

export const DEFAULT_PALETTE: readonly ShapeColor[] = ['primary', 'accent', 'ink'];

/** Composición de `n × n` celdas (n entre 2 y 8) para un texto. Con una paleta de al menos un color. */
export function composeShapes(seedText: string, n = 3, palette: readonly ShapeColor[] = DEFAULT_PALETTE): Composition {
  const size = Math.min(8, Math.max(2, Math.round(n)));
  const colors = palette.length > 0 ? palette : DEFAULT_PALETTE;
  const rand = rng(hash(seedText.trim().toLowerCase()));
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const cells: Cell[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const kind = pick(KINDS);
      // Siempre se consumen los mismos números aleatorios por celda, haya forma o no: así una celda no cambia al cambiar las de al lado.
      const rot = Math.floor(rand() * 4) as 0 | 1 | 2 | 3;
      const color = pick(colors);
      const hole = pick(colors);
      if (kind !== 'empty') cells.push({ col, row, kind, rot, color, hole: hole === color ? colors[(colors.indexOf(color) + 1) % colors.length] : hole });
    }
  }
  // Una composición sin ninguna forma no tiene sentido: si el azar la dejó vacía, una forma en el centro.
  if (cells.length === 0) cells.push({ col: Math.floor(size / 2), row: Math.floor(size / 2), kind: 'circle', rot: 0, color: colors[0], hole: colors[0] });
  return { n: size, cells };
}

/** Trazado SVG (en una cuadrícula de 100×100) de una celda, sin el giro. Devuelve `null` para el círculo, el anillo y el cuadrado, que son elementos propios. */
export function cellPath(cell: Cell, n: number): string | null {
  const c = 100 / n;
  const x = cell.col * c;
  const y = cell.row * c;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  switch (cell.kind) {
    case 'quarter': // cuarto de círculo con el centro en la esquina inferior izquierda
      return `M${r(x)},${r(y + c)}L${r(x)},${r(y)}A${r(c)},${r(c)} 0 0 1 ${r(x + c)},${r(y + c)}Z`;
    case 'half': // semicírculo apoyado en el borde inferior
      return `M${r(x)},${r(y + c)}A${r(c / 2)},${r(c / 2)} 0 0 1 ${r(x + c)},${r(y + c)}Z`;
    case 'triangle':
      return `M${r(x)},${r(y + c)}L${r(x + c)},${r(y + c)}L${r(x)},${r(y)}Z`;
    default:
      return null;
  }
}
