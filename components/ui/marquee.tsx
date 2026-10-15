import { cn } from '@/lib/utils';

/**
 * Cinta de texto en movimiento, solo CSS (ver `.marquee` en globals.css). Componente de servidor: no necesita JavaScript en el navegador.
 * Para lectores de pantalla el contenido se anuncia UNA vez (el resto es decorativo y va oculto); con prefers-reduced-motion se queda quieta.
 * El separador es un carácter de texto, no una imagen ni un emoji.
 */
export function Marquee({
  items,
  className,
  duration = 40,
  separator = '/',
}: {
  items: readonly string[];
  className?: string;
  /** Segundos que tarda en dar la vuelta; más alto = más lento. */
  duration?: number;
  separator?: string;
}) {
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  // Cada grupo tiene que ser más ancho que la pantalla: se repiten los elementos hasta tener al menos 8.
  const reps = Math.ceil(8 / clean.length);
  const group = Array.from({ length: reps }, () => clean).flat();
  const renderGroup = (key: string) => (
    <ul className="marquee-group" key={key}>
      {group.map((text, i) => (
        <li className="marquee-item" key={i}>
          {text}
          <span aria-hidden className="marquee-sep ml-[0.6em]">
            {separator}
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className={cn('marquee', className)} style={{ ['--marquee-duration' as string]: `${duration}s` }}>
      <p className="sr-only">{clean.join(' · ')}</p>
      <div className="marquee-track" aria-hidden>
        {renderGroup('a')}
        {renderGroup('b')}
      </div>
    </div>
  );
}
