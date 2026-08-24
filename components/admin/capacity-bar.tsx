import { cn } from '@/lib/utils';

type Props = {
  current: number;
  max: number;
  sold: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

const HEIGHTS = { sm: 'h-2', md: 'h-3', lg: 'h-4' };

// Vendidas siempre >= dentro (aforo físico), así que la barra de "dentro" se
// dibuja encima y siempre cabe dentro de la de "vendidas" — nunca hace falta
// apilarlas lado a lado.
export function CapacityBar({ current, max, sold, size = 'sm', className }: Props) {
  const soldPct = max > 0 ? Math.min((sold / max) * 100, 100) : 0;
  const enteredPct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const isCritical = enteredPct >= 95;
  const isWarning = enteredPct >= 80;
  const enteredColor = isCritical ? 'bg-red-500' : isWarning ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <div className={cn('relative w-full bg-muted rounded-full overflow-hidden', HEIGHTS[size], className)}>
      <div className="absolute inset-y-0 left-0 rounded-full bg-primary/25" style={{ width: `${soldPct}%` }} />
      <div className={cn('absolute inset-y-0 left-0 rounded-full transition-all', enteredColor)} style={{ width: `${enteredPct}%` }} />
    </div>
  );
}
