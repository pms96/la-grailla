import { cn } from '@/lib/utils';
import { cellPath, composeShapes, type ShapeColor } from './shapes';

/** Cada color de la composición es un token del tema del cliente: cambia con su marca, nunca lleva un color fijo. */
const FILL: Record<ShapeColor, string> = {
  primary: 'hsl(var(--primary))',
  accent: 'hsl(var(--accent))',
  ink: 'hsl(var(--foreground))',
  paper: 'hsl(var(--background))',
  onPrimary: 'hsl(var(--primary-foreground))',
};

const r = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Composición geométrica generada a partir de un texto (ver shapes.ts): hace de «foto» en la plantilla «tipo». Es decorativa (el texto ya
 * dice todo), así que va oculta a lectores de pantalla. Componente de servidor, determinista.
 */
export function Composition({ seed, n = 3, palette, className }: { seed: string; n?: number; palette?: readonly ShapeColor[]; className?: string }) {
  const { n: size, cells } = composeShapes(seed, n, palette);
  const c = 100 / size;
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className={cn('tp-composition', className)}>
      {cells.map((cell) => {
        const x = cell.col * c;
        const y = cell.row * c;
        const cx = x + c / 2;
        const cy = y + c / 2;
        const transform = cell.rot ? `rotate(${cell.rot * 90} ${r(cx)} ${r(cy)})` : undefined;
        const fill = { fill: FILL[cell.color] };
        const key = `${cell.col}-${cell.row}`;
        if (cell.kind === 'circle') return <circle key={key} cx={r(cx)} cy={r(cy)} r={r(c / 2)} style={fill} />;
        if (cell.kind === 'ring')
          return (
            <g key={key}>
              <circle cx={r(cx)} cy={r(cy)} r={r(c / 2)} style={fill} />
              <circle cx={r(cx)} cy={r(cy)} r={r(c / 4)} style={{ fill: FILL[cell.hole] }} />
            </g>
          );
        // Las figuras de borde recto comparten lados con sus vecinas: un trazo muy fino del mismo color tapa la línea de antialiasing que, si no,
        // se cuela entre celdas contiguas.
        const solid = { ...fill, stroke: FILL[cell.color], strokeWidth: 0.25 };
        if (cell.kind === 'square') return <rect key={key} x={r(x)} y={r(y)} width={r(c)} height={r(c)} style={solid} />;
        return <path key={key} d={cellPath(cell, size) ?? ''} transform={transform} style={solid} />;
      })}
    </svg>
  );
}
